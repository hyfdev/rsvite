use napi::{Error, Result, Status};
use napi_derive::napi;
use rsvite_core::DevServer as CoreDevServer;

#[napi(object)]
pub struct StartOptions {
    pub root: String,
    pub port: u16,
}

#[napi]
pub struct DevServer {
    inner: CoreDevServer,
}

#[napi]
impl DevServer {
    #[napi(factory)]
    pub async fn start(options: StartOptions) -> Result<Self> {
        let inner = CoreDevServer::start(options.root, options.port)
            .await
            .map_err(to_napi_error)?;
        Ok(Self { inner })
    }

    #[napi(getter)]
    pub fn address(&self) -> String {
        self.inner.address().to_string()
    }

    #[napi]
    pub async fn wait(&self) -> Result<()> {
        self.inner.wait().await.map_err(to_napi_error)
    }

    #[napi]
    pub async fn close(&self) -> Result<()> {
        self.inner.close().await.map_err(to_napi_error)
    }
}

fn to_napi_error(error: rsvite_core::ServerError) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
}
