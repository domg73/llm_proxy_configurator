//! llm_proxy configurator — Tauri shell around the web UI.
//!
//! The UI (../web) is plain static files; this crate only provides the
//! native commands the browser cannot do itself:
//!   - pick_file(kind)        native "open" dialog with per-kind filters
//!   - pick_save_file(name)   native "save" dialog with a default file name
//!   - read_text_file(path)   read a file from disk
//!   - save_text_file(p, txt) write a file to disk
//!   - default_config()       the llm_proxy*.toml sitting next to the exe (auto-load at startup)

use rfd::FileDialog;

/// "Open" dialog. `kind` selects the filter:
/// model / mmproj / exe / toml.
#[tauri::command]
fn pick_file(kind: String) -> Option<String> {
    let (title, exts): (&str, Vec<String>) = match kind.as_str() {
        "model" => ("Select model file", vec!["ninfer".into(), "gguf".into()]),
        "mmproj" => ("Select mmproj file", vec!["mmproj".into(), "gguf".into()]),
        "exe" => ("Select executable", vec!["exe".into()]),
        "toml" => ("Load configuration", vec!["toml".into()]),
        _ => ("Select file", vec![]),
    };
    let mut dlg = FileDialog::new().set_title(title);
    if !exts.is_empty() {
        dlg = dlg.add_filter("Files", &exts);
    }
    dlg.pick_file().map(|p| p.to_string_lossy().to_string())
}

/// "Save" dialog with a default file name.
#[tauri::command]
fn pick_save_file(default_name: String) -> Option<String> {
    FileDialog::new()
        .set_title("Save configuration")
        .set_file_name(default_name)
        .save_file()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_text_file(path: String, text: String) -> Result<(), String> {
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

/// Config file sitting next to the executable, if any:
/// llm_proxy.toml preferred, then llm_proxy_bridge.toml.
#[derive(serde::Serialize)]
struct DefaultConfig {
    name: String,
    path: String,
    text: String,
}

#[tauri::command]
fn default_config() -> Option<DefaultConfig> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    for name in ["llm_proxy.toml", "llm_proxy_bridge.toml"] {
        let path = dir.join(name);
        if let Ok(text) = std::fs::read_to_string(&path) {
            return Some(DefaultConfig {
                name: name.to_string(),
                path: path.to_string_lossy().to_string(),
                text,
            });
        }
    }
    None
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            pick_file,
            pick_save_file,
            read_text_file,
            save_text_file,
            default_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running the tauri application");
}
