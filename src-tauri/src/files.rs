use std::fs;

/// Reads a SQL file picked through the native dialog; invalid UTF-8 is
/// replaced rather than failing the whole load.
#[tauri::command]
pub fn read_sql_file(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub fn write_sql_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| format!("Could not write {path}: {e}"))
}
