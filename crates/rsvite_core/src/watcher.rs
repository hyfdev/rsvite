//! Turning filesystem activity into the coarse reload the browser needs.
//!
//! An ordinary edit does not reach the watcher as one event. Writing a file produces several
//! notifications, and saving two files together produces more; sending a reload for each of them
//! would load the document again and again for one edit. So notifications that concern a file this
//! server answers with open an edit window, each further one extends it, and when the window falls
//! quiet the server sends a single reload.
//!
//! The quiet interval groups the notifications of one ordinary edit. It is not evidence that every
//! writer has finished: a writer that pauses long enough looks like one that stopped. What follows
//! a reload is a fresh request for the document, which reads and transforms whatever the files hold
//! at that moment.
//!
//! What a page would be given is a question about names. `GET /` reads `index.html` through
//! whatever links it goes through, so the document can live outside the project. Each link that
//! resolution follows, and the file it ends at, is watched by name in the directory it lives in,
//! so replacing one of them is seen. Replacing a non-symlink ancestor directory of that chain is
//! not observed by this slice. Module and resource names keep the containment and kind their own
//! routes require.
//!
//! A notification, though, carries the path the filesystem changed, and that is not always a name
//! a request could spell. A link can give a file a name the route answers for while the file's own
//! path holds a segment no request may use, so what decides an edit is whether a name a request
//! may use currently leads to that file — not how the filesystem happens to spell it. That
//! question is the route's own, asked in the route's own terms: the way a name takes may leave the
//! project and come back, because containment is decided on the file it finally reaches, and a
//! module has to be one this server can write a URL for or it is refused however it is asked for.

use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use notify::{
    Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
    event::{AccessKind, ModifyKind, RenameMode},
};
use tokio::{
    sync::mpsc,
    task::JoinHandle,
    time::{Instant, sleep_until},
};

use crate::{
    javascript::{MODULE_EXTENSIONS, can_be_named_in_a_module_url},
    project_file::{has_extension, names_a_segment_a_request_may_use},
    resource::served_extension_of,
    root_document::{ROOT_DOCUMENT, RootResolution, resolve_root_document},
};

/// How long an edit window stays open after the last notification that belongs to it.
///
/// This groups the notifications one ordinary edit produces. It is a private detail: what the
/// server promises is one reload per edit window, not any particular number of milliseconds.
const BURST_WINDOW: Duration = Duration::from_millis(60);

/// What a notification says about a name this server may answer for.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Notice {
    /// Its contents changed.
    Changed(PathBuf),
    /// It now names a different file.
    Arrived(PathBuf),
}

impl Notice {
    fn path(&self) -> &Path {
        match self {
            Notice::Changed(path) | Notice::Arrived(path) => path,
        }
    }
}

/// Passes on what a notification says, or reports that notifications were lost.
///
/// `reported` remembers the move already passed on: one rename reaches the watcher as the name it
/// left, the name it arrived at, and once more as both together; all of them belong to one move
/// and arrive next to each other, so one slot is enough to pass that move on once.
fn observe(
    event: Event,
    reported: &mut Option<usize>,
    notices: &mpsc::UnboundedSender<Notice>,
    report_failure: &impl Fn(String),
) {
    // The kernel's queue overflowed, so an unknown number of notifications never arrived. This
    // server cannot say which files changed while it was not told, and it will not go on serving
    // as if nothing had happened.
    if event.need_rescan() || lost_by_request(&event) {
        report_failure("the watcher lost notifications and cannot say what changed".to_owned());
        return;
    }
    let Some(kind) = describes_an_edit(event.kind) else {
        return;
    };
    let tracker = event.attrs.tracker();
    match kind {
        EditKind::Renamed | EditKind::Arrived => {
            if tracker.is_some() && *reported == tracker {
                return;
            }
            *reported = tracker;
            // Both halves of one rename in a single event. Only the name the file arrived at is a
            // change to what that name gives.
            let arrived = match kind {
                EditKind::Renamed => event.paths.into_iter().nth(1),
                _ => event.paths.into_iter().next(),
            };
            if let Some(arrived) = arrived {
                let _ = notices.send(Notice::Arrived(arrived));
            }
        }
        EditKind::Changed => {
            for path in event.paths {
                let _ = notices.send(Notice::Changed(path));
            }
        }
    }
}

/// What kind of change a notification describes, or nothing if it describes none.
///
/// Only a changed file and a name that now leads somewhere else can be an edit. A close says a
/// writer let go, which by itself changed nothing; a removal, a metadata change, an open and a
/// read say nothing about an edit either.
fn describes_an_edit(kind: EventKind) -> Option<EditKind> {
    match kind {
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => Some(EditKind::Renamed),
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => Some(EditKind::Arrived),
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => None,
        EventKind::Access(AccessKind::Close(_)) => None,
        EventKind::Access(_)
        | EventKind::Modify(ModifyKind::Metadata(_))
        | EventKind::Remove(_)
        | EventKind::Other => None,
        _ => Some(EditKind::Changed),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EditKind {
    /// One event carrying both halves of a rename: the name it left and the name it arrived at.
    Renamed,
    Arrived,
    Changed,
}

/// Whether a path is a name a module or resource request would ask this server for.
///
/// A request carries its own segments, so a name that traverses or holds a segment the route
/// refuses is not one any page could spell, and the name has to carry a kind this server serves.
/// This asks about a name, not about a file: a file can be reached by a name that looks nothing
/// like the file's own path.
fn names_a_project_file(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let nameable = relative.components().all(|component| {
        matches!(component, Component::Normal(segment)
            if segment
                .to_str()
                .is_some_and(names_a_segment_a_request_may_use))
    });
    nameable && is_of_a_kind_this_server_serves(path)
}

/// Whether a name carries one of the kinds a module or resource request accepts.
fn is_of_a_kind_this_server_serves(path: &Path) -> bool {
    has_extension(path, MODULE_EXTENSIONS) || served_extension_of(path).is_some()
}

/// Whether this server would really answer for a name, with the file that name leads to.
///
/// The file has to be a regular file inside the project and of a kind the name's own route
/// accepts, so a link out of the project or to another kind answers nothing. A module has one
/// condition more: the response rewrites its imports to URLs built from the file the import
/// resolved to, so a resolved module this server cannot write a URL for is refused however it is
/// asked for. That question is asked here through the module route's own answer to it.
fn is_a_served_project_file(root: &Path, path: &Path) -> bool {
    let Ok(canonical) = std::fs::canonicalize(path) else {
        return false;
    };
    if !canonical.starts_with(root) {
        return false;
    }
    if !std::fs::metadata(&canonical).is_ok_and(|entry| entry.is_file()) {
        return false;
    }
    if has_extension(path, MODULE_EXTENSIONS) {
        return has_extension(&canonical, MODULE_EXTENSIONS)
            && can_be_named_in_a_module_url(root, &canonical);
    }
    served_extension_of(path).is_some_and(|extension| has_extension(&canonical, &[extension]))
}

/// Whether a page could be given the file a notification is about.
///
/// A request carries its own segments; the route follows them wherever they lead and then asks
/// what it ended at to be a file it may answer with. Those are two different names, and a
/// notification carries the second one. A file whose own path is a name a request may use is
/// asked for by that name. A file whose path is not — a directory on the way to it carries a
/// backslash, say — can still be what such a name leads to, because a link may point at it and
/// the route answers for that link. So a path that is not a name itself is not the end of the
/// question: what is asked is whether a name a request may use currently leads here.
fn a_page_could_be_given(root: &Path, path: &Path) -> bool {
    if names_a_project_file(root, path) {
        return is_a_served_project_file(root, path);
    }
    a_name_a_request_may_use_leads_to(root, path)
}

/// Whether some name a request may use currently leads to this file.
///
/// The project is read the way a request reads it: from the root, one segment a request may use
/// at a time, through whatever those segments lead to. A name that lands on this file is the
/// answer, and it is then held to the same questions as any other name, so a name that leads to
/// another kind, or one the module route could never write a URL for, still answers nothing.
///
/// A name that lands on a directory is a way further in and is followed once. It is followed even
/// where it leaves the project, because the route decides containment on the file a request
/// finally reaches and not on the way it took: a link out of the project and a link back into it
/// make a name this server really answers for. Each directory is followed once under the
/// name it canonically is, so a chain of links is walked to its end and a link that leads back to
/// somewhere already read is not walked again. Only names whose kind could be answered with this
/// file are resolved at all, which is what keeps this from canonicalizing every file it passes.
///
/// This reads directories, so it is worth doing only for a file this server could answer with: a
/// path outside the project, of a kind no route serves, or one that is not a regular file is
/// refused first. That is a matter of cost rather than of meaning — such a file is refused by the
/// questions below too, after the reading has happened for nothing. A file this server serves
/// under its own path never reaches here at all, so what is read for is the unusual name — one
/// carrying a backslash, or bytes that are not text — that a request could never spell for itself.
fn a_name_a_request_may_use_leads_to(root: &Path, target: &Path) -> bool {
    if !target.starts_with(root) || !is_of_a_kind_this_server_serves(target) {
        return false;
    }
    if !std::fs::metadata(target).is_ok_and(|entry| entry.is_file()) {
        return false;
    }
    let mut visited = BTreeSet::from([root.to_path_buf()]);
    let mut ways = vec![root.to_path_buf()];
    while let Some(way) = ways.pop() {
        let Ok(entries) = std::fs::read_dir(&way) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry
                .file_name()
                .to_str()
                .is_some_and(names_a_segment_a_request_may_use)
            {
                continue;
            }
            let name = way.join(entry.file_name());
            let Ok(entry) = std::fs::metadata(&name) else {
                continue;
            };
            if entry.is_dir() {
                let Ok(destination) = std::fs::canonicalize(&name) else {
                    continue;
                };
                if visited.insert(destination) {
                    ways.push(name);
                }
                continue;
            }
            if !could_be_answered_with(&name, target) {
                continue;
            }
            if std::fs::canonicalize(&name).is_ok_and(|destination| destination == target)
                && names_a_project_file(root, &name)
                && is_a_served_project_file(root, &name)
            {
                return true;
            }
        }
    }
    false
}

/// Whether a name and a file carry kinds that could ever be answered for one another.
///
/// Every route answers a name with a file of the kind that name asked for, so a name of another
/// kind is not worth resolving to find out where it goes.
fn could_be_answered_with(name: &Path, target: &Path) -> bool {
    if has_extension(target, MODULE_EXTENSIONS) {
        return has_extension(name, MODULE_EXTENSIONS);
    }
    served_extension_of(target).is_some_and(|extension| has_extension(name, &[extension]))
}

/// The roots whose notifications must be reported as lost, so the overflow path can be exercised.
///
/// A queue overflows because the operating system decided it did, under a load a test cannot ask
/// for, so a test says which root's next notification to treat as one. It is scoped to a canonical
/// root rather than global so that tests running side by side are unaffected, it is read at the
/// same point the real overflow flag is, and it exists in test builds only.
#[cfg(test)]
static LOST_NOTIFICATIONS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

#[cfg(test)]
pub(crate) struct LostNotifications(PathBuf);

#[cfg(test)]
impl Drop for LostNotifications {
    fn drop(&mut self) {
        let mut lost = LOST_NOTIFICATIONS
            .lock()
            .expect("lost notifications mutex poisoned");
        if let Some(position) = lost.iter().position(|root| root == &self.0) {
            lost.swap_remove(position);
        }
    }
}

#[cfg(test)]
pub(crate) fn lose_notifications_under(root: &Path) -> LostNotifications {
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    LOST_NOTIFICATIONS
        .lock()
        .expect("lost notifications mutex poisoned")
        .push(root.clone());
    LostNotifications(root)
}

#[cfg(test)]
fn lost_by_request(event: &Event) -> bool {
    LOST_NOTIFICATIONS
        .lock()
        .expect("lost notifications mutex poisoned")
        .iter()
        .any(|root| event.paths.iter().any(|path| path.starts_with(root)))
}

#[cfg(not(test))]
fn lost_by_request(_event: &Event) -> bool {
    false
}

/// The roots whose registration must fail, so the startup path can be exercised.
///
/// Registration only fails for reasons the operating system decides — a missing directory, an
/// exhausted watch limit — so a test cannot ask for one on a root the server has already accepted.
/// Refusal is scoped to a named root rather than global so that tests starting their own servers
/// are unaffected, and it exists in test builds only.
#[cfg(test)]
static REFUSED_ROOTS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

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
pub(crate) fn refuse_registration_for(root: &Path) -> RefusedRoot {
    REFUSED_ROOTS
        .lock()
        .expect("refused roots mutex poisoned")
        .push(root.to_path_buf());
    RefusedRoot(root.to_path_buf())
}

/// The watcher, held where both the coalescer and the shutdown can reach it.
///
/// The coalescer adds and removes the directories outside the project that the root document leads
/// through; the shutdown takes the watcher out, which stops every one of them at once and ends the
/// work that reads from it.
pub(crate) type SharedWatcher = Arc<Mutex<Option<RecommendedWatcher>>>;

/// The directories outside the project that the root document currently leads through.
pub(crate) type ExternalDirectories = BTreeMap<PathBuf, BTreeSet<OsString>>;

/// Starts watching the project and reports what happens under it.
///
/// Registration is complete when this returns, so a caller that has the watcher can rely on later
/// edits being seen. The callback only classifies and forwards; which names matter is decided
/// where the edit windows are, because the document `GET /` answers with can be any file the
/// project's `index.html` leads to.
///
/// A failure is reported through `report_failure` at the moment it happens, rather than queued for
/// someone to read later, because when it happened is what decides whether it or a caller's
/// shutdown is the reason the server stopped.
pub(crate) fn watch(
    root: &Path,
    notices: mpsc::UnboundedSender<Notice>,
    report_failure: impl Fn(String) + Send + 'static,
) -> Result<RecommendedWatcher, notify::Error> {
    #[cfg(test)]
    if REFUSED_ROOTS
        .lock()
        .expect("refused roots mutex poisoned")
        .iter()
        .any(|refused| refused == root)
    {
        return Err(notify::Error::generic("registration refused for a test"));
    }
    let mut reported: Option<usize> = None;
    // A directory link inside the project is not registered as a way into the tree behind it.
    // A name may well go through such a link — the route follows a request wherever it leads and
    // asks only that it end inside the project — but every file it can end at is a project file
    // already watched here under the path it really has. Registering the tree behind the link
    // would add nothing but this server's watch allowance spent on somebody else's directories,
    // and would report activity out there that no page can ask about. The way to the root
    // document is watched on purpose instead, one named entry at a time.
    let mut watcher = RecommendedWatcher::new(
        move |result: notify::Result<Event>| match result {
            Ok(event) => observe(event, &mut reported, &notices, &report_failure),
            Err(error) => {
                report_failure(error.to_string());
            }
        },
        Config::default().with_follow_symlinks(false),
    )?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    Ok(watcher)
}

/// Watches the links the root document is followed through, and the file it ends at.
///
/// `GET /` follows `index.html` wherever it goes, so editing the file at the end of that way, or
/// replacing one of the links along it, changes what a page is given. Each of those names is
/// watched in the directory it lives in, and only those names are accepted from those directories;
/// the rest of what lives there belongs to somebody else. Replacing a non-symlink ancestor
/// directory of that chain is not observed by this slice.
///
/// A project with no document yet is a project whose `/` answers `404`, and that is not a failure.
/// A document the route would read but this server cannot follow is: it would be served while
/// nothing watched it, so the server says so rather than start.
pub(crate) fn watch_the_way_to_the_document(
    watcher: &SharedWatcher,
    root: &Path,
) -> Result<(Option<RootResolution>, ExternalDirectories), String> {
    let document = root.join(ROOT_DOCUMENT);
    let resolution = resolve_root_document(root);
    if resolution.is_none() && std::fs::metadata(&document).is_ok_and(|entry| entry.is_file()) {
        return Err(cannot_follow(&document));
    }
    let directories = resolution
        .as_ref()
        .map(|resolution| resolution.external_directories(root))
        .unwrap_or_default();
    for directory in directories.keys() {
        register(watcher, directory).map_err(|error| error.to_string())?;
    }
    Ok((resolution, directories))
}

/// What this server says about a document it would serve but cannot watch.
fn cannot_follow(document: &Path) -> String {
    format!(
        "the document {} leads to cannot be followed",
        document.display()
    )
}

fn register(watcher: &SharedWatcher, directory: &Path) -> Result<(), notify::Error> {
    let mut held = watcher.lock().expect("watcher mutex poisoned");
    match held.as_mut() {
        Some(watcher) => watcher.watch(directory, RecursiveMode::NonRecursive),
        // The server is already closing, so there is nothing left to watch for.
        None => Ok(()),
    }
}

fn retire(watcher: &SharedWatcher, directory: &Path) {
    let mut held = watcher.lock().expect("watcher mutex poisoned");
    if let Some(watcher) = held.as_mut() {
        let _ = watcher.unwatch(directory);
    }
}

/// Turns notifications into one reload per edit window.
///
/// A notification about a file this server answers with opens an edit window; each further one
/// extends it. When the window falls quiet, one completion is published and the next qualifying
/// notification opens the following window. Edits to several files inside one window share that
/// window's single reload.
///
/// Anything this server would not answer for — a directory, a link out of the project, a kind the
/// route refuses, a name that leads nowhere — opens no window, so activity the page could never
/// ask about cannot reload it.
///
/// The returned handle finishes once the watcher that feeds it is taken away, so a shutdown can
/// wait for this work rather than abandon it.
pub(crate) fn spawn_coalescer(
    root: PathBuf,
    watcher: SharedWatcher,
    resolution: Option<RootResolution>,
    external: ExternalDirectories,
    mut notices: mpsc::UnboundedReceiver<Notice>,
    reloads: mpsc::UnboundedSender<()>,
    report_failure: impl Fn(String) + Send + 'static,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut state = Coalescer {
            root,
            watcher,
            resolution,
            external,
            report_failure,
        };
        // The one edit window this server has open, if any.
        let mut window: Option<Instant> = None;
        loop {
            tokio::select! {
                biased;
                notice = notices.recv() => match notice {
                    Some(notice) => {
                        if state.qualifies(&notice) {
                            window = Some(Instant::now() + BURST_WINDOW);
                        }
                    }
                    None => break,
                },
                () = async {
                    match window {
                        Some(deadline) => sleep_until(deadline).await,
                        None => std::future::pending().await,
                    }
                } => {
                    window = None;
                    if reloads.send(()).is_err() {
                        return;
                    }
                }
            }
        }
    })
}

struct Coalescer<Report: Fn(String)> {
    root: PathBuf,
    watcher: SharedWatcher,
    resolution: Option<RootResolution>,
    external: ExternalDirectories,
    report_failure: Report,
}

impl<Report: Fn(String)> Coalescer<Report> {
    /// Whether this notification is about a file a page could ask this server for.
    fn qualifies(&mut self, notice: &Notice) -> bool {
        let path = notice.path();
        if self.leads_to_the_document(path) {
            // The way to the document may be different now, so it is followed again before
            // anything is decided about it.
            return self.follow_the_document_again() && self.serves_a_document();
        }
        a_page_could_be_given(&self.root, path)
    }

    /// Whether a path is one of the names the document is currently reached through, or the file
    /// it currently comes from.
    fn leads_to_the_document(&self, path: &Path) -> bool {
        path == self.root.join(ROOT_DOCUMENT)
            || self.resolution.as_ref().is_some_and(|resolution| {
                resolution.is_a_step(path) || resolution.is_the_target(path)
            })
    }

    /// Whether `GET /` would answer with a document right now.
    fn serves_a_document(&self) -> bool {
        self.resolution.is_some()
    }

    /// Follows `index.html` again and watches the chain it resolves through now.
    ///
    /// Every directory the replacement chain needs is watched before any directory of the prior
    /// chain is given up, so an edit that lands while this is happening is still seen, and each
    /// directory is recorded as soon as it is watched so nothing is left watched but forgotten.
    ///
    /// Returns whether this server can still answer for the document. A document the route would
    /// read but this server cannot follow ends the server here exactly as it refuses to start:
    /// serving it while nothing watched it is the one thing this must not do.
    fn follow_the_document_again(&mut self) -> bool {
        let document = self.root.join(ROOT_DOCUMENT);
        let resolution = resolve_root_document(&self.root);
        if resolution.is_none() && std::fs::metadata(&document).is_ok_and(|entry| entry.is_file()) {
            (self.report_failure)(cannot_follow(&document));
            return false;
        }
        let directories = resolution
            .as_ref()
            .map(|resolution| resolution.external_directories(&self.root))
            .unwrap_or_default();
        for (directory, names) in &directories {
            if self.external.contains_key(directory) {
                continue;
            }
            if let Err(error) = register(&self.watcher, directory) {
                (self.report_failure)(error.to_string());
                return false;
            }
            self.external.insert(directory.clone(), names.clone());
        }
        // What is no longer on the way is dropped rather than kept: only the names in the current
        // resolution are answered for, and a server that ran for a long time would otherwise go
        // on watching every place the document has ever been.
        let retired: Vec<PathBuf> = self
            .external
            .keys()
            .filter(|directory| !directories.contains_key(*directory))
            .cloned()
            .collect();
        self.resolution = resolution;
        for directory in retired {
            self.external.remove(&directory);
            retire(&self.watcher, &directory);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{OpenOptions, create_dir_all, write},
        os::unix::fs::{PermissionsExt, symlink},
    };

    use notify::event::{AccessMode, CreateKind, DataChange, MetadataKind, RemoveKind};
    use tempfile::TempDir;
    use tokio::time::timeout;

    use super::*;

    /// How long a test waits before deciding nothing was published.
    const LONG_ENOUGH: Duration = Duration::from_millis(500);

    /// How long a test waits for something it expects.
    const GENEROUS: Duration = Duration::from_secs(5);

    /// Everything a server runs to turn edits into reloads, without the listener in front of it.
    struct Watching {
        root: PathBuf,
        reloads: mpsc::UnboundedReceiver<()>,
        failures: std::sync::mpsc::Receiver<String>,
        watcher: SharedWatcher,
        coalescer: JoinHandle<()>,
    }

    impl Watching {
        fn start(root: &Path) -> Self {
            let root = std::fs::canonicalize(root).unwrap();
            let (notices, incoming) = mpsc::unbounded_channel();
            let (failed, failures) = std::sync::mpsc::channel::<String>();
            let report = move |message: String| {
                let _ = failed.send(message);
            };
            let watcher: SharedWatcher = Arc::new(Mutex::new(Some(
                watch(&root, notices, report.clone()).unwrap(),
            )));
            let (resolution, external) =
                watch_the_way_to_the_document(&watcher, &root).expect("watching the document");
            let (published, reloads) = mpsc::unbounded_channel();
            let coalescer = spawn_coalescer(
                root.clone(),
                Arc::clone(&watcher),
                resolution,
                external,
                incoming,
                published,
                report,
            );
            Self {
                root,
                reloads,
                failures,
                watcher,
                coalescer,
            }
        }

        async fn a_reload(&mut self, what: &str) {
            timeout(GENEROUS, self.reloads.recv())
                .await
                .unwrap_or_else(|_| panic!("{what}"))
                .unwrap_or_else(|| panic!("{what}"));
        }

        async fn nothing(&mut self, what: &str) {
            if let Ok(Some(())) = timeout(LONG_ENOUGH, self.reloads.recv()).await {
                panic!("{what}");
            }
        }

        fn failure(&self) -> Option<String> {
            self.failures.try_recv().ok()
        }

        async fn stop(self) {
            self.watcher.lock().unwrap().take();
            let _ = self.coalescer.await;
        }
    }

    /// A project with a document, a module and a stylesheet, ready to be edited.
    fn a_project() -> TempDir {
        let project = TempDir::new().unwrap();
        create_dir_all(project.path().join("src")).unwrap();
        write(
            project.path().join("index.html"),
            "<script type=\"module\" src=\"/src/main.js\"></script>",
        )
        .unwrap();
        write(project.path().join("src/main.js"), "export const a = 1;\n").unwrap();
        write(
            project.path().join("src/styles.css"),
            "#app { color: red; }\n",
        )
        .unwrap();
        project
    }

    #[test]
    fn matches_only_the_files_a_request_would_ask_for() {
        let root = Path::new("/project");
        for served in [
            "/project/src/main.js",
            "/project/src/main.ts",
            "/project/src/styles.css",
            "/project/assets/mark.svg",
        ] {
            assert!(
                names_a_project_file(root, Path::new(served)),
                "{served} is served"
            );
        }
        for ignored in [
            "/project/notes.md",
            "/project/src/main.tsx",
            "/project/src/main",
            "/project/src/main.js.pending",
            "/elsewhere/src/main.js",
        ] {
            assert!(
                !names_a_project_file(root, Path::new(ignored)),
                "{ignored} is not served"
            );
        }
    }

    #[test]
    fn separates_edits_from_events_that_say_nothing() {
        assert_eq!(
            describes_an_edit(EventKind::Modify(ModifyKind::Data(DataChange::Content))),
            Some(EditKind::Changed)
        );
        assert_eq!(
            describes_an_edit(EventKind::Create(CreateKind::File)),
            Some(EditKind::Changed)
        );
        assert_eq!(
            describes_an_edit(EventKind::Modify(ModifyKind::Name(RenameMode::To))),
            Some(EditKind::Arrived)
        );
        assert_eq!(
            describes_an_edit(EventKind::Modify(ModifyKind::Name(RenameMode::Both))),
            Some(EditKind::Renamed)
        );
        assert_eq!(
            describes_an_edit(EventKind::Modify(ModifyKind::Name(RenameMode::From))),
            None,
            "the name a rename left is not a change to it"
        );
        assert_eq!(
            describes_an_edit(EventKind::Access(AccessKind::Close(AccessMode::Write))),
            None,
            "letting go of a file changed nothing by itself"
        );
        assert_eq!(
            describes_an_edit(EventKind::Access(AccessKind::Open(AccessMode::Write))),
            None,
            "opening a file is not an edit"
        );
        assert_eq!(
            describes_an_edit(EventKind::Modify(ModifyKind::Metadata(
                MetadataKind::Permissions
            ))),
            None,
            "a permission change is not an edit"
        );
        assert_eq!(
            describes_an_edit(EventKind::Remove(RemoveKind::File)),
            None,
            "removing a file is not an edit to what remains"
        );
    }

    #[test]
    fn answers_only_for_project_files_the_route_would_serve() {
        let project = a_project();
        let outside = TempDir::new().unwrap();
        let root = std::fs::canonicalize(project.path()).unwrap();
        let elsewhere = std::fs::canonicalize(outside.path()).unwrap();
        write(elsewhere.join("outside.js"), "export const outside = 1;\n").unwrap();
        write(root.join("src/notes.txt"), "not a module\n").unwrap();
        write(root.join("src/actual.ts"), "export const actual = 1;\n").unwrap();

        // A link between the two module extensions is still a module.
        symlink("actual.ts", root.join("src/module.js")).unwrap();
        assert!(is_a_served_project_file(&root, &root.join("src/module.js")));

        // A link out of the project, a name that leads to another kind, a directory and a name
        // that leads nowhere are all things this server would refuse to answer for.
        symlink(elsewhere.join("outside.js"), root.join("src/escape.js")).unwrap();
        symlink("notes.txt", root.join("src/wrong.js")).unwrap();
        create_dir_all(root.join("src/folder.css")).unwrap();
        for refused in [
            "src/escape.js",
            "src/wrong.js",
            "src/folder.css",
            "src/gone.css",
        ] {
            assert!(
                !is_a_served_project_file(&root, &root.join(refused)),
                "{refused} is not answered for"
            );
        }
    }

    #[test]
    fn says_so_when_notifications_were_lost_instead_of_carrying_on() {
        let (notices, mut sent) = mpsc::unbounded_channel();
        let (failed, failures) = std::sync::mpsc::channel::<String>();
        let report = move |message: String| {
            let _ = failed.send(message);
        };
        let mut reported = None;

        // The kernel's queue overflowed. An unknown number of notifications never arrived, so
        // this server cannot say which files changed while it was not being told.
        let overflowed = Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan);
        observe(overflowed, &mut reported, &notices, &report);

        let message = failures
            .try_recv()
            .expect("the server is told it lost notifications");
        assert!(message.contains("lost notifications"), "{message}");
        assert!(
            sent.try_recv().is_err(),
            "a lost notification was passed on as if it said something"
        );

        // An ordinary notification is still passed on.
        observe(
            Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                .add_path(PathBuf::from("/project/src/main.js")),
            &mut reported,
            &notices,
            &report,
        );
        assert_eq!(
            sent.try_recv().unwrap(),
            Notice::Changed(PathBuf::from("/project/src/main.js"))
        );
    }

    #[tokio::test]
    async fn keeps_running_when_the_document_is_taken_away() {
        let project = a_project();
        let mut watching = Watching::start(project.path());

        // A project whose document is gone is a project whose `/` answers `404`. That is an
        // answer, not a failure, and the files it still serves are still watched.
        std::fs::remove_file(watching.root.join("index.html")).unwrap();
        watching
            .nothing("taking the document away reloaded the page")
            .await;
        assert!(
            watching.failure().is_none(),
            "a project without a document is not a failure"
        );

        write(
            watching.root.join("src/main.js"),
            "export const edited = 1;\n",
        )
        .unwrap();
        watching.a_reload("a module edit is still a reload").await;
        assert!(watching.failure().is_none(), "still not a failure");
        watching.stop().await;
    }
    #[tokio::test]
    async fn stops_rather_than_answer_for_a_document_it_can_no_longer_follow() {
        let project = a_project();
        let mut watching = Watching::start(project.path());
        let root = watching.root.clone();
        let _refusal = crate::root_document::refuse_to_follow(&root);

        // The route still reads `index.html` and answers with it. Going on would serve it while
        // nothing watched it, which is what this server refuses at startup too.
        write(root.join("index.html"), "<h1>changed</h1>").unwrap();

        watching
            .nothing("a document this server cannot follow reloaded the page")
            .await;
        let message = watching
            .failure()
            .expect("the server is told it cannot answer for the document");
        assert!(message.contains("cannot be followed"), "{message}");
        watching.stop().await;
    }
    #[tokio::test]
    async fn publishes_one_reload_for_one_edit() {
        let project = a_project();
        let mut watching = Watching::start(project.path());

        write(
            watching.root.join("src/main.js"),
            "export const edited = 1;\n",
        )
        .unwrap();
        watching.a_reload("the module was edited").await;
        watching.nothing("one edit reloaded the page twice").await;
        watching.stop().await;
    }

    #[tokio::test]
    async fn edits_made_together_share_one_reload_and_a_later_edit_opens_the_next() {
        let project = a_project();
        let mut watching = Watching::start(project.path());

        // Two files edited in one go is one edit window.
        write(watching.root.join("src/main.js"), "export const a = 2;\n").unwrap();
        write(
            watching.root.join("src/styles.css"),
            "#app { color: blue; }\n",
        )
        .unwrap();
        watching.a_reload("the edit reached the page").await;
        watching
            .nothing("one edit window reloaded the page twice")
            .await;

        // The next edit is its own window.
        write(watching.root.join("src/main.js"), "export const a = 3;\n").unwrap();
        watching.a_reload("the next edit is its own window").await;
        watching.stop().await;
    }

    #[tokio::test]
    async fn publishes_a_replacement_written_and_closed_before_it_is_renamed() {
        let project = a_project();
        let mut watching = Watching::start(project.path());

        let pending = watching.root.join("src/main.js.pending");
        write(&pending, "export const replaced = 1;\n").unwrap();
        std::fs::rename(&pending, watching.root.join("src/main.js")).unwrap();

        watching.a_reload("the replacement is in place").await;
        watching
            .nothing("one replacement reloaded the page twice")
            .await;
        watching.stop().await;
    }

    #[tokio::test]
    async fn publishes_nothing_for_activity_a_page_could_never_ask_about() {
        let project = a_project();
        let mut watching = Watching::start(project.path());
        let module = watching.root.join("src/main.js");

        // Opening a served file and letting go without changing it.
        drop(OpenOptions::new().write(true).open(&module).unwrap());

        // Changing only its permissions.
        let mut permissions = std::fs::metadata(&module).unwrap().permissions();
        permissions.set_mode(0o644);
        std::fs::set_permissions(&module, permissions).unwrap();

        // Writing a file this server does not answer for, and one outside the project.
        write(watching.root.join("notes.md"), "not served\n").unwrap();

        // Renaming a directory that carries a served name, and removing a served file.
        create_dir_all(watching.root.join("src/folder.js")).unwrap();
        std::fs::rename(
            watching.root.join("src/folder.js"),
            watching.root.join("src/renamed.js"),
        )
        .unwrap();
        std::fs::remove_file(watching.root.join("src/styles.css")).unwrap();

        watching
            .nothing("something a page could never ask about reloaded it")
            .await;

        // A real edit still reaches the page.
        write(&module, "export const edited = 1;\n").unwrap();
        watching.a_reload("a real edit is still a reload").await;
        watching.stop().await;
    }

    #[tokio::test]
    async fn ignores_a_file_whose_name_no_request_could_ask_for() {
        let project = a_project();
        let mut watching = Watching::start(project.path());

        // A backslash is not something a request path may contain, so this file has no name a
        // page could ask for, and the route answers `400` for the closest request to it.
        write(
            watching.root.join("src/noise\\file.js"),
            "export const noise = 1;\n",
        )
        .unwrap();
        watching
            .nothing("a file the route would refuse reloaded the page")
            .await;

        // The file next to it, whose name a request can use, still reloads.
        write(
            watching.root.join("src/main.js"),
            "export const edited = 1;\n",
        )
        .unwrap();
        watching
            .a_reload("a file a request can name still reloads")
            .await;
        watching.stop().await;
    }

    /// Every kind this server answers for takes the same way here: the file's own path is one no
    /// request could spell, and a link that a request can spell leads to it.
    #[test]
    fn answers_for_a_served_file_a_safe_name_leads_to_whatever_it_is_called() {
        let project = a_project();
        let root = std::fs::canonicalize(project.path()).unwrap();
        let behind = root.join("bad\\dir");
        create_dir_all(&behind).unwrap();

        for (name, file, contents) in [
            ("src/alias.js", "actual.js", "export const actual = 1;\n"),
            ("src/alias.ts", "actual.ts", "export const actual = 1;\n"),
            ("src/alias.css", "actual.css", "#app { color: blue; }\n"),
            ("src/alias.svg", "actual.svg", "<svg></svg>\n"),
        ] {
            let target = behind.join(file);
            write(&target, contents).unwrap();
            assert!(
                !names_a_project_file(&root, &target),
                "{file} is not a name a request could use"
            );
            assert!(
                !a_page_could_be_given(&root, &target),
                "{file} is answered for nothing while no name leads to it"
            );

            symlink(&target, root.join(name)).unwrap();
            assert!(
                a_page_could_be_given(&root, &target),
                "{name} is answered with {file}, so an edit to it reaches a page"
            );
        }
    }

    #[test]
    fn reaches_a_file_through_a_directory_a_safe_name_leads_through() {
        let project = a_project();
        let root = std::fs::canonicalize(project.path()).unwrap();
        let behind = root.join("bad\\dir");
        create_dir_all(&behind).unwrap();
        let target = behind.join("actual.js");
        write(&target, "export const actual = 1;\n").unwrap();

        // `/src/good/actual.js` is a name every segment of which a request may use, and it is
        // answered with this file, so the way the link is spelt does not have to be.
        symlink(&behind, root.join("src/good")).unwrap();
        assert!(a_page_could_be_given(&root, &target));

        // A request follows as many links as it takes, so a file two directories deep behind names
        // no request could spell is still answered for by `/src/first/second/deeper.js`.
        let further = root.join("bad\\further");
        create_dir_all(&further).unwrap();
        let deeper = further.join("deeper.js");
        write(&deeper, "export const deeper = 1;\n").unwrap();
        symlink(&further, behind.join("second")).unwrap();
        symlink(&behind, root.join("src/first")).unwrap();
        assert!(
            a_page_could_be_given(&root, &deeper),
            "a name that goes through two links is still a name"
        );
    }

    #[test]
    fn follows_a_name_that_leaves_the_project_and_comes_back() {
        let project = a_project();
        let outside = TempDir::new().unwrap();
        let root = std::fs::canonicalize(project.path()).unwrap();
        let elsewhere = std::fs::canonicalize(outside.path()).unwrap();
        let behind = root.join("bad\\dir");
        create_dir_all(&behind).unwrap();
        let target = behind.join("actual.js");
        write(&target, "export const actual = 1;\n").unwrap();

        // Every segment of `/src/out/back/actual.js` is one a request may use. The way it takes
        // goes out of the project and back into it, and containment is decided on the file it
        // finally reaches, so this server really answers for that name.
        symlink(&elsewhere, root.join("src/out")).unwrap();
        symlink(&behind, elsewhere.join("back")).unwrap();
        assert!(
            a_page_could_be_given(&root, &target),
            "a name that leaves the project and comes back is still a name"
        );
    }

    /// Every route answers a name with the file it leads to, but not every route can answer with
    /// every file: a module response has to write URLs for what its imports resolved to, and a
    /// stylesheet is returned as the bytes it holds. So the same shape of name is a permanent
    /// refusal for one kind and an ordinary answer for the other, and watching follows each.
    #[test]
    fn answers_only_where_the_route_can_name_what_it_resolved_to() {
        use std::os::unix::ffi::OsStringExt;

        let project = a_project();
        let root = std::fs::canonicalize(project.path()).unwrap();
        let unnameable = root.join(OsString::from_vec(vec![0xff, 0xfe]));
        create_dir_all(&unnameable).unwrap();
        let module = unnameable.join("actual.js");
        let stylesheet = unnameable.join("actual.css");
        write(&module, "export const actual = 1;\n").unwrap();
        write(&stylesheet, "#app { color: blue; }\n").unwrap();
        symlink(&module, root.join("src/alias.js")).unwrap();
        symlink(&stylesheet, root.join("src/alias.css")).unwrap();

        assert!(
            !a_page_could_be_given(&root, &module),
            "the module route can never answer with a file it cannot write a URL for"
        );
        assert!(
            a_page_could_be_given(&root, &stylesheet),
            "the stylesheet route answers with the bytes this file holds"
        );
    }

    #[test]
    fn answers_for_no_file_a_safe_name_does_not_lead_to() {
        let project = a_project();
        let outside = TempDir::new().unwrap();
        let root = std::fs::canonicalize(project.path()).unwrap();
        let elsewhere = std::fs::canonicalize(outside.path()).unwrap();
        let behind = root.join("bad\\dir");
        create_dir_all(&behind).unwrap();
        let lonely = behind.join("lonely.js");
        let picture = behind.join("picture.svg");
        write(&lonely, "export const lonely = 1;\n").unwrap();
        write(&picture, "<svg></svg>\n").unwrap();
        write(elsewhere.join("outside.js"), "export const outside = 1;\n").unwrap();

        // Nothing in the project leads to it.
        assert!(
            !a_page_could_be_given(&root, &lonely),
            "nothing leads there"
        );

        // A link that leads to it, but is itself spelt in a way no request may use, is not a name
        // this file can be asked for by either.
        symlink(&lonely, behind.join("alias.js")).unwrap();
        assert!(
            !a_page_could_be_given(&root, &lonely),
            "the link is no more nameable than the file"
        );

        // A name that asks for another kind is not answered with this file.
        symlink(&picture, root.join("src/wrong.css")).unwrap();
        assert!(
            !a_page_could_be_given(&root, &picture),
            "a stylesheet name is not answered with an image"
        );

        // A file outside the project is not answered for under any name.
        assert!(
            !a_page_could_be_given(&root, &elsewhere.join("outside.js")),
            "the project answers for nothing outside itself"
        );

        // Looking for a name does follow directory links, so a link that leads back into the
        // project is followed like any other. It ends the walk rather than repeating it because
        // the directory it lands on is already among those read. That leaves this file where it
        // was: the only segment that names its directory is one no request may spell.
        symlink(&root, root.join("src/round")).unwrap();
        symlink(&behind, behind.join("round")).unwrap();
        assert!(
            !a_page_could_be_given(&root, &lonely),
            "a link back to a directory already read gave this file a name it does not have"
        );
    }

    #[tokio::test]
    async fn publishes_an_edit_made_through_a_name_the_route_answers_for() {
        let project = a_project();
        let root = std::fs::canonicalize(project.path()).unwrap();
        let behind = root.join("bad\\dir");
        create_dir_all(&behind).unwrap();
        let target = behind.join("actual.js");
        write(&target, "export const actual = 1;\n").unwrap();
        symlink(&target, root.join("src/alias.js")).unwrap();
        let mut watching = Watching::start(&root);

        // A page imports `/src/alias.js`, which the route answers with this file. An edit made
        // through that name reaches the file under the path the filesystem reports, which is one
        // no request could spell — and the page still has to be told.
        write(root.join("src/alias.js"), "export const actual = 2;\n").unwrap();
        watching
            .a_reload("an edit through a name the route answers for reloads the page")
            .await;

        // With the link gone the route answers for that file under no name, and neither does this.
        std::fs::remove_file(root.join("src/alias.js")).unwrap();
        watching
            .nothing("removing a link is not an edit to what it led to")
            .await;
        write(&target, "export const actual = 3;\n").unwrap();
        watching
            .nothing("a file no name leads to reloaded the page")
            .await;
        watching.stop().await;
    }

    #[tokio::test]
    async fn publishes_a_write_to_a_document_outside_the_project() {
        let project = a_project();
        let outside = TempDir::new().unwrap();
        let root = std::fs::canonicalize(project.path()).unwrap();
        let elsewhere = std::fs::canonicalize(outside.path()).unwrap();
        write(elsewhere.join("published.html"), "<h1>first</h1>").unwrap();
        std::fs::remove_file(root.join("index.html")).unwrap();
        symlink(elsewhere.join("published.html"), root.join("index.html")).unwrap();
        let mut watching = Watching::start(&root);

        write(elsewhere.join("published.html"), "<h1>second</h1>").unwrap();
        watching
            .a_reload("the document a page is given was rewritten")
            .await;

        // The rest of that directory is somebody else's.
        write(elsewhere.join("unrelated.html"), "<h1>unrelated</h1>").unwrap();
        watching
            .nothing("a file this server never answers with reloaded the page")
            .await;
        watching.stop().await;
    }

    #[tokio::test]
    async fn follows_the_document_to_a_new_place_outside_the_project() {
        let project = a_project();
        let outside = TempDir::new().unwrap();
        let root = std::fs::canonicalize(project.path()).unwrap();
        let elsewhere = std::fs::canonicalize(outside.path()).unwrap();
        create_dir_all(elsewhere.join("published")).unwrap();
        write(elsewhere.join("first.html"), "<h1>first</h1>").unwrap();
        write(elsewhere.join("published/second.html"), "<h1>second</h1>").unwrap();
        std::fs::remove_file(root.join("index.html")).unwrap();
        symlink(elsewhere.join("first.html"), root.join("index.html")).unwrap();
        let mut watching = Watching::start(&root);

        let pending = root.join("index.html.pending");
        symlink(elsewhere.join("published/second.html"), &pending).unwrap();
        std::fs::rename(&pending, root.join("index.html")).unwrap();
        watching
            .a_reload("the document a page is given changed")
            .await;

        // The new place is watched from the moment the link points at it.
        write(
            elsewhere.join("published/second.html"),
            "<h1>rewritten</h1>",
        )
        .unwrap();
        watching
            .a_reload("a write where the document lives now")
            .await;

        // And the old one is not this server's business any more.
        write(elsewhere.join("first.html"), "<h1>abandoned</h1>").unwrap();
        watching
            .nothing("a write to the document this server no longer answers with")
            .await;
        watching.stop().await;
    }

    #[tokio::test]
    async fn follows_the_document_when_its_link_is_replaced_rather_than_renamed() {
        let project = a_project();
        let outside = TempDir::new().unwrap();
        let root = std::fs::canonicalize(project.path()).unwrap();
        let elsewhere = std::fs::canonicalize(outside.path()).unwrap();
        write(elsewhere.join("first.html"), "<h1>first</h1>").unwrap();
        write(elsewhere.join("second.html"), "<h1>second</h1>").unwrap();
        std::fs::remove_file(root.join("index.html")).unwrap();
        symlink(elsewhere.join("first.html"), root.join("index.html")).unwrap();
        let mut watching = Watching::start(&root);

        // Pointing the link somewhere else by replacing it, the way `ln -sf` does.
        std::fs::remove_file(root.join("index.html")).unwrap();
        symlink(elsewhere.join("second.html"), root.join("index.html")).unwrap();
        watching
            .a_reload("the document a page is given changed")
            .await;

        write(elsewhere.join("second.html"), "<h1>rewritten</h1>").unwrap();
        watching
            .a_reload("a write where the document lives now")
            .await;
        watching.stop().await;
    }

    #[tokio::test]
    async fn starts_without_a_root_document_and_still_publishes_project_edits() {
        let project = a_project();
        std::fs::remove_file(project.path().join("index.html")).unwrap();
        let mut watching = Watching::start(project.path());

        write(
            watching.root.join("src/main.js"),
            "export const edited = 1;\n",
        )
        .unwrap();
        watching.a_reload("a module edit is still a reload").await;
        assert!(
            watching.failure().is_none(),
            "a project without a document yet is not a failure"
        );
        watching.stop().await;
    }

    #[tokio::test]
    async fn never_answers_for_activity_behind_a_link_that_leaves_the_project() {
        let project = a_project();
        let outside = TempDir::new().unwrap();
        let root = std::fs::canonicalize(project.path()).unwrap();
        let elsewhere = std::fs::canonicalize(outside.path()).unwrap();
        create_dir_all(elsewhere.join("deep/deeper")).unwrap();
        symlink(&elsewhere, root.join("external")).unwrap();
        symlink(elsewhere.join("outside.js"), root.join("src/escape.js")).unwrap();
        let mut watching = Watching::start(&root);

        // The route answers for nothing behind that directory link, so this server never follows
        // it into the tree there — not the directory itself, and not the directories below it.
        write(elsewhere.join("outside.js"), "export const outside = 1;\n").unwrap();
        write(elsewhere.join("noise.js"), "export const noise = 1;\n").unwrap();
        write(
            elsewhere.join("deep/deeper/buried.js"),
            "export const buried = 1;\n",
        )
        .unwrap();
        watching
            .nothing("activity outside the project reloaded the page")
            .await;

        write(
            watching.root.join("src/main.js"),
            "export const inside = 1;\n",
        )
        .unwrap();
        watching
            .a_reload("an edit inside the project still reloads")
            .await;
        watching.stop().await;
    }
}
