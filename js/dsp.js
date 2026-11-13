/* Spectrogram: the signal side. No browser needed, so the tests run it in Node.
 *
 *   Pitch             the note being sung (McLeod pitch method, through an FFT)
 *   Spectrum          a Hann-windowed spectrum in dB
 *   measureHarmonics  how loud the fundamental and each overtone is
 *   voiceFeatures     what that says about the voice (overtones against the fundamental,
 *                     H1-H2, how fast the overtones fall away, the ring around 3 kHz)
 *   registerIndex     those folded into one number, 0 (head) to 1 (chest)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SG = Object.assign(root.SG || {}, api);
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  class FFT {
    constructor(n) {
      if (n & (n - 1)) throw new Error('FFT size must be a power of two');
      this.n = n;
      const bits = Math.round(Math.log2(n));
      this.rev = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
        this.rev[i] = r;
      }
      this.cos = new Float64Array(n / 2);
      this.sin = new Float64Array(n / 2);
      for (let i = 0; i < n / 2; i++) {
        this.cos[i] = Math.cos((2 * Math.PI * i) / n);
        this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
      }
    }
    transform(re, im) {
      const n = this.n;
      const rev = this.rev;
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i];
          re[i] = re[j];
          re[j] = t;
          t = im[i];
          im[i] = im[j];
          im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = 0, k = 0; j < half; j++, k += step) {
            const a = i + j;
            const b = a + half;
            const tr = re[b] * this.cos[k] - im[b] * this.sin[k];
            const ti = re[b] * this.sin[k] + im[b] * this.cos[k];
            re[b] = re[a] - tr;
            im[b] = im[a] - ti;
            re[a] += tr;
            im[a] += ti;
          }
        }
      }
    }
    inverse(re, im) {
      const n = this.n;
      for (let i = 0; i < n; i++) im[i] = -im[i];
      this.transform(re, im);
      for (let i = 0; i < n; i++) {
        re[i] /= n;
        im[i] = -im[i] / n;
      }
    }
  }

  /** The spectrum of the newest `win` samples, in dB (0 dB is a full-scale sine). */
  class Spectrum {
    constructor(sampleRate, win, pad) {
      this.sr = sampleRate;
      this.win = win;
      this.size = win * (pad || 2); // zero-padded, so peaks between bins are read well
      this.fft = new FFT(this.size);
      this.re = new Float64Array(this.size);
      this.im = new Float64Array(this.size);
      this.window = new Float64Array(win);
      let sum = 0;
      for (let i = 0; i < win; i++) {
        this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win);
        sum += this.window[i];
      }
      this.norm = 2 / sum;
      this.binHz = sampleRate / this.size;
      this.db = new Float32Array(this.size / 2 + 1);
    }
    compute(x) {
      const W = this.win;
      const off = x.length - W;
      const re = this.re;
      const im = this.im;
      let mean = 0;
      for (let i = 0; i < W; i++) mean += x[off + i];
      mean /= W;
      for (let i = 0; i < W; i++) re[i] = (x[off + i] - mean) * this.window[i];
      re.fill(0, W);
      im.fill(0);
      this.fft.transform(re, im);
      const db = this.db;
      const norm = this.norm;
      for (let i = 0; i < db.length; i++) db[i] = 20 * Math.log10(Math.hypot(re[i], im[i]) * norm + 1e-10);
      return db;
    }
  }

  /** The pitch of the newest `win` samples: { freq, clarity (0 to 1), rms }. */
  class Pitch {
    constructor(sampleRate, win, opts) {
      opts = opts || {};
      this.sr = sampleRate;
      this.W = win;
      this.size = win * 2;
      this.fft = new FFT(this.size);
      this.re = new Float64Array(this.size);
      this.im = new Float64Array(this.size);
      this.tmin = Math.max(2, Math.floor(sampleRate / (opts.fmax || 1400)));
      this.tmax = Math.min(win >> 1, Math.ceil(sampleRate / (opts.fmin || 55)) + 2);
      this.nsdf = new Float64Array(this.tmax + 2);
      this.k = opts.k || 0.9;
    }
    detect(x) {
      const W = this.W;
      const N = this.size;
      const re = this.re;
      const im = this.im;
      const off = x.length - W;
      let mean = 0;
      for (let i = 0; i < W; i++) mean += x[off + i];
      mean /= W;
      let energy = 0;
      for (let i = 0; i < W; i++) {
        const v = x[off + i] - mean;
        re[i] = v;
        energy += v * v;
      }
      const rms = Math.sqrt(energy / W);
      if (energy < 1e-12) return { freq: 0, clarity: 0, rms };
      re.fill(0, W);
      im.fill(0);
      this.fft.transform(re, im);
      for (let i = 0; i < N; i++) {
        re[i] = re[i] * re[i] + im[i] * im[i];
        im[i] = 0;
      }
      this.fft.inverse(re, im); // re is now the autocorrelation
      const nsdf = this.nsdf;
      const tmax = this.tmax;
      let m = 2 * energy;
      nsdf[0] = 1;
      for (let t = 1; t <= tmax; t++) {
        const a = x[off + t - 1] - mean;
        const b = x[off + W - t] - mean;
        m -= a * a + b * b;
        nsdf[t] = m > 1e-12 ? (2 * re[t]) / m : 0;
      }
      // the highest point of every positive lobe after the one around zero
      const peaks = [];
      let top = 0;
      let t = 1;
      while (t < tmax && nsdf[t] > 0) t++;
      while (t < tmax) {
        while (t < tmax && nsdf[t] <= 0) t++;
        let best = -1;
        let bv = 0;
        while (t < tmax && nsdf[t] > 0) {
          if (t >= this.tmin && nsdf[t] > bv) {
            bv = nsdf[t];
            best = t;
          }
          t++;
        }
        if (best > 0 && best < tmax && nsdf[best] >= nsdf[best - 1] && nsdf[best] >= nsdf[best + 1]) {
          peaks.push(best);
          if (bv > top) top = bv;
        }
      }
      if (!peaks.length) return { freq: 0, clarity: 0, rms };
      let pick = peaks[0];
      for (const p of peaks) {
        if (nsdf[p] >= this.k * top) {
          pick = p;
          break;
        }
      }
      const a = nsdf[pick - 1];
      const b = nsdf[pick];
      const c = nsdf[pick + 1];
      const den = a - 2 * b + c;
      const d = den < 0 ? (0.5 * (a - c)) / den : 0;
      return { freq: this.sr / (pick + d), clarity: Math.min(1, b - 0.25 * (a - c) * d), rms };
    }
  }

  /**
   * How loud each harmonic of f0 is. db is a Spectrum's output.
   * Returns { f0, n, level[] (dB), freq[] (Hz), snr[] (dB over the dips either side), present[] }.
   * A harmonic counts as present when it stands minSnr dB over those dips.
   */
  function measureHarmonics(db, binHz, f0, opts) {
    opts = opts || {};
    const minSnr = opts.minSnr == null ? 12 : opts.minSnr;
    const last = db.length - 2;
    const topF = Math.min(opts.maxF || 5000, (last - 1) * binHz - f0 / 2);
    const n = Math.max(0, Math.min(opts.maxN || 40, Math.floor(topF / f0)));
    const level = new Float32Array(n);
    const freq = new Float32Array(n);
    const snr = new Float32Array(n);
    const present = new Uint8Array(n);
    const half = Math.max(2, Math.round((0.3 * f0) / binHz));
    const dip = (f) => {
      const i = Math.max(1, Math.min(last, Math.round(f / binHz)));
      return Math.max(db[i - 1], db[i], db[i + 1]);
    };
    for (let k = 1; k <= n; k++) {
      const c = Math.round((k * f0) / binHz);
      let bi = Math.max(1, Math.min(last, c));
      for (let i = Math.max(1, c - half); i <= Math.min(last, c + half); i++) if (db[i] > db[bi]) bi = i;
      const a = db[bi - 1];
      const b = db[bi];
      const g = db[bi + 1];
      const den = a - 2 * b + g;
      const d = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - g)) / den)) : 0;
      level[k - 1] = b - 0.25 * (a - g) * d;
      freq[k - 1] = (bi + d) * binHz;
      snr[k - 1] = level[k - 1] - (dip((k - 0.5) * f0) + dip((k + 0.5) * f0)) / 2;
      present[k - 1] = snr[k - 1] >= minSnr ? 1 : 0;
    }
    return { f0, n, level, freq, snr, present };
  }

  /**
   * What the harmonics say about the voice:
   *   overtone  all the overtones together against the fundamental, dB
   *   h1h2      fundamental minus the 2nd harmonic, dB
   *   tilt      how fast the harmonics fall away, dB per octave (null with too few to tell)
   *   ring      the share of the sound between 2 and 4 kHz, dB
   *   count     harmonics present
   */
  function voiceFeatures(h) {
    if (!h || h.n < 2) return null;
    const pow = (L) => Math.pow(10, L / 10);
    const p1 = pow(h.level[0]);
    let over = 0;
    let ring = 0;
    let count = h.present[0] ? 1 : 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    let m = 0;
    for (let k = 1; k <= h.n; k++) {
      if (!h.present[k - 1] && k > 1) continue;
      const L = h.level[k - 1];
      const f = k * h.f0;
      if (k > 1) {
        over += pow(L);
        count++;
        if (f >= 2000 && f <= 4000) ring += pow(L);
      }
      const x = Math.log2(k);
      sx += x;
      sy += L;
      sxx += x * x;
      sxy += x * L;
      m++;
    }
    const clamp = (v) => Math.max(-40, Math.min(40, v));
    const den = m * sxx - sx * sx;
    return {
      overtone: clamp(10 * Math.log10(over / p1 + 1e-9)),
      h1h2: clamp(h.level[0] - h.level[1]),
      tilt: m >= 3 && den > 1e-9 ? (m * sxy - sx * sy) / den : null,
      ring: clamp(10 * Math.log10(ring / (p1 + over) + 1e-9)),
      count,
    };
  }

  const lin = (v, a, b) => Math.max(0, Math.min(1, (v - a) / (b - a)));

  /** 0 (head: the fundamental carries the sound) to 1 (chest: the overtones do), on a generic scale. */
  function registerIndex(f) {
    if (!f) return null;
    const a = lin(f.overtone, -6, 14);
    const c = lin(-f.h1h2, -12, 6);
    if (f.tilt == null) return (0.45 * a + 0.3 * c) / 0.75;
    return 0.45 * a + 0.3 * c + 0.25 * lin(f.tilt, -18, -5);
  }

  const CAL_MIN_GAP = 0.08;
  /** The generic index stretched so the singer's own head sample sits at 0.15 and chest at 0.85. */
  function mapIndex(raw, cal) {
    if (raw == null) return null;
    if (cal && cal.chest != null && cal.head != null && cal.chest - cal.head >= CAL_MIN_GAP) {
      return Math.max(0, Math.min(1, 0.15 + (0.7 * (raw - cal.head)) / (cal.chest - cal.head)));
    }
    return raw;
  }
  const calibrated = (cal) => !!(cal && cal.chest != null && cal.head != null && cal.chest - cal.head >= CAL_MIN_GAP);
  const zoneOf = (idx) => (idx == null ? null : idx < 0.36 ? 'head' : idx < 0.64 ? 'mix' : 'chest');

  const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  /** The nearest note to a frequency, and how many cents off it is. */
  function noteOf(freq, a4) {
    const m = 69 + 12 * Math.log2(freq / (a4 || 440));
    const midi = Math.round(m);
    return { midi, name: NAMES[((midi % 12) + 12) % 12], octave: Math.floor(midi / 12) - 1, cents: (m - midi) * 100 };
  }
  const freqOf = (midi, a4) => (a4 || 440) * Math.pow(2, (midi - 69) / 12);

  return { FFT, Spectrum, Pitch, measureHarmonics, voiceFeatures, registerIndex, mapIndex, calibrated, zoneOf, noteOf, freqOf, CAL_MIN_GAP };
});
