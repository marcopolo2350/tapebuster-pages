// Off-thread renderer.
//
// A four-minute track is about eight million samples and takes a couple of
// seconds of arithmetic to synthesise and master. Doing that on the main
// thread would drop frames in a store that is already drawing 20,000 cases,
// and slicing it across animation frames would still stall on the loudness
// measurement, which is global by definition. So it happens here, and the
// finished buffer is transferred (not copied) back.

import { composeTrack } from './compose.js';
import { renderTrack } from './synth.js';
import { masterTrack, trimTail } from './master.js';

self.onmessage = (e) => {
  const { seed, family, sr, jobId } = e.data;
  try {
    const track = composeTrack(seed, family);
    const full = renderTrack(track, sr);
    const meters = masterTrack(full, sr);
    const buf = new Float32Array(trimTail(full, sr));
    self.postMessage({ jobId, ok: true, buffer: buf.buffer, meters }, [buf.buffer]);
  } catch (err) {
    self.postMessage({ jobId, ok: false, error: String(err && err.message || err) });
  }
};
