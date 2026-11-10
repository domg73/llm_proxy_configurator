/* llm_proxy configurator — logic
 * Standalone (browser) + Tauri bridge (window.__TAURI__).
 */

// Flag used by the backend for the mmproj file (adjust if different).
const MMPROJ_FLAG = '--mmproj';

// Known backends: how each one receives the model path in its args.
//   model: null      → positional (bare path, first arg without --)
//   model: '--model' → flag followed by the path
// UI-only concept: NOT written to the TOML (llm_proxy just runs exe + args).
const BACKENDS = {
  ninfer: { model: null, ctx: '--max-context' },
  llama:  { model: '--model', ctx: '--ctx-size' },
};
function modelFlagOf(backend) { return BACKENDS[backend]?.model ?? null; }
function ctxFlagOf(backend) { return BACKENDS[backend]?.ctx ?? null; }

// Backend recognition from the exe file name: ninfer*.exe → ninfer, llama*.exe → llama
// Backend of a profile: derived on the fly from the exe name
// (ninfer*.exe / llama*.exe); unrecognized → null (any generic OpenAI-compatible
// backend: its flags are NOT auto-managed — model stays positional, no ctx flag).
function profileBackend(p) {
  return backendFromExe(p.exe);
}

function backendFromExe(exe) {
  const base = (exe || '').split(/[\\/]/).pop() || '';
  const m = base.match(/^(ninfer|llama)/i);
  return m ? m[1].toLowerCase() : null;
}
function modelHint(backend) {
  const f = modelFlagOf(backend);
  return f ? `→ flag ${f} in args` : '→ first args line (positional)';
}
function modelPlaceholder(backend) {
  return modelFlagOf(backend) ? 'C:\\...\\model.gguf' : 'C:\\...\\model.ninfer';
}


function emptyState() {
  return {
    mode: 'local',
    bind_on: false,
    bind: '',
    token_on: false,
    token: '',
    active_profile: 'p1',
    proxy: { port: 9931, stats_port: 9935 },
    remote: '',
    bridge_token: '',
    proxy_bridge: { port: 9940, stats_port: 9941 },
    profiles: [freshProfile('p1')],
  };
}

let state = emptyState();
let currentIdx = 0; // start on the first profile
let loadedPath = null; // Tauri: path of the file this config was loaded from (Save overwrites it)
let previewScrolledProfile = null; // last profile in editing already scrolled into view in the preview

/* ================= helpers ================= */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const cur = () => state.profiles[currentIdx];

function status(msg) {
  const el = $('#status');
  el.textContent = msg || '';
  if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 6000);
}

function inTauri() { return !!(window.__TAURI__ && window.__TAURI__.core); }
function tInvoke(cmd, args) { return window.__TAURI__.core.invoke(cmd, args); }

/* ---------------- args <-> textarea ---------------- */

// Textarea format: one item per line.
//   --flag value    -> ['--flag', 'value']
//   --flag          -> ['--flag']
//   C:\...\x.ninfer -> positional (model path)
function parseArgsText(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('--')) {
      const parts = line.split(/\s+/);
      out.push(parts[0]);
      if (parts.length > 1) out.push(parts.slice(1).join(' '));
    } else {
      out.push(line);
    }
  }
  return out;
}

function argsToText(args) {
  const lines = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      lines.push(a + ' ' + args[i + 1]);
      i++;
    } else {
      lines.push(a);
    }
  }
  return lines.join('\n');
}

// Get/replace the model path in args, per backend representation:
//   flag-based (llama)  → --model <path>
//   positional (ninfer) → bare path without -- (not a flag value!)
// path === '' removes the model from args.
function setModelArg(args, path, backend) {
  const flag = modelFlagOf(backend);
  if (flag) return setFlagArg(args, flag, path);
  const out = [];
  let replaced = false;
  let prevFlagHasValue = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (prevFlagHasValue) { prevFlagHasValue = false; out.push(a); continue; } // copy the flag's value
    if (!a.startsWith('--')) {
      if (replaced) continue; // drop extra positional args
      replaced = true;
      if (path) out.push(path);
    } else {
      out.push(a);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) prevFlagHasValue = true;
    }
  }
  if (!replaced && path) out.unshift(path);
  return out;
}

function modelArgOf(args, backend) {
  const flag = modelFlagOf(backend);
  if (flag) return flagArgOf(args, flag);
  // first token that is NOT a flag value
  let prevFlagHasValue = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (prevFlagHasValue) { prevFlagHasValue = false; continue; }
    if (!a.startsWith('--')) return a;
    if (i + 1 < args.length && !args[i + 1].startsWith('--')) prevFlagHasValue = true;
  }
  return '';
}

// Get/replace a --flag value in args (removes when value is empty).
// Preserves every other flag and its value.
function setFlagArg(args, flag, value) {
  const out = [];
  let done = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      if (value) out.push(flag, value);
      i++; // skip old value
      done = true;
    } else if (args[i].startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      out.push(args[i], args[i + 1]); // copy the flag+value pair
      i++;
    } else {
      out.push(args[i]);
    }
  }
  if (!done && value) out.push(flag, value);
  return out;
}

function flagArgOf(args, flag) {
  const i = args.indexOf(flag);
  return (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--')) ? args[i + 1] : '';
}

// Sync a profile's --api-key with the token gate: checked + non-empty token →
// set it; unchecked or empty token → remove it.
function tokenSyncArg(args) {
  return setFlagArg(args, '--api-key', state.token_on ? state.token : '');
}

// Mirror the profile's vision toggle into the backend's own vision flag,
// dropping the other backend's flag — each backend has its own:
// ninfer → bare --vision; llama → --mmproj <file>. Unknown backends
// leave their args untouched.
function visionSyncArg(args, backend, on, mmproj) {
  if (backend === 'llama')
    return setFlagArg(setFlagArg(args, '--vision', ''), MMPROJ_FLAG, on ? mmproj : '');
  if (backend === 'ninfer') {
    const out = setFlagArg(args, MMPROJ_FLAG, '');
    if (!on) return out.filter(a => a !== '--vision');
    return out.includes('--vision') ? out : out.concat('--vision');
  }
  return args;
}

// Mirror a profile's context_length into its backend's own context flag:
// ninfer → --max-context, llama → --ctx-size. Value 0/empty removes the flag,
// and the other backend's flag is dropped — each backend has its own.
function ctxSyncArg(args, backend, value) {
  const flag = ctxFlagOf(backend);
  if (!flag) return args;
  const other = ctxFlagOf(backend === 'llama' ? 'ninfer' : 'llama');
  return setFlagArg(setFlagArg(args, other, ''), flag, value ? String(value) : '');
}

// Move whatever context flag is present to the given backend's representation,
// preserving the value. If no flag is present, the field value is used
// (added when non-zero). The other backend's flag is dropped (never both).
function ctxToBackend(args, backend, fieldValue = 0) {
  const flag = ctxFlagOf(backend);
  if (!flag) return args;
  const other = ctxFlagOf(backend === 'llama' ? 'ninfer' : 'llama');
  const val = flagArgOf(args, flag) || flagArgOf(args, other) || (fieldValue ? String(fieldValue) : '');
  return setFlagArg(setFlagArg(args, other, ''), flag, val);
}

/* ---------------- path helpers ---------------- */

function dirname(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : '';
}

/* ---------------- TOML output ---------------- */

function q(s) {
  s = String(s);
  if (s.includes("'")) return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  return "'" + s + "'";
}

function renderTOMLBridge(st) {
  const L = [];
  L.push('# llm_proxy — BRIDGE (remote connection) config — generated by llm_proxy-configurator');
  L.push('');
  L.push('# "host:port" of the remote llm_proxy — its [proxy] port, not its backend.');
  L.push("# LAN example: the remote machine's IP. Same machine: 127.0.0.1.");
  L.push(`remote = ${q(st.remote)}`);
  L.push('');
  if (st.bridge_token) {
    L.push("# The remote's token, if the remote's toml has one (it is sent on every");
    L.push('# forwarded request; with a wrong/missing token the remote answers 401).');
    L.push(`token = ${q(st.bridge_token)}`);
    L.push('');
  }
  L.push('[proxy]');
  L.push(`port = ${st.proxy_bridge.port}`);
  L.push(`stats_port = ${st.proxy_bridge.stats_port}`);
  return L.join('\n') + '\n';
}

function renderTOML(st) {
  if (st.mode === 'bridge') return renderTOMLBridge(st);
  const L = [];
  L.push('# llm_proxy config — generated by llm_proxy-configurator');
  L.push('');
  L.push('# Optional: listen address (default 127.0.0.1 — local only).');
  L.push('# Uncomment to expose both servers on the LAN: keep the Windows firewall');
  L.push('# exception for the proxy port and pair it with a token (below); other');
  L.push('# llm_proxy instances then connect here as bridges (remote = "<this ip>:9931").');
  const bindLine = `bind = ${q(st.bind || '0.0.0.0')}`;
  L.push(st.bind_on ? bindLine : '# ' + bindLine);
  L.push('');
  L.push('# Security option: gate every request with a shared secret.');
  L.push('# token = "" means "generate a 256-bit secret on first start" — it is');
  L.push('# persisted back into this file and printed once; copy it into the bridge');
  L.push('# configs and, in your OpenAI client, set it as the API key. /health stays open.');
  const tokLine = `token = ${q(st.token || '')}`;
  L.push(st.token_on ? tokLine : '# ' + tokLine);
  L.push('');
  L.push(`active_profile = ${q(st.active_profile || '')}`);
  L.push('');
  L.push('[proxy]');
  L.push(`port = ${st.proxy.port}`);
  L.push(`stats_port = ${st.proxy.stats_port}`);
  for (const p of st.profiles) {
    L.push('');
    L.push(`[profiles.${p.name}]`);
    L.push(`exe = ${q(p.exe)}`);
    L.push(`workdir = ${q(p.workdir)}`);
    L.push(`model_id = ${q(p.model_id)}`);
    L.push(`context_length = ${Number(p.context_length) || 0}`);
    L.push(`vision = ${p.vision ? 'true' : 'false'}`);
    if (p.idle_unload_secs) L.push(`idle_unload_secs = ${p.idle_unload_secs}`);
    L.push('args = [');
    for (let i = 0; i < p.args.length; i++) {
      const a = p.args[i];
      if (a.startsWith('--') && i + 1 < p.args.length && !p.args[i + 1].startsWith('--')) {
        L.push(`  ${q(a)}, ${q(p.args[i + 1])},`);
        i++;
      } else {
        L.push(`  ${q(a)},`);
      }
    }
    L.push(']');
  }
  return L.join('\n') + '\n';
}

/* ---------------- minimal TOML parser (for loading existing configs) ---------------- */

function stripComment(line) {
  let qch = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (qch) {
      if (qch === '"' && c === '\\') { i++; continue; }
      if (c === qch) qch = null;
    } else if (c === '"' || c === "'") qch = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function bracketsBalanced(s) {
  let depth = 0, qch = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (qch) {
      if (qch === '"' && c === '\\') { i++; continue; }
      if (c === qch) qch = null;
    } else if (c === '"' || c === "'") qch = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
  }
  return depth <= 0;
}

function parseValue(v) {
  v = v.trim();
  if (v.startsWith("'")) return v.slice(1, -1);
  if (v.startsWith('"')) {
    let s = v.slice(1, -1).replace(/\\(.)/g, (_, c) => c === '"' ? '"' : c === 'n' ? '\n' : c);
    return s;
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function parseArray(text) {
  const inner = text.trim().replace(/^\[/, '').replace(/\]$/, '');
  const tokens = inner.match(/'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|true|false|-?\d+(\.\d+)?/g) || [];
  return tokens.map(parseValue);
}

function parseTOML(text) {
  const lines = text.split(/\r?\n/).map(stripComment);
  const root = {};
  let section = root;
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    i++;
    if (!t) continue;
    let m;
    if ((m = t.match(/^\[([^\]]+)\]$/))) {
      const parts = m[1].split('.').map(s => s.trim().replace(/^(["'])(.*)\1$/, '$2'));
      let node = root;
      for (const part of parts) {
        if (typeof node[part] !== 'object' || node[part] === null || Array.isArray(node[part])) node[part] = {};
        node = node[part];
      }
      section = node;
    } else if ((m = t.match(/^([^=]+)=(.*)$/))) {
      const key = m[1].trim().replace(/^(["'])(.*)\1$/, '$2');
      let val = m[2].trim();
      if (val.startsWith('[')) {
        let buf = val;
        while (!bracketsBalanced(buf) && i < lines.length) { buf += ',' + lines[i].trim(); i++; }
        section[key] = parseArray(buf);
      } else {
        section[key] = parseValue(val);
      }
    }
  }
  return root;
}

function fromToml(root, prev) {
  const isBridge = 'remote' in root;
  const st = {
    mode: isBridge ? 'bridge' : 'local',
    bind_on: 'bind' in root,
    bind: root.bind ?? '0.0.0.0',
    token_on: 'token' in root,
    token: root.token ?? '',
    active_profile: root.active_profile ?? '',
    proxy: { port: root.proxy?.port ?? 9931, stats_port: root.proxy?.stats_port ?? 9935 },
    remote: isBridge ? String(root.remote ?? '') : (prev ? prev.remote : ''),
    bridge_token: isBridge ? String(root.token ?? '') : (prev ? prev.bridge_token : ''),
    proxy_bridge: isBridge
      ? { port: root.proxy?.port ?? 9940, stats_port: root.proxy?.stats_port ?? 9941 }
      : (prev ? prev.proxy_bridge : { port: 9940, stats_port: 9941 }),
    profiles: [],
  };
  const profs = root.profiles || {};
  for (const [k, v] of Object.entries(profs)) {
    if (typeof v !== 'object' || v === null) continue;
    st.profiles.push({
      name: k,
      exe: v.exe || '',
      workdir: v.workdir || '',
      model_id: v.model_id || '',
      context_length: v.context_length ?? 0,
      vision: !!v.vision,
      idle_unload_secs: v.idle_unload_secs ?? null,
      args: Array.isArray(v.args) ? v.args.map(String) : [],
    });
  }
  if (!st.profiles.length) st.profiles.push(freshProfile('p1'));
  if (!st.profiles.some(p => p.name === st.active_profile)) st.active_profile = st.profiles[0].name;
  return st;
}

function freshProfile(name) {
  return { name, exe: '', workdir: '', model_id: '', context_length: 0, vision: false, idle_unload_secs: null, args: [] };
}

function sanitizeName(name) {
  return (name || '').replace(/[^A-Za-z0-9_-]/g, '_') || 'profile';
}

/* ---------------- validation ---------------- */

function validate(st) {
  const w = [];
  if (st.mode === 'bridge') {
    if (!st.remote) w.push('bridge: remote is empty');
    else if (!/^[^:\s]+:\d{1,5}$/.test(st.remote)) w.push(`bridge: remote "${st.remote}" does not look like host:port`);
    if (Number(st.proxy_bridge.port) === Number(st.proxy_bridge.stats_port))
      w.push('bridge: local proxy port and stats port are the same');
    return w;
  }
  if (st.bind_on && st.bind && st.bind !== '127.0.0.1' && st.bind !== 'localhost' && !st.token_on) {
    w.push(`global: non-local bind (${st.bind}) without token — other hosts on the LAN can use the proxy without a secret`);
  }
  for (const p of st.profiles) {
    const args = p.args;
    if (!args.length) {
      w.push(`profile "${p.name}": empty args`);
      continue;
    }
    if (!modelArgOf(args, profileBackend(p))) w.push(`profile "${p.name}": model path missing (${modelFlagOf(profileBackend(p)) ? 'flag ' + modelFlagOf(profileBackend(p)) : 'first line without --'})`);
    const i = args.indexOf('--port');
    if (i >= 0 && args[i + 1]) {
      const bp = args[i + 1];
      if (bp === String(st.proxy.port)) w.push(`profile "${p.name}": --port ${bp} collides with the proxy port`);
      if (bp === String(st.proxy.stats_port)) w.push(`profile "${p.name}": --port ${bp} collides with the stats port`);
    }
    const be = profileBackend(p);
    if (be) {
      const visionFlag = be === 'llama' ? MMPROJ_FLAG : '--vision';
      if (p.vision !== args.includes(visionFlag))
        w.push(`profile "${p.name}": "vision" field not in sync with the ${visionFlag} flag in args`);
    }
    if (st.token_on && st.token) {
      const k = args.indexOf('--api-key');
      const key = k >= 0 && args[k + 1] ? args[k + 1] : '';
      if (key !== st.token)
        w.push(`profile "${p.name}": token is not in sync with --api-key in args (${key ? 'different key' : 'missing'})`);
    }
    if (!be) {
      w.push(`profile "${p.name}": backend not recognized — context_length and vision are not synced to flags (set them in args manually)`);
    } else {
      const ctxFlag = ctxFlagOf(be);
      const c = args.indexOf(ctxFlag);
      if (c >= 0 && args[c + 1] && Number(args[c + 1]) !== Number(p.context_length)) {
        w.push(`profile "${p.name}": context_length (${p.context_length}) not in sync with ${ctxFlag} (${args[c + 1]})`);
      }
      const otherCtx = be === 'llama' ? '--max-context' : '--ctx-size';
      if (args.includes(otherCtx))
        w.push(`profile "${p.name}": ${otherCtx} is the other backend's context flag (this one uses ${ctxFlag})`);
    }
  }
  if (st.proxy.port === st.proxy.stats_port) w.push('global: proxy port and stats port are the same');
  if (st.active_profile && !st.profiles.some(p => p.name === st.active_profile))
    w.push(`global: active_profile "${st.active_profile}" does not exist among the profiles`);
  return w;
}

/* ================= UI ================= */

function renderModeTabs() {
  $('#mode-local').className = 'mode-tab' + (state.mode === 'local' ? ' active' : '');
  $('#mode-bridge').className = 'mode-tab' + (state.mode === 'bridge' ? ' active' : '');
  $('#panel-local').style.display = state.mode === 'local' ? '' : 'none';
  $('#panel-bridge').style.display = state.mode === 'bridge' ? '' : 'none';
  $('#legend').style.display = state.mode === 'local' ? '' : 'none';
  if (state.mode === 'local') previewScrolledProfile = null;
}

function switchMode(m) {
  if (state.mode === m) return;
  state.mode = m;
  rebuildAll();
}

function renderBridge() {
  $('#b-remote').value = state.remote;
  $('#b-token').value = state.bridge_token;
  $('#b-port').value = state.proxy_bridge.port;
  $('#b-stats').value = state.proxy_bridge.stats_port;
}

function rebuildAll() {
  renderModeTabs();
  if (state.mode === 'local') {
    if (currentIdx >= state.profiles.length) currentIdx = state.profiles.length - 1;
    renderTabs();
    renderActiveSelect();
    renderProfile();
  } else {
    renderBridge();
  }
  renderPreview();
}

function renderTabs() {
  const tabs = $('#tabs');
  tabs.innerHTML = '';
  state.profiles.forEach((p, i) => {
    const b = document.createElement('div');
    b.className = 'tab' + (i === currentIdx ? ' active' : '');
    b.textContent = p.name;
    b.onclick = () => { currentIdx = i; rebuildAll(); };
    tabs.appendChild(b);
  });
}

function renderActiveSelect() {
  const sel = $('#f-active');
  sel.innerHTML = '';
  for (const p of state.profiles) {
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = p.name;
    sel.appendChild(o);
  }
  sel.value = state.active_profile || state.profiles[0].name;
}

function syncPickerInputs() {
  const p = cur();
  $('#pf-model').value = modelArgOf(p.args, profileBackend(p));
  $('#pf-mmproj').value = flagArgOf(p.args, MMPROJ_FLAG);
}

// The model picker needs the backend exe first: the exe name decides how the
// model path is passed (positional vs --model).
function syncModelPickEnabled() {
  const b = document.querySelector('#profile-body .pick[data-pick="model"]');
  if (!b) return;
  const on = !!cur().exe;
  b.disabled = !on;
  b.title = on ? 'Browse for the model file' : 'Select the backend exe first';
}

// The mmproj file is used only by llama.cpp (--mmproj <file>):
// for ninfer (or no exe selected) the field and the picker are disabled.
function syncMmprojPickEnabled() {
  const b = document.querySelector('#profile-body .pick[data-pick="mmproj"]');
  if (!b) return;
  const on = profileBackend(cur()) === 'llama';
  b.disabled = !on;
  b.title = on ? 'Browse for the mmproj file' : 'mmproj is only used by the llama.cpp backend';
  const f = $('#pf-mmproj');
  if (f) f.disabled = !on;
}

// Per-backend hints: --vision/--max-context for ninfer, --mmproj/--ctx-size
// for llama.cpp, generic text for unrecognized backends.
function syncBackendHints() {
  const be = profileBackend(cur());
  const llama = be === 'llama';
  const v = $('#pf-vision-hint');
  if (v) v.innerHTML = be
    ? 'in sync with the <code>' + (llama ? MMPROJ_FLAG : '--vision') + '</code> flag in args'
    : 'no auto-sync — unknown backend';
  const c = $('#pf-ctx-hint');
  if (c) c.innerHTML = be
    ? 'in sync with <code>' + ctxFlagOf(be) + '</code>'
    : 'no auto-sync — unknown backend';
}

// Switch backend: moves the model path between representations
// (positional ↔ --model) so the value is never lost.
function applyBackendChange(p, newBackend) {
  const oldB = profileBackend(p);
  if (!BACKENDS[newBackend] || oldB === newBackend) return;
  const path = modelArgOf(p.args, oldB);
  if (path) {
    p.args = setModelArg(p.args, '', oldB);          // remove the old representation
    p.args = setModelArg(p.args, path, newBackend);  // insert the new one
  }
  // same for the context flag: --max-context ↔ --ctx-size, value preserved
  // (or added from the field when no flag is present)
  p.args = ctxToBackend(p.args, newBackend, p.context_length);
  const ma = $('#pf-args'); if (ma) ma.value = argsToText(p.args);
  const hi = $('#pf-model-hint'); if (hi) hi.textContent = modelHint(newBackend);
  const mi = $('#pf-model'); if (mi) mi.placeholder = modelPlaceholder(newBackend);
  syncPickerInputs();
  renderPreview();
}

function renderProfile() {
  const p = cur();
  const body = $('#profile-body');
  body.innerHTML = `
    <div class="grid2">
      <label>Profile name
        <input id="pf-name" type="text" spellcheck="false">
      </label>
      <label>model_id (exposed to the client)
        <input id="pf-model-id" type="text" spellcheck="false">
      </label>
      <label>context_length <span class="hint" id="pf-ctx-hint">in sync with <code>--max-context</code></span>
        <input id="pf-ctx" type="number" min="1" step="1">
      </label>
      <label>idle_unload_secs <span class="hint">(0 / empty = never)</span>
        <input id="pf-idle" type="number" min="0" step="1">
      </label>
    </div>
    <label class="check">
      <input id="pf-vision" type="checkbox">
      Vision <span class="hint" id="pf-vision-hint">in sync with the <code>--vision</code> flag in args</span>
    </label>
    <div class="grid2">
      <label>Backend exe
        <div class="row">
          <input id="pf-exe" type="text" spellcheck="false" placeholder="C:\\...\\backend.exe">
          <button class="pick" data-pick="exe" title="Browse for the backend exe">📂</button>
        </div>
      </label>
      <label>Workdir <span class="hint">(auto-filled from the exe folder)</span>
        <input id="pf-workdir" type="text" spellcheck="false">
      </label>
    </div>
    <div class="grid2">
      <label>Model <span class="hint" id="pf-model-hint"></span>
        <div class="row">
          <input id="pf-model" type="text" spellcheck="false">
          <button class="pick" data-pick="model" title="Browse for the model file">📂</button>
        </div>
      </label>
      <label>mmproj file <span class="hint">→ flag <code>${MMPROJ_FLAG}</code> in args</span>
        <div class="row">
          <input id="pf-mmproj" type="text" spellcheck="false" placeholder="C:\\...\\model.mmproj">
          <button class="pick" data-pick="mmproj" title="Browse for the mmproj file">📂</button>
        </div>
      </label>
    </div>
    <label>Args <span class="hint">— one line per flag: <code>--flag value</code>, flag without a value: <code>--flag</code></span>
      <textarea id="pf-args" rows="12" spellcheck="false"></textarea>
    </label>`;

  const pEl = cur();
  $('#pf-name').value = p.name;
  $('#pf-model-id').value = p.model_id;
  $('#pf-ctx').value = p.context_length;
  $('#pf-idle').value = p.idle_unload_secs ?? '';
  $('#pf-vision').checked = !!p.vision;
  $('#pf-exe').value = p.exe;
  $('#pf-workdir').value = p.workdir;
  $('#pf-args').value = argsToText(p.args);
  $('#pf-model-hint').textContent = modelHint(profileBackend(p));
  $('#pf-model').placeholder = modelPlaceholder(profileBackend(p));
  syncPickerInputs();
  syncModelPickEnabled();
  syncMmprojPickEnabled();
  syncBackendHints();
}

/* Delegated bindings — attach ONCE to #profile-body (a persistent node that
   never gets recreated). Handlers attached to the per-render DOM could end
   up stale/dead after a re-render; delegation makes that impossible: the
   listener lives on the parent and sees every new child. */
function bindProfileDelegation() {
  const body = $('#profile-body');
  body.addEventListener('input', e => {
    const t = e.target;
    const p = cur();
    switch (t.id) {
      case 'pf-name': {
        const nn = sanitizeName(t.value);
        const old = p.name;
        p.name = nn;
        if (state.active_profile === old) state.active_profile = nn;
        renderTabs(); renderActiveSelect(); renderPreview();
        break;
      }
      case 'pf-model-id': p.model_id = t.value; renderPreview(); break;
      case 'pf-ctx': {
        const v = Number(t.value) || 0;
        p.context_length = v;
        // mirror the value into the backend's own context flag (added if missing).
        p.args = ctxSyncArg(p.args, profileBackend(p), v);
        const ma = $('#pf-args'); if (ma) ma.value = argsToText(p.args);
        renderPreview(); break;
      }
      case 'pf-idle': p.idle_unload_secs = t.value === '' ? null : (Number(t.value) || 0); renderPreview(); break;
      case 'pf-exe': {
        // Convert the model arg (positional ↔ --model) BEFORE p.exe changes,
        // so profileBackend(p) still reports the old backend.
        const beNew = backendFromExe(t.value);
        if (beNew && beNew !== profileBackend(p)) applyBackendChange(p, beNew);
        p.exe = t.value;
        p.workdir = dirname(p.exe);
        const wd = $('#pf-workdir'); if (wd) wd.value = p.workdir;
        // the context flag follows the recognized backend: converted when
        // present, added from the field when missing; unknown backends keep
        // their args untouched
        p.args = ctxToBackend(p.args, profileBackend(p), p.context_length);
        // the vision flag follows the recognized backend the same way
        const mf = $('#pf-mmproj');
        p.args = visionSyncArg(p.args, profileBackend(p), p.vision, mf ? mf.value.trim() : '');
        const ma = $('#pf-args'); if (ma) ma.value = argsToText(p.args);
        syncPickerInputs();
        syncModelPickEnabled();
        syncMmprojPickEnabled();
        syncBackendHints();
        renderPreview(); break;
      }
      case 'pf-workdir': p.workdir = t.value; renderPreview(); break;
      case 'pf-model':
        p.args = setModelArg(p.args, t.value.trim(), profileBackend(p));
        const ma = $('#pf-args'); if (ma) ma.value = argsToText(p.args);
        renderPreview(); break;
      case 'pf-mmproj': {
        const v = t.value.trim();
        p.args = setFlagArg(p.args, MMPROJ_FLAG, v);
        // the mmproj file is the llama vision switch itself: keep the toggle in sync
        p.vision = v !== '';
        const cb = $('#pf-vision'); if (cb) cb.checked = p.vision;
        const mm = $('#pf-args'); if (mm) mm.value = argsToText(p.args);
        renderPreview(); break;
      }
      case 'pf-args':
        p.args = parseArgsText(t.value);
        syncPickerInputs();
        renderPreview();
        break;
    }
  });
  body.addEventListener('change', e => {
    if (e.target.id !== 'pf-vision') return;
    const p = cur();
    p.vision = e.target.checked;
    // mirror the toggle into the backend's own vision flag: --vision for
    // ninfer, --mmproj <file> for llama (the picker's value); unknown
    // backends keep their args untouched
    const f = $('#pf-mmproj');
    p.args = visionSyncArg(p.args, profileBackend(p), p.vision, f ? f.value.trim() : '');
    const ma = $('#pf-args'); if (ma) ma.value = argsToText(p.args);
    renderPreview();
  });
  // Drag & drop on path fields: in Chrome/Edge the dropped file exposes
  // the full path (file.path); in other browsers only the file name.
  const dropIds = ['pf-model', 'pf-mmproj', 'pf-exe'];
  body.addEventListener('dragover', e => {
    if (e.target && dropIds.includes(e.target.id)) e.preventDefault();
  });
  body.addEventListener('drop', e => {
    const t = e.target;
    if (!t || !dropIds.includes(t.id)) return;
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    t.value = f.path || f.name;
    t.dispatchEvent(new Event('input', { bubbles: true }));
    if (!f.path) status('This browser does not expose the full path: only the file name was inserted — complete the path');
  });
  body.addEventListener('click', e => {
    const b = e.target.closest ? e.target.closest('.pick') : null;
    if (b) pickFile(b.dataset.pick);
  });
}

/* ---------------- preview ---------------- */

function renderPreview() {
  const toml = renderTOML(state);
  const lines = toml.split('\n');
  // the highlighted section is the profile in editing (current tab),
  // NOT the active profile (default at startup, chosen via the dropdown)
  const activeKey = `[profiles.${cur().name}]`;
  let inActive = false;
  const pre = $('#preview');
  pre.innerHTML = lines.map(l => {
    if (l.startsWith('[profiles.')) inActive = !inActive;
    if (l.startsWith('[') && !l.startsWith(activeKey)) inActive = false;
    const esc = l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return inActive ? `<span class="act">${esc}</span>` : esc;
  }).join('\n');
  // repaint nudge: some Chromium builds do not repaint the <pre> after
  // innerHTML until a reflow happens — force layout + invisible paint change
  pre.style.backgroundColor = 'rgba(0,0,0,0.01)';
  void pre.offsetHeight;
  pre.style.backgroundColor = '';
  // scroll to the section of the profile in editing — only when the tab changes
  // (never while typing), and only if it is not already visible
  const editKey = cur().name;
  if (editKey !== previewScrolledProfile) {
    previewScrolledProfile = editKey;
    const sec = pre.querySelector('.act');
    if (sec) {
      const r = sec.getBoundingClientRect();
      const p = pre.getBoundingClientRect();
      if (r.top < p.top || r.bottom > p.bottom) {
        pre.scrollTo({ top: Math.max(0, pre.scrollTop + r.top - p.top - 8), behavior: 'smooth' });
      }
    }
  }
  $('#preview-ts').textContent = 'updated ' + new Date().toLocaleTimeString('en-US', { hour12: false });
  const w = validate(state);
  const box = $('#warnings');
  if (w.length) {
    box.hidden = false;
    box.innerHTML = '<ul>' + w.map(x => `<li>${x}</li>`).join('') + '</ul>';
  } else {
    box.hidden = true;
    box.innerHTML = '';
  }
}

function setField(id, v) {
  const el = $(id);
  if (el) el.value = v;
}

/* ================= actions ================= */

function genToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function pickFile(kind) {
  let path = null;
  if (inTauri()) {
    try {
      path = await tInvoke('pick_file', { kind });
    } catch (e) { status('dialog error: ' + e.message); return; }
  } else {
    // Browser: no full-path API — fallback to manual input
    const el = $(kind === 'model' ? '#pf-model' : kind === 'mmproj' ? '#pf-mmproj' : '#pf-exe');
    el.focus();
    status('Browser mode: the picker does not expose the full path — paste the path or drag the file onto the field (in Tauri the picker works)');
    return;
  }
  if (!path) return;

  if (kind === 'model') { const el = $('#pf-model'); el.value = path; el.dispatchEvent(new Event('input', { bubbles: true })); }
  else if (kind === 'mmproj') { const el = $('#pf-mmproj'); el.value = path; el.dispatchEvent(new Event('input', { bubbles: true })); }
  else { const el = $('#pf-exe'); el.value = path; el.dispatchEvent(new Event('input', { bubbles: true })); }
}

async function loadConfig() {
  let text = null, name = '', fromPath = null;
  if (inTauri()) {
    const sel = await tInvoke('pick_file', { kind: 'toml' });
    if (!sel) return;
    try { text = await tInvoke('read_text_file', { path: sel }); name = sel.split('\\').pop(); fromPath = sel; }
    catch (e) { status('read error: ' + e.message); return; }
  } else {
    const inp = $('#load-file');
    inp.value = '';
    const file = await new Promise(res => {
      inp.onchange = () => res(inp.files[0] || null);
      inp.click();
    });
    if (!file) return;
    text = await file.text();
    name = file.name;
  }
  try {
    state = fromToml(parseTOML(text), state);
    currentIdx = Math.max(0, state.profiles.findIndex(p => p.name === state.active_profile));
    rebuildAll();
    setField('#f-bind', state.bind);
    setField('#f-token', state.token);
    setField('#f-port', state.proxy.port);
    setField('#f-stats', state.proxy.stats_port);
    $('#f-bind-on').checked = state.bind_on;
    $('#f-token-on').checked = state.token_on;
    status('Loaded ' + name + ' — ' + state.profiles.length + ' profile(s)');
    loadedPath = fromPath;
  } catch (e) {
    status('TOML parsing error: ' + e.message);
  }
}

async function saveConfig(as) {
  const text = renderTOML(state);
  const fname = state.mode === 'bridge' ? 'llm_proxy_bridge.toml' : 'llm_proxy.toml';
  if (inTauri()) {
    // Plain Save overwrites the file this config was loaded from (only when
    // its name matches the current mode, so switching local→bridge never
    // clobbers the other file). Save As (Ctrl+Shift+S) always picks a path.
    let path = (!as && loadedPath && loadedPath.split('\\').pop() === fname) ? loadedPath : null;
    if (!path) {
      path = await tInvoke('pick_save_file', { defaultName: fname });
      if (!path) return;
    }
    try {
      await tInvoke('save_text_file', { path, text });
    } catch (e) {
      status('write error: ' + e.message);
      return;
    }
    loadedPath = path;
    status('Saved to ' + path);
  } else {
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'llm_proxy.toml';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    status('Download started: ' + fname);
  }
}

async function copyTOML() {
  try {
    await navigator.clipboard.writeText(renderTOML(state));
    status('TOML copied to clipboard');
  } catch {
    status('Unable to copy (browser permissions)');
  }
}

/* Auto-load the config file sitting next to the executable (Tauri only):
   llm_proxy.toml preferred, then llm_proxy_bridge.toml. */
async function maybeLoadDefaultConfig() {
  let def = null;
  try { def = await tInvoke('default_config'); } catch {}
  if (!def) { status('No llm_proxy.toml next to the app — starting empty'); return; }
  try {
    state = fromToml(parseTOML(def.text), state);
    currentIdx = Math.max(0, state.profiles.findIndex(p => p.name === state.active_profile));
    rebuildAll();
    setField('#f-bind', state.bind);
    setField('#f-token', state.token);
    setField('#f-port', state.proxy.port);
    setField('#f-stats', state.proxy.stats_port);
    $('#f-bind-on').checked = state.bind_on;
    $('#f-token-on').checked = state.token_on;
    status('Auto-loaded ' + def.name + (state.mode === 'bridge' ? ' (bridge)' : ' (local)'));
    loadedPath = def.path;
  } catch (e) {
    status('TOML parsing error: ' + e.message);
  }
}

/* ================= init ================= */

function init() {
  bindProfileDelegation();

  // mode tabs (local / bridge)
  $('#mode-local').onclick = () => switchMode('local');
  $('#mode-bridge').onclick = () => switchMode('bridge');
  // bridge fields
  $('#b-remote').addEventListener('input', e => { state.remote = e.target.value; renderPreview(); });
  $('#b-token').addEventListener('input', e => { state.bridge_token = e.target.value; renderPreview(); });
  $('#b-port').addEventListener('input', e => { state.proxy_bridge.port = Number(e.target.value) || 0; renderPreview(); });
  $('#b-stats').addEventListener('input', e => { state.proxy_bridge.stats_port = Number(e.target.value) || 0; renderPreview(); });
  // global fields
  $('#f-bind-on').checked = state.bind_on;
  $('#f-token-on').checked = state.token_on;
  $('#f-bind').value = state.bind;
  $('#f-token').value = state.token;
  $('#f-port').value = state.proxy.port;
  $('#f-stats').value = state.proxy.stats_port;

  $('#f-bind').oninput = e => { state.bind = e.target.value.trim() || '0.0.0.0'; renderPreview(); };
  $('#f-token').oninput = e => { state.token = e.target.value.trim(); renderPreview(); };
  $('#f-bind-on').onchange = e => { state.bind_on = e.target.checked; renderPreview(); };
  $('#f-token-on').onchange = e => {
    state.token_on = e.target.checked;
    // keep every profile's --api-key in sync with the token gate.
    for (const p of state.profiles) p.args = tokenSyncArg(p.args);
    renderProfile(); renderPreview();
  };
  $('#f-port').oninput = e => { state.proxy.port = Number(e.target.value) || 0; renderPreview(); };
  $('#f-stats').oninput = e => { state.proxy.stats_port = Number(e.target.value) || 0; renderPreview(); };
  $('#f-active').onchange = e => {
    state.active_profile = e.target.value;
    currentIdx = state.profiles.findIndex(p => p.name === e.target.value);
    if (currentIdx < 0) currentIdx = 0;
    renderTabs(); renderProfile(); renderPreview();
  };

  $('#btn-token').onclick = () => {
    state.token = genToken();
    state.token_on = true;
    // the backend gate: the proxy presents its token on every backend hop, so
    // every profile starts its backend with the SAME secret (--api-key).
    for (const p of state.profiles) p.args = setFlagArg(p.args, '--api-key', state.token);
    $('#f-token').value = state.token;
    $('#f-token-on').checked = true;
    renderProfile();
    renderPreview();
    status('256-bit token generated — --api-key <token> set on all profiles');
  };
  $('#btn-token-clear').onclick = () => {
    state.token = '';
    for (const p of state.profiles) p.args = setFlagArg(p.args, '--api-key', '');
    $('#f-token').value = '';
    renderProfile(); renderPreview();
  };

  $('#btn-load').onclick = loadConfig;
  $('#btn-save').onclick = () => saveConfig(false);
  $('#btn-copy').onclick = copyTOML;

  $('#btn-add').onclick = () => {
    let n = 'p' + (state.profiles.length + 1);
    while (state.profiles.some(p => p.name === n)) n += '_';
    const np = freshProfile(n);
    np.args = tokenSyncArg(np.args); // new profile inherits the token gate
    state.profiles.push(np);
    currentIdx = state.profiles.length - 1;
    rebuildAll();
  };
  $('#btn-dup').onclick = () => {
    const src = cur();
    let n = src.name + '_copy';
    while (state.profiles.some(p => p.name === n)) n += '_';
    const cp = structuredClone({ ...src, name: n });
    cp.args = tokenSyncArg(cp.args); // keep the copy in sync with the token gate
    state.profiles.push(cp);
    currentIdx = state.profiles.length - 1;
    rebuildAll();
  };
  $('#btn-del').onclick = () => {
    if (state.profiles.length <= 1) { status('Cannot delete the last profile'); return; }
    const wasActive = cur().name === state.active_profile;
    state.profiles.splice(currentIdx, 1);
    if (currentIdx >= state.profiles.length) currentIdx = state.profiles.length - 1;
    if (wasActive) state.active_profile = cur().name;
    rebuildAll();
  };

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveConfig(e.shiftKey); }
  });

  rebuildAll();
  if (inTauri()) maybeLoadDefaultConfig();
}

if (typeof document !== 'undefined') init();

// test hooks (node)
if (typeof module !== 'undefined') module.exports = { parseTOML, renderTOML, fromToml, parseArgsText, argsToText, setModelArg, setFlagArg, modelArgOf, modelFlagOf, ctxFlagOf, ctxSyncArg, ctxToBackend, tokenSyncArg, visionSyncArg, profileBackend, validate, BACKENDS, backendFromExe };
