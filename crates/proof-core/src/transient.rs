use crate::{owned_data, Error, Proof, Result};
use std::path::{Path, PathBuf};

pub(crate) struct TemporaryIndex {
    path: PathBuf,
    #[cfg(unix)]
    folder: owned_data::RecoveryFolder,
    #[cfg(not(unix))]
    _directory: tempfile::TempDir,
}
impl TemporaryIndex {
    pub fn path(&self) -> &Path {
        &self.path
    }
}
#[cfg(unix)]
impl Drop for TemporaryIndex {
    fn drop(&mut self) {
        let _ = self.folder.delete_index();
    }
}
impl Proof {
    pub(crate) fn temporary_index(&self, workspace: &str) -> Result<TemporaryIndex> {
        let tx = rusqlite::Transaction::new_unchecked(
            &self.store.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        if !tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=?)",
            [workspace],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(Error::new(
                "DATA_RECORDS_DELETED",
                "本地仓库记录已删除，Git 操作尚未执行。",
                "Workspace removed before private index allocation",
            ));
        }
        #[cfg(unix)]
        let value = {
            let (path, folder) = owned_data::create_index_directory(&self.data_dir, workspace)?;
            TemporaryIndex { path, folder }
        };
        #[cfg(not(unix))]
        let value = {
            let root = self.data_dir.join("transient").join(workspace);
            std::fs::create_dir_all(&root)?;
            let directory = tempfile::Builder::new()
                .prefix(&uuid::Uuid::new_v4().to_string())
                .rand_bytes(0)
                .tempdir_in(root)?;
            TemporaryIndex {
                path: directory.path().to_path_buf(),
                _directory: directory,
            }
        };
        tx.commit()?;
        Ok(value)
    }
}
