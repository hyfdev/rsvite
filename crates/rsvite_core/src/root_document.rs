//! Following `index.html` the way the root route does, and remembering how it got there.
//!
//! `GET /` reads `<root>/index.html` and lets the kernel follow whatever links it goes through, so
//! the document a page is given can live outside the project and can change without the project's
//! own files changing. Watching only the file the name finally resolves to is not enough: pointing
//! an intermediate link somewhere else changes the response while leaving that file, its directory
//! and the project untouched.
//!
//! This module answers where the document currently comes from and which links were followed to
//! get there, so the current parent directory of each followed link and of the final target can
//! be watched for those names. Replacing a non-symlink ancestor directory of that chain is not
//! observed by this slice.

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    ffi::OsString,
    path::{Component, Path, PathBuf},
};

/// The root document, which is the only HTML file this server serves.
pub(crate) const ROOT_DOCUMENT: &str = "index.html";

/// How many links one resolution may follow before it is treated as unresolvable.
///
/// The kernel gives up on a cycle rather than looping, and so does this.
const LINK_LIMIT: usize = 40;

/// A directory entry, named the way a watcher sees it: a directory and a name inside it.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct Entry {
    pub(crate) directory: PathBuf,
    pub(crate) name: OsString,
}

impl Entry {
    fn path(&self) -> PathBuf {
        self.directory.join(&self.name)
    }

    fn names(&self, path: &Path) -> bool {
        path == self.path()
    }
}

/// Where `GET /` currently reads the document from, and the links it was followed through.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RootResolution {
    /// Every link that was followed, in the order the resolution followed it.
    links: Vec<Entry>,
    /// The file the document is finally read from.
    target: Entry,
}

impl RootResolution {
    /// Whether a path is the file the document currently comes from.
    pub(crate) fn is_the_target(&self, path: &Path) -> bool {
        self.target.names(path)
    }

    /// Whether a path is one of the links the resolution followed.
    ///
    /// A change here points the document at a different file without touching the file it used
    /// to come from.
    pub(crate) fn is_a_step(&self, path: &Path) -> bool {
        self.links.iter().any(|link| link.names(path))
    }

    /// The directories outside the project that have to be watched, and the names in each of them
    /// that belong to this resolution.
    ///
    /// These are the links this resolution followed and the file it ends at. Everything inside the
    /// project is already covered by the project's own recursive watch, and a name that is not
    /// part of the resolution is somebody else's file. The directories those names live in are
    /// watched for those names, so replacing one of them is seen. Replacing a non-symlink
    /// ancestor directory of that chain is not observed by this slice.
    pub(crate) fn external_directories(
        &self,
        root: &Path,
    ) -> BTreeMap<PathBuf, BTreeSet<OsString>> {
        let mut directories: BTreeMap<PathBuf, BTreeSet<OsString>> = BTreeMap::new();
        for entry in self.links.iter().chain(std::iter::once(&self.target)) {
            if entry.directory.starts_with(root) {
                continue;
            }
            directories
                .entry(entry.directory.clone())
                .or_default()
                .insert(entry.name.clone());
        }
        directories
    }
}

/// One step of a path, kept so a link's own target can be walked the same way.
enum Piece {
    Root,
    Parent,
    Current,
    Name(OsString),
}

fn pieces(path: &Path) -> VecDeque<Piece> {
    path.components()
        .map(|component| match component {
            Component::RootDir | Component::Prefix(_) => Piece::Root,
            Component::ParentDir => Piece::Parent,
            Component::CurDir => Piece::Current,
            Component::Normal(name) => Piece::Name(name.to_os_string()),
        })
        .collect()
}

/// Where the root document currently resolves to, or nothing if it resolves nowhere servable.
///
/// The walk follows links one entry at a time instead of asking for the canonical result, because
/// the entries it passes through are what has to be watched. A relative link is resolved against
/// the directory the link itself is in, which is what the kernel does.
pub(crate) fn resolve_root_document(root: &Path) -> Option<RootResolution> {
    #[cfg(test)]
    if REFUSED_ROOTS
        .lock()
        .expect("refused roots mutex poisoned")
        .iter()
        .any(|refused| refused == root)
    {
        return None;
    }
    let mut links: Vec<Entry> = Vec::new();
    let mut directory = root.to_path_buf();
    let mut remaining = pieces(Path::new(ROOT_DOCUMENT));
    let mut followed = 0usize;

    while let Some(piece) = remaining.pop_front() {
        match piece {
            Piece::Root => directory = PathBuf::from("/"),
            Piece::Current => {}
            Piece::Parent => {
                directory.pop();
            }
            Piece::Name(name) => {
                let candidate = directory.join(&name);
                let entry = std::fs::symlink_metadata(&candidate).ok()?;
                if !entry.file_type().is_symlink() {
                    directory = candidate;
                    continue;
                }
                followed += 1;
                if followed > LINK_LIMIT {
                    return None;
                }
                links.push(Entry {
                    directory: directory.clone(),
                    name,
                });
                let target = std::fs::read_link(&candidate).ok()?;
                for piece in pieces(&target).into_iter().rev() {
                    remaining.push_front(piece);
                }
            }
        }
    }

    if !std::fs::metadata(&directory).ok()?.is_file() {
        return None;
    }
    Some(RootResolution {
        links,
        target: Entry {
            directory: directory.parent()?.to_path_buf(),
            name: directory.file_name()?.to_os_string(),
        },
    })
}

/// The roots whose document must not be followable, so the fail-closed path can be exercised.
///
/// This walk mirrors the kernel's, so a document the route can read is one it can follow; a
/// disagreement is the case this server refuses to guess about, and it cannot be produced by
/// writing files. Refusal is scoped to a canonical root rather than global so that tests running
/// side by side are unaffected, and it exists in test builds only.
#[cfg(test)]
static REFUSED_ROOTS: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

#[cfg(test)]
pub(crate) struct RefusedRoot(PathBuf);

#[cfg(test)]
impl Drop for RefusedRoot {
    fn drop(&mut self) {
        let mut refused = REFUSED_ROOTS.lock().expect("refused roots mutex poisoned");
        if let Some(position) = refused.iter().position(|root| root == &self.0) {
            refused.swap_remove(position);
        }
    }
}

#[cfg(test)]
pub(crate) fn refuse_to_follow(root: &Path) -> RefusedRoot {
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    REFUSED_ROOTS
        .lock()
        .expect("refused roots mutex poisoned")
        .push(root.clone());
    RefusedRoot(root)
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{create_dir_all, write},
        os::unix::fs::symlink,
    };

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn resolves_a_document_the_project_holds_itself() {
        let project = TempDir::new().unwrap();
        let root = std::fs::canonicalize(project.path()).unwrap();
        write(root.join(ROOT_DOCUMENT), "<h1>hello</h1>").unwrap();

        let resolution = resolve_root_document(&root).expect("the document is right there");
        assert!(resolution.is_the_target(&root.join(ROOT_DOCUMENT)));
        assert!(
            resolution.external_directories(&root).is_empty(),
            "nothing outside the project is involved"
        );
    }

    #[test]
    fn follows_every_link_the_document_goes_through() {
        let project = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let root = std::fs::canonicalize(project.path()).unwrap();
        let elsewhere = std::fs::canonicalize(outside.path()).unwrap();
        create_dir_all(elsewhere.join("documents")).unwrap();
        write(elsewhere.join("documents/actual.html"), "<h1>actual</h1>").unwrap();

        // `index.html` leads out of the project, through a link in one external directory, and
        // then through a linked directory before it reaches the file a page is given.
        symlink(elsewhere.join("chosen.html"), root.join(ROOT_DOCUMENT)).unwrap();
        symlink("published/actual.html", elsewhere.join("chosen.html")).unwrap();
        symlink("documents", elsewhere.join("published")).unwrap();

        let resolution = resolve_root_document(&root).expect("the document resolves");

        // Each of these changes what a page is given without touching the file it comes from.
        assert!(resolution.is_a_step(&root.join(ROOT_DOCUMENT)));
        assert!(resolution.is_a_step(&elsewhere.join("chosen.html")));
        assert!(resolution.is_a_step(&elsewhere.join("published")));
        assert!(resolution.is_the_target(&elsewhere.join("documents/actual.html")));
        assert!(!resolution.is_a_step(&elsewhere.join("unrelated.html")));

        let directories = resolution.external_directories(&root);
        assert_eq!(
            directories.keys().collect::<Vec<_>>(),
            vec![&elsewhere, &elsewhere.join("documents")],
            "only the directories outside the project have to be watched separately"
        );
        assert_eq!(
            directories[&elsewhere],
            ["chosen.html", "published"]
                .into_iter()
                .map(Into::into)
                .collect(),
            "and only the names this resolution went through"
        );
        assert_eq!(
            directories[&elsewhere.join("documents")],
            ["actual.html"].into_iter().map(Into::into).collect()
        );
    }

    #[test]
    fn resolves_a_relative_link_against_the_directory_it_is_in() {
        let project = TempDir::new().unwrap();
        let root = std::fs::canonicalize(project.path()).unwrap();
        create_dir_all(root.join("pages")).unwrap();
        write(root.join("pages/home.html"), "<h1>home</h1>").unwrap();
        symlink("pages/home.html", root.join(ROOT_DOCUMENT)).unwrap();

        let resolution = resolve_root_document(&root).expect("the document resolves");
        assert!(resolution.is_the_target(&root.join("pages/home.html")));
    }

    #[test]
    fn resolves_nowhere_when_the_document_leads_nowhere() {
        let project = TempDir::new().unwrap();
        let root = std::fs::canonicalize(project.path()).unwrap();
        assert!(
            resolve_root_document(&root).is_none(),
            "there is no document"
        );

        symlink("missing.html", root.join(ROOT_DOCUMENT)).unwrap();
        assert!(
            resolve_root_document(&root).is_none(),
            "the document leads to nothing"
        );

        std::fs::remove_file(root.join(ROOT_DOCUMENT)).unwrap();
        create_dir_all(root.join(ROOT_DOCUMENT)).unwrap();
        assert!(
            resolve_root_document(&root).is_none(),
            "a directory is not a document"
        );
    }

    #[test]
    fn gives_up_on_a_document_that_leads_back_to_itself() {
        let project = TempDir::new().unwrap();
        let root = std::fs::canonicalize(project.path()).unwrap();
        symlink("loop.html", root.join(ROOT_DOCUMENT)).unwrap();
        symlink(ROOT_DOCUMENT, root.join("loop.html")).unwrap();

        assert!(resolve_root_document(&root).is_none());
    }
}
