#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use tauri::Manager;

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      let window = app.get_webview_window("main").unwrap();
      if cfg!(target_os = "windows") || cfg!(target_os = "macos") {
        window.set_decorations(false)?;
      }
      // Hide window until frontend signals ready — prevents white flash on Windows WebView2 bootstrap
      #[cfg(target_os = "windows")]
      window.hide()?;
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
