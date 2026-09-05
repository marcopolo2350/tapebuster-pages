// CUSTOM PLAYLISTS — the shopper's own stations.
//
// This replaces a single `tb_yt_playlist` string that was only ever a config
// hatch: one slot, no name, no list, no validation, and it silently outranked
// whatever the dial said. If the UI offers to take a playlist link, that has to
// be a real feature, so this is a real list — named, validated before it is
// saved, persisted, and selectable like any other station.
//
// Persistence is localStorage, which is what the rest of the store already uses
// for settings. No server, no account.

const KEY = 'tb_custom_playlists';
const CURRENT = 'tb_custom_current';
const MAX = 24;                 // a dial, not a library

/**
 * Pull a playlist id out of whatever the shopper pasted.
 *
 * Accepted, because these are the forms people actually copy:
 *   https://www.youtube.com/playlist?list=PL...
 *   https://www.youtube.com/watch?v=VIDEO&list=PL...     (a video *in* a list)
 *   https://m.youtube.com/... / music.youtube.com/...    (phone + YT Music)
 *   https://www.youtube.com/embed?listType=playlist&list=PL...
 *   a bare PL... id
 *
 * DELIBERATELY REJECTED:
 *   a plain video link with no list= — that is one song, not a station, and
 *   accepting it would put a station on the dial that ends after four minutes.
 *   RD.../ RDMM... radio mixes — YouTube generates those per viewer and they
 *   are not retrievable as a manifest, so they cannot be shuffled or verified.
 *
 * @returns {string|null} the playlist id, or null if this is not one
 */
export function parsePlaylistId(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  // A bare id.
  if (/^PL[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  // Anything with a list= parameter, in any of the URL shapes above.
  const m = s.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (m) return /^PL[A-Za-z0-9_-]{10,}$/.test(m[1]) ? m[1] : null;
  return null;
}

/** Why a paste was rejected, in words a shopper can act on. */
export function rejectionReason(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 'Paste a YouTube playlist link first.';
  if (/[?&]list=(RD|UL|LL|WL)/.test(s)) {
    return 'That is an auto-generated YouTube mix, not a saved playlist. Open the playlist itself and copy its link.';
  }
  if (/youtu\.?be/.test(s) && !/[?&]list=/.test(s)) {
    return 'That link is a single video. Open the playlist it belongs to and copy that link instead.';
  }
  return 'That does not look like a YouTube playlist link. It should contain "list=PL…".';
}

export function customPlaylists() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((p) => p && p.id && p.playlistId) : [];
  } catch { return []; }   // corrupt storage must not take the radio down
}

function write(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch { /* quota */ }
}

/**
 * Save a validated playlist. The CALLER validates against YouTube first — this
 * module does not reach the network, so it stays usable in tests.
 * @returns {{ok:true,entry:object}|{ok:false,reason:string}}
 */
export function addCustomPlaylist({ name, url, title, author }) {
  const playlistId = parsePlaylistId(url);
  if (!playlistId) return { ok: false, reason: rejectionReason(url) };
  const list = customPlaylists();
  if (list.some((p) => p.playlistId === playlistId)) {
    return { ok: false, reason: 'That playlist is already on your dial.' };
  }
  if (list.length >= MAX) return { ok: false, reason: `You can save up to ${MAX} playlists.` };
  const entry = {
    id: `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    name: (name || title || 'My playlist').slice(0, 48),
    playlistId,
    title: title ?? null,
    author: author ?? null,
  };
  write([...list, entry]);
  return { ok: true, entry };
}

/**
 * Rename a saved playlist.
 *
 * ONLY THE NAME. The playlist id, the channel and the original title are what
 * the station actually plays and what it credits, so they are not the
 * shopper's to edit — renaming is for the dial, not for the record of where
 * the music came from. An empty name falls back to YouTube's own title rather
 * than leaving a blank row on the dial.
 *
 * @returns {{ok:true}|{ok:false,reason:string}}
 */
export function renameCustomPlaylist(id, name) {
  const list = customPlaylists();
  const entry = list.find((p) => p.id === id);
  if (!entry) return { ok: false, reason: 'That playlist is no longer saved.' };
  const next = (name ?? '').trim().slice(0, 48) || entry.title || 'My playlist';
  write(list.map((p) => (p.id === id ? { ...p, name: next } : p)));
  return { ok: true };
}

export function removeCustomPlaylist(id) {
  write(customPlaylists().filter((p) => p.id !== id));
  if (localStorage.getItem(CURRENT) === id) localStorage.removeItem(CURRENT);
}

export function setCurrentCustom(id) { localStorage.setItem(CURRENT, id); }
export function currentCustomId() { return localStorage.getItem(CURRENT); }
export function currentCustom() {
  const id = currentCustomId();
  return customPlaylists().find((p) => p.id === id) ?? null;
}
