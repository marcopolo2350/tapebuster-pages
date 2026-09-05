import { C } from './systems/crash-schema.js';
// SUBSCRIPTION-FIRST STARTUP (phase-3 directive §1-§3, §6, §24).
//
// This file is the entire module graph until the user has answered "what
// services do you have?" — importing main.js pulls the 122,948-title catalog
// through a JSON parse that transiently spikes the heap past 400 MB, so the
// heavy world may not begin until the choice is made. The measured order:
//
//   app shell (this file, no heavy imports)
//     → WELCOME / service picker  (first run)  ·  WELCOME BACK (returning)
//       → persist services + filter
//         → import('./main.js')   — catalog, projection, occupancy, world
//           → existing STEP INSIDE gate
//
// The inventory projection therefore knows the session's services before a
// single fixture or texture exists (§6), and MY SERVICES occupancy is right
// on the very first frame. Changing services later uses the same in-store
// flow it always has — the building is never rebuilt.
//
// The provider list is the canonical registry, duplicated NOWHERE: it is the
// one import this file allows itself, and it is a data module.
import { SUBSCRIPTION_PROVIDERS } from './data/watchability.js';

const $ = (id) => document.getElementById(id);
// Built from a string so no source-level escaping can mangle it — this file
// has already been broken twice that way.
const NL = String.fromCharCode(10);

// CRASH FORENSICS (iPhone repair). Safari gives a killed tab no console and
// no error — just "a problem repeatedly occurred". So every boot milestone
// stamps a breadcrumb into localStorage, pagehide marks a clean exit, and if
// a session ends any other way the NEXT load knows exactly which stage died
// and says so on the welcome screen, where the user can read it to us.
let LAST_CRASH = null;
let LAST_ALIVE = null;
let LAST_ERROR = null;
try {
  // THE ACTUAL ERROR, not just the stage it died at. main.js now installs
  // window.onerror / unhandledrejection handlers and records boot rejections,
  // so for the first time a crash can name a cause rather than a position.
  LAST_ERROR = localStorage.getItem('tb_lasterror');
  localStorage.removeItem('tb_lasterror');
  const prev = localStorage.getItem('tb_bootcrumb');
  if (prev && prev !== 'closed') {
    LAST_CRASH = prev;
    LAST_ALIVE = localStorage.getItem('tb_alive');
    localStorage.setItem('tb_lastcrash', prev);
    if (LAST_ALIVE) localStorage.setItem('tb_lastalive', LAST_ALIVE);
    console.warn('previous session ended uncleanly at:', prev, LAST_ALIVE ? `(survived ${LAST_ALIVE})` : '(died before entry)');
  }
  localStorage.removeItem('tb_alive');
  localStorage.setItem('tb_bootcrumb', 'onboard');
  addEventListener('pagehide', () => { try { localStorage.setItem('tb_bootcrumb', 'closed'); } catch { /* full */ } });
} catch { /* no storage — forensics degrade silently */ }

// Did the last session die BEFORE the shopper got inside? Those stages are
// the memory-hungry build; anything from 'entered' onward is a different
// (and much rarer) problem, so it must not trigger a capacity offer.
const POST_ENTRY = /^(entered|stable-|radio-started|closed)/;
const preEntryCrash = () => !!LAST_CRASH && !POST_ENTRY.test(LAST_CRASH);

// The store's scale is only ever reduced by an explicit human choice. A
// device that cannot hold the full 20,000-title build otherwise gets a crash
// loop and no way out — so after a pre-entry death we say what happened and
// OFFER a smaller build. Never automatic, always reversible in Settings.
const LIGHT_STEPS = [8000, 4000, 2000];
function nextLighterCapacity() {
  const cur = Number(localStorage.getItem('tb_capacity')) || 0;
  return LIGHT_STEPS.find(c => !cur || c < cur) ?? LIGHT_STEPS[LIGHT_STEPS.length - 1];
}

/**
 * The last seconds before the tab died, read back from the ring buffer.
 * Milestone crumbs saturated and told us nothing about what the device was
 * doing; these rows do. Rendered compactly enough to read off a phone.
 */
function crashRing(host) {
  let raw = null, hwmRaw = null;
  try {
    raw = localStorage.getItem('tb_ring');
    hwmRaw = localStorage.getItem('tb_hwm');
  } catch { /* no storage */ }
  if (!raw && !hwmRaw) return;

  const box = document.createElement('div');
  box.style.cssText = 'margin:12px auto 0;max-width:560px;padding:8px 10px;border:1px solid rgba(255,255,255,.18);border-radius:8px;text-align:left;font-size:.72em;opacity:.85';

  // THE MONOTONIC RECORD FIRST. It is the one thing that survives a kill that
  // lands mid-write, and it answers "how much work had the browser been asked
  // to do" — which residency figures never could.
  let hwm = null;
  if (hwmRaw) {
    try { hwm = JSON.parse(hwmRaw); } catch { /* truncated by the kill */ }
  }
  if (hwm) {
    const h = document.createElement('div');
    h.style.cssText = 'margin-bottom:6px;line-height:1.5';
    h.textContent =
      `Last session: alive ${hwm.alive}s · worst frame ${hwm.worstFrameMs}ms · ${hwm.longFrames} long frames\n` +
      `fetched ${hwm.fetches} (${hwm.failed} failed) · DECODED ${hwm.decodedMiB} MiB cumulative\n` +
      // THE PAIR THAT ACTUALLY DISCRIMINATES. A refetch ratio near 1.0 means the
      // store simply has a lot of posters; well above 1.0 means the same poster
      // is being decoded repeatedly, which is a defect with a fix.
      (hwm.uniqueTitles
        ? `distinct titles ${hwm.uniqueTitles} · REFETCH ${hwm.refetchRatio}x` +
          (hwm.alive ? ` · ${(hwm.decodedMiB / hwm.alive).toFixed(1)} MiB/s\n` : '\n')
        : '') +
      `GL textures created ${hwm.texCreated} / disposed ${hwm.texDisposed} · ${hwm.megatexels} Mtexels uploaded\n` +
      `peak resident textures ${hwm.peakTextures} · peak posters held ${hwm.peakHeld} · backlog ${hwm.backlog}` +
      // Phrased so it cannot be read as a memory figure: it is structurally
      // equal to `released`, because no HTMLImageElement has close().
      (hwm.unfreeable ? `\nreleases with no deterministic free (always == released): ${hwm.unfreeable}` : '') +
      (hwm.ctxLost ? `\nWebGL context lost ${hwm.ctxLost}x` : '') +
      (hwm.peakHeapMiB > 0 ? `\npeak JS heap ${hwm.peakHeapMiB} MiB` : '\nJS heap: not reported by this browser');
    h.style.whiteSpace = 'pre-wrap';
    box.appendChild(h);

    // CURRENT vs PEAK, side by side. This is the shape that distinguishes a
    // leak (current tracks peak and both climb every traversal) from bounded
    // caching (rises, then plateaus) from transient pressure (peak high,
    // current low). Cumulative totals cannot tell those apart.
    if (hwm.res && hwm.resMax) {
      const r = hwm.res, m = hwm.resMax;
      const row = (k, label) => `${label.padEnd(13)}${String(r[k] ?? 0).padStart(8)}${String(m[k] ?? 0).padStart(8)}`;
      const p2 = document.createElement('pre');
      p2.style.cssText = 'margin:6px 0 0;font-size:.92em;line-height:1.35';
      p2.textContent = [
        'resource        now    peak',
        row('coverMiB', 'cover MiB'),
        row('base', 'base tex'),
        row('mid', 'mid tex'),
        row('detail', 'detail tex'),
        row('pooled', 'pooled'),
        row('held', 'posters held'),
        row('inFlight', 'in flight'),
        row('claimed', 'claims'),
        row('textures', 'GL textures'),
        row('geometries', 'GL geometry'),
        row('npcs', 'NPCs'),
        row('detailTitles', 'detail recs'),
        row('backlog', 'backlog'),
      ].join(NL);
      box.appendChild(p2);
    }
  }

  const rows = (raw || '').split(';').filter(Boolean).map((r) => r.split(',').map(Number));
  if (rows.length) {
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:6px 0 0;overflow-x:auto;font-size:.92em;line-height:1.35';
    const G = ['ok', 'str', 'CRIT'];
    const lines = ['    t  gov  fps frmw  mv  job cmt bklg  tex  held decMiB  uniq'];
    for (const r of rows.slice(-14)) {
      lines.push([
        (r[C.t] / 10).toFixed(1).padStart(6),
        (G[r[C.gov]] || '?').padStart(5),
        String(r[C.fps]).padStart(5),
        String(r[C.frame]).padStart(5),
        String(r[C.moving] ? 'Y' : '.').padStart(4),
        String(r[C.job]).padStart(5),
        String(r[C.cmt]).padStart(4),
        String(r[C.backlog]).padStart(5),
        String(r[C.tex]).padStart(5),
        String(r[C.held]).padStart(6),
        String(r[C.decMiB]).padStart(7),
        String(r[C.uniq]).padStart(6),
      ].join(''));
    }
    pre.textContent = lines.join('\n');
    box.appendChild(pre);
  }

  // The whole point is that this reaches me. Reading 36 columns off a phone by
  // eye is not a reporting mechanism.
  const btn = document.createElement('button');
  btn.textContent = 'Copy crash data';
  btn.style.cssText = 'margin-top:8px;padding:6px 10px;font:inherit;font-size:1em;border-radius:6px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.08);color:inherit';
  btn.onclick = () => {
    const payload = [
      'tb_hwm: ' + (hwmRaw || '(none)'),
      'tb_lasterror: ' + (() => { try { return localStorage.getItem('tb_lasterror') || '(none)'; } catch { return '(none)'; } })(),
      'tb_lastcrash: ' + (() => { try { return localStorage.getItem('tb_lastcrash') || '(none)'; } catch { return '(none)'; } })(),
      'tb_lastalive: ' + (() => { try { return localStorage.getItem('tb_lastalive') || '(none)'; } catch { return '(none)'; } })(),
      'tb_ring: ' + (raw || '(none)'),
      // THE RADIO PATH. "The playlists don't work" is unanswerable without
      // this. A blocked play emits NO error at all; an embed-disabled video
      // emits 101 or 150; a region-locked one emits 150; a dead playlist emits
      // nothing. None of it survives a reload. Every step from init to PLAYING
      // is recorded here, in order, and it never appears over the store.
      // TIME TO WALK AROUND — the only startup number that matters. Four
      // moments, plus whether this was a cold or a warm load, so "is the
      // second visit faster" is answerable from a device rather than guessed.
      'tb_boot: ' + (() => {
        try {
          const b = window.__tbBoot;
          if (!b) return '(none)';
          return NL
            + `  first screen        ${b.firstScreen}s` + NL
            + `  progress complete   ${b.progressComplete}s` + NL
            + `  world ready         ${b.worldReady}s` + NL
            + `  FIRST PLAYABLE      ${b.firstPlayableFrame}s` + NL
            + `  load                ${b.cache ? (b.cache.warm ? 'WARM' : 'COLD') : 'unknown'}`
            + (b.cache ? ` (${b.cache.cached}/${b.cache.of} resources from cache)` : '');
        } catch { return '(unreadable)'; }
      })(),
      'tb_radiolog: ' + (() => {
        try {
          const v = JSON.parse(localStorage.getItem('tb_radiolog') ?? '[]');
          if (!Array.isArray(v) || !v.length) return '(none: the radio never started)';
          return NL + v.map((r) => {
            const { t, event, ...rest } = r;
            const bits = Object.entries(rest).map(([k, x]) => `${k}=${x}`).join(' ');
            return `${String(t).padStart(7)}s  ${event}${bits ? '  ' + bits : ''}`;
          }).join(NL);
        } catch { return '(unreadable)'; }
      })(),
    ].join('\n\n');
    const done = () => { btn.textContent = 'Copied. Paste it to Claude.'; };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(payload).then(done, () => fallback());
    else fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = payload;
      ta.style.cssText = 'width:100%;height:120px;font-size:.8em';
      box.appendChild(ta);
      ta.select();
      btn.textContent = 'Select all and copy';
    }
  };
  box.appendChild(btn);

  host.appendChild(box);
}

// The recorded exception, if the last session produced one. A stage crumb
// says WHERE; this says WHAT — and until now nothing in the app could answer
// the second question at all.
function errorNote(host) {
  if (!LAST_ERROR) return;
  const p = document.createElement('p');
  p.style.cssText = 'opacity:.55;font-size:.72em;margin:6px 0 0;word-break:break-word;font-family:ui-monospace,Menlo,monospace';
  p.textContent = LAST_ERROR;
  host.appendChild(p);
}

function crashNote(host) {
  if (!LAST_CRASH) return;
  const cur = Number(localStorage.getItem('tb_capacity')) || 0;
  if (!preEntryCrash()) {
    const p = document.createElement('p');
    p.style.cssText = 'opacity:.6;font-size:.78em;margin:10px 0 0';
    // BOTH numbers, because one alone misleads: the stage says which
    // milestone was passed, the heartbeat says how long the tab actually
    // lived. A stage marker is a position, never a cause.
    p.textContent = LAST_ALIVE
      ? `Last visit: reached "${LAST_CRASH}", then ran ${LAST_ALIVE} before ending unexpectedly.`
      : `Last visit ended unexpectedly at: ${LAST_CRASH} (before entering).`;
    host.appendChild(p);
    errorNote(host);
    return;
  }
  errorNote(host);
  const smaller = nextLighterCapacity();
  const box = document.createElement('div');
  box.style.cssText = 'margin:14px auto 0;max-width:420px;padding:10px 12px;border:1px solid rgba(242,183,5,.45);border-radius:10px;text-align:left';
  box.innerHTML = `
    <b style="font-size:.9em">This device ran out of memory last time</b>
    <p style="opacity:.8;font-size:.82em;margin:6px 0 8px">
      The build stopped at <i>${LAST_CRASH}</i>${cur ? ` on a ${cur.toLocaleString('en-US')}-title store` : ''}.
      A smaller store fits in less memory, with the same building style and the same rules,
      fewer titles on the shelves. You can go back to the full
      ${cur ? '' : '20,000-title '}store any time in Settings.
    </p>
    <button id="ob-light" class="gold" style="padding:8px 14px;font-size:.9em">
      BUILD A LIGHTER STORE (${smaller.toLocaleString('en-US')} TITLES)
    </button>`;
  host.appendChild(box);
  box.querySelector('#ob-light').onclick = () => {
    localStorage.setItem('tb_capacity', String(smaller));
    startWorld();
  };
}

function readServices() {
  try { return new Set(JSON.parse(localStorage.getItem('tb_services') || '[]')); }
  catch { return new Set(); }
}
const onboarded = () => localStorage.getItem('tb_onboarded') === '1';

function startWorld() {
  // THE ONE CLICK THAT DOES EVERYTHING. This handler is the only user
  // gesture the flow needs, so it unlocks the audio here — the store now
  // AUTO-ENTERS when it finishes building (the second "STEP INSIDE" button
  // was the same decision asked twice), and main.js adopts this context
  // rather than creating a suspended one it could never resume.
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume();
    window.__tbAudioCtx = ctx;
  } catch { /* no audio — the store still works */ }
  $('onboard')?.remove();
  $('load-status').textContent = 'Stocking your store…';
  // The heaviest un-instrumented window is the module import itself: the
  // snapshot JSONs parse during it, BEFORE main.js can stamp a stage. A
  // death here used to read as 'onboard' — indistinguishable from dying at
  // the picker.
  try { localStorage.setItem('tb_bootcrumb', 'loading-world-data'); } catch { /* full */ }
  import('./main.js');
}

function renderPicker(preselected) {
  const chosen = new Set(preselected);
  // THE INVENTORY MODE IS THE USER'S CHOICE, MADE HERE (emergency onboarding
  // repair): the old copy — "Your store stocks what you can watch" — hard-
  // coded MODE A's semantics into the welcome screen as if the system had
  // already decided. It has not. The radio below presents both experiences
  // in the same words Settings uses; MY SERVICES ONLY is preselected as the
  // default, visibly changeable, never mandatory.
  let invChoice = localStorage.getItem('tb_inv_mode') === 'full' ? 'full' : 'services';
  const host = document.createElement('div');
  host.id = 'onboard';
  host.style.cssText = 'position:relative;z-index:5;max-width:560px;margin:0 auto;text-align:center;font-family:inherit;';
  host.innerHTML = `
    <h2 style="letter-spacing:.08em;margin:10px 0 4px">WELCOME TO BINGEBUSTER</h2>
    <p style="opacity:.85;margin:0 0 12px">Build your store around what you watch.</p>
    <h3 style="letter-spacing:.06em;font-size:.95em;margin:0 0 8px">WHAT SERVICES DO YOU HAVE?</h3>
    <div id="ob-svcs" style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-bottom:14px"></div>
    <h3 style="letter-spacing:.06em;font-size:.95em;margin:0 0 8px">HOW DO YOU WANT YOUR STORE STOCKED?</h3>
    <div id="ob-inv" style="display:flex;flex-direction:column;gap:8px;max-width:420px;margin:0 auto 8px;text-align:left">
      <button data-inv="services" style="padding:10px 14px;border-radius:10px;text-align:left">
        <b>● MY SERVICES ONLY</b><br>
        <span style="opacity:.8;font-size:.88em">Only stock titles available through my selected services.</span>
      </button>
      <button data-inv="full" style="padding:10px 14px;border-radius:10px;text-align:left">
        <b>○ FULL STORE + DISCOVERY</b><br>
        <span style="opacity:.8;font-size:.88em">Fill the store with up to 20,000 titles, prioritizing my services while leaving room for discovery.</span>
      </button>
    </div>
    <p style="opacity:.6;font-size:.82em;margin:0 0 14px">You can change this anytime in Settings.</p>
    <div style="display:flex;gap:10px;justify-content:center">
      <button id="ob-build" class="gold" style="font-size:1.05em;padding:10px 22px">BUILD MY STORE</button>
      <button id="ob-all" class="ghost" style="padding:10px 16px">ENTER WITH ALL SERVICES</button>
    </div>`;
  crashNote(host);
  crashRing(host);
  $('loading').insertBefore(host, $('load-status'));

  const wrap = $('ob-svcs');
  for (const name of SUBSCRIPTION_PROVIDERS) {
    const b = document.createElement('button');
    b.textContent = (chosen.has(name) ? '☑ ' : '☐ ') + name;
    b.style.cssText = 'padding:8px 12px;border-radius:8px;';
    b.onclick = () => {
      if (chosen.has(name)) chosen.delete(name); else chosen.add(name);
      b.textContent = (chosen.has(name) ? '☑ ' : '☐ ') + name;
      b.classList.toggle('active', chosen.has(name));
    };
    b.classList.toggle('active', chosen.has(name));
    wrap.appendChild(b);
  }
  const invBtns = [...host.querySelectorAll('#ob-inv button')];
  const paintInv = () => invBtns.forEach(b => {
    const on = b.dataset.inv === invChoice;
    b.classList.toggle('active', on);
    b.querySelector('b').textContent = (on ? '● ' : '○ ')
      + (b.dataset.inv === 'services' ? 'MY SERVICES ONLY' : 'FULL STORE + DISCOVERY');
  });
  invBtns.forEach(b => b.onclick = () => { invChoice = b.dataset.inv; paintInv(); });
  paintInv();
  $('ob-build').onclick = () => {
    localStorage.setItem('tb_services', JSON.stringify([...chosen]));
    localStorage.setItem('tb_filter', chosen.size ? 'mine' : 'all');
    localStorage.setItem('tb_inv_mode', invChoice);   // the user's explicit choice
    localStorage.setItem('tb_onboarded', '1');
    startWorld();
  };
  $('ob-all').onclick = () => {
    localStorage.setItem('tb_filter', 'all');
    localStorage.setItem('tb_inv_mode', invChoice);
    localStorage.setItem('tb_onboarded', '1');
    startWorld();
  };
}

function renderWelcomeBack(services) {
  const host = document.createElement('div');
  host.id = 'onboard';
  host.style.cssText = 'position:relative;z-index:5;max-width:520px;margin:0 auto;text-align:center;';
  const list = services.size ? [...services].join(' · ') : 'All services';
  const modeLabel = localStorage.getItem('tb_inv_mode') === 'full'
    ? 'FULL STORE + DISCOVERY' : 'MY SERVICES ONLY';
  host.innerHTML = `
    <h2 style="letter-spacing:.08em;margin:10px 0 4px">WELCOME BACK</h2>
    <p style="opacity:.9;margin:0 0 4px">${list}</p>
    <p style="opacity:.6;font-size:.85em;margin:0 0 14px">${modeLabel} · change anytime in Settings</p>
    <div style="display:flex;gap:10px;justify-content:center">
      <button id="ob-enter" class="gold" style="font-size:1.05em;padding:10px 22px">ENTER STORE</button>
      <button id="ob-change" class="ghost" style="padding:10px 16px">CHANGE SERVICES</button>
    </div>`;
  crashNote(host);
  crashRing(host);
  $('loading').insertBefore(host, $('load-status'));
  $('ob-enter').onclick = startWorld;
  $('ob-change').onclick = () => { host.remove(); renderPicker(services); };
}

// QA hook: ?onboard=skip preserves every automated boot flow unchanged.
const skip = new URLSearchParams(location.search).get('onboard') === 'skip';
if (skip || (onboarded() && sessionStorage.getItem('tb_seen_welcome') === '1')) {
  startWorld();
} else if (onboarded()) {
  sessionStorage.setItem('tb_seen_welcome', '1');
  renderWelcomeBack(readServices());
} else {
  renderPicker(readServices());
}
