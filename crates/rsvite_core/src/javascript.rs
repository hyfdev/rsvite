use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    AccessorProperty, Class, ClassElement, MethodDefinition, PropertyDefinition, VariableDeclarator,
};
use oxc_ast_visit::{Visit, walk};
use oxc_parser::Parser;
use oxc_span::{ContentEq, SourceType, Span};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};

use crate::project_file::{
    ProjectFileError as ModuleError, ProjectFileErrorKind as ModuleErrorKind, canonicalize_file,
    decode_path, has_extension, resolve_request_file,
};

/// The file kinds a module request or import may resolve to.
pub(crate) const MODULE_EXTENSIONS: &[&str] = &["js", "ts"];

const MODULE_SEGMENT_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

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

struct ModuleAnalysis {
    requests: Vec<StaticModuleRequest>,
    type_annotations: Vec<Span>,
}

struct ResolvedImport {
    path: PathBuf,
    url: String,
}

struct SourceReplacement {
    start: usize,
    end: usize,
    text: String,
}

#[derive(Default)]
struct VariableTypeAnnotations {
    spans: Vec<Span>,
}

#[derive(Default)]
struct RetainedTypeScriptClassSyntax {
    found: bool,
}

impl<'a> Visit<'a> for VariableTypeAnnotations {
    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'a>) {
        if let Some(annotation) = &declarator.type_annotation {
            self.spans.push(annotation.span);
        }
        walk::walk_variable_declarator(self, declarator);
    }
}

impl<'a> Visit<'a> for RetainedTypeScriptClassSyntax {
    fn visit_class(&mut self, class: &Class<'a>) {
        self.found |= class.is_typescript_syntax()
            || class.type_parameters.is_some()
            || !class.implements.is_empty()
            || class
                .heritage
                .as_ref()
                .is_some_and(|heritage| heritage.type_arguments.is_some());
        walk::walk_class(self, class);
    }

    fn visit_class_element(&mut self, element: &ClassElement<'a>) {
        self.found |= element.is_typescript_syntax();
        walk::walk_class_element(self, element);
    }

    fn visit_method_definition(&mut self, method: &MethodDefinition<'a>) {
        let has_parameter_syntax = method.value.params.items.iter().any(|parameter| {
            parameter.type_annotation.is_some()
                || parameter.optional
                || parameter.accessibility.is_some()
                || parameter.readonly
                || parameter.r#override
        }) || method
            .value
            .params
            .rest
            .as_ref()
            .is_some_and(|parameter| parameter.type_annotation.is_some());
        self.found |= method.r#override
            || method.optional
            || method.accessibility.is_some()
            || method.value.type_parameters.is_some()
            || method.value.this_param.is_some()
            || method.value.return_type.is_some()
            || has_parameter_syntax;
        walk::walk_method_definition(self, method);
    }

    fn visit_property_definition(&mut self, property: &PropertyDefinition<'a>) {
        self.found |= property.type_annotation.is_some()
            || property.declare
            || property.r#override
            || property.optional
            || property.definite
            || property.readonly
            || property.accessibility.is_some();
        walk::walk_property_definition(self, property);
    }

    fn visit_accessor_property(&mut self, property: &AccessorProperty<'a>) {
        self.found |= property.type_annotation.is_some()
            || property.r#override
            || property.definite
            || property.accessibility.is_some();
        walk::walk_accessor_property(self, property);
    }
}

pub(crate) async fn load(root: &Path, request_path: &str) -> Result<LoadedJavaScript, ModuleError> {
    let importer = resolve_request_path(root, request_path).await?;
    let importer_url = module_url(root, &importer)?;
    let source = tokio::fs::read_to_string(&importer)
        .await
        .map_err(|error| {
            ModuleError::new(
                ModuleErrorKind::Internal,
                format!("failed to read module {importer_url}: {error}"),
            )
        })?;
    let source_type = source_type(&importer);
    let analysis = analyze_module(&source, &importer_url, source_type)?;

    let mut replacements =
        Vec::with_capacity(analysis.requests.len() + analysis.type_annotations.len());
    let mut importees = BTreeSet::new();
    for request in analysis.requests {
        let resolved = resolve_import(root, &importer, &importer_url, &request.specifier).await?;
        importees.insert(resolved.path);
        replacements.push(SourceReplacement {
            start: request.start,
            end: request.end,
            text: format!("\"{}\"", resolved.url),
        });
    }
    replacements.extend(
        analysis
            .type_annotations
            .into_iter()
            .map(|span| SourceReplacement {
                start: span.start as usize,
                end: span.end as usize,
                text: String::new(),
            }),
    );

    let transformed = apply_replacements(source, replacements);
    if source_type.is_typescript() {
        validate_transformed_typescript(&transformed, &importer_url)?;
    }

    Ok(LoadedJavaScript {
        path: importer,
        source: transformed,
        importees,
    })
}

fn analyze_module(
    source: &str,
    importer_url: &str,
    source_type: SourceType,
) -> Result<ModuleAnalysis, ModuleError> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(ModuleError::new(
            ModuleErrorKind::BadRequest,
            format!(
                "cannot analyze module {importer_url}: {} parser diagnostic(s)",
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

    let mut annotations = VariableTypeAnnotations::default();
    if source_type.is_typescript() {
        annotations.visit_program(&parsed.program);
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
    Ok(ModuleAnalysis {
        requests,
        type_annotations: annotations.spans,
    })
}

fn apply_replacements(source: String, mut replacements: Vec<SourceReplacement>) -> String {
    replacements.sort_unstable_by_key(|replacement| replacement.start);
    let mut transformed = source;
    for replacement in replacements.into_iter().rev() {
        transformed.replace_range(replacement.start..replacement.end, &replacement.text);
    }
    transformed
}

fn validate_transformed_typescript(
    transformed: &str,
    importer_url: &str,
) -> Result<(), ModuleError> {
    let typescript_allocator = Allocator::default();
    let typescript = Parser::new(
        &typescript_allocator,
        transformed,
        SourceType::ts().with_module(true),
    )
    .parse();
    let javascript_allocator = Allocator::default();
    let javascript = Parser::new(&javascript_allocator, transformed, SourceType::mjs()).parse();
    let mut retained_class_syntax = RetainedTypeScriptClassSyntax::default();
    retained_class_syntax.visit_program(&typescript.program);
    let same_program = !retained_class_syntax.found
        && typescript.diagnostics.is_empty()
        && javascript.diagnostics.is_empty()
        && typescript
            .program
            .hashbang
            .content_eq(&javascript.program.hashbang)
        && typescript
            .program
            .directives
            .content_eq(&javascript.program.directives)
        && typescript.program.body.content_eq(&javascript.program.body);
    if same_program {
        return Ok(());
    }
    Err(ModuleError::new(
        ModuleErrorKind::BadRequest,
        format!(
            "cannot transform TypeScript module {importer_url}: unsupported TypeScript syntax remains"
        ),
    ))
}

fn source_type(path: &Path) -> SourceType {
    if path.extension().and_then(|extension| extension.to_str()) == Some("ts") {
        SourceType::ts().with_module(true)
    } else {
        SourceType::mjs()
    }
}

async fn resolve_request_path(root: &Path, request_path: &str) -> Result<PathBuf, ModuleError> {
    resolve_request_file(root, request_path, MODULE_EXTENSIONS, "module").await
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
    let candidate = append_import_segments(root, base, &decoded, specifier, importer_url)?;
    let candidate = match candidate
        .extension()
        .and_then(|extension| extension.to_str())
    {
        None => resolve_extensionless_import(&candidate, specifier, importer_url).await?,
        Some("js" | "ts") => candidate,
        Some(_) => {
            return Err(ModuleError::new(
                ModuleErrorKind::UnsupportedMediaType,
                format!("unsupported import file type {specifier:?} in {importer_url}"),
            ));
        }
    };

    let canonical = canonicalize_file(
        root,
        &candidate,
        // Every failure to canonicalize a file in the module graph reports the same noun,
        // whether the request named it directly or an import did.
        "module",
        format!("import {specifier:?} was not found from {importer_url}"),
        format!("import {specifier:?} escapes the project root from {importer_url}"),
    )
    .await?;
    if !has_extension(&canonical, MODULE_EXTENSIONS) {
        return Err(ModuleError::new(
            ModuleErrorKind::UnsupportedMediaType,
            format!("resolved module has an unsupported file type: {specifier}"),
        ));
    }
    let url = module_url(root, &canonical)?;
    Ok(ResolvedImport {
        path: canonical,
        url,
    })
}

async fn resolve_extensionless_import(
    candidate: &Path,
    specifier: &str,
    importer_url: &str,
) -> Result<PathBuf, ModuleError> {
    match tokio::fs::metadata(candidate).await {
        Ok(metadata) if metadata.is_dir() => {
            return Err(ModuleError::new(
                ModuleErrorKind::BadRequest,
                format!("directory import {specifier:?} is not supported in {importer_url}"),
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
                format!("failed to inspect import {specifier:?} in {importer_url}: {error}"),
            ));
        }
    }

    for extension in ["js", "ts"] {
        let mut resolved = candidate.to_path_buf();
        resolved.set_extension(extension);
        match tokio::fs::symlink_metadata(&resolved).await {
            Ok(_) => return Ok(resolved),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(ModuleError::new(
                    ModuleErrorKind::Internal,
                    format!("failed to inspect import {specifier:?} in {importer_url}: {error}"),
                ));
            }
        }
    }

    Err(ModuleError::new(
        ModuleErrorKind::NotFound,
        format!("import {specifier:?} was not found from {importer_url}"),
    ))
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

/// Whether the module route could answer with this resolved file at all.
///
/// A module response rewrites each of its imports to the URL the import resolved to, so a module
/// this server cannot write a URL for is one it refuses however the request was spelt. That is a
/// property of the resolved file rather than of the request, and it does not change while the file
/// stays where it is. Watching asks it too, so an edit to a file the module route can never answer
/// with does not reload a page.
pub(crate) fn can_be_named_in_a_module_url(root: &Path, path: &Path) -> bool {
    module_url(root, path).is_ok()
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
                "module path is not valid UTF-8",
            )
        })?;
        url.push('/');
        url.push_str(&utf8_percent_encode(segment, MODULE_SEGMENT_ENCODE_SET).to_string());
    }
    if url.is_empty() {
        return Err(ModuleError::new(
            ModuleErrorKind::BadRequest,
            "project root is not a module",
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
