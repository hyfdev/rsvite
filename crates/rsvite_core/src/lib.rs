use std::{
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use axum::{
    Router,
    body::Body,
    extract::State,
    http::{HeaderValue, Method, StatusCode, header},
    response::Response,
    routing::any,
};
use thiserror::Error;
use tokio::{
    net::TcpListener,
    sync::{oneshot, watch},
};

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
        let root = Arc::new(canonical_root);
        // Axum's GET router also accepts HEAD, so the handler enforces the narrower contract.
        let router = Router::new()
            .route("/", any(serve_root_request))
            .with_state(Arc::clone(&root));

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

async fn serve_root_request(method: Method, State(root): State<Arc<PathBuf>>) -> Response<Body> {
    if method != Method::GET {
        let mut response = response(StatusCode::METHOD_NOT_ALLOWED, None, Body::empty());
        response
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET"));
        return response;
    }

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
        net::{Ipv4Addr, SocketAddr},
        path::Path,
        sync::Mutex,
        time::Duration,
    };

    use tempfile::TempDir;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        sync::{oneshot, watch},
        time::timeout,
    };

    use super::{DevServer, Inner, LifecycleState, ServerError};

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
        std::fs::write(root.join("index.html"), body).unwrap();
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
            },
        };

        let error = timeout(Duration::from_secs(2), server.wait())
            .await
            .unwrap()
            .unwrap_err();
        assert!(matches!(error, ServerError::CompletionChannelClosed));
    }
}
