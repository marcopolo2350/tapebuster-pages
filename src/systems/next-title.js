// NEXT TITLE — browse the shelf without walking to it.
//
// THE ARCHITECTURAL RULE THIS FILE OBEYS, AND WHY IT IS A FILE.
//
//     store universe  ->  candidates  ->  deterministic selection  ->  UI
//
// and NEVER
//
//     services / availability  ->  rebuild membership  ->  select
//
// This module is PURE and imports nothing from the projection, the catalogue,
// the services model or availability. It cannot rebuild store membership
// because it cannot see it: its only input is the layout that was already
// built from the already-selected store. Selection is not membership, and the
// easiest way to keep that true is to make the wrong thing unreachable rather
// than merely discouraged.
//
// Availability may still colour what the UI SAYS about a title. It may never
// decide whether the title is on the shelf, and nothing here consults it.

/**
 * Index the shop floor as it is actually laid out.
 *
 *   section -> aisle -> shelf(row) -> titles in position order
 *
 * Built from layout.titles, whose addresses were assigned when the store was
 * merchandised. No filtering happens here: every title the store carries is in
 * the index, in the order a shopper would meet it walking the aisle.
 *
 * @param {{ titles: Map<string, {address: object, level: number}> }} layout
 */
export function buildShelfIndex(layout) {
  const rows = new Map();          // key -> { key, section, floor, aisle, shelf, titleIds }
  for (const [titleId, rec] of layout.titles) {
    const a = rec.address;
    if (!a) continue;
    const key = `${a.section}|${a.aisle}|${a.shelf}`;
    let row = rows.get(key);
    if (!row) {
      row = { key, section: a.section, floor: a.floor ?? null, aisle: a.aisle, shelf: a.shelf, entries: [] };
      rows.set(key, row);
    }
    row.entries.push({ titleId, position: a.position ?? 0 });
  }
  // Position order, with the id as a tie-break so the index is STABLE: two
  // titles sharing a position must not swap between builds, or "next" stops
  // being deterministic for reasons nobody can see.
  for (const row of rows.values()) {
    row.entries.sort((x, y) => (x.position - y.position) || (x.titleId < y.titleId ? -1 : 1));
    row.titleIds = row.entries.map((e) => e.titleId);
  }
  const ordered = [...rows.values()].sort((a, b) =>
    (a.section < b.section ? -1 : a.section > b.section ? 1 : 0)
    || (a.aisle < b.aisle ? -1 : a.aisle > b.aisle ? 1 : 0)
    || (a.shelf - b.shelf));

  const rowOf = new Map();
  for (const row of ordered) for (const id of row.titleIds) rowOf.set(id, row);

  // Memoised because rowsIn() went from a once-per-render call to the inner
  // step of a loop: walking a section looking for the next shelf that still
  // has a case on it would otherwise re-filter every row in the store on every
  // hop, turning one skipped shelf into a full scan.
  const bySection = new Map();

  return {
    rows: ordered,
    rowOf,
    /** Sections, in shop order, for the picker. */
    sections: [...new Set(ordered.map((r) => r.section))],
    /** The rows of one section, in shop order: aisle, then shelf. */
    rowsIn(section) {
      let list = bySection.get(section);
      if (!list) { list = ordered.filter((r) => r.section === section); bySection.set(section, list); }
      return list;
    },
    get size() { return rowOf.size; },
  };
}

/**
 * The shelf next door, within the same section.
 *
 * TWO SCOPES, TWO FUNCTIONS. nextTitle() moves along ONE shelf and wraps at
 * its ends; this moves BETWEEN shelves and stops at the section's. Folding
 * them together — "next title, unless you are at the end, then next shelf" —
 * would mean neither control had a scope you could state, and the shelf
 * counter would silently start counting something else.
 *
 * NO CROSS-SECTION WRAP. Running off the end of a section returns null rather
 * than landing in DRAMA, because the shopper asked for the next shelf, not the
 * next department; the caller disables the control instead of moving somewhere
 * unrelated. Ordering is the shop's own: rowsIn() is already sorted by aisle
 * and then by shelf, so "next" is the next shelf a walker would meet.
 *
 * PURE, like the rest of this file. Whether a shelf has a case left ON it is a
 * question about the physical store, not about the layout, so this never asks
 * it — the caller skips unbrowsable shelves by stepping again.
 *
 * @param {ReturnType<buildShelfIndex>} index
 * @param {object} row   the shelf being browsed
 * @param {1|-1} dir
 * @returns {object|null} the adjacent shelf, or null at the section boundary
 */
export function adjacentShelf(index, row, dir = 1) {
  if (!row) return null;
  const rows = index.rowsIn(row.section);
  const i = rows.findIndex((r) => r.key === row.key);
  if (i < 0) return null;
  const j = i + dir;
  return (j < 0 || j >= rows.length) ? null : rows[j];
}

/** Where a shelf sits within its section, for the readout and for bounding a walk. */
export function shelfPosition(index, row) {
  if (!row) return null;
  const rows = index.rowsIn(row.section);
  return { position: rows.findIndex((r) => r.key === row.key), of: rows.length, section: row.section };
}

/**
 * The next shelf in this section that still has a case to pick up, and which
 * title to lift off it.
 *
 * THE PHYSICAL QUESTION IS INJECTED, NOT IMPORTED. Whether a case is actually
 * on the shelf — as opposed to in the shopper's own stack — is a fact about
 * the running store, and this module is not allowed to know about the store.
 * So the caller passes a predicate. That keeps the file pure, and it makes the
 * skipping itself testable with a predicate that says a chosen shelf is empty,
 * rather than testable only through a browser.
 *
 * SKIPPING IS NOT CHEATING. A shelf with nothing on it is stepped over; a
 * title the predicate rejects is never selected to make the navigation look
 * like it worked. Bounded by the section's shelf count, so a section emptied
 * into the stack terminates at the boundary instead of circling.
 *
 * @param {ReturnType<buildShelfIndex>} index
 * @param {object} row     the shelf being browsed
 * @param {1|-1} dir
 * @param {(titleId: string) => boolean} hasCase
 * @returns {{row: object, titleId: string}|null} null at the section edge
 */
export function nextBrowsableShelf(index, row, dir, hasCase) {
  const here = shelfPosition(index, row);
  if (!here) return null;
  let cur = row;
  for (let hop = 0; hop < here.of; hop++) {
    cur = adjacentShelf(index, cur, dir);
    if (!cur) return null;                      // section boundary: never wraps
    const titleId = cur.titleIds.find((id) => hasCase(id));
    if (titleId) return { row: cur, titleId };
  }
  return null;
}

/**
 * The next title along a shelf.
 *
 * DETERMINISTIC: the same index, the same current title and the same direction
 * always give the same answer. There is no randomness here at all, because
 * "next" is a position on a shelf, not a recommendation.
 *
 * NEVER RETURNS THE CURRENT TITLE while any other candidate exists — that is
 * the whole point of the feature, and it is the easiest thing to get wrong
 * when a row has one member or the id is not found.
 *
 * @param {ReturnType<buildShelfIndex>} index
 * @param {string} currentId
 * @param {1|-1} dir
 * @param {{ row?: object }} opts  browse a chosen row instead of the current one
 * @returns {{ titleId: string, row: object, position: number, wrapped: boolean }
 *           | { exhausted: true, titleId: string }}
 */
export function nextTitle(index, currentId, dir = 1, { row = null } = {}) {
  const target = row ?? index.rowOf.get(currentId);
  if (!target || !target.titleIds.length) {
    // Nothing to browse. Say so rather than handing back the current title and
    // letting the caller believe it moved.
    return { exhausted: true, titleId: currentId };
  }
  const ids = target.titleIds;
  let i = ids.indexOf(currentId);
  if (ids.length === 1) {
    // EXHAUSTION IS EXPLICIT — BUT ONLY ONCE YOU ARE ALREADY STANDING THERE.
    //
    // A one-title row genuinely has no alternative, so stepping along it is
    // exhaustion. Being SENT to it from the row picker is not: the shopper
    // chose that shelf and there is exactly one title on it, so the honest
    // answer is that title. This ordering was the other way round, which made
    // every single-title shelf selectable in the picker and impossible to
    // reach — the one case where the picker showed a row it could not open.
    if (i >= 0) return { exhausted: true, titleId: ids[0] };
    return { titleId: ids[0], row: target, position: 0, wrapped: false };
  }
  if (i < 0) {
    // Jumped into a row the current title is not on: start at its near end so
    // the first press lands on a real title rather than skipping one.
    const start = dir > 0 ? 0 : ids.length - 1;
    return { titleId: ids[start], row: target, position: start, wrapped: false };
  }
  const n = ids.length;
  const j = ((i + dir) % n + n) % n;
  return { titleId: ids[j], row: target, position: j, wrapped: dir > 0 ? j < i : j > i };
}

/** Where a title sits, for the picker's current state. */
export function locate(index, titleId) {
  const row = index.rowOf.get(titleId);
  if (!row) return null;
  return { row, position: row.titleIds.indexOf(titleId), of: row.titleIds.length };
}

/** A human label for a row, matching the signage a shopper reads. */
export function rowLabel(row) {
  const floor = row.floor === 'MEZZANINE' ? 'MEZZANINE · ' : '';
  return `${floor}AISLE ${row.aisle} · SHELF ${String(row.shelf).padStart(2, '0')}`;
}
