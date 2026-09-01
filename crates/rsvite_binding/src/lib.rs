use std::{future::Future, pin::Pin, sync::Arc};

use napi::{Error, Result, Status, threadsafe_function::ThreadsafeFunction};
use napi_derive::napi;
use rsvite_core::{DevServer as CoreDevServer, TransformIndexHtml};

#[napi(object, object_to_js = false)]
pub struct StartOptions {
    pub root: String,
    pub port: u16,
    /// The one HTML transformation this project declared, already checked and wrapped by the
    /// caller. Only the document text crosses here: no plugin object, configuration value or path
    /// context reaches Rust.
    /// `CalleeHandled` is off because the document is the only argument this call carries; a
    /// failure comes back as the exception the caller's dispatcher threw, not as an argument.
    pub transform_index_html: Option<ThreadsafeFunction<String, String, String, Status, false>>,
}

#[napi]
pub struct DevServer {
    inner: CoreDevServer,
}

#[napi]
impl DevServer {
    #[napi(factory)]
    pub async fn start(options: StartOptions) -> Result<Self> {
        let inner = CoreDevServer::start(
            options.root,
            options.port,
            options.transform_index_html.map(into_transform),
        )
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

/// Turns the caller's transformation into the one call this server makes.
///
/// The document goes in as text and its replacement comes back as text; nothing else crosses.
/// The server owns what this returns and lets go of it when it stops, which is what lets the
/// caller's own handle be collected: nothing here reaches back to that handle, so holding the
/// transformation cannot keep the object that started the server alive.
///
/// A failure arrives as the text the caller's code produced for it. That text is already written
/// for a reader — it names the plugin and says what happened — so it is passed on rather than
/// described again from this side.
fn into_transform(
    callback: ThreadsafeFunction<String, String, String, Status, false>,
) -> TransformIndexHtml {
    let callback = Arc::new(callback);
    Box::new(move |html: String| {
        let callback = Arc::clone(&callback);
        Box::pin(async move {
            // The caught call is what keeps one request's failure to one request: the ordinary
            // call routes a thrown exception through a fatal handler, which would end the whole
            // process rather than the response being written.
            callback
                .call_async_catch(html)
                .await
                .map_err(|error| error.reason.clone())
        }) as Pin<Box<dyn Future<Output = std::result::Result<String, String>> + Send>>
    })
}

fn to_napi_error(error: rsvite_core::ServerError) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
}
