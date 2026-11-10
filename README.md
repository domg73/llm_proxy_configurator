# llm_proxy configurator

Website: https://ai.domg73.cc/llm_proxy/

A native Windows **GUI editor for `llm_proxy.toml` / `llm_proxy_bridge.toml`** — the companion app to [llm_proxy](https://github.com/domg73/llm_proxy). Instead of hand-editing TOML, you work in a structured two-pane window: a form-based editor on the left, a **live preview** of the exact TOML that gets written on the right.

The editor covers both configuration modes:

- **Local** — `llm_proxy.toml`: global settings (bind, token, ports) plus one or more backend profiles (exe, workdir, model, mmproj, args), with the active profile selectable at startup.
- **Bridge** — `llm_proxy_bridge.toml`: no local backend; the remote `host:port` and token of the llm_proxy that runs the backend, plus the local proxy/stats ports.

The preview updates on every keystroke and flags **out-of-sync fields** (e.g. `vision = true` without the backend's `--vision` flag, or `context_length` differing from `--max-context`) before you save, so the toml you hand to llm_proxy is always internally consistent.

## Features

- **Two modes** — a Local / Bridge tab in the header switches the whole editor (and the target file: `llm_proxy.toml` vs `llm_proxy_bridge.toml`).
- **Backend recognition** — the backend is inferred from the exe file name (`ninfer*.exe` → ninfer, `llama*.exe` → llama). The editor adapts to it: ninfer takes the model path **positionally** (no flag), llama gets `--model <path>` inserted automatically in front of the model path — and the two keep the correct flags in sync: `--vision` ↔ `--mmproj`, `--max-context` ↔ `--ctx-size`.
- **Profiles** — add (＋ New), duplicate (⧉ Duplicate) and delete (🗑 Delete) backend profiles, select them with tabs, and choose the **active profile** (the one llm_proxy starts at boot).
- **Args text area** — CLI arguments one per line: `--flag value`, or `--flag` for valueless flags. The model and mmproj fields are two-way synced with their lines in args (edit either side).
- **File pickers** — native 📂 pickers for the backend exe, the model and the mmproj file (plus drag & drop). Picking the exe auto-fills the workdir from its folder. Constraints follow the backend: the model cannot be picked before the exe is chosen, and the mmproj field is disabled for ninfer.
- **Live preview + warnings** — the exact TOML rendered on the right, with the profile in editing highlighted. Warnings above the preview catch: vision / context_length out of sync with the backend flags, empty args or a missing model path, a backend `--port` colliding with the proxy/stats port, proxy/stats ports being equal, an active profile that doesn't exist, a token out of sync with a profile's `--api-key`, and a LAN bind without a token.
- **Save / Save As** — **Ctrl+S** overwrites the file the config was loaded from (no dialog); **Ctrl+Shift+S** (or a plain Save from a fresh config) opens a Save As dialog. ⧉ Copy puts the current TOML on the clipboard.
- **Auto-load** — on start the app loads the config sitting next to the exe (`llm_proxy.toml` preferred, then `llm_proxy_bridge.toml`); with none present the editor starts empty.
- **Token helper** — 🎲 Generate produces a random 256-bit secret (64 hex) for the `token` field **and sets `--api-key <token>` in every profile's args** — the backend gate: llm_proxy presents its token on every backend hop, so each backend starts with the same secret.
- **Themes** — system / dark / light, per-browser choice persisted.

## Requirements

- Windows 10/11.
- [llm_proxy](https://github.com/domg73/llm_proxy) — the app this configures.
- To build from source: Rust toolchain (x86_64-pc-windows-msvc) + Visual Studio 2022 Build Tools (C++ / MSVC workload).

## Quick start (Windows)

1. Put `llm_proxy_configurator.exe` in the same folder as your `llm_proxy.toml` — it is loaded automatically on start (with no toml next to it, use **📂 Load** to pick one).
2. Edit the config: switch the Local / Bridge mode, fill in the profiles, and watch the **live preview** on the right.
3. **💾 Save** (Ctrl+S) overwrites the loaded file; Ctrl+Shift+S saves under a new name.
4. Run llm_proxy with that toml — it validates nothing, it just reads the file, which is why the preview's sync warnings matter.

## Configuration (`llm_proxy.toml` / `llm_proxy_bridge.toml`)

The editor manages every field llm_proxy reads; the preview is the file that gets written (commented, in the same layout llm_proxy documents).

### Global (Local mode)

| Field | Meaning |
|---|---|
| Bind | Listen address for proxy + stats servers. Disabled = the line is commented out (llm_proxy defaults to `127.0.0.1`). |
| Token | Shared secret. Empty with the toggle on = llm_proxy auto-generates a 256-bit secret on first start. Disabled = line commented out. |
| Active profile | Profile started at boot (dropdown over the defined profiles). |
| Proxy port / Stats port | The OpenAI `/v1` port and the dashboard port (must differ from each other and from every backend `--port`). |

### Profiles (Local mode, one card each)

| Field | Meaning |
|---|---|
| Profile name / model_id | Profile id (the `[profiles.<name>]` key) and the model id exposed to clients. |
| context_length | Advertised context window — kept in sync with the backend's `--max-context` (ninfer) / `--ctx-size` (llama). |
| Vision | Model is vision-capable — kept in sync with the backend's `--vision` flag (ninfer) / `--mmproj` file (llama). |
| idle_unload_secs | Stop the backend after N seconds without traffic (0 / empty = never). |
| Backend exe / Workdir | The backend executable and its working directory (auto-filled from the exe folder). |
| Model / mmproj file | The model path — positional for ninfer, `--model <path>` for llama — and (llama only) the mmproj path behind `--mmproj`. Both two-way synced with the args lines. |
| Args | The backend's CLI arguments, one `--flag value` line each. |

### Bridge (Bridge mode)

| Field | Meaning |
|---|---|
| Remote | `host:port` of the remote llm_proxy — its **[proxy] port**, not its backend. |
| Remote token | The remote's token, sent on every forwarded request (required in bridge mode). |
| Local proxy port / Local stats port | The ports clients point at, and the local dashboard mirror. |

Example — what the editor produces for one ninfer profile:

```toml
active_profile = 'ninfer'
token = ''
bind = '0.0.0.0'

[proxy]
port = 9931
stats_port = 9935

[profiles.ninfer]
exe = 'C:\ninfer\ninfer-server.exe'
workdir = 'C:\ninfer'
model_id = 'qwen3.8-27b'
context_length = 32768
vision = true
args = [
  'C:\ninfer\models\Qwen3.8-27B-IQ3_S.ninfer',
  '--max-context', '32768',
  '--host', '127.0.0.1',
  '--port', '8080',
  '--vision',
]
```

## Windows

- A single self-contained `.exe` (Tauri v2, the web UI is embedded): no console, no runtime dependencies, no install step.
- No command-line options: everything is in the window.
- The exe looks for the config **next to itself** at start (auto-load); any other file is opened with **📂 Load**.

## Building from source

- `build_windows.ps1` (Rust toolchain + VS 2022 Build Tools).

The result is a single static exe in `dist\`: no runtime dependencies.

---

## Copyright

© 2026 Domenico Giuffrida (domg73). MIT license.
