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

use javascript::{ModuleErrorKind, load as load_javascript};
use module_graph::ModuleGraph;

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
    if uri.path().ends_with(".js") {
        return serve_javascript(&state, uri.path()).await;
    }
    response(StatusCode::NOT_FOUND, None, Body::empty())
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
            let status = match error.kind() {
                ModuleErrorKind::BadRequest => StatusCode::BAD_REQUEST,
                ModuleErrorKind::Forbidden => StatusCode::FORBIDDEN,
                ModuleErrorKind::NotFound => StatusCode::NOT_FOUND,
                ModuleErrorKind::UnsupportedMediaType => StatusCode::UNSUPPORTED_MEDIA_TYPE,
                ModuleErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
            };
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
    async fn rejects_unsupported_or_escaping_javascript_requests_without_a_fallback() {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        write_index(root.path(), "ok");
        write_project_file(root.path(), "src/main.js", "export {};\n");
        write_project_file(root.path(), "src/style.css", "body {}\n");
        create_dir_all(root.path().join("src/directory")).unwrap();
        write(
            outside.path().join("outside.js"),
            "export const outside = true;\n",
        )
        .unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            outside.path().join("outside.js"),
            root.path().join("src/escape.js"),
        )
        .unwrap();
        let server = DevServer::start(root.path(), 0).await.unwrap();

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
                "import './missing';\n",
                "HTTP/1.1 404",
                "import \"./missing\" was not found",
            ),
            (
                "void import('./message.js');\n",
                "HTTP/1.1 400",
                "dynamic imports are not supported",
            ),
            (
                "import {\n",
                "HTTP/1.1 400",
                "cannot analyze JavaScript module /src/main.js",
            ),
        ] {
            write_project_file(root.path(), "src/main.js", source);
            let response = request(&server, "GET", "/src/main.js").await;
            assert!(response.starts_with(status), "{response}");
            assert!(response.contains(marker), "{response}");
        }

        #[cfg(unix)]
        {
            write_project_file(root.path(), "src/main.js", "import './escape.js';\n");
            let imported_escape = request(&server, "GET", "/src/main.js").await;
            assert!(
                imported_escape.starts_with("HTTP/1.1 403"),
                "{imported_escape}"
            );
            assert!(
                imported_escape.contains("escapes the project root"),
                "{imported_escape}"
            );

            let requested_escape = request(&server, "GET", "/src/escape.js").await;
            assert!(
                requested_escape.starts_with("HTTP/1.1 403"),
                "{requested_escape}"
            );
            assert!(
                requested_escape.contains("request escapes the project root"),
                "{requested_escape}"
            );
        }

        let traversal = request(&server, "GET", "/src/%2e%2e/main.js").await;
        assert!(traversal.starts_with("HTTP/1.1 400"), "{traversal}");
        assert!(
            traversal.contains("traversing JavaScript request path"),
            "{traversal}"
        );

        let missing = request(&server, "GET", "/src/missing.js").await;
        assert!(missing.starts_with("HTTP/1.1 404"), "{missing}");
        assert!(missing.contains("JavaScript module not found"), "{missing}");

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
