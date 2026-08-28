//! Stylesheets and the assets they name, served as the project wrote them.
//!
//! Nothing here parses or rewrites: the browser resolves a stylesheet's own relative URLs, and
//! this server answers each of those requests with the file's current bytes. Reading on every
//! request is what makes an edit visible to the next full reload without restarting.

use std::path::Path;

use percent_encoding::percent_decode_str;

use crate::project_file::{
    ProjectFileError, ProjectFileErrorKind, decode_path_strictly, resolve_decoded_request_file,
};

/// A resource kind this server answers directly.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ResourceKind {
    pub(crate) extension: &'static str,
    pub(crate) content_type: &'static str,
    pub(crate) subject: &'static str,
}

const RESOURCE_KINDS: &[ResourceKind] = &[
    ResourceKind {
        extension: "css",
        content_type: "text/css; charset=utf-8",
        subject: "stylesheet",
    },
    ResourceKind {
        extension: "svg",
        content_type: "image/svg+xml",
        subject: "asset",
    },
];

/// The kind a request path asks for, or nothing if this server does not answer that extension.
///
/// The path is read as text: percent escapes stand for the characters they encode, and bytes that
/// are not valid UTF-8 stand for the replacement character. So `/src/styles%2Ecss` and
/// `/src/%ZZ%2Ecss` both name a stylesheet, and whether either can be served is decided after
/// this by the decoding contract. This reading names a kind and nothing else: it never reaches the
/// resolver or the filesystem, and the loader decodes the request itself. Classifying first is what lets a malformed stylesheet request be
/// refused as a malformed stylesheet request. Deciding from the request rather than from the file
/// is what makes an unaccepted extension a 404 rather than a general static-file fallback.
pub(crate) fn resource_kind_for(request_path: &str) -> Option<ResourceKind> {
    let text = percent_decode_str(request_path).decode_utf8_lossy();
    RESOURCE_KINDS
        .iter()
        .copied()
        .find(|kind| text.ends_with(&format!(".{}", kind.extension)))
}

/// The requested resource's bytes, re-read now.
///
/// This decoding of `request_path` is the only one that reaches the resolver and the filesystem;
/// the classification above chooses the kind from a textual reading of the same path and goes no
/// further. Here a `%` that does not introduce two hexadecimal digits, or an escape that decodes
/// to invalid UTF-8, makes the request malformed. A request for one kind may only be answered by that kind, so a
/// link or a differently-typed target cannot substitute for what was asked for.
pub(crate) async fn load_resource(
    root: &Path,
    request_path: &str,
    kind: ResourceKind,
) -> Result<Vec<u8>, ProjectFileError> {
    let decoded = decode_path_strictly(request_path, "request path")?;
    let path = resolve_decoded_request_file(
        root,
        &decoded,
        request_path,
        &[kind.extension],
        kind.subject,
    )
    .await?;
    tokio::fs::read(&path).await.map_err(|error| {
        ProjectFileError::new(
            ProjectFileErrorKind::Internal,
            format!("failed to read {request_path}: {error}"),
        )
    })
}
