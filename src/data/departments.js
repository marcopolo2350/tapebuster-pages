// Department definitions — keys match `dept` in catalog.js.
// hue: base hue used by procedural signage accents. code: aisle code prefix.
export const DEPARTMENTS = {
  newreleases: { key: 'newreleases', name: 'NEW RELEASES', code: 'NR', hue: 48 },
  action:      { key: 'action',      name: 'ACTION',       code: 'AC', hue: 22 },
  comedy:      { key: 'comedy',      name: 'COMEDY',       code: 'CO', hue: 52 },
  drama:       { key: 'drama',       name: 'DRAMA',        code: 'DR', hue: 210 },
  horror:      { key: 'horror',      name: 'HORROR',       code: 'HO', hue: 355 },
  scifi:       { key: 'scifi',       name: 'SCI-FI',       code: 'SF', hue: 200 },
  thriller:    { key: 'thriller',    name: 'THRILLER',     code: 'TH', hue: 190 },
  classics:    { key: 'classics',    name: 'CLASSICS',     code: 'CL', hue: 36 },
  family:      { key: 'family',      name: 'FAMILY',       code: 'FA', hue: 140 },
  documentary: { key: 'documentary', name: 'DOCUMENTARY',  code: 'DO', hue: 215 },
  anime:       { key: 'anime',       name: 'ANIME',        code: 'AN', hue: 320 },
  tvdrama:     { key: 'tvdrama',     name: 'TV DRAMA',     code: 'TD', hue: 260 },
  tvcomedy:    { key: 'tvcomedy',    name: 'TV COMEDY',    code: 'TC', hue: 14 },
};

// Curated sections that physically exist in the store (endcaps / gondola sides / tables).
export const CURATED_SECTIONS = {
  staffPicks:          { name: 'STAFF PICKS',           code: 'SP' },
  cultClassics:        { name: 'CULT CLASSICS',         code: 'CC' },
  ninetiesFavorites:   { name: "90s THROWBACKS",        code: 'NT' },
  hiddenGems:          { name: 'HIDDEN GEMS',           code: 'HG' },
  bingeWorthy:         { name: 'BINGE THIS WEEKEND',    code: 'BW' },
  oneNightWatch:       { name: 'ONE-NIGHT WATCH',       code: 'ON' },
  leavingSoon:         { name: 'LEAVING SOON',          code: 'LS' },
  criticallyAcclaimed: { name: 'CRITICALLY ACCLAIMED',  code: 'CA' },
  familyNight:         { name: 'FAMILY NIGHT',          code: 'FN' },
  weekendMarathon:     { name: 'WEEKEND MARATHON',      code: 'WM' },
  // A CURATED SECTION, NOT A FOURTEENTH DEPARTMENT. Romance is the one large
  // body of stock with no home of its own — 2,892 stocked titles, 1,443 of
  // them rom-coms — scattered through DRAMA and COMEDY. A real department
  // would mean an ingest re-run, a change to deptGroupKey and re-merchandising
  // all 562 fixtures; that is a separately measured project. An endcap gives
  // the stock a place to be found NOW, on the existing infrastructure, and
  // costs one fixture.
  romanceRomCom:       { name: 'ROMANCE & ROM-COM',     code: 'RR' },
};
