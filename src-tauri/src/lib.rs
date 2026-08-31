pub mod can;
pub mod commands;
pub mod listener;
pub mod state;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_can_interfaces,
            commands::load_dbc,
            commands::start_can_stream,
            commands::start_recording,
            commands::start_replay,
            commands::stop_can_stream,
            commands::stop_recording,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
