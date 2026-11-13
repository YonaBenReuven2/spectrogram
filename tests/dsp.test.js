const test = require('node:test');
const assert = require('node:assert');
const SG = require('../js/dsp.js');

const SR = 48000;
const WIN = 4096;

/** A steady sung note: harmonic k at levels[k-1] dB, with a little noise under it. */
function tone(f0, levels, n) {
  const x = new Float32Array(n || WIN);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (let i = 0; i < x.length; i++) {
    let v = 0;
    for (let k = 1; k <= levels.length; k++) v += Math.pow(10, levels[k - 1] / 20) * Math.sin((2 * Math.PI * k * f0 * i) / SR + k);
    x[i] = 0.05 * v + 1e-5 * rnd();
  }
  return x;
}
const slope = (dbPerOct, n) => Array.from({ length: n }, (_, i) => dbPerOct * Math.log2(i + 1));
function analyse(x) {
  const p = new SG.Pitch(SR, WIN).detect(x);
  const s = new SG.Spectrum(SR, WIN);
  const h = SG.measureHarmonics(s.compute(x), s.binHz, p.freq);
  const f = SG.voiceFeatures(h);
  return { p, h, f, idx: SG.registerIndex(f) };
}

test('note names and cents', () => {
  assert.deepStrictEqual({ ...SG.noteOf(440), cents: 0 }, { midi: 69, name: 'A', octave: 4, cents: 0 });
  const c3 = SG.noteOf(130.81);
  assert.strictEqual(c3.name + c3.octave, 'C3');
  const sharp = SG.noteOf(440 * Math.pow(2, 20 / 1200));
  assert.ok(Math.abs(sharp.cents - 20) < 0.01);
  const third = SG.noteOf(5 * 110); // the 5th harmonic of A2: a C♯5, 14 cents flat
  assert.strictEqual(third.name + third.octave, 'C♯5');
  assert.ok(Math.abs(third.cents + 13.7) < 0.2);
  assert.ok(Math.abs(SG.noteOf(442, 442).cents) < 1e-9);
});

test('finds the sung note across the range, to within 3 cents', () => {
  for (const f0 of [65.4, 82.4, 110, 146.8, 220, 329.6, 440, 587.3, 880, 1046.5]) {
    const { p } = analyse(tone(f0, slope(-9, Math.min(20, Math.floor(6000 / f0)))));
    assert.ok(p.clarity > 0.9, `${f0}: clarity ${p.clarity}`);
    assert.ok(Math.abs(1200 * Math.log2(p.freq / f0)) < 3, `${f0}: read ${p.freq}`);
  }
});

test('keeps the right octave when the 2nd harmonic is the loudest, or the fundamental is weak', () => {
  let r = analyse(tone(110, [-8, 0, -3, -6, -5, -9, -12, -15]));
  assert.ok(Math.abs(1200 * Math.log2(r.p.freq / 110)) < 5, `read ${r.p.freq}`);
  r = analyse(tone(98, [-25, -4, 0, -3, -6, -8, -10, -14, -18]));
  assert.ok(Math.abs(1200 * Math.log2(r.p.freq / 98)) < 5, `read ${r.p.freq}`);
});

test('silence and noise are not a note', () => {
  const det = new SG.Pitch(SR, WIN);
  assert.strictEqual(det.detect(new Float32Array(WIN)).freq, 0);
  const x = new Float32Array(WIN);
  let seed = 3;
  for (let i = 0; i < WIN; i++) x[i] = 0.1 * (((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1);
  assert.ok(det.detect(x).clarity < 0.6);
});

test('measures each harmonic to within 1 dB, and marks the missing ones', () => {
  const levels = [0, -6, -3, -20, -12, -30, -100, -18];
  const { h } = analyse(tone(196, levels));
  for (let k = 0; k < levels.length; k++) {
    if (levels[k] <= -100) {
      assert.strictEqual(h.present[k], 0, `harmonic ${k + 1} is not there`);
      continue;
    }
    assert.strictEqual(h.present[k], 1, `harmonic ${k + 1} present`);
    assert.ok(Math.abs(h.level[k] - h.level[0] - levels[k]) < 1, `harmonic ${k + 1}: ${h.level[k] - h.level[0]} for ${levels[k]}`);
    assert.ok(Math.abs(h.freq[k] - 196 * (k + 1)) < 2);
  }
  assert.strictEqual(h.present[10], 0);
});

test('reads H1-H2, tilt and the overtones against the fundamental', () => {
  const { f } = analyse(tone(220, slope(-12, 12)));
  assert.ok(Math.abs(f.h1h2 - 12) < 1, `h1h2 ${f.h1h2}`);
  assert.ok(Math.abs(f.tilt + 12) < 1, `tilt ${f.tilt}`);
  // sum of k^-4 over k >= 2 is 0.0823: -10.8 dB
  assert.ok(Math.abs(f.overtone + 10.8) < 1, `overtone ${f.overtone}`);
});

test('chest reads high, head low, mix between', () => {
  // chest: 2nd and 3rd harmonics over the fundamental, plenty above, a ring near 3 kHz
  const chest = analyse(tone(147, [-6, 0, -1, -2, -5, -9, -12, -14, -16, -18, -20, -22, -24, -24, -24, -22, -20, -18, -17, -18, -22, -26]));
  // mix: fundamental and 2nd about level, falling steadily
  const mix = analyse(tone(294, [0, -2, -7, -11, -15, -19, -23, -27, -30, -33]));
  // head: the fundamental far over everything else
  const head = analyse(tone(392, [0, -14, -24, -32, -40, -46]));
  assert.ok(chest.idx > mix.idx && mix.idx > head.idx, `${chest.idx} ${mix.idx} ${head.idx}`);
  assert.strictEqual(SG.zoneOf(chest.idx), 'chest');
  assert.strictEqual(SG.zoneOf(mix.idx), 'mix');
  assert.strictEqual(SG.zoneOf(head.idx), 'head');
  assert.ok(chest.f.count > head.f.count);
  assert.ok(chest.f.ring > head.f.ring + 10);
});

test('a singer\'s own chest and head samples set the ends of the scale', () => {
  const cal = { chest: 0.6, head: 0.3 };
  assert.ok(Math.abs(SG.mapIndex(0.6, cal) - 0.85) < 1e-9);
  assert.ok(Math.abs(SG.mapIndex(0.3, cal) - 0.15) < 1e-9);
  assert.strictEqual(SG.zoneOf(SG.mapIndex(0.45, cal)), 'mix');
  assert.strictEqual(SG.mapIndex(2, cal), 1);
  // samples too alike to tell apart, or only one of them: the generic scale stays
  assert.strictEqual(SG.mapIndex(0.5, { chest: 0.5, head: 0.47 }), 0.5);
  assert.strictEqual(SG.mapIndex(0.5, { chest: 0.7 }), 0.5);
  assert.strictEqual(SG.calibrated({ chest: 0.7 }), false);
  assert.strictEqual(SG.calibrated(cal), true);
});
