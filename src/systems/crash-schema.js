// ONE DEFINITION OF THE CRASH RING'S COLUMNS, shared by the recorder and the
// reader.
//
// This exists because they drifted. main.js built the row as a positional array
// literal and onboard.js read it with hardcoded indices; when a column was
// inserted at the front, the reader kept reading r[0] as the timestamp long
// after column 0 had become the phase flag. Nothing failed — the welcome
// screen simply displayed the wrong number under every heading, which is worse
// than displaying nothing, because it is the screen the crash gets read off.
//
// Both sides now address columns BY NAME through `C`, so a column can be added
// anywhere without silently corrupting the readout.
export const RING_COLS = [
  'phase',      // 0 dressing, 1 entered
  'gov',        // governor: 0 ok, 1 strained, 2 critical
  't',          // tenths of a second since the ring started
  'fps',
  'frame',      // worst frame ms in this sample window
  'longF',      // cumulative frames over 120 ms
  'x', 'z', 'level',
  'moving',     // 1 while the player is actually walking
  'mid', 'detail', 'pooled', 'job',
  'fcmt',       // texture commits in the last frame
  'cmt',        // cumulative commits
  'fails', 'backlog',
  'tex', 'geo', // RESIDENT GL objects (renderer.info.memory)
  'calls', 'ktris',
  'inflight', 'held',   // transient decode load
  'heap',       // MiB, or -1 where the browser does not report it (Safari)
  'ctxLost',
  // --- cumulative totals. The residency figures above were bounded in every
  // previous investigation while the device kept dying; these are the ones that
  // say how much work the browser was actually asked to do.
  'fetched', 'fok', 'ffail',
  'decMiB',     // cumulative decoded RGBA, from real naturalWidth/Height
  'rel',        // decodes we dropped
  'uneviq',     // ...of which we could not actually free (HTMLImageElement)
  'texC', 'texD',
  'mtex',       // cumulative megatexels uploaded
  'uniq',       // DISTINCT titles ever fetched — fetched/uniq is the refetch ratio
  'vis',        // document.visibilityState === 'visible'
];

export const C = Object.fromEntries(RING_COLS.map((k, i) => [k, i]));
