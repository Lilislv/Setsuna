use rusqlite::Connection;
use std::ops::{Deref, DerefMut};
use std::sync::{Arc, OnceLock};
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

fn gate() -> Arc<RwLock<()>> {
    static GATE: OnceLock<Arc<RwLock<()>>> = OnceLock::new();
    GATE.get_or_init(|| Arc::new(RwLock::new(()))).clone()
}
pub fn reading() -> Result<OwnedRwLockReadGuard<()>, String> {
    gate().try_read_owned().map_err(|_| "Dictionary database is being restored. Try again shortly.".into())
}
pub fn replacing() -> Result<OwnedRwLockWriteGuard<()>, String> {
    gate().try_write_owned().map_err(|_| "Dictionary is in use. Wait for import or lookup to finish and retry.".into())
}
pub struct DatabaseConnection {
    connection: Connection,
    _lease: OwnedRwLockReadGuard<()>,
}
impl DatabaseConnection {
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        let lease = reading()?;
        let connection = Connection::open(path).map_err(|e| e.to_string())?;
        crate::core::database::configure_connection(&connection)?;
        Ok(Self { connection, _lease: lease })
    }
}
impl Deref for DatabaseConnection {
    type Target = Connection;
    fn deref(&self) -> &Connection { &self.connection }
}
impl DerefMut for DatabaseConnection {
    fn deref_mut(&mut self) -> &mut Connection { &mut self.connection }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restore_cannot_swap_a_database_used_by_lookup_or_import() {
        let reader = reading().unwrap();
        assert!(replacing().is_err());
        drop(reader);
        let restore = replacing().unwrap();
        assert!(reading().is_err());
        drop(restore);
        assert!(reading().is_ok());
    }
}
