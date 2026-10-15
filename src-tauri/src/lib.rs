mod db;
mod files;

use tauri::Manager;

// `tauri dev` runs a bare binary with no .app bundle, so the Dock falls back
// to a generic icon; paint the bundled artwork onto the running process.
#[cfg(all(debug_assertions, target_os = "macos"))]
fn set_dev_dock_icon() {
    use objc2::AnyThread;
    let Some(mtm) = objc2::MainThreadMarker::new() else {
        return;
    };
    let data = objc2_foundation::NSData::with_bytes(include_bytes!("../icons/icon.png"));
    if let Some(image) = objc2_app_kit::NSImage::initWithData(objc2_app_kit::NSImage::alloc(), &data) {
        unsafe {
            objc2_app_kit::NSApplication::sharedApplication(mtm)
                .setApplicationIconImage(Some(&image));
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            app.manage(db::AppState::load(db::config_path(app.handle())));
            #[cfg(all(debug_assertions, target_os = "macos"))]
            set_dev_dock_icon();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::list_connections,
            db::save_connection,
            db::delete_connection,
            db::list_groups,
            db::create_group,
            db::get_password,
            db::connect,
            db::disconnect,
            db::list_schemas,
            db::list_tables,
            db::describe_table,
            db::run_query,
            files::read_sql_file,
            files::write_sql_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
