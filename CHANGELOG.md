# Changelog

## v1.0.2 — 2026-11-26

- **New llm_proxy blocks are now editable** — `[web_search]` and `[telegram]`, mirroring the llm_proxy additions: the `[web_search]` Exa API key (optional — lifts the free-tier rate limits of the keyless search endpoint) and the whole `[telegram]` section (`bot_token`, `allow_user_ids`, `system_prompt`, `history`, `thinking`, `web_search`) are available as toggles in General settings. Toggle off = the block is emitted commented out (values kept; an absent/empty `bot_token` leaves the bot off); toggle on = the active block after `[proxy]`, in the same order as llm_proxy's `toml.example`.
- `thinking` is a dropdown restricted to the six levels llm_proxy accepts (`default | off | low | medium | high | xhigh`); a loaded value outside that set raises a warning.
- New warnings: `telegram` enabled with an empty `bot_token` (the bot would stay off) and non-numeric entries in `allow_user_ids` (they are dropped from the serialized list).
- Version metadata (Cargo.toml, tauri.conf.json, exe) bumped to 1.0.2.

## v1.0.1 — 2026-11-12

- **`model_id` is now required**: a warning (`profile "X": model_id is empty`) is shown whenever a profile's `model_id` is empty — mirroring the llm_proxy v1.0.1 requirement, where `model_id` is the id clients use (composite `<profile>/<model_id>`) and must be non-empty.
- **Profile reordering**: ▲ Up / ▼ Down buttons move a profile within the list. The order is reflected in the generated TOML, the profile tabs and the `active_profile` dropdown (single source of truth: the in-memory profile order).
- **Layout**: the profile section now uses a two-row layout — a stable header (title left, actions right) and a full-width tab bar below it — so the UI stays symmetric no matter how many profiles there are.
- `llm_proxy.toml.example` refreshed from llm_proxy v1.0.1: the `model_id` note now documents the required-field semantics and the composite-id / id-translation behavior.

## v1.0.0 — 2026-11-09

Initial release.

Native Windows GUI editor for llm_proxy.toml / llm_proxy_bridge.toml: two-pane form + live TOML preview, token generator, profile sync and sanity warnings. Single static exe (Tauri v2).
