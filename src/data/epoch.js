// Shared, synchronous invalidation signal for anything that memoises data
// derived from the lazy detail shards.
//
// This lives in its own module on purpose: detail.js must be able to bump it
// the instant it folds new detail onto records, and recommend.js must be able
// to read it while building a query — a dynamic import() would defer the bump
// into a microtask, and a search running before that resolved would keep
// serving stale (blurb-less) haystacks.
let epoch = 0;
export const bumpDetailEpoch = () => { epoch++; };
export const detailEpoch = () => epoch;
