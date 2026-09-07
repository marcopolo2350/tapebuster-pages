// THE INVENTORY TIER MODEL (phase-4 directive §7/§9/§16) — and the retirement
// of the occupancy binary it replaces.
//
// Session H hid every slot whose title failed the watchability predicate in
// MY SERVICES mode. The phase-4A census measured what that produced for a
// real three-service user: the evidence union for Netflix+Tubi+Hulu is 5,644
// titles TOTAL (the predicate rejects zero of them — the pool simply is that
// small while 64.7% of the catalogue has no availability data at all), so the
// binary turned a fully stocked 20,000-title building into a 23.7%-occupied
// warehouse with 45 dead fixtures. Availability provenance being incomplete
// must not empty the store (§10).
//
// The phase-4 repair made every stocked title visible; the inventory-mode
// directive then made that ONE OF TWO USER-SELECTABLE POLICIES (see
// INVENTORY_MODES below): FULL_STORE_DISCOVERY keeps the dense store where
// services mean PLACEMENT — Tier-1 titles win the curated endcaps and the
// front of every section — while MY_SERVICES_ONLY makes eligibility a real
// membership constraint on the active inventory. In both, the search/label
// surfaces stay exactly as honest as before (watchability.js remains the
// sole label authority; a discovery title never claims "Included").
//
//   TIER 4  PROTECTED   Stack/Cart — overrides everything, always stocked.
//   TIER 1  WATCHABLE   isCurrentlyWatchable().eligible on selected services.
//   TIER 2  ASSOCIATED  service evidence too weak for the predicate. The
//                       4A census measured this class EMPTY in the current
//                       snapshot (C = 0) — it exists in the model so a
//                       future evidence source slots in without rework.
//   TIER 3  DISCOVERY   the rest of the visit's stock. Present, honest.
import { isCurrentlyWatchable } from '../data/watchability.js';

export const TIER = Object.freeze({ WATCHABLE: 1, ASSOCIATED: 2, DISCOVERY: 3, PROTECTED: 4 });

/** Which tier a stocked title occupies for this user. Pure. */
export function tierOf(title, { services, protectedIds }) {
  if (!title) return TIER.DISCOVERY;
  if (protectedIds && protectedIds.has(title.id)) return TIER.PROTECTED;
  if (services && services.size && isCurrentlyWatchable(title, services).eligible) return TIER.WATCHABLE;
  // Tier 2 would be decided here from weaker evidence when a source exists.
  return TIER.DISCOVERY;
}

/**
 * USER-SELECTABLE INVENTORY MODES (inventory-mode directive §1/§3-§4) — the
 * seam this function was documented as being.
 *
 *   MY_SERVICES_ONLY ('services')  the ACTIVE inventory is an eligibility
 *     constraint: only Tier 1/2/4 slots render. The building never shrinks —
 *     buildLayout derives the 562 fixtures from the full capacity plan — so
 *     "a smaller store" means genuinely empty shelves, exactly the certified
 *     session-H presentation, now chosen by the user instead of imposed.
 *     If the evidence supports 5,644 titles, the store shows 5,644 titles.
 *   FULL_STORE_DISCOVERY ('full')  the phase-4 dense store: every stocked
 *     tier renders; services mean placement priority and honest labels.
 *
 * Neither mode is forced (§21): the user decides, the setting persists, and
 * because BOTH modes share the same 20,000-title physical stock, switching
 * is a pure occupancy change — instant, reload-free, ghost-free.
 */
export const INVENTORY_MODES = Object.freeze({ SERVICES_ONLY: 'services', FULL_DISCOVERY: 'full' });

export function slotVisible(title, opts = {}) {
  const { strict, inventoryMode } = opts;
  if (!strict || inventoryMode !== INVENTORY_MODES.SERVICES_ONLY) return true;
  return tierOf(title, opts) !== TIER.DISCOVERY;
}
