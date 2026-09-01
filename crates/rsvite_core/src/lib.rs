use std::{
    convert::Infallible,
    future::Future,
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
};

use axum::{
    Router,
    body::Body,
    extract::State,
    http::{HeaderValue, Method, StatusCode, Uri, header},
    response::{
        IntoResponse, Response,
        sse::{Event, Sse},
    },
    routing::any,
};
use thiserror::Error;
use tokio::{
    net::TcpListener,
    sync::{Notify, broadcast, mpsc, oneshot, watch},
};
use tokio_stream::{
    StreamExt,
    wrappers::{BroadcastStream, WatchStream},
};

mod javascript;
mod module_graph;
mod project_file;
mod reload;
mod resource;
mod root_document;
mod watcher;

use javascript::load as load_javascript;
use module_graph::ModuleGraph;
use project_file::{ProjectFileError, ProjectFileErrorKind};
use reload::{CLIENT_PATH, EVENTS_PATH, RELOAD_EVENT};
use resource::{load_resource, resource_kind_for};

#[derive(Debug, Error)]
pub enum ServerError {
    #[error("failed to resolve root {root}: {source}")]
    ResolveRoot {
        root: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("root is not a directory: {0}")]
    RootNotDirectory(PathBuf),
    #[error("failed to bind 127.0.0.1:{port}: {source}")]
    Bind {
        port: u16,
        #[source]
        source: std::io::Error,
    },
    // The watcher library is an implementation detail, so its error type does not become part of
    // this one; what a caller can act on is which root could not be watched, and why.
    #[error("failed to watch root {root}: {message}")]
    Watch { root: PathBuf, message: String },
    #[error("development server failed: {0}")]
    Serve(String),
    #[error("development server stopped before reporting its final state")]
    CompletionChannelClosed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum LifecycleState {
    Running,
    Closing,
    Closed,
    Failed(String),
}

struct Inner {
    address: SocketAddr,
    lifecycle: watch::Receiver<LifecycleState>,
    // Registering a cause is how a shutdown starts, so every reason is recorded the same way
    // and in the order they happen.
    shutdown: Arc<ShutdownSlot>,
    // A listener that ends on its own is the third reason a server stops. Nothing in the product
    // ends it that way on demand, so tests reach it through this handle.
    #[cfg(test)]
    serving_abort: tokio::task::AbortHandle,
    #[cfg(test)]
    state: Arc<ServerState>,
}

/// Why the server is shutting down.
#[derive(Clone, Debug)]
enum ShutdownCause {
    Requested,
    WatchFailure(String),
    /// The listener stopped on its own; what it reported is read by joining its task.
    ListenerEnded,
}

/// Registers the end of the listener where it happens, however it happens.
///
/// A task that is cancelled never reaches its last statement, so the registration lives in a drop
/// guard: ending normally, failing, panicking and being cancelled all pass through it.
struct ListenerEnds(Arc<ShutdownSlot>);

impl Drop for ListenerEnds {
    fn drop(&mut self) {
        self.0.register(ShutdownCause::ListenerEnded);
    }
}

/// The one reason this server stopped.
///
/// All three causes are registered where they happen — a caller's request in the calling thread, a
/// watcher failure in the callback that reports it, the listener ending in the task that ran it —
/// so the first registration is the first event. Deciding the order later, by which channel a reader happens to poll first, would let a
/// failure that occurred after a close request still overrule it.
#[derive(Default)]
struct ShutdownSlot {
    cause: Mutex<Option<ShutdownCause>>,
    registered: Notify,
}

impl ShutdownSlot {
    fn register(&self, cause: ShutdownCause) {
        let mut slot = self.cause.lock().expect("shutdown cause mutex poisoned");
        if slot.is_none() {
            *slot = Some(cause);
            self.registered.notify_one();
        }
    }

    async fn first_cause(&self) -> ShutdownCause {
        loop {
            // Arming the wake-up before reading is what keeps a registration that lands between
            // the two from being missed.
            let registered = self.registered.notified();
            if let Some(cause) = self
                .cause
                .lock()
                .expect("shutdown cause mutex poisoned")
                .clone()
            {
                return cause;
            }
            registered.await;
        }
    }
}

/// The one HTML transformation a project may declare, as this server sees it.
///
/// Everything about the plugin — its name, the shape it had to have, what its hook returned and
/// how a failure reads — is decided where that code runs. What crosses into this server is a
/// single call: the document as text in, the document to serve back out, or the text of one
/// failure. No plugin object, configuration value or path context is on this side of the call.
pub type TransformIndexHtml = Box<
    dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> + Send + Sync,
>;

struct ServerState {
    root: PathBuf,
    module_graph: Mutex<ModuleGraph>,
    reloads: broadcast::Sender<()>,
    // Closing is state, not an event. A stream that subscribes after a shutdown has begun reads
    // the current value and ends immediately, which an event sent once would never reach.
    lifecycle: watch::Receiver<LifecycleState>,
    // Held for exactly as long as this server serves. Whatever the caller gave is let go when the
    // state is, so nothing this server holds keeps that caller's work alive after the last
    // request has been answered.
    transform_index_html: Option<TransformIndexHtml>,
}

impl ServerState {
    fn new(
        root: PathBuf,
        lifecycle: watch::Receiver<LifecycleState>,
        transform_index_html: Option<TransformIndexHtml>,
    ) -> Self {
        Self {
            root,
            transform_index_html,
            module_graph: Mutex::new(ModuleGraph::default()),
            // A reload nobody is open to receive is not kept: the next document load reads
            // the current files anyway.
            reloads: broadcast::channel(RELOAD_BACKLOG).0,
            lifecycle,
        }
    }
}

/// How many reloads a stream may fall behind before it is told it missed some.
///
/// A page only needs to load once however many it missed, so a small backlog is enough: the
/// stream turns an overflow into one more event rather than ending, and the client is what
/// collapses whatever arrives into a single navigation.
const RELOAD_BACKLOG: usize = 8;

pub struct DevServer {
    inner: Inner,
}

impl DevServer {
    /// Starts serving `root`, transforming the root document through `transform_index_html`
    /// when the caller supplied one.
    ///
    /// The transformation is held for exactly as long as this server serves and is let go with it,
    /// so a caller that has stopped this server, or has let go of its handle, is not still being
    /// called back into.
    pub async fn start(
        root: impl AsRef<Path>,
        port: u16,
        transform_index_html: Option<TransformIndexHtml>,
    ) -> Result<Self, ServerError> {
        let requested_root = root.as_ref().to_path_buf();
        let canonical_root = tokio::fs::canonicalize(&requested_root)
            .await
            .map_err(|source| ServerError::ResolveRoot {
                root: requested_root.clone(),
                source,
            })?;
        let metadata = tokio::fs::metadata(&canonical_root)
            .await
            .map_err(|source| ServerError::ResolveRoot {
                root: requested_root,
                source,
            })?;
        if !metadata.is_dir() {
            return Err(ServerError::RootNotDirectory(canonical_root));
        }

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .await
            .map_err(|source| ServerError::Bind { port, source })?;
        let address = listener
            .local_addr()
            .map_err(|source| ServerError::Bind { port, source })?;
        let (task_lifecycle, lifecycle) = watch::channel(LifecycleState::Running);
        let state = Arc::new(ServerState::new(
            canonical_root.clone(),
            lifecycle.clone(),
            transform_index_html,
        ));

        // Watching starts before this function returns, so the readiness the CLI prints means
        // both that the listener accepts requests and that a save will be seen. The project is
        // watched recursively. Resolving `index.html` also watches, without recursion, the parent
        // directory of every symlink that resolution goes through and the parent directory of the
        // file it ends at, because `GET /` answers with that file however far away it lives.
        let (notices, watched_changes) = mpsc::unbounded_channel();
        let shutdown = Arc::new(ShutdownSlot::default());
        let watch_failed = {
            let shutdown = Arc::clone(&shutdown);
            move |message: String| shutdown.register(ShutdownCause::WatchFailure(message))
        };
        let watcher: watcher::SharedWatcher = Arc::new(std::sync::Mutex::new(Some(
            watcher::watch(&canonical_root, notices, watch_failed.clone()).map_err(|source| {
                ServerError::Watch {
                    root: canonical_root.clone(),
                    message: source.to_string(),
                }
            })?,
        )));
        let (resolution, external) =
            watcher::watch_the_way_to_the_document(&watcher, &canonical_root).map_err(
                |source| ServerError::Watch {
                    root: canonical_root.clone(),
                    message: source.to_string(),
                },
            )?;

        let (published, mut completed) = mpsc::unbounded_channel();
        let coalescer = watcher::spawn_coalescer(
            canonical_root,
            Arc::clone(&watcher),
            resolution,
            external,
            watched_changes,
            published,
            watch_failed,
        );
        let forwarder = {
            let reloads = state.reloads.clone();
            tokio::spawn(async move {
                while completed.recv().await.is_some() {
                    // No open page is not an error: the next document load reads current files.
                    let _ = reloads.send(());
                }
            })
        };

        // Axum's GET router also accepts HEAD, so the handler enforces the narrower contract.
        let router = Router::new()
            .route("/", any(serve_request))
            .route("/{*path}", any(serve_request))
            .with_state(Arc::clone(&state));

        let (listener_shutdown_tx, listener_shutdown_rx) = oneshot::channel::<()>();
        let serving = tokio::spawn({
            let shutdown = Arc::clone(&shutdown);
            async move {
                let _ends = ListenerEnds(shutdown);
                axum::serve(listener, router)
                    .with_graceful_shutdown(async move {
                        let _ = listener_shutdown_rx.await;
                    })
                    .await
            }
        });

        // One task owns the shutdown from end to end: it decides the cause, publishes the closing
        // state every stream can read, stops watching, closes the listener, waits for the work
        // that fed it, and only then publishes the final state.
        #[cfg(test)]
        let serving_abort = serving.abort_handle();
        let owned_shutdown = Arc::clone(&shutdown);
        tokio::spawn(async move {
            // A server stops for one of three reasons, and each registers itself where it
            // happens, so the first registration is the one that began the shutdown. Deciding
            // between an already registered cause and an already finished task here would put
            // that order back in the hands of whichever this task polls first.
            let cause = owned_shutdown.first_cause().await;

            // Leaving `Running` is what ends the open streams, including one that subscribes
            // after this point.
            task_lifecycle.send_replace(LifecycleState::Closing);
            // Taking the watcher away stops every directory it was watching at once, and closes
            // the channel that keeps the coalescer and the forwarder alive.
            watcher.lock().expect("watcher mutex poisoned").take();
            // Harmless if the listener has already stopped: it is what asks a running one to.
            let _ = listener_shutdown_tx.send(());
            let served = serving.await;
            let _ = coalescer.await;
            let _ = forwarder.await;

            // The cause says why the shutdown began; it is not always what a caller is told.
            // A listener that reported an error, or a task that ended without returning one,
            // describes the work being closed more precisely than the reason for closing it, so
            // that is reported instead.
            let final_state = match (served, cause) {
                (Ok(Err(error)), _) => LifecycleState::Failed(error.to_string()),
                (Err(error), _) => LifecycleState::Failed(error.to_string()),
                (Ok(Ok(())), ShutdownCause::WatchFailure(message)) => {
                    LifecycleState::Failed(format!("file watcher failed: {message}"))
                }
                (Ok(Ok(())), ShutdownCause::Requested | ShutdownCause::ListenerEnded) => {
                    LifecycleState::Closed
                }
            };
            task_lifecycle.send_replace(final_state);
        });

        Ok(Self {
            inner: Inner {
                address,
                lifecycle,
                shutdown,
                #[cfg(test)]
                serving_abort,
                #[cfg(test)]
                state,
            },
        })
    }

    pub fn address(&self) -> SocketAddr {
        self.inner.address
    }

    pub async fn wait(&self) -> Result<(), ServerError> {
        let mut lifecycle = self.inner.lifecycle.clone();
        loop {
            let state = lifecycle.borrow().clone();
            match state {
                LifecycleState::Running | LifecycleState::Closing => {}
                LifecycleState::Closed => return Ok(()),
                LifecycleState::Failed(message) => return Err(ServerError::Serve(message)),
            }
            lifecycle
                .changed()
                .await
                .map_err(|_| ServerError::CompletionChannelClosed)?;
        }
    }

    pub async fn close(&self) -> Result<(), ServerError> {
        self.begin_closing();
        self.wait().await
    }

    /// Asks the server to stop, without waiting for it.
    ///
    /// The shutdown itself belongs to one task, so this only registers the request; stopping the
    /// watcher, ending open streams, closing the listener and waiting for the remaining work all
    /// happen there, in that order.
    fn begin_closing(&self) {
        self.inner.shutdown.register(ShutdownCause::Requested);
    }
}

/// Letting go of the handle is a close request.
///
/// This handle is the only way to ask this server to stop, and it cannot be copied, so a caller
/// that drops it has given that up — including a JavaScript wrapper that is collected without
/// anyone having called `close()`. A server left running then owns a listener, a watcher and its
/// tasks that nothing can reach, so letting go asks for the same shutdown a caller would.
///
/// It is registered the way every other reason is, into the slot that only accepts the first, so a
/// close or a failure that happened earlier still decides what the server ends as, and the task
/// that owns the shutdown does the stopping.
impl Drop for DevServer {
    fn drop(&mut self) {
        self.begin_closing();
    }
}

async fn serve_request(
    method: Method,
    uri: Uri,
    State(state): State<Arc<ServerState>>,
) -> Response<Body> {
    if method != Method::GET {
        let mut response = response(StatusCode::METHOD_NOT_ALLOWED, None, Body::empty());
        response
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET"));
        return response;
    }

    if uri.path() == CLIENT_PATH {
        return serve_client();
    }
    if uri.path() == EVENTS_PATH {
        return serve_events(&state);
    }
    if uri.path() == "/" {
        return serve_root_html(&state).await;
    }
    if uri.path().ends_with(".js") || uri.path().ends_with(".ts") {
        return serve_javascript(&state, uri.path()).await;
    }

    // A path that names a stylesheet or an asset is answered under the resource contract, which
    // decodes it. A path that names no kind this server answers is an empty `404`.
    match resource_kind_for(uri.path()) {
        Some(kind) => serve_resource(&state.root, uri.path(), kind).await,
        None => response(StatusCode::NOT_FOUND, None, Body::empty()),
    }
}

/// The document `GET /` answers with, transformed first if the project declared a hook.
///
/// The file is read again for every request, so what a page is given is what the project holds
/// now; nothing transformed is kept between requests. A project that declared no hook is answered
/// with the bytes it wrote, byte for byte — reading them as text is only done
/// for a project that asked for its document to be transformed, and a document that is not text
/// cannot be handed to a hook that takes a string.
///
/// The built-in client reference is appended after the hook, so what a hook is given is the
/// project's own document and nothing this server adds to it.
async fn serve_root_html(state: &ServerState) -> Response<Body> {
    let html = match tokio::fs::read(state.root.join("index.html")).await {
        Ok(html) => html,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return response(StatusCode::NOT_FOUND, None, Body::empty());
        }
        Err(_) => return response(StatusCode::INTERNAL_SERVER_ERROR, None, Body::empty()),
    };
    let Some(transform) = state.transform_index_html.as_ref() else {
        return response(
            StatusCode::OK,
            Some("text/html; charset=utf-8"),
            Body::from(reload::with_client_reference(html)),
        );
    };
    let Ok(source) = String::from_utf8(html) else {
        return hook_failure("index.html is not valid UTF-8".to_owned());
    };
    match transform(source).await {
        Ok(transformed) => response(
            StatusCode::OK,
            Some("text/html; charset=utf-8"),
            Body::from(reload::with_client_reference(transformed.into_bytes())),
        ),
        Err(message) => hook_failure(message),
    }
}

/// A root request the declared hook could not answer for.
///
/// It says what happened and which plugin it happened in, because that text is what the caller
/// wrote for exactly this. The document is not served untransformed instead: a project that asked
/// for its document to be transformed is not given one that was not.
fn hook_failure(message: String) -> Response<Body> {
    no_store(response(
        StatusCode::INTERNAL_SERVER_ERROR,
        Some("text/plain; charset=utf-8"),
        Body::from(format!("rsvite: {message}\n")),
    ))
}

/// The built-in client, served from the same listener as the project's own files.
fn serve_client() -> Response<Body> {
    no_store(response(
        StatusCode::OK,
        Some("text/javascript; charset=utf-8"),
        Body::from(reload::client_source()),
    ))
}

/// The stream a document listens to for the duration of its life.
///
/// The stream ends when the server leaves `Running`. That is what allows a shutdown to complete
/// while pages are connected: an event stream that never ended would hold the graceful shutdown
/// open until the browser gave up.
fn serve_events(state: &ServerState) -> Response<Body> {
    // Falling behind means at least one save was missed, and one load answers all of them.
    let reloads = BroadcastStream::new(state.reloads.subscribe()).map(|_| StreamItem::Reload);
    // The current value arrives on subscription, so a request routed after the shutdown began
    // ends here rather than holding that shutdown open.
    let closing = WatchStream::new(state.lifecycle.clone()).filter_map(|state| {
        (!matches!(state, LifecycleState::Running)).then_some(StreamItem::Stop)
    });
    let events = reloads.merge(closing).map_while(|item| match item {
        // A message with no data field is not dispatched to a page, so the event carries its own
        // name as the payload; the client reacts to the name and ignores the value.
        StreamItem::Reload => Some(Ok::<Event, Infallible>(
            Event::default().event(RELOAD_EVENT).data(RELOAD_EVENT),
        )),
        StreamItem::Stop => None,
    });
    no_store(Sse::new(events).into_response())
}

/// What an open event stream reacts to.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StreamItem {
    Reload,
    Stop,
}

async fn serve_javascript(state: &ServerState, request_path: &str) -> Response<Body> {
    match load_javascript(&state.root, request_path).await {
        Ok(module) => {
            state
                .module_graph
                .lock()
                .expect("module graph mutex poisoned")
                .replace_importees(module.path, module.importees);
            let mut response = response(
                StatusCode::OK,
                Some("text/javascript; charset=utf-8"),
                Body::from(module.source),
            );
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err(error) => {
            let status = project_file_status(error.kind());
            let mut response = response(
                status,
                Some("text/plain; charset=utf-8"),
                Body::from(format!("rsvite: {error}\n")),
            );
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
    }
}

async fn serve_resource(
    root: &Path,
    request_path: &str,
    kind: resource::ResourceKind,
) -> Response<Body> {
    match load_resource(root, request_path, kind).await {
        Ok(bytes) => no_store(response(
            StatusCode::OK,
            Some(kind.content_type),
            Body::from(bytes),
        )),
        Err(error) => project_file_refusal(error),
    }
}

/// A failed resource request, answered as a refusal. What each reason says depends on where it
/// came from: the resolver names the resource subject, some of its branches also name the request
/// the client sent, and a read failure after resolution names the request. None of them name the
/// host path the request resolved to, and none carry the bytes of a file.
fn project_file_refusal(error: ProjectFileError) -> Response<Body> {
    no_store(response(
        project_file_status(error.kind()),
        Some("text/plain; charset=utf-8"),
        Body::from(format!("rsvite: {error}\n")),
    ))
}

fn project_file_status(kind: ProjectFileErrorKind) -> StatusCode {
    match kind {
        ProjectFileErrorKind::BadRequest => StatusCode::BAD_REQUEST,
        ProjectFileErrorKind::Forbidden => StatusCode::FORBIDDEN,
        ProjectFileErrorKind::NotFound => StatusCode::NOT_FOUND,
        ProjectFileErrorKind::UnsupportedMediaType => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ProjectFileErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// The resource responses and refusals this marks are never cached: the next reload has to see
/// the file as it is now, and a refusal must not outlive the edit that fixes it.
fn no_store(mut response: Response<Body>) -> Response<Body> {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn response(status: StatusCode, content_type: Option<&str>, body: Body) -> Response<Body> {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    if let Some(content_type) = content_type {
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            content_type.parse().expect("static content type is valid"),
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{create_dir_all, read_to_string, write},
        net::{Ipv4Addr, SocketAddr},
        path::{Path, PathBuf},
        sync::Arc,
        time::Duration,
    };

    use tempfile::TempDir;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        sync::watch,
        time::timeout,
    };

    use super::{
        DevServer, Inner, LifecycleState, ServerError, ServerState, ShutdownCause, ShutdownSlot,
    };

    async fn request(server: &DevServer, method: &str, path: &str) -> String {
        let mut stream = TcpStream::connect(server.address()).await.unwrap();
        stream
            .write_all(
                format!(
                    "{method} {path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
                    server.address()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    fn write_index(root: &Path, body: &str) {
        write(root.join("index.html"), body).unwrap();
    }

    fn write_project_file(root: &Path, relative: &str, body: &str) {
        let path = root.join(relative);
        create_dir_all(path.parent().unwrap()).unwrap();
        write(path, body).unwrap();
    }

    fn response_body(response: &str) -> &str {
        response.split_once("\r\n\r\n").unwrap().1
    }

    fn empty_state() -> Arc<ServerState> {
        Arc::new(ServerState::new(
            PathBuf::new(),
            watch::channel(LifecycleState::Running).1,
            None,
        ))
    }

    fn has_import_edge(server: &DevServer, importer: &str, importee: &str) -> bool {
        let state = &server.inner.state;
        state
            .module_graph
            .lock()
            .expect("module graph mutex poisoned")
            .contains_edge(&state.root.join(importer), &state.root.join(importee))
    }

    #[tokio::test]
    async fn serves_the_root_html_from_rust_on_every_request() {
        let root = TempDir::new().unwrap();
        write_index(root.path(), "<h1>first</h1>");
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        let first = request(&server, "GET", "/").await;
        assert!(first.starts_with("HTTP/1.1 200 OK"));
        assert!(first.contains("content-type: text/html; charset=utf-8"));
        assert!(first.contains("<h1>first</h1>"), "{first}");
        // The project's document is served as written, followed by the built-in client.
        assert!(
            first.ends_with("<script type=\"module\" src=\"/@rsvite/client\"></script>\n"),
            "{first}"
        );

        write_index(root.path(), "<h1>second</h1>");
        let second = request(&server, "GET", "/").await;
        assert!(second.contains("<h1>second</h1>"), "{second}");
        assert!(!second.contains("<h1>first</h1>"), "{second}");

        // The file on disk keeps the HTML the project wrote.
        let on_disk = read_to_string(root.path().join("index.html")).unwrap();
        assert_eq!(on_disk, "<h1>second</h1>");

        server.close().await.unwrap();
    }

    /// Opens an event stream and returns the connection with the response head already read.
    async fn open_event_stream(server: &DevServer) -> (TcpStream, String) {
        let mut stream = TcpStream::connect(server.address()).await.unwrap();
        stream
            .write_all(
                format!(
                    "GET /@rsvite/events HTTP/1.1\r\nHost: {}\r\nAccept: text/event-stream\r\n\r\n",
                    server.address()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut head = Vec::new();
        let mut byte = [0_u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            let read = timeout(Duration::from_secs(5), stream.read(&mut byte))
                .await
                .expect("the response head arrives")
                .unwrap();
            assert!(read == 1, "the stream closed before its head was complete");
            head.push(byte[0]);
        }
        (stream, String::from_utf8(head).unwrap())
    }

    /// Waits for the connection to reach its end, returning what arrived first.
    ///
    /// A terminating body is bytes followed by end of file, so an ended stream is not a silent
    /// one: the check is that the peer closes, and that nothing further was sent as an event.
    async fn read_until_end(stream: &mut TcpStream, patience: Duration) -> String {
        let mut tail = String::new();
        let mut buffer = [0_u8; 512];
        loop {
            match timeout(patience, stream.read(&mut buffer)).await {
                Ok(Ok(0)) => return tail,
                Ok(Ok(read)) => tail.push_str(&String::from_utf8_lossy(&buffer[..read])),
                Ok(Err(error)) => panic!("event stream failed: {error}"),
                Err(_) => panic!("the event stream never ended; it received {tail:?}"),
            }
        }
    }

    /// Reads whatever the stream sends next, or gives up.
    async fn read_from_stream(stream: &mut TcpStream, patience: Duration) -> Option<String> {
        let mut buffer = [0_u8; 512];
        match timeout(patience, stream.read(&mut buffer)).await {
            Ok(Ok(0)) | Err(_) => None,
            Ok(Ok(read)) => Some(String::from_utf8_lossy(&buffer[..read]).into_owned()),
            Ok(Err(error)) => panic!("event stream failed: {error}"),
        }
    }

    #[tokio::test]
    async fn refuses_to_start_for_a_document_it_would_serve_but_cannot_follow() {
        let root = TempDir::new().unwrap();
        write_index(root.path(), "<h1>served</h1>");
        let canonical = std::fs::canonicalize(root.path()).unwrap();
        let _refusal = super::root_document::refuse_to_follow(&canonical);

        // The route would read this document and answer with it. Starting anyway would serve it
        // while nothing watched it, so the server says so instead.
        let started = DevServer::start(root.path(), 0, None).await;
        let error = match started {
            Ok(_) => panic!("a server started for a document nothing could watch"),
            Err(error) => error,
        };
        assert!(
            matches!(&error, ServerError::Watch { root, message }
                if root == &canonical && message.contains("cannot be followed")),
            "{error}"
        );
    }

    #[tokio::test]
    async fn starts_for_a_project_that_has_no_document_yet() {
        let root = TempDir::new().unwrap();
        write_project_file(root.path(), "src/main.js", "export const value = 1;\n");

        // A project without a document is a project whose `/` answers `404`, not a failure.
        let server = DevServer::start(root.path(), 0, None).await.unwrap();
        let response = request(&server, "GET", "/").await;
        assert!(response.starts_with("HTTP/1.1 404 Not Found"), "{response}");
        server.close().await.unwrap();
    }
    #[tokio::test]
    async fn refuses_to_start_when_the_watcher_cannot_register() {
        let root = TempDir::new().unwrap();
        write_index(root.path(), "<h1>unreachable</h1>");
        // `start` canonicalizes before watching, so the refusal has to name the canonical root.
        let canonical = std::fs::canonicalize(root.path()).unwrap();
        let _refusal = super::watcher::refuse_registration_for(&canonical);

        // A known address, so that what the refusal left behind can be looked at afterwards.
        let probe = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = probe.local_addr().unwrap();
        drop(probe);

        let started = DevServer::start(root.path(), address.port(), None).await;
        let error = match started {
            Ok(_) => panic!("a server started without a watcher"),
            Err(error) => error,
        };

        assert!(
            matches!(&error, ServerError::Watch { root, .. } if root == &canonical),
            "{error}"
        );
        assert!(
            error.to_string().contains("failed to watch root"),
            "{error}"
        );

        // The listener never reached a running server, so nothing is left holding its address.
        let rebound = TcpListener::bind(address).await.unwrap();
        drop(rebound);
    }

    #[tokio::test]
    async fn notifications_lost_by_the_watcher_close_the_server_and_reject_wait() {
        let root = TempDir::new().unwrap();
        write_index(root.path(), "<h1>served</h1>");
        write_project_file(root.path(), "src/main.js", "export const value = 1;\n");
        let server = DevServer::start(root.path(), 0, None).await.unwrap();
        let address = server.address();
        let (mut events, head) = open_event_stream(&server).await;
        assert!(head.starts_with("HTTP/1.1 200 OK"), "{head}");

        // The next notification under this root arrives the way an overflowed queue does: it says
        // that notifications were lost, not what changed. It reaches the watcher's own callback,
        // so this is the production path from notification to shutdown.
        let canonical = std::fs::canonicalize(root.path()).unwrap();
        let _lost = super::watcher::lose_notifications_under(&canonical);
        std::fs::write(canonical.join("src/main.js"), "export const value = 2;\n").unwrap();

        let failure = timeout(Duration::from_secs(5), server.wait())
            .await
            .expect("the server finishes shutting down")
            .unwrap_err();
        assert!(
            matches!(&failure, ServerError::Serve(message)
                if message.contains("file watcher failed")
                    && message.contains("lost notifications")),
            "{failure}"
        );

        // The stream was ended by the shutdown rather than told to reload, and the address is
        // free again, so the listener and the work behind it were both finished.
        let tail = read_until_end(&mut events, Duration::from_secs(5)).await;
        assert!(!tail.contains("event: full-reload"), "{tail}");
        let rebound = TcpListener::bind(address).await.unwrap();
        drop(rebound);
    }

    #[tokio::test]
    async fn a_watcher_failure_after_readiness_closes_the_server_and_rejects_wait() {
        let root = TempDir::new().unwrap();
        write_index(root.path(), "<h1>served</h1>");
        let server = DevServer::start(root.path(), 0, None).await.unwrap();
        let address = server.address();
        let (mut events, head) = open_event_stream(&server).await;
        assert!(head.starts_with("HTTP/1.1 200 OK"), "{head}");

        server.inner.shutdown.register(ShutdownCause::WatchFailure(
            "the watch backend stopped".into(),
        ));

        let failure = timeout(Duration::from_secs(5), server.wait())
            .await
            .expect("the server finishes shutting down")
            .unwrap_err();
        assert!(
            matches!(&failure, ServerError::Serve(message)
                if message.contains("file watcher failed")
                    && message.contains("the watch backend stopped")),
            "{failure}"
        );

        // The open stream was ended by the shutdown rather than left dangling, and the shutdown
        // itself is not delivered to the page as a reload.
        let tail = read_until_end(&mut events, Duration::from_secs(5)).await;
        assert!(!tail.contains("event: full-reload"), "{tail}");
        let rebound = TcpListener::bind(address).await.unwrap();
        drop(rebound);
    }

    #[tokio::test]
    async fn one_save_reaches_every_open_stream_from_the_same_listener() {
        let root = TempDir::new().unwrap();
        write_index(root.path(), "<h1>served</h1>");
        write_project_file(root.path(), "src/styles.css", "#app { color: red; }\n");
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        // The built-in client and the stream it opens are answered by the same listener as the
        // project's own files.
        let client = request(&server, "GET", "/@rsvite/client").await;
        assert!(client.starts_with("HTTP/1.1 200 OK"), "{client}");
        assert!(
            client.contains("content-type: text/javascript; charset=utf-8"),
            "{client}"
        );
        assert!(client.contains("cache-control: no-store"), "{client}");
        assert!(client.contains("/@rsvite/events"), "{client}");

        let (mut first, first_head) = open_event_stream(&server).await;
        let (mut second, second_head) = open_event_stream(&server).await;
        for head in [&first_head, &second_head] {
            assert!(head.starts_with("HTTP/1.1 200 OK"), "{head}");
            assert!(head.contains("content-type: text/event-stream"), "{head}");
            assert!(head.contains("cache-control: no-store"), "{head}");
        }

        write_project_file(root.path(), "src/styles.css", "#app { color: blue; }\n");

        for stream in [&mut first, &mut second] {
            let received = read_from_stream(stream, Duration::from_secs(10))
                .await
                .expect("an open stream is told about the save");
            assert!(received.contains("event: full-reload"), "{received}");
            // A message without a data field is not dispatched to a page, so a frame that only
            // names the event would reach the browser and be discarded by it.
            assert!(received.contains("data:"), "{received}");
        }

        server.close().await.unwrap();
    }

    #[tokio::test]
    async fn a_save_reloads_without_changing_module_graph_state() {
        let root = TempDir::new().unwrap();
        write_index(
            root.path(),
            "<script type=\"module\" src=\"/src/main.js\"></script>",
        );
        write_project_file(root.path(), "src/main.js", "import './message';\n");
        write_project_file(
            root.path(),
            "src/message.js",
            "export const message = 'a';\n",
        );
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        assert!(
            request(&server, "GET", "/src/main.js")
                .await
                .starts_with("HTTP/1.1 200 OK")
        );
        assert!(has_import_edge(&server, "src/main.js", "src/message.js"));

        let (mut events, _) = open_event_stream(&server).await;
        write_project_file(root.path(), "src/styles.css", "#app { color: red; }\n");
        let received = read_from_stream(&mut events, Duration::from_secs(10))
            .await
            .expect("the save reaches the open stream");
        assert!(received.contains("event: full-reload"), "{received}");

        // The reload channel carries no graph state: the edge recorded by the last request is the
        // edge that is still there, and the following document load is what replaces it.
        assert!(has_import_edge(&server, "src/main.js", "src/message.js"));

        server.close().await.unwrap();
    }

    #[tokio::test]
    async fn a_failure_that_arrived_before_the_close_request_still_ends_the_server() {
        let root = TempDir::new().unwrap();
        write_index(root.path(), "<h1>served</h1>");
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        // The failure is already waiting when the request is made, so it is what happened first
        // and it is what a caller is told about, rather than being lost to the request.
        server.inner.shutdown.register(ShutdownCause::WatchFailure(
            "the watch backend stopped".into(),
        ));
        server.begin_closing();

        let failure = timeout(Duration::from_secs(5), server.wait())
            .await
            .expect("the server finishes shutting down")
            .unwrap_err();
        assert!(
            matches!(&failure, ServerError::Serve(message)
                if message.contains("file watcher failed")
                    && message.contains("the watch backend stopped")),
            "{failure}"
        );
    }

    #[tokio::test]
    async fn a_stream_routed_after_the_shutdown_began_does_not_hold_it_open() {
        let root = TempDir::new().unwrap();
        write_index(root.path(), "<h1>served</h1>");
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        // A connection the server has accepted, carrying a request that is not finished yet.
        let mut pending = TcpStream::connect(server.address()).await.unwrap();
        pending
            .write_all(
                format!(
                    "GET /@rsvite/events HTTP/1.1\r\nHost: {}\r\n",
                    server.address()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        pending.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;

        server.begin_closing();
        tokio::time::sleep(Duration::from_millis(100)).await;
        // The request is only routed now, after the shutdown began. A stream that learned about
        // closing from a one-time message would never hear it and would hold the shutdown open.
        pending.write_all(b"\r\n").await.unwrap();
        pending.flush().await.unwrap();

        timeout(Duration::from_secs(5), server.wait())
            .await
            .expect("the shutdown finishes with a stream routed into it")
            .expect("a requested shutdown succeeds");
    }

    #[tokio::test]
    async fn a_fatal_failure_stops_the_watcher_before_wait_rejects() {
        let root = TempDir::new().unwrap();
        write_index(root.path(), "<h1>served</h1>");
        write_project_file(root.path(), "src/styles.css", "#app { color: red; }\n");
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        server.inner.shutdown.register(ShutdownCause::WatchFailure(
            "the watch backend stopped".into(),
        ));
        let failure = timeout(Duration::from_secs(5), server.wait())
            .await
            .expect("the server finishes shutting down")
            .unwrap_err();
        assert!(
            matches!(&failure, ServerError::Serve(message) if message.contains("file watcher failed")),
            "{failure}"
        );

        // Cleanup happened before that rejection, so nothing is watching a project the server
        // has already given up on.
        let mut reloads = server.inner.state.reloads.subscribe();
        write_project_file(root.path(), "src/styles.css", "#app { color: blue; }\n");
        assert!(
            timeout(Duration::from_secs(2), reloads.recv())
                .await
                .is_err(),
            "a save still reached the server after it failed"
        );
    }

    #[tokio::test]
    async fn a_failure_that_happened_after_the_close_request_does_not_replace_it() {
        let root = TempDir::new().unwrap();
        write_index(root.path(), "<h1>served</h1>");
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        // The request is registered where it happens, so a failure reported afterwards — in the
        // same turn, before anything has been polled — is second and does not become the reason.
        server.begin_closing();
        server.inner.shutdown.register(ShutdownCause::WatchFailure(
            "the watch backend stopped".into(),
        ));

        timeout(Duration::from_secs(5), server.wait())
            .await
            .expect("the server finishes shutting down")
            .expect("the shutdown a caller asked for succeeds");
    }

    #[tokio::test]
    async fn a_listener_that_ends_on_its_own_finishes_the_server() {
        let root = TempDir::new().unwrap();
        write_index(root.path(), "<h1>served</h1>");
        let server = DevServer::start(root.path(), 0, None).await.unwrap();
        let address = server.address();
        let (mut events, _) = open_event_stream(&server).await;

        // Nobody asked to close and the watcher is healthy, but the listener is gone. A server
        // that only waited for those two reasons would report that it is still running.
        server.inner.serving_abort.abort();

        let ended = timeout(Duration::from_secs(5), server.wait())
            .await
            .expect("the server finishes rather than waiting for a reason it will never get");
        // What the listener reported is what a caller is told, rather than a clean close or a
        // reason borrowed from somewhere else.
        let reported = match ended {
            Ok(()) => panic!("a lost listener is not a clean close"),
            Err(ServerError::Serve(message)) => message,
            Err(other) => panic!("unexpected error: {other}"),
        };
        assert!(reported.contains("cancel"), "{reported}");
        assert!(
            matches!(
                &*server.inner.lifecycle.borrow(),
                LifecycleState::Failed(state) if state == &reported
            ),
            "the server still reports that it is running"
        );

        // The same cleanup ran: the stream ended and the address is free again.
        let tail = read_until_end(&mut events, Duration::from_secs(5)).await;
        assert!(!tail.contains("event: full-reload"), "{tail}");
        let rebound = TcpListener::bind(address).await.unwrap();
        drop(rebound);
    }

    #[tokio::test]
    async fn a_close_request_with_a_live_watcher_finishes_cleanly() {
        let root = TempDir::new().unwrap();
        write_index(root.path(), "<h1>served</h1>");
        write_project_file(root.path(), "src/styles.css", "#app { color: red; }\n");
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        // The watcher is stopped by the shutdown itself, so whatever it reports on the way out
        // cannot turn an ordinary close into a failure.
        timeout(Duration::from_secs(5), server.close())
            .await
            .expect("the server finishes shutting down")
            .expect("a requested shutdown succeeds");
    }

    #[tokio::test]
    async fn close_finishes_with_open_event_streams_and_releases_the_port() {
        let root = TempDir::new().unwrap();
        write_index(root.path(), "<h1>served</h1>");
        let server = DevServer::start(root.path(), 0, None).await.unwrap();
        let address = server.address();
        let (mut first, _) = open_event_stream(&server).await;
        let (mut second, _) = open_event_stream(&server).await;

        timeout(Duration::from_secs(5), server.close())
            .await
            .expect("close finishes while streams are open")
            .unwrap();

        for stream in [&mut first, &mut second] {
            let tail = read_until_end(stream, Duration::from_secs(5)).await;
            assert!(!tail.contains("event: full-reload"), "{tail}");
        }
        let rebound = TcpListener::bind(address).await.unwrap();
        drop(rebound);
    }

    #[tokio::test]
    async fn serves_css_and_svg_with_declared_types_and_rereads_them() {
        let root = TempDir::new().unwrap();
        write_project_file(
            root.path(),
            "src/styles.css",
            "#app { background-image: url(\"../assets/mark.svg\"); color: rgb(1, 2, 3); }\n",
        );
        write_project_file(
            root.path(),
            "assets/mark.svg",
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"1\" /></svg>\n",
        );
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        let css = request(&server, "GET", "/src/styles.css").await;
        assert!(css.starts_with("HTTP/1.1 200 OK"), "{css}");
        assert!(
            css.contains("content-type: text/css; charset=utf-8"),
            "{css}"
        );
        assert!(css.contains("cache-control: no-store"), "{css}");
        assert!(css.contains("rgb(1, 2, 3)"), "{css}");

        // The browser resolves the stylesheet's relative URL; this is the request it produces.
        let svg = request(&server, "GET", "/assets/mark.svg").await;
        assert!(svg.starts_with("HTTP/1.1 200 OK"), "{svg}");
        assert!(svg.contains("content-type: image/svg+xml"), "{svg}");
        assert!(svg.contains("cache-control: no-store"), "{svg}");
        assert!(svg.contains("<circle"), "{svg}");

        // Re-read on every request: a full reload after an edit must see the new bytes.
        write_project_file(
            root.path(),
            "src/styles.css",
            "#app { color: rgb(9, 9, 9); }\n",
        );
        write_project_file(
            root.path(),
            "assets/mark.svg",
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"2\" /></svg>\n",
        );
        assert!(
            request(&server, "GET", "/src/styles.css")
                .await
                .contains("rgb(9, 9, 9)")
        );
        assert!(
            request(&server, "GET", "/assets/mark.svg")
                .await
                .contains("<rect")
        );

        server.close().await.unwrap();
    }

    #[tokio::test]
    async fn resolves_percent_encoded_resource_names_including_the_extension() {
        let root = TempDir::new().unwrap();
        write_project_file(root.path(), "src/a b.css", "#app { color: red; }\n");
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        let spaced = request(&server, "GET", "/src/a%20b.css").await;
        assert!(spaced.starts_with("HTTP/1.1 200 OK"), "{spaced}");
        assert!(spaced.contains("color: red"), "{spaced}");

        // The extension may be encoded too: the kind comes from reading the path as text, so
        // this names the same stylesheet.
        let encoded_extension = request(&server, "GET", "/src/a%20b%2Ecss").await;
        assert!(
            encoded_extension.starts_with("HTTP/1.1 200 OK"),
            "{encoded_extension}"
        );
        assert!(
            encoded_extension.contains("content-type: text/css; charset=utf-8"),
            "{encoded_extension}"
        );
        assert!(
            encoded_extension.contains("color: red"),
            "{encoded_extension}"
        );

        server.close().await.unwrap();
    }

    #[tokio::test]
    async fn refuses_malformed_percent_encoding_in_a_resource_request() {
        let root = TempDir::new().unwrap();
        write_project_file(root.path(), "src/styles.css", "#app { color: red; }\n");
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        // A resource request that cannot be decoded is malformed. Reading it leniently would
        // answer it as a request for a file named after the mistake.
        for path in [
            "/src/%ZZ.css",
            "/src/%2.css",
            "/src/%FF.css",
            "/src/%ZZ.svg",
            // The extension that identifies the request may itself be encoded.
            "/src/%ZZ%2Ecss",
            "/src/%FF%2Esvg",
        ] {
            let response = request(&server, "GET", path).await;
            assert!(
                response.starts_with("HTTP/1.1 400"),
                "{path} expected 400, got {response}"
            );
            assert!(
                response.contains("cache-control: no-store"),
                "{path}: {response}"
            );
        }

        // The contract reaches a request that asks for a resource. A path that names no kind
        // this server answers is an empty 404, whatever its encoding does.
        let unrecognised = request(&server, "GET", "/src/styles.css%").await;
        assert!(unrecognised.starts_with("HTTP/1.1 404"), "{unrecognised}");

        // The strictly decoded value is not decoded again: an encoded escape stands for the
        // text it spells rather than becoming a traversal.
        let double = request(&server, "GET", "/src/%252E%252E/outside.css").await;
        assert!(double.starts_with("HTTP/1.1 404"), "{double}");

        server.close().await.unwrap();
    }

    #[tokio::test]
    async fn import_failures_report_module_file_diagnostics() {
        let root = TempDir::new().unwrap();
        write_index(root.path(), "ok");
        write_project_file(root.path(), "src/theme.txt", "not a module\n");
        create_dir_all(root.path().join("src/folder.js")).unwrap();
        std::os::unix::fs::symlink("cycle-b.js", root.path().join("src/cycle-a.js")).unwrap();
        std::os::unix::fs::symlink("cycle-a.js", root.path().join("src/cycle-b.js")).unwrap();
        std::os::unix::fs::symlink(
            root.path().join("src/theme.txt"),
            root.path().join("src/disguised.js"),
        )
        .unwrap();
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        // Canonicalizing a file in the module graph reports module-file diagnostics, whether a
        // request or an import reached the file.
        for (source, status, reason) in [
            (
                "import './cycle-a.js';\n",
                "HTTP/1.1 500",
                "failed to resolve module file:",
            ),
            (
                "import './folder.js';\n",
                "HTTP/1.1 400",
                "resolved module is a directory or non-file",
            ),
            (
                "import './disguised.js';\n",
                "HTTP/1.1 415",
                "resolved module has an unsupported file type: ./disguised.js",
            ),
        ] {
            write_project_file(root.path(), "src/main.js", source);
            let response = request(&server, "GET", "/src/main.js").await;
            assert!(response.starts_with(status), "{source}: {response}");
            assert!(response.contains(reason), "{source}: {response}");
        }

        server.close().await.unwrap();
    }

    #[tokio::test]
    async fn routes_modules_by_raw_suffix_and_answers_other_extensions_with_an_empty_404() {
        let root = TempDir::new().unwrap();
        write_index(
            root.path(),
            "<script type=\"module\" src=\"/src/main.js\"></script>",
        );
        write_project_file(root.path(), "src/main.js", "document.title = \"served\";\n");
        write_project_file(root.path(), "src/theme.txt", "not a stylesheet\n");
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        let module = request(&server, "GET", "/src/main.js").await;
        assert!(module.starts_with("HTTP/1.1 200 OK"), "{module}");

        // A path whose raw suffix is `.js` or `.ts` enters the module route and decodes under
        // the module rules, so an encoded extension does not name a module and a malformed escape
        // names a file that does not exist.
        for path in [
            "/src/main%2Ejs",
            "/src/%ZZ.js",
            "/src/%ZZ.ts",
            "/src/main%2Ets",
        ] {
            let response = request(&server, "GET", path).await;
            assert!(
                response.starts_with("HTTP/1.1 404"),
                "{path} expected 404, got {response}"
            );
            assert!(!response.contains("served"), "{path}: {response}");
        }

        // An extension this server does not answer is an empty 404, encoded or not.
        for path in ["/src/theme.txt", "/src/%ZZ.txt", "/src/theme%2Etxt"] {
            let response = request(&server, "GET", path).await;
            assert!(
                response.starts_with("HTTP/1.1 404"),
                "{path} expected 404, got {response}"
            );
            assert!(!response.contains("not a stylesheet"), "{path}: {response}");
        }

        server.close().await.unwrap();
    }

    #[tokio::test]
    async fn an_unresolvable_stylesheet_fails_without_disclosing_the_host() {
        let root = TempDir::new().unwrap();
        write_project_file(root.path(), "src/styles.css", "#app { color: red; }\n");
        // A symlink cycle inside the project resolves to an error that is not "no such file",
        // which is the internal-failure branch, on every run.
        std::os::unix::fs::symlink("cycle-b.css", root.path().join("src/cycle-a.css")).unwrap();
        std::os::unix::fs::symlink("cycle-a.css", root.path().join("src/cycle-b.css")).unwrap();
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        let response = request(&server, "GET", "/src/cycle-a.css").await;
        assert!(response.starts_with("HTTP/1.1 500"), "{response}");
        assert!(response.contains("cache-control: no-store"), "{response}");
        assert!(
            response.contains("content-type: text/plain; charset=utf-8"),
            "{response}"
        );
        // The refusal names neither the project root nor the stylesheet's own bytes.
        assert!(
            !response.contains(root.path().to_str().unwrap()),
            "{response}"
        );
        assert!(!response.contains("color: red"), "{response}");

        server.close().await.unwrap();
    }

    #[tokio::test]
    async fn refuses_every_resource_request_the_project_does_not_own() {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        write_project_file(root.path(), "src/styles.css", "#app { color: red; }\n");
        write_project_file(root.path(), "src/theme.txt", "not a stylesheet\n");
        create_dir_all(root.path().join("src/folder.css")).unwrap();
        write(
            outside.path().join("outside.css"),
            "#app { color: blue; }\n",
        )
        .unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("outside.css"),
            root.path().join("src/linked.css"),
        )
        .unwrap();
        // In-root, and the request's own extension, but the file it truly is has another one.
        std::os::unix::fs::symlink(
            root.path().join("src/theme.txt"),
            root.path().join("src/disguised.css"),
        )
        .unwrap();
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        for (path, expected) in [
            ("/src/../outside.css", "HTTP/1.1 400"),
            ("/src/./styles.css", "HTTP/1.1 400"),
            ("/src\\styles.css", "HTTP/1.1 400"),
            ("/src/%00.css", "HTTP/1.1 400"),
            ("/src/folder.css", "HTTP/1.1 400"),
            ("/src/linked.css", "HTTP/1.1 403"),
            ("/src/missing.css", "HTTP/1.1 404"),
            ("/assets/missing.svg", "HTTP/1.1 404"),
            // Not an accepted extension: a 404, never raw file serving.
            ("/src/theme.txt", "HTTP/1.1 404"),
            ("/src/disguised.css", "HTTP/1.1 415"),
        ] {
            let response = request(&server, "GET", path).await;
            assert!(
                response.starts_with(expected),
                "{path} expected {expected}, got {response}"
            );
        }

        // The unaccepted extension really is unavailable rather than served as bytes.
        let unaccepted = request(&server, "GET", "/src/theme.txt").await;
        assert!(!unaccepted.contains("not a stylesheet"), "{unaccepted}");

        server.close().await.unwrap();
    }

    #[tokio::test]
    async fn rewrites_local_imports_rereads_modules_and_retains_graph_edges() {
        let root = TempDir::new().unwrap();
        write_index(
            root.path(),
            "<script type=\"module\" src=\"/src/main.js\"></script>",
        );
        write_project_file(
            root.path(),
            "src/main.js",
            "const example = \"import './not-a-dependency'\";\n/* import './also-not-a-dependency' */\nimport { message } from './message';\nimport { suffix } from \"/src/suffix\";\ndocument.body.textContent = message + suffix + example.slice(0, 0);\n",
        );
        write_project_file(
            root.path(),
            "src/message.js",
            "export const message = 'first';\n",
        );
        write_project_file(root.path(), "src/suffix.js", "export const suffix = '!';\n");
        write_project_file(root.path(), "src/next.js", "export const next = 'next';\n");
        write_project_file(
            root.path(),
            "src/nested/main.js",
            "import { message } from '../message';\nvoid message;\n",
        );
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        let main = request(&server, "GET", "/src/main.js").await;
        assert!(main.starts_with("HTTP/1.1 200 OK"), "{main}");
        assert!(
            main.contains("content-type: text/javascript; charset=utf-8"),
            "{main}"
        );
        assert!(main.contains("cache-control: no-store"), "{main}");
        assert!(response_body(&main).contains("from \"/src/message.js\""));
        assert!(response_body(&main).contains("from \"/src/suffix.js\""));
        assert!(has_import_edge(&server, "src/main.js", "src/message.js"));
        assert!(has_import_edge(&server, "src/main.js", "src/suffix.js"));

        let nested = request(&server, "GET", "/src/nested/main.js").await;
        assert!(response_body(&nested).contains("from \"/src/message.js\""));
        assert!(has_import_edge(
            &server,
            "src/nested/main.js",
            "src/message.js"
        ));

        let first = request(&server, "GET", "/src/message.js").await;
        assert!(response_body(&first).contains("'first'"));
        write_project_file(
            root.path(),
            "src/message.js",
            "export const message = 'second';\n",
        );
        let second = request(&server, "GET", "/src/message.js").await;
        assert!(response_body(&second).contains("'second'"));

        write_project_file(
            root.path(),
            "src/main.js",
            "import { next } from './next';\ndocument.body.textContent = next;\n",
        );
        let updated = request(&server, "GET", "/src/main.js").await;
        assert!(response_body(&updated).contains("from \"/src/next.js\""));
        assert!(has_import_edge(&server, "src/main.js", "src/next.js"));
        assert!(!has_import_edge(&server, "src/main.js", "src/message.js"));
        assert!(!has_import_edge(&server, "src/main.js", "src/suffix.js"));

        server.close().await.unwrap();
    }

    #[tokio::test]
    async fn transforms_typescript_resolves_extensions_and_replaces_graph_edges() {
        let root = TempDir::new().unwrap();
        write_index(
            root.path(),
            "<script type=\"module\" src=\"/src/main.ts\"></script>",
        );
        write_project_file(
            root.path(),
            "src/main.ts",
            "import { preferred } from './choice';\nimport { selected } from './choice.ts';\nimport { typed } from './typed';\nconst value: string = preferred + selected + typed;\ndocument.body.textContent = value;\n",
        );
        write_project_file(
            root.path(),
            "src/choice.js",
            "export const preferred = 'js';\n",
        );
        write_project_file(
            root.path(),
            "src/choice.ts",
            "export const selected: string = 'explicit-ts';\n",
        );
        write_project_file(
            root.path(),
            "src/typed.ts",
            "export const typed: string = 'extensionless-ts';\n",
        );
        write_project_file(
            root.path(),
            "src/next.ts",
            "export const next: string = 'next';\n",
        );
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        let main = request(&server, "GET", "/src/main.ts").await;
        assert!(main.starts_with("HTTP/1.1 200 OK"), "{main}");
        assert!(
            main.contains("content-type: text/javascript; charset=utf-8"),
            "{main}"
        );
        assert!(main.contains("cache-control: no-store"), "{main}");
        assert!(response_body(&main).contains("from \"/src/choice.js\""));
        assert!(response_body(&main).contains("from \"/src/choice.ts\""));
        assert!(response_body(&main).contains("from \"/src/typed.ts\""));
        assert!(!response_body(&main).contains(": string"));
        assert!(has_import_edge(&server, "src/main.ts", "src/choice.js"));
        assert!(has_import_edge(&server, "src/main.ts", "src/choice.ts"));
        assert!(has_import_edge(&server, "src/main.ts", "src/typed.ts"));

        let dependency = request(&server, "GET", "/src/typed.ts").await;
        assert!(dependency.starts_with("HTTP/1.1 200 OK"), "{dependency}");
        assert!(!response_body(&dependency).contains(": string"));

        write_project_file(
            root.path(),
            "src/main.ts",
            "import { next } from './next.ts';\nconst value: string = next;\nvoid value;\n",
        );
        let updated = request(&server, "GET", "/src/main.ts").await;
        assert!(updated.starts_with("HTTP/1.1 200 OK"), "{updated}");
        assert!(response_body(&updated).contains("from \"/src/next.ts\""));
        assert!(has_import_edge(&server, "src/main.ts", "src/next.ts"));
        assert!(!has_import_edge(&server, "src/main.ts", "src/choice.js"));
        assert!(!has_import_edge(&server, "src/main.ts", "src/choice.ts"));
        assert!(!has_import_edge(&server, "src/main.ts", "src/typed.ts"));

        server.close().await.unwrap();
    }

    #[tokio::test]
    async fn typescript_failures_preserve_the_last_successful_graph_edges() {
        let root = TempDir::new().unwrap();
        write_index(root.path(), "ok");
        write_project_file(
            root.path(),
            "src/main.ts",
            "import { previous } from './previous';\nconst value: string = previous;\nvoid value;\n",
        );
        write_project_file(
            root.path(),
            "src/previous.ts",
            "export const previous: string = 'previous';\n",
        );
        write_project_file(
            root.path(),
            "src/next.ts",
            "export const next: string = 'next';\n",
        );
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        let successful = request(&server, "GET", "/src/main.ts").await;
        assert!(successful.starts_with("HTTP/1.1 200 OK"), "{successful}");
        assert!(has_import_edge(&server, "src/main.ts", "src/previous.ts"));

        write_project_file(
            root.path(),
            "src/main.ts",
            "import { next } from './next';\nconst broken: = next;\n",
        );
        let parser_failure = request(&server, "GET", "/src/main.ts").await;
        assert!(
            parser_failure.starts_with("HTTP/1.1 400"),
            "{parser_failure}"
        );
        assert!(
            parser_failure.contains("parser diagnostic"),
            "{parser_failure}"
        );
        assert!(has_import_edge(&server, "src/main.ts", "src/previous.ts"));
        assert!(!has_import_edge(&server, "src/main.ts", "src/next.ts"));

        write_project_file(
            root.path(),
            "src/main.ts",
            "import { next } from './next';\nconst target: Element | null = document.querySelector<Element>('body');\nif (target !== null) target.textContent = next;\n",
        );
        let transform_failure = request(&server, "GET", "/src/main.ts").await;
        assert!(
            transform_failure.starts_with("HTTP/1.1 400"),
            "{transform_failure}"
        );
        assert!(
            transform_failure.contains("unsupported TypeScript syntax"),
            "{transform_failure}"
        );
        assert!(has_import_edge(&server, "src/main.ts", "src/previous.ts"));
        assert!(!has_import_edge(&server, "src/main.ts", "src/next.ts"));

        for member in [
            "public value = next;",
            "private value = next;",
            "protected value = next;",
            "readonly value = next;",
            "override value = next;",
            "public static readonly value = next;",
            "public method() { return next; }",
            "protected get value() { return next; }",
            "private set value(input) { void input; }",
            "constructor(public value = next) {}",
        ] {
            let source = format!(
                "import {{ next }} from './next';\nclass Unsupported {{ {member} }}\nconst value: string = next;\nvoid value;\n"
            );
            write_project_file(root.path(), "src/main.ts", &source);
            let class_modifier_failure = request(&server, "GET", "/src/main.ts").await;
            assert!(
                class_modifier_failure.starts_with("HTTP/1.1 400"),
                "member={member:?}\n{class_modifier_failure}"
            );
            assert!(
                class_modifier_failure.contains("unsupported TypeScript syntax"),
                "member={member:?}\n{class_modifier_failure}"
            );
            assert!(has_import_edge(&server, "src/main.ts", "src/previous.ts"));
            assert!(!has_import_edge(&server, "src/main.ts", "src/next.ts"));
        }

        server.close().await.unwrap();
    }

    #[tokio::test]
    async fn rejects_unsupported_or_escaping_module_requests_without_a_fallback() {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        write_index(root.path(), "ok");
        write_project_file(root.path(), "src/style.css", "body {}\n");
        create_dir_all(root.path().join("src/directory")).unwrap();
        for extension in ["js", "ts"] {
            write(
                outside.path().join(format!("outside.{extension}")),
                "export const outside = true;\n",
            )
            .unwrap();
            #[cfg(unix)]
            std::os::unix::fs::symlink(
                outside.path().join(format!("outside.{extension}")),
                root.path().join(format!("src/escape.{extension}")),
            )
            .unwrap();
        }
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        for extension in ["js", "ts"] {
            let main_file = format!("src/main.{extension}");
            let main_request = format!("/src/main.{extension}");
            for (source, status, marker) in [
                (
                    "import 'a-package';\n",
                    "HTTP/1.1 400",
                    "bare import \"a-package\" is not supported",
                ),
                (
                    "import 'https://example.com/module.js';\n",
                    "HTTP/1.1 400",
                    "URL import \"https://example.com/module.js\" is not supported",
                ),
                (
                    "import '../../outside';\n",
                    "HTTP/1.1 403",
                    "traverses outside the project root",
                ),
                (
                    "import './directory';\n",
                    "HTTP/1.1 400",
                    "directory import \"./directory\" is not supported",
                ),
                (
                    "import './style.css';\n",
                    "HTTP/1.1 415",
                    "unsupported import file type \"./style.css\"",
                ),
                (
                    "import './message?raw';\n",
                    "HTTP/1.1 400",
                    "import queries and fragments are not supported",
                ),
                (
                    "import './missing';\n",
                    "HTTP/1.1 404",
                    "import \"./missing\" was not found",
                ),
                (
                    "void import('./message.js');\n",
                    "HTTP/1.1 400",
                    "dynamic imports are not supported",
                ),
                ("import {\n", "HTTP/1.1 400", "cannot analyze module"),
            ] {
                write_project_file(root.path(), &main_file, source);
                let response = request(&server, "GET", &main_request).await;
                assert!(response.starts_with(status), "{response}");
                assert!(response.contains(marker), "{response}");
            }

            #[cfg(unix)]
            {
                write_project_file(
                    root.path(),
                    &main_file,
                    &format!("import './escape.{extension}';\n"),
                );
                let imported_escape = request(&server, "GET", &main_request).await;
                assert!(
                    imported_escape.starts_with("HTTP/1.1 403"),
                    "{imported_escape}"
                );
                assert!(
                    imported_escape.contains("escapes the project root"),
                    "{imported_escape}"
                );

                let requested_escape =
                    request(&server, "GET", &format!("/src/escape.{extension}")).await;
                assert!(
                    requested_escape.starts_with("HTTP/1.1 403"),
                    "{requested_escape}"
                );
                assert!(
                    requested_escape.contains("request escapes the project root"),
                    "{requested_escape}"
                );
            }

            let traversal = request(&server, "GET", &format!("/src/%2e%2e/main.{extension}")).await;
            assert!(traversal.starts_with("HTTP/1.1 400"), "{traversal}");
            assert!(
                traversal.contains("traversing module request path"),
                "{traversal}"
            );

            let missing = request(&server, "GET", &format!("/src/missing.{extension}")).await;
            assert!(missing.starts_with("HTTP/1.1 404"), "{missing}");
            assert!(missing.contains("module not found"), "{missing}");
        }

        server.close().await.unwrap();
    }

    #[tokio::test]
    async fn returns_declared_http_failures() {
        let root = TempDir::new().unwrap();
        let server = DevServer::start(root.path(), 0, None).await.unwrap();

        assert!(
            request(&server, "GET", "/")
                .await
                .starts_with("HTTP/1.1 404")
        );
        assert!(
            request(&server, "GET", "/missing")
                .await
                .starts_with("HTTP/1.1 404")
        );
        for method in ["HEAD", "POST"] {
            let response = request(&server, method, "/").await;
            assert!(response.starts_with("HTTP/1.1 405"), "{response}");
            assert!(response.contains("allow: GET\r\n"), "{response}");
            assert!(!response.contains("allow: GET,HEAD"), "{response}");
        }

        std::fs::create_dir(root.path().join("index.html")).unwrap();
        assert!(
            request(&server, "GET", "/")
                .await
                .starts_with("HTTP/1.1 500")
        );

        server.close().await.unwrap();
    }

    #[tokio::test]
    async fn rejects_a_missing_root_and_a_busy_port() {
        let root = TempDir::new().unwrap();
        let missing = root.path().join("missing");
        assert!(matches!(
            DevServer::start(&missing, 0, None).await,
            Err(ServerError::ResolveRoot { .. })
        ));

        let occupied = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = occupied.local_addr().unwrap().port();
        assert!(matches!(
            DevServer::start(root.path(), port, None).await,
            Err(ServerError::Bind { .. })
        ));
    }

    /// The handle is the only way to ask this server to stop, so a caller that lets go of it
    /// without closing has left a listener, a watcher and their tasks that nothing can reach. That
    /// is what happens when a JavaScript wrapper is collected, and it has to end the server.
    #[tokio::test]
    async fn dropping_the_last_handle_closes_the_server_and_releases_the_port() {
        let root = TempDir::new().unwrap();
        write_index(root.path(), "<h1>served</h1>");
        let server = DevServer::start(root.path(), 0, None).await.unwrap();
        let address = server.address();
        assert!(request(&server, "GET", "/").await.contains("200 OK"));

        // Nobody asked it to stop; there is simply nobody left who could.
        drop(server);

        let rebound = timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(listener) = TcpListener::bind(address).await {
                    return listener;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the address is free again once the last handle is gone");
        drop(rebound);
    }

    #[tokio::test]
    async fn close_waits_for_shutdown_and_releases_the_port() {
        let root = TempDir::new().unwrap();
        write_index(root.path(), "ok");
        let server = DevServer::start(root.path(), 0, None).await.unwrap();
        let address = server.address();

        timeout(Duration::from_secs(2), server.close())
            .await
            .unwrap()
            .unwrap();
        server.wait().await.unwrap();
        let rebound = TcpListener::bind(address).await.unwrap();
        drop(rebound);
    }

    #[tokio::test]
    async fn close_preserves_a_failure_reported_by_the_server_task() {
        let (_lifecycle_sender, lifecycle) =
            watch::channel(LifecycleState::Failed("serve failed".into()));
        let server = DevServer {
            inner: Inner {
                address: SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
                lifecycle,
                shutdown: Arc::new(ShutdownSlot::default()),
                serving_abort: tokio::spawn(std::future::pending::<()>()).abort_handle(),
                state: empty_state(),
            },
        };

        let error = timeout(Duration::from_secs(2), server.close())
            .await
            .unwrap()
            .unwrap_err();
        assert!(matches!(error, ServerError::Serve(message) if message == "serve failed"));
    }

    #[tokio::test]
    async fn wait_rejects_if_the_server_task_stops_without_a_final_state() {
        let (lifecycle_sender, lifecycle) = watch::channel(LifecycleState::Running);
        drop(lifecycle_sender);
        let server = DevServer {
            inner: Inner {
                address: SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
                lifecycle,
                shutdown: Arc::new(ShutdownSlot::default()),
                serving_abort: tokio::spawn(std::future::pending::<()>()).abort_handle(),
                state: empty_state(),
            },
        };

        let error = timeout(Duration::from_secs(2), server.wait())
            .await
            .unwrap()
            .unwrap_err();
        assert!(matches!(error, ServerError::CompletionChannelClosed));
    }
}
