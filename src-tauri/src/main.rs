#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use tauri::Manager;

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(target_os = "windows") {
        let window = app.get_webview_window("main").unwrap();
        window.set_decorations(false)?;
      }
      Ok(())
    })
    .plugin(tauri_plugin_window_state::Builder::new().build())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![""])
        ))
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
