# Changelog

## v1.0.1 — 2026-11-12

- **`model_id` is now required**: a warning (`profile "X": model_id is empty`) is shown whenever a profile's `model_id` is empty — mirroring the llm_proxy v1.0.1 requirement, where `model_id` is the id clients use (composite `<profile>/<model_id>`) and must be non-empty.
- **Profile reordering**: ▲ Up / ▼ Down buttons move a profile within the list. The order is reflected in the generated TOML, the profile tabs and the `active_profile` dropdown (single source of truth: the in-memory profile order).
- **Layout**: the profile section now uses a two-row layout — a stable header (title left, actions right) and a full-width tab bar below it — so the UI stays symmetric no matter how many profiles there are.
- `llm_proxy.toml.example` refreshed from llm_proxy v1.0.1: the `model_id` note now documents the required-field semantics and the composite-id / id-translation behavior.

## v1.0.0 — 2026-11-09

Initial release.

Native Windows GUI editor for llm_proxy.toml / llm_proxy_bridge.toml: two-pane form + live TOML preview, token generator, profile sync and sanity warnings. Single static exe (Tauri v2).
