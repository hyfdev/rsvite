//! Turning a request path into a file this project owns.
//!
//! Every served resource answers the same questions in the same order, so the answers live here
//! rather than once per resource type: what the percent-encoded path decodes to, whether it names
//! a segment this server will follow, whether the file it canonically resolves to is still inside
//! the project root, and whether that file is one of the kinds this request accepts. A resource
//! type adds what is specific to it — a content type, a transform — and inherits this table.

use std::{
    fmt,
    path::{Path, PathBuf},
};

use percent_encoding::percent_decode_str;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProjectFileErrorKind {
    BadRequest,
    Forbidden,
    NotFound,
    UnsupportedMediaType,
    Internal,
}

#[derive(Debug)]
pub(crate) struct ProjectFileError {
    kind: ProjectFileErrorKind,
    message: String,
}

impl ProjectFileError {
    pub(crate) fn new(kind: ProjectFileErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub(crate) fn kind(&self) -> ProjectFileErrorKind {
        self.kind
    }
}

impl fmt::Display for ProjectFileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

pub(crate) fn decode_path(path: &str, label: &str) -> Result<String, ProjectFileError> {
    percent_decode_str(path)
        .decode_utf8()
        .map(|decoded| decoded.into_owned())
        .map_err(|_| {
            ProjectFileError::new(
                ProjectFileErrorKind::BadRequest,
                format!("{label} is not valid UTF-8: {path:?}"),
            )
        })
}

/// Percent-decoding for requests whose contract refuses what it cannot decode.
///
/// `percent_decode_str` leaves a malformed escape as literal text, which reads a request the
/// client got wrong as a request for a file named after the mistake. Under this contract every
/// `%` introduces two hexadecimal digits, so `%ZZ` and a truncated `%2` are malformed requests.
/// Resource requests decode this way; module requests decode under the ordinary contract above.
pub(crate) fn decode_path_strictly(path: &str, label: &str) -> Result<String, ProjectFileError> {
    let bytes = path.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'%' {
            continue;
        }
        let escape = bytes.get(index + 1..index + 3);
        if !escape.is_some_and(|escape| escape.iter().all(u8::is_ascii_hexdigit)) {
            return Err(ProjectFileError::new(
                ProjectFileErrorKind::BadRequest,
                format!("{label} has a malformed percent escape: {path}"),
            ));
        }
    }
    decode_path(path, label)
}

/// Walks a root-relative request into a candidate path without following anything the request
/// should not name. `.`, `..`, empty segments, backslashes and NUL bytes are refusals rather than
/// something to normalise away, because normalising them would decide on the caller's behalf what
/// a traversing path meant.
pub(crate) fn append_request_segments(
    root: &Path,
    relative: &str,
    request_path: &str,
    subject: &str,
) -> Result<PathBuf, ProjectFileError> {
    let mut candidate = root.to_path_buf();
    for segment in relative.split('/') {
        if !names_a_segment_a_request_may_use(segment) {
            return Err(ProjectFileError::new(
                ProjectFileErrorKind::BadRequest,
                format!("invalid or traversing {subject} request path: {request_path}"),
            ));
        }
        if segment.contains('\0') {
            return Err(ProjectFileError::new(
                ProjectFileErrorKind::BadRequest,
                format!("{subject} request path contains a NUL byte: {request_path}"),
            ));
        }
        candidate.push(segment);
    }
    Ok(candidate)
}

/// Whether one path segment is one a request may name.
///
/// A request that cannot name a segment is a request this server refuses, so this decides what a
/// page is allowed to ask for. It says nothing about the file that name leads to: resolution
/// happens after this, and a name a request may use can lead to a file whose own path this would
/// refuse. Watching asks this of the names it looks for, not of the paths it is told about.
pub(crate) fn names_a_segment_a_request_may_use(segment: &str) -> bool {
    !(segment.is_empty() || segment == "." || segment == ".." || segment.contains('\\'))
}

/// The file a candidate really is, once every link has been followed. Containment is decided on
/// the canonical path, so a link that leaves the project cannot be answered by its target.
pub(crate) async fn canonicalize_file(
    root: &Path,
    candidate: &Path,
    subject: &str,
    missing_message: String,
    escape_message: String,
) -> Result<PathBuf, ProjectFileError> {
    let canonical = tokio::fs::canonicalize(candidate).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ProjectFileError::new(ProjectFileErrorKind::NotFound, missing_message)
        } else {
            ProjectFileError::new(
                ProjectFileErrorKind::Internal,
                format!("failed to resolve {subject} file: {error}"),
            )
        }
    })?;
    if !canonical.starts_with(root) {
        return Err(ProjectFileError::new(
            ProjectFileErrorKind::Forbidden,
            escape_message,
        ));
    }
    let metadata = tokio::fs::metadata(&canonical).await.map_err(|error| {
        ProjectFileError::new(
            ProjectFileErrorKind::Internal,
            format!("failed to inspect resolved {subject} file: {error}"),
        )
    })?;
    if !metadata.is_file() {
        return Err(ProjectFileError::new(
            ProjectFileErrorKind::BadRequest,
            format!("resolved {subject} is a directory or non-file"),
        ));
    }
    Ok(canonical)
}

pub(crate) fn has_extension(path: &Path, accepted: &[&str]) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| accepted.contains(&extension))
}

/// The whole table for a request that carries its own encoding, decoded here under the ordinary
/// contract.
pub(crate) async fn resolve_request_file(
    root: &Path,
    request_path: &str,
    accepted: &[&str],
    subject: &str,
) -> Result<PathBuf, ProjectFileError> {
    let decoded = decode_path(request_path, "request path")?;
    resolve_decoded_request_file(root, &decoded, request_path, accepted, subject).await
}

/// The whole table, for a request the caller has decoded that accepts `accepted` file
/// kinds. `request_path` is what the client sent; the refusals that name a request quote it
/// back, while the directory and internal-failure branches name only the subject.
///
/// The extension is checked twice on purpose: once on what was asked for, so an unaccepted kind is
/// refused before the filesystem is touched, and once on what the request canonically resolved to,
/// so a link or a case-difference cannot deliver a different kind of file than the one requested.
pub(crate) async fn resolve_decoded_request_file(
    root: &Path,
    decoded: &str,
    request_path: &str,
    accepted: &[&str],
    subject: &str,
) -> Result<PathBuf, ProjectFileError> {
    let relative = decoded.strip_prefix('/').ok_or_else(|| {
        ProjectFileError::new(
            ProjectFileErrorKind::BadRequest,
            format!("{subject} request path must be root-relative: {request_path}"),
        )
    })?;
    let candidate = append_request_segments(root, relative, request_path, subject)?;
    if !has_extension(&candidate, accepted) {
        return Err(ProjectFileError::new(
            ProjectFileErrorKind::UnsupportedMediaType,
            format!("unsupported {subject} request file type: {request_path}"),
        ));
    }

    let canonical = canonicalize_file(
        root,
        &candidate,
        subject,
        format!("{subject} not found: {request_path}"),
        format!("{subject} request escapes the project root: {request_path}"),
    )
    .await?;
    if !has_extension(&canonical, accepted) {
        return Err(ProjectFileError::new(
            ProjectFileErrorKind::UnsupportedMediaType,
            format!("resolved {subject} has an unsupported file type: {request_path}"),
        ));
    }
    Ok(canonical)
}
