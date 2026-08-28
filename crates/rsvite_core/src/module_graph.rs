use std::{
    collections::{BTreeSet, HashMap},
    path::PathBuf,
};

#[cfg(test)]
use std::path::Path;

#[derive(Debug, Default)]
pub(crate) struct ModuleGraph {
    importees_by_importer: HashMap<PathBuf, BTreeSet<PathBuf>>,
}

impl ModuleGraph {
    pub(crate) fn replace_importees(&mut self, importer: PathBuf, importees: BTreeSet<PathBuf>) {
        self.importees_by_importer.insert(importer, importees);
    }

    #[cfg(test)]
    pub(crate) fn contains_edge(&self, importer: &Path, importee: &Path) -> bool {
        self.importees_by_importer
            .get(importer)
            .is_some_and(|importees| importees.contains(importee))
    }
}
