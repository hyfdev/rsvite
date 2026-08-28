use std::{
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use axum::{
    Router,
    body::Body,
    extract::State,
    http::{HeaderValue, Method, StatusCode, Uri, header},
    response::Response,
    routing::any,
};
use thiserror::Error;
use tokio::{
    net::TcpListener,
    sync::{oneshot, watch},
};

mod javascript;
mod module_graph;
mod project_file;
mod resource;

use javascript::load as load_javascript;
use module_graph::ModuleGraph;
use project_file::{ProjectFileError, ProjectFileErrorKind};
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
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
    lifecycle: watch::Receiver<LifecycleState>,
    #[cfg(test)]
    state: Arc<ServerState>,
}

struct ServerState {
    root: PathBuf,
    module_graph: Mutex<ModuleGraph>,
}

impl ServerState {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            module_graph: Mutex::new(ModuleGraph::default()),
        }
    }
}

pub struct DevServer {
    inner: Inner,
}

impl DevServer {
    pub async fn start(root: impl AsRef<Path>, port: u16) -> Result<Self, ServerError> {
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
        let state = Arc::new(ServerState::new(canonical_root));
        // Axum's GET router also accepts HEAD, so the handler enforces the narrower contract.
        let router = Router::new()
            .route("/", any(serve_request))
            .route("/{*path}", any(serve_request))
            .with_state(Arc::clone(&state));

        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let (task_lifecycle, lifecycle) = watch::channel(LifecycleState::Running);
        tokio::spawn(async move {
            let shutdown_lifecycle = task_lifecycle.clone();
            let result = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                    shutdown_lifecycle.send_replace(LifecycleState::Closing);
                })
                .await;
            let final_state = match result {
                Ok(()) => LifecycleState::Closed,
                Err(error) => LifecycleState::Failed(error.to_string()),
            };
            task_lifecycle.send_replace(final_state);
        });

        Ok(Self {
            inner: Inner {
                address,
                shutdown: Mutex::new(Some(shutdown_tx)),
                lifecycle,
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
        let shutdown = {
            let mut shutdown = self.inner.shutdown.lock().expect("shutdown mutex poisoned");
            shutdown.take()
        };
        if let Some(shutdown) = shutdown {
            let _ = shutdown.send(());
        }
        self.wait().await
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

    if uri.path() == "/" {
        return serve_root_html(&state.root).await;
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

async fn serve_root_html(root: &Path) -> Response<Body> {
    match tokio::fs::read(root.join("index.html")).await {
        Ok(html) => response(
            StatusCode::OK,
            Some("text/html; charset=utf-8"),
            Body::from(html),
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            response(StatusCode::NOT_FOUND, None, Body::empty())
        }
        Err(_) => response(StatusCode::INTERNAL_SERVER_ERROR, None, Body::empty()),
    }
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
        fs::{create_dir_all, write},
        net::{Ipv4Addr, SocketAddr},
        path::{Path, PathBuf},
        sync::{Arc, Mutex},
        time::Duration,
    };

    use tempfile::TempDir;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        sync::{oneshot, watch},
        time::timeout,
    };

    use super::{DevServer, Inner, LifecycleState, ServerError, ServerState};

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
        Arc::new(ServerState::new(PathBuf::new()))
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
        let server = DevServer::start(root.path(), 0).await.unwrap();

        let first = request(&server, "GET", "/").await;
        assert!(first.starts_with("HTTP/1.1 200 OK"));
        assert!(first.contains("content-type: text/html; charset=utf-8"));
        assert!(first.ends_with("<h1>first</h1>"));

        write_index(root.path(), "<h1>second</h1>");
        let second = request(&server, "GET", "/").await;
        assert!(second.ends_with("<h1>second</h1>"));

        server.close().await.unwrap();
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
        let server = DevServer::start(root.path(), 0).await.unwrap();

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
        let server = DevServer::start(root.path(), 0).await.unwrap();

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
        let server = DevServer::start(root.path(), 0).await.unwrap();

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
        let server = DevServer::start(root.path(), 0).await.unwrap();

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
        let server = DevServer::start(root.path(), 0).await.unwrap();

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
        let server = DevServer::start(root.path(), 0).await.unwrap();

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
        let server = DevServer::start(root.path(), 0).await.unwrap();

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
        let server = DevServer::start(root.path(), 0).await.unwrap();

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
        let server = DevServer::start(root.path(), 0).await.unwrap();

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
        let server = DevServer::start(root.path(), 0).await.unwrap();

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
        let server = DevServer::start(root.path(), 0).await.unwrap();

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
        let server = DevServer::start(root.path(), 0).await.unwrap();

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
            DevServer::start(&missing, 0).await,
            Err(ServerError::ResolveRoot { .. })
        ));

        let occupied = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = occupied.local_addr().unwrap().port();
        assert!(matches!(
            DevServer::start(root.path(), port).await,
            Err(ServerError::Bind { .. })
        ));
    }

    #[tokio::test]
    async fn close_waits_for_shutdown_and_releases_the_port() {
        let root = TempDir::new().unwrap();
        write_index(root.path(), "ok");
        let server = DevServer::start(root.path(), 0).await.unwrap();
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
        let (shutdown, _shutdown_receiver) = oneshot::channel();
        let (_lifecycle_sender, lifecycle) =
            watch::channel(LifecycleState::Failed("serve failed".into()));
        let server = DevServer {
            inner: Inner {
                address: SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
                shutdown: Mutex::new(Some(shutdown)),
                lifecycle,
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
        let (shutdown, _shutdown_receiver) = oneshot::channel();
        let (lifecycle_sender, lifecycle) = watch::channel(LifecycleState::Running);
        drop(lifecycle_sender);
        let server = DevServer {
            inner: Inner {
                address: SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
                shutdown: Mutex::new(Some(shutdown)),
                lifecycle,
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
