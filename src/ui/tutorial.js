// FIRST-RUN TUTORIAL — the shop floor, then the counter behind it.
//
// Device QA: dropped into a 3D store on a phone with no idea that the left
// half of the screen walks and the right half looks. The controls were not the
// problem there; nobody had said what they were.
//
// Deliberately NOT a permanent HUD hint. A hint that lives on screen forever
// is a tax on everyone who read it the first time, and this store has just
// spent a whole pass clearing chrome off the viewport. It shows once, it can
// be replayed from Settings, and if it is skipped a single contextual line
// appears briefly and then never again.
//
// It explains the controls. It does not excuse them: a tutorial cannot make a
// bad control good, and this one is not a substitute for the movement work.
//
// WHY IT GREW, AND WHY IT IS STILL SHORT.
//
// The store has since grown a search box, a radio with real stations, a mute,
// and a way to browse a shelf without walking to it. None of those were
// mentioned anywhere, so for a first-time shopper they did not exist. But a
// nine-card tutorial is its own kind of failure, so the cards are ORDERED BY
// WHEN YOU NEED THEM: the first three get you walking and are the only ones
// that block the door, and everything after that is the stuff you go looking
// for once you are inside. SKIP stays live on every single card, and the whole
// thing replays from Settings, so the later cards cost a curious shopper
// nothing and cost an impatient one one tap.

const KEY = 'tb_tutorial_done';
const HINT_KEY = 'tb_tutorial_hinted';

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

export const tutorialSeen = () => read(KEY) === '1';
export const markTutorialSeen = () => write(KEY, '1');

/** Touch gets the swipe wording; a mouse and keyboard get their own. */
// EXPORTED so the copy gate can assert the CARDS THEMSELVES rather than grep
// this file for phrases. A gate that greps source proves a string is present;
// it does not prove a card renders, or that the deck still covers the store.
export function cards(touch) {
  // Shared cards first. Only WALK and LOOK differ by input device; describing
  // the radio twice would be two copies to keep in step and one to forget.
  const move = touch ? [
    { h: 'WALK', b: 'Hold the left side of the screen and push the stick in the direction you want to go.' },
    { h: 'LOOK', b: 'Swipe anywhere on the right side to look around the store.' },
    { h: 'EXPLORE', b: 'Walk down the aisles. Tap a case to pick it up, then drag to turn it over.' },
  ] : [
    { h: 'WALK', b: 'W A S D walks. The arrow keys look around. Click anywhere on the floor to stroll there.' },
    { h: 'LOOK', b: 'Drag with the mouse to look around. Scroll to zoom.' },
    { h: 'EXPLORE', b: 'Walk down the aisles. Click a case to pick it up, then drag to turn it over.' },
  ];
  const rest = [
    { h: 'FIND IT',
      b: 'Search by title, actor, director or year. Results say which shelf a film is on, '
       + 'and TAKE ME THERE walks you to it. That card has NEXT TITLE on it too, '
       + 'with a picker for any shelf in the store.' },
    // TWO SCOPES, TAUGHT AS TWO SCOPES. The store grew a second level of
    // browsing, and a card that said "step along the shelf" would leave the
    // shelf buttons looking like decoration. The last sentence is the whole
    // lesson: which control moves which thing.
    { h: 'BROWSE THE SHELVES',
      b: 'Pick a case up and the big arrows step through the titles on that shelf. '
       + 'PREV SHELF and NEXT SHELF move you to another shelf in the same section. '
       + 'The arrows change the title; the shelf buttons change the shelf.' },
    { h: 'MUSIC',
      b: 'The store plays real playlists. Change the station or turn it off from Settings, '
       + 'and the speaker button mutes everything instantly.' },
    { h: 'MAKE IT COMFORTABLE',
      b: 'Settings holds look and movement speed, and separate invert switches for looking and for walking. '
       + 'Set them once and the store remembers.' },
  ];
  return [...move, ...rest].map((c, idx) => ({ ...c, n: idx + 1 }));
}

/**
 * Show the tutorial. Resolves when the shopper finishes or skips it, so the
 * caller can hold entry until then.
 * @param {{ touch?: boolean, onBlip?: () => void }} opts
 */
export function showTutorial({ touch = false, onBlip = null } = {}) {
  return new Promise((resolve) => {
    const host = document.getElementById('tutorial');
    if (!host) return resolve(false);
    const list = cards(touch);
    let i = 0;

    const body = document.getElementById('tut-body');
    const step = document.getElementById('tut-step');
    const back = document.getElementById('tut-back');
    const next = document.getElementById('tut-next');
    const skip = document.getElementById('tut-skip');

    const finish = (completed) => {
      markTutorialSeen();
      host.classList.add('hidden');
      // Nothing here is re-bound on replay, so the handlers are cleared to
      // avoid a second showing stacking a second set on the same buttons.
      back.onclick = next.onclick = skip.onclick = null;
      resolve(completed);
    };

    const draw = () => {
      const done = i >= list.length;
      step.textContent = done ? '' : `${list[i].n} of ${list.length}`;
      // textContent throughout: this is our own copy, but building UI out of
      // string concatenation is how markup injection gets in later.
      body.textContent = '';
      const h = document.createElement('div');
      h.className = 'tut-h';
      h.textContent = done ? "YOU'RE READY" : list[i].h;
      const p = document.createElement('p');
      p.className = 'tut-p';
      p.textContent = done
        ? 'Have a look around. The rest of the shelves fill in while you walk.'
        : list[i].b;
      body.append(h, p);
      back.style.visibility = i === 0 ? 'hidden' : 'visible';
      next.textContent = done ? 'START STORE' : 'NEXT';
      skip.style.visibility = done ? 'hidden' : 'visible';
    };

    back.onclick = () => { onBlip?.(); i = Math.max(0, i - 1); draw(); };
    next.onclick = () => {
      onBlip?.();
      if (i >= list.length) return finish(true);
      i++;
      draw();
    };
    skip.onclick = () => { onBlip?.(); finish(false); };

    host.classList.remove('hidden');
    draw();
  });
}

/**
 * One line, once, for someone who skipped. Shown briefly and then never again,
 * because a hint that keeps coming back is just a banner with a delay on it.
 */
export function maybeHint(toast, touch) {
  if (read(HINT_KEY) === '1') return;
  write(HINT_KEY, '1');
  setTimeout(() => {
    toast(touch
      ? 'Left side walks, right side looks. Settings has the rest.'
      : 'WASD walks, drag to look. Settings has the rest.', 5000);
  }, 2500);
}
