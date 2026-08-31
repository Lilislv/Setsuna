use rusqlite::{params, Connection, OpenFlags};
use std::collections::BTreeSet;
use std::path::Path;
use std::time::Duration;

pub const DICTIONARY_SCHEMA_VERSION: i64 = 3;

const CANONICAL_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY,
        term TEXT NOT NULL,
        reading TEXT,
        definition TEXT NOT NULL,
        dict_name TEXT DEFAULT 'Unknown',
        tags TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS frequencies (
        id INTEGER PRIMARY KEY,
        term TEXT NOT NULL,
        reading TEXT,
        value INTEGER,
        display_value TEXT,
        dict_name TEXT
    );
    CREATE TABLE IF NOT EXISTS pitches (
        id INTEGER PRIMARY KEY,
        term TEXT NOT NULL,
        reading TEXT,
        position INTEGER,
        dict_name TEXT
    );
    CREATE TABLE IF NOT EXISTS pronunciations (
        id INTEGER PRIMARY KEY,
        term TEXT NOT NULL,
        reading TEXT,
        ipa TEXT NOT NULL,
        tags TEXT DEFAULT '',
        dict_name TEXT
    );
    CREATE TABLE IF NOT EXISTS dictionary_meta (
        title TEXT PRIMARY KEY,
        revision TEXT DEFAULT '',
        format INTEGER DEFAULT 0,
        index_url TEXT DEFAULT '',
        download_url TEXT DEFAULT '',
        is_updatable INTEGER DEFAULT 0,
        imported_at_ms INTEGER DEFAULT 0
    );
";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LegacyMigrationReport {
    pub legacy_rows: i64,
    pub inserted_rows: i64,
    pub dropped_legacy_table: bool,
}

pub fn configure_connection(conn: &Connection) -> Result<(), String> {
    conn.busy_timeout(Duration::from_secs(15))
        .map_err(|error| format!("Failed to configure dictionary database: {error}"))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = DEFAULT;",
    )
    .map_err(|error| format!("Failed to configure dictionary database: {error}"))
}

pub fn ensure_canonical_schema(conn: &mut Connection) -> Result<LegacyMigrationReport, String> {
    conn.execute_batch(CANONICAL_SCHEMA)
        .map_err(|error| format!("Failed to prepare dictionary database: {error}"))?;

    let report = migrate_legacy_mobile_dictionary(conn)?;
    rebuild_indexes(conn)?;
    conn.pragma_update(None, "user_version", DICTIONARY_SCHEMA_VERSION)
        .map_err(|error| format!("Failed to set dictionary schema version: {error}"))?;
    Ok(report)
}

pub fn rebuild_indexes(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_term ON entries(term);
         CREATE INDEX IF NOT EXISTS idx_reading ON entries(reading);
         CREATE INDEX IF NOT EXISTS idx_freq_term ON frequencies(term);
         CREATE INDEX IF NOT EXISTS idx_freq_reading ON frequencies(reading);
         CREATE INDEX IF NOT EXISTS idx_pitch_term ON pitches(term);
         CREATE INDEX IF NOT EXISTS idx_pitch_reading ON pitches(reading);
         CREATE INDEX IF NOT EXISTS idx_pron_term ON pronunciations(term);
         CREATE INDEX IF NOT EXISTS idx_pron_reading ON pronunciations(reading);",
    )
    .map_err(|error| format!("Failed to build dictionary indexes: {error}"))
}

pub fn table_exists(conn: &Connection, name: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        params![name],
        |row| row.get(0),
    )
    .map_err(|error| format!("Failed to inspect dictionary schema: {error}"))
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let sql = format!("PRAGMA table_info({table})");
    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| format!("Failed to inspect dictionary table columns: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Failed to inspect dictionary table columns: {error}"))?;
    for name in rows {
        if name.map_err(|error| format!("Failed to read dictionary table column: {error}"))? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn migrate_legacy_mobile_dictionary(
    conn: &mut Connection,
) -> Result<LegacyMigrationReport, String> {
    if !table_exists(conn, "dictionary")? {
        return Ok(LegacyMigrationReport::default());
    }

    let has_dict_name = table_has_column(conn, "dictionary", "dict_name")?;
    let legacy_rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM dictionary", [], |row| row.get(0))
        .map_err(|error| format!("Failed to count legacy mobile dictionary rows: {error}"))?;
    let dict_name = if has_dict_name {
        "COALESCE(NULLIF(d.dict_name, ''), 'Mobile dictionary')"
    } else {
        "'Mobile dictionary'"
    };
    let before_entries: i64 = conn
        .query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))
        .map_err(|error| format!("Failed to count canonical dictionary rows: {error}"))?;
    let sql = format!(
        "INSERT INTO entries (term, reading, definition, dict_name, tags)
         SELECT d.term,
                COALESCE(d.reading, ''),
                COALESCE(d.meanings, '[]'),
                {dict_name},
                ''
         FROM dictionary d
         WHERE NOT EXISTS (
             SELECT 1 FROM entries e
             WHERE e.term = d.term
               AND COALESCE(e.reading, '') = COALESCE(d.reading, '')
               AND e.definition = COALESCE(d.meanings, '[]')
               AND COALESCE(e.dict_name, 'Unknown') = {dict_name}
         )"
    );

    let transaction = conn
        .transaction()
        .map_err(|error| format!("Failed to start legacy dictionary migration: {error}"))?;
    let inserted_rows = transaction
        .execute(&sql, [])
        .map_err(|error| format!("Failed to migrate legacy mobile dictionary: {error}"))? as i64;
    let after_entries: i64 = transaction
        .query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))
        .map_err(|error| format!("Failed to validate migrated dictionary rows: {error}"))?;
    if after_entries < before_entries + inserted_rows {
        return Err("Legacy dictionary migration row count validation failed".to_string());
    }
    let integrity: String = transaction
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("Failed to validate dictionary integrity: {error}"))?;
    if integrity != "ok" {
        return Err(format!("Dictionary integrity check failed: {integrity}"));
    }
    transaction
        .execute("DROP TABLE dictionary", [])
        .map_err(|error| format!("Failed to retire legacy mobile dictionary table: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit legacy dictionary migration: {error}"))?;

    Ok(LegacyMigrationReport {
        legacy_rows,
        inserted_rows,
        dropped_legacy_table: true,
    })
}

pub fn installed_dictionary_names(conn: &Connection) -> Result<Vec<String>, String> {
    let mut names = BTreeSet::new();
    for table in ["entries", "frequencies", "pitches", "pronunciations"] {
        let sql = format!(
            "SELECT DISTINCT dict_name FROM {table} WHERE dict_name IS NOT NULL AND dict_name != ''"
        );
        let mut statement = conn
            .prepare(&sql)
            .map_err(|error| format!("Failed to list installed dictionaries: {error}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Failed to list installed dictionaries: {error}"))?;
        for name in rows {
            names.insert(name.map_err(|error| format!("Failed to read dictionary name: {error}"))?);
        }
    }
    Ok(names.into_iter().collect())
}

pub fn delete_dictionaries(conn: &Connection, names: &[String]) -> Result<(), String> {
    for name in names {
        for table in ["entries", "frequencies", "pitches", "pronunciations"] {
            let sql = format!("DELETE FROM {table} WHERE dict_name = ?1");
            conn.execute(&sql, params![name])
                .map_err(|error| format!("Failed to delete dictionary '{name}': {error}"))?;
        }
        conn.execute("DELETE FROM dictionary_meta WHERE title = ?1", params![name])
            .map_err(|error| format!("Failed to delete dictionary metadata '{name}': {error}"))?;
    }
    Ok(())
}

pub fn clear_dictionary_data(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "DELETE FROM entries;
         DELETE FROM frequencies;
         DELETE FROM pitches;
         DELETE FROM pronunciations;
         DELETE FROM dictionary_meta;",
    )
    .map_err(|error| format!("Failed to clear dictionary database: {error}"))
}

pub fn dictionary_entry_count(path: &Path) -> Option<i64> {
    if !path.exists() || path.metadata().ok()?.len() == 0 {
        return None;
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    if table_exists(&conn, "entries").ok()? {
        return conn
            .query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))
            .ok();
    }
    if table_exists(&conn, "dictionary").ok()? {
        return conn
            .query_row("SELECT COUNT(*) FROM dictionary", [], |row| row.get(0))
            .ok();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_mobile_dictionary_migrates_to_canonical_entries() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE dictionary (
                id INTEGER PRIMARY KEY,
                term TEXT NOT NULL,
                reading TEXT,
                meanings TEXT,
                dict_name TEXT
            );
            INSERT INTO dictionary (term, reading, meanings, dict_name)
            VALUES ('食べる', 'たべる', '[\"to eat\"]', 'Mobile JMdict');",
        )
        .unwrap();

        let report = ensure_canonical_schema(&mut conn).unwrap();
        assert_eq!(report.legacy_rows, 1);
        assert_eq!(report.inserted_rows, 1);
        assert!(report.dropped_legacy_table);
        assert!(!table_exists(&conn, "dictionary").unwrap());
        let entry: (String, String, String) = conn
            .query_row(
                "SELECT reading, definition, dict_name FROM entries WHERE term = '食べる'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(entry.0, "たべる");
        assert_eq!(entry.1, "[\"to eat\"]");
        assert_eq!(entry.2, "Mobile JMdict");
    }

    #[test]
    fn migration_deduplicates_existing_canonical_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE dictionary (
                id INTEGER PRIMARY KEY,
                term TEXT NOT NULL,
                reading TEXT,
                meanings TEXT,
                dict_name TEXT
            );
            INSERT INTO dictionary (term, reading, meanings, dict_name)
            VALUES ('読む', 'よむ', '[\"to read\"]', 'Test');
            CREATE TABLE entries (
                id INTEGER PRIMARY KEY,
                term TEXT NOT NULL,
                reading TEXT,
                definition TEXT NOT NULL,
                dict_name TEXT,
                tags TEXT DEFAULT ''
            );
            INSERT INTO entries (term, reading, definition, dict_name, tags)
            VALUES ('読む', 'よむ', '[\"to read\"]', 'Test', '');",
        )
        .unwrap();

        let report = ensure_canonical_schema(&mut conn).unwrap();
        assert_eq!(report.inserted_rows, 0);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM entries WHERE term = '読む'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
