use std::{
    collections::BTreeSet,
    fmt,
    path::{Path, PathBuf},
};

use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};

const MODULE_SEGMENT_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ModuleErrorKind {
    BadRequest,
    Forbidden,
    NotFound,
    UnsupportedMediaType,
    Internal,
}

#[derive(Debug)]
pub(crate) struct ModuleError {
    kind: ModuleErrorKind,
    message: String,
}

impl ModuleError {
    fn new(kind: ModuleErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub(crate) fn kind(&self) -> ModuleErrorKind {
        self.kind
    }
}

impl fmt::Display for ModuleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

pub(crate) struct LoadedJavaScript {
    pub(crate) path: PathBuf,
    pub(crate) source: String,
    pub(crate) importees: BTreeSet<PathBuf>,
}

struct StaticModuleRequest {
    specifier: String,
    start: usize,
    end: usize,
}

struct ResolvedImport {
    path: PathBuf,
    url: String,
}

pub(crate) async fn load(root: &Path, request_path: &str) -> Result<LoadedJavaScript, ModuleError> {
    let importer = resolve_request_path(root, request_path).await?;
    let importer_url = module_url(root, &importer)?;
    let source = tokio::fs::read_to_string(&importer)
        .await
        .map_err(|error| {
            ModuleError::new(
                ModuleErrorKind::Internal,
                format!("failed to read JavaScript module {importer_url}: {error}"),
            )
        })?;
    let requests = analyze_static_module_requests(&source, &importer_url)?;

    let mut replacements = Vec::with_capacity(requests.len());
    let mut importees = BTreeSet::new();
    for request in requests {
        let resolved = resolve_import(root, &importer, &importer_url, &request.specifier).await?;
        importees.insert(resolved.path);
        replacements.push((request.start, request.end, resolved.url));
    }

    replacements.sort_unstable_by_key(|replacement| replacement.0);
    let mut transformed = source;
    for (start, end, url) in replacements.into_iter().rev() {
        transformed.replace_range(start..end, &format!("\"{url}\""));
    }

    Ok(LoadedJavaScript {
        path: importer,
        source: transformed,
        importees,
    })
}

fn analyze_static_module_requests(
    source: &str,
    importer_url: &str,
) -> Result<Vec<StaticModuleRequest>, ModuleError> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(ModuleError::new(
            ModuleErrorKind::BadRequest,
            format!(
                "cannot analyze JavaScript module {importer_url}: {} syntax error(s)",
                parsed.diagnostics.len()
            ),
        ));
    }
    if !parsed.module_record.dynamic_imports.is_empty() {
        return Err(ModuleError::new(
            ModuleErrorKind::BadRequest,
            format!("dynamic imports are not supported in {importer_url}"),
        ));
    }

    let mut requests = Vec::new();
    for (specifier, occurrences) in &parsed.module_record.requested_modules {
        for occurrence in occurrences {
            let start = occurrence.span.start as usize;
            let end = occurrence.span.end as usize;
            requests.push(StaticModuleRequest {
                specifier: specifier.to_string(),
                start,
                end,
            });
        }
    }
    requests.sort_unstable_by_key(|request| request.start);
    Ok(requests)
}

async fn resolve_request_path(root: &Path, request_path: &str) -> Result<PathBuf, ModuleError> {
    let decoded = decode_path(request_path, "request path")?;
    let relative = decoded.strip_prefix('/').ok_or_else(|| {
        ModuleError::new(
            ModuleErrorKind::BadRequest,
            format!("JavaScript request path must be root-relative: {request_path}"),
        )
    })?;
    let candidate = append_request_segments(root, relative, request_path)?;
    if candidate
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("js")
    {
        return Err(ModuleError::new(
            ModuleErrorKind::UnsupportedMediaType,
            format!("unsupported JavaScript request file type: {request_path}"),
        ));
    }

    let canonical = canonicalize_file(
        root,
        &candidate,
        format!("JavaScript module not found: {request_path}"),
        format!("JavaScript request escapes the project root: {request_path}"),
    )
    .await?;
    ensure_javascript_file(&canonical, request_path)?;
    Ok(canonical)
}

async fn resolve_import(
    root: &Path,
    importer: &Path,
    importer_url: &str,
    specifier: &str,
) -> Result<ResolvedImport, ModuleError> {
    if is_url_import(specifier) {
        return Err(ModuleError::new(
            ModuleErrorKind::BadRequest,
            format!("URL import {specifier:?} is not supported in {importer_url}"),
        ));
    }
    if specifier.contains('?') || specifier.contains('#') {
        return Err(ModuleError::new(
            ModuleErrorKind::BadRequest,
            format!(
                "import queries and fragments are not supported: {specifier:?} in {importer_url}"
            ),
        ));
    }

    let (base, path) = if let Some(path) = specifier.strip_prefix('/') {
        (root, path)
    } else if specifier.starts_with("./") || specifier.starts_with("../") {
        (
            importer
                .parent()
                .expect("a project file has a parent directory"),
            specifier,
        )
    } else {
        return Err(ModuleError::new(
            ModuleErrorKind::BadRequest,
            format!("bare import {specifier:?} is not supported in {importer_url}"),
        ));
    };

    let decoded = decode_path(path, "import specifier")?;
    let mut candidate = append_import_segments(root, base, &decoded, specifier, importer_url)?;
    match candidate
        .extension()
        .and_then(|extension| extension.to_str())
    {
        None => {
            match tokio::fs::metadata(&candidate).await {
                Ok(metadata) if metadata.is_dir() => {
                    return Err(ModuleError::new(
                        ModuleErrorKind::BadRequest,
                        format!(
                            "directory import {specifier:?} is not supported in {importer_url}"
                        ),
                    ));
                }
                Ok(_) => {
                    return Err(ModuleError::new(
                        ModuleErrorKind::UnsupportedMediaType,
                        format!(
                            "extensionless import {specifier:?} resolves to an unsupported file type in {importer_url}"
                        ),
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(ModuleError::new(
                        ModuleErrorKind::Internal,
                        format!(
                            "failed to inspect import {specifier:?} in {importer_url}: {error}"
                        ),
                    ));
                }
            }
            candidate.set_extension("js");
        }
        Some("js") => {}
        Some(_) => {
            return Err(ModuleError::new(
                ModuleErrorKind::UnsupportedMediaType,
                format!("unsupported import file type {specifier:?} in {importer_url}"),
            ));
        }
    }

    let canonical = canonicalize_file(
        root,
        &candidate,
        format!("import {specifier:?} was not found from {importer_url}"),
        format!("import {specifier:?} escapes the project root from {importer_url}"),
    )
    .await?;
    ensure_javascript_file(&canonical, specifier)?;
    let url = module_url(root, &canonical)?;
    Ok(ResolvedImport {
        path: canonical,
        url,
    })
}

fn decode_path(path: &str, label: &str) -> Result<String, ModuleError> {
    percent_decode_str(path)
        .decode_utf8()
        .map(|decoded| decoded.into_owned())
        .map_err(|_| {
            ModuleError::new(
                ModuleErrorKind::BadRequest,
                format!("{label} is not valid UTF-8: {path:?}"),
            )
        })
}

fn append_request_segments(
    root: &Path,
    relative: &str,
    request_path: &str,
) -> Result<PathBuf, ModuleError> {
    let mut candidate = root.to_path_buf();
    for segment in relative.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." || segment.contains('\\') {
            return Err(ModuleError::new(
                ModuleErrorKind::BadRequest,
                format!("invalid or traversing JavaScript request path: {request_path}"),
            ));
        }
        if segment.contains('\0') {
            return Err(ModuleError::new(
                ModuleErrorKind::BadRequest,
                format!("JavaScript request path contains a NUL byte: {request_path}"),
            ));
        }
        candidate.push(segment);
    }
    Ok(candidate)
}

fn append_import_segments(
    root: &Path,
    base: &Path,
    path: &str,
    specifier: &str,
    importer_url: &str,
) -> Result<PathBuf, ModuleError> {
    let mut candidate = base.to_path_buf();
    for segment in path.split('/') {
        match segment {
            "" => {
                return Err(ModuleError::new(
                    ModuleErrorKind::BadRequest,
                    format!("invalid import path {specifier:?} in {importer_url}"),
                ));
            }
            "." => {}
            ".." => {
                if candidate == root {
                    return Err(ModuleError::new(
                        ModuleErrorKind::Forbidden,
                        format!(
                            "import {specifier:?} traverses outside the project root from {importer_url}"
                        ),
                    ));
                }
                candidate.pop();
            }
            segment if segment.contains('\\') || segment.contains('\0') => {
                return Err(ModuleError::new(
                    ModuleErrorKind::BadRequest,
                    format!("invalid import path {specifier:?} in {importer_url}"),
                ));
            }
            segment => candidate.push(segment),
        }
    }
    if !candidate.starts_with(root) {
        return Err(ModuleError::new(
            ModuleErrorKind::Forbidden,
            format!("import {specifier:?} escapes the project root from {importer_url}"),
        ));
    }
    Ok(candidate)
}

async fn canonicalize_file(
    root: &Path,
    candidate: &Path,
    missing_message: String,
    escape_message: String,
) -> Result<PathBuf, ModuleError> {
    let canonical = tokio::fs::canonicalize(candidate).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ModuleError::new(ModuleErrorKind::NotFound, missing_message)
        } else {
            ModuleError::new(
                ModuleErrorKind::Internal,
                format!("failed to resolve module file: {error}"),
            )
        }
    })?;
    if !canonical.starts_with(root) {
        return Err(ModuleError::new(ModuleErrorKind::Forbidden, escape_message));
    }
    let metadata = tokio::fs::metadata(&canonical).await.map_err(|error| {
        ModuleError::new(
            ModuleErrorKind::Internal,
            format!("failed to inspect resolved module file: {error}"),
        )
    })?;
    if !metadata.is_file() {
        return Err(ModuleError::new(
            ModuleErrorKind::BadRequest,
            "resolved JavaScript module is a directory or non-file",
        ));
    }
    Ok(canonical)
}

fn ensure_javascript_file(path: &Path, requested: &str) -> Result<(), ModuleError> {
    if path.extension().and_then(|extension| extension.to_str()) == Some("js") {
        return Ok(());
    }
    Err(ModuleError::new(
        ModuleErrorKind::UnsupportedMediaType,
        format!("resolved module has an unsupported file type: {requested}"),
    ))
}

fn module_url(root: &Path, path: &Path) -> Result<String, ModuleError> {
    let relative = path.strip_prefix(root).map_err(|_| {
        ModuleError::new(
            ModuleErrorKind::Forbidden,
            "resolved module escapes the project root",
        )
    })?;
    let mut url = String::new();
    for component in relative.components() {
        let segment = component.as_os_str().to_str().ok_or_else(|| {
            ModuleError::new(
                ModuleErrorKind::BadRequest,
                "JavaScript module path is not valid UTF-8",
            )
        })?;
        url.push('/');
        url.push_str(&utf8_percent_encode(segment, MODULE_SEGMENT_ENCODE_SET).to_string());
    }
    if url.is_empty() {
        return Err(ModuleError::new(
            ModuleErrorKind::BadRequest,
            "project root is not a JavaScript module",
        ));
    }
    Ok(url)
}

fn is_url_import(specifier: &str) -> bool {
    if specifier.starts_with("//") {
        return true;
    }
    let Some((scheme, _)) = specifier.split_once(':') else {
        return false;
    };
    let mut characters = scheme.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
        })
}
