/* Spectrogram: the page. Listens to the mic, and every frame shows the note sung (and how many
 * cents off it is), how loud each of its harmonics is, where that puts the voice between head
 * and chest, and a scrolling picture of the last few seconds. The measuring is in dsp.js.
 */
(function () {
  'use strict';
  const SG = window.SG;
  const $ = (id) => document.getElementById(id);
  const KEY = 'spectrogram.'; // the github.io site is shared with the other apps
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(KEY + k);
        return v == null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(KEY + k, JSON.stringify(v));
      } catch (e) {
        /* private window: just not remembered */
      }
    },
  };

  const F_LO = 50; // the picture's range, Hz
  const F_HI = 8000;
  const MAX_F = 5000; // harmonics are measured up to here
  const MAX_N = 40;
  const BARS = 32; // most bars drawn
  const ROWS = 20; // rows in the harmonics picture
  const GATE_DB = -60; // quieter than this is not singing
  const CLARITY = 0.85;
  const SPEED = 80; // the picture's speed, px per second
  const RANGE = 70; // dB from the picture's brightest to its darkest
  const BAR_RANGE = 60;
  const C = { ink: '#0f1a2b', deep: '#0a1320', line: '#2a3a56', text: '#e6ebf3', muted: '#93a1b8', voice: '#8bd3f7', brass: '#d4b26a', sage: '#7fb8a4', hit: '#5bd69b', close: '#f2c14e', off: '#f07a6a' };
  const FONT = "'Instrument Sans', system-ui, sans-serif";
  const WHY = {
    head: 'The fundamental carries the sound; the overtones fall away fast.',
    mix: 'The fundamental and its overtones are about level.',
    chest: 'The overtones carry the sound, with many strong harmonics.',
  };
  const ZONE = { head: 'Head', mix: 'Mix', chest: 'Chest' };

  // ---------- colours ----------
  const LUT = (() => {
    const stops = [
      [0, 10, 19, 32],
      [0.3, 29, 63, 115],
      [0.55, 63, 158, 208],
      [0.75, 168, 224, 245],
      [0.9, 242, 210, 138],
      [1, 255, 246, 224],
    ];
    const out = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const u = i / 255;
      let s = 0;
      while (s < stops.length - 2 && u > stops[s + 1][0]) s++;
      const a = stops[s];
      const b = stops[s + 1];
      const t = (u - a[0]) / (b[0] - a[0]);
      for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(a[c + 1] + (b[c + 1] - a[c + 1]) * t);
    }
    return out;
  })();
  const REG = [
    [139, 211, 247],
    [127, 184, 164],
    [212, 178, 106],
  ];
  /** Head ice-blue, mix sage, chest brass. */
  function regRgb(idx) {
    const u = Math.max(0, Math.min(1, idx)) * 2;
    const a = REG[u < 1 ? 0 : 1];
    const b = REG[u < 1 ? 1 : 2];
    const t = u < 1 ? u : u - 1;
    return [0, 1, 2].map((c) => Math.round(a[c] + (b[c] - a[c]) * t));
  }

  // ---------- canvases ----------
  /** A canvas that scrolls left, a column of pixels at a time. */
  class Scroller {
    constructor(cv) {
      this.cv = cv;
      this.g = cv.getContext('2d', { alpha: false });
      this.col = null;
      this.acc = 0;
    }
    /** Match the canvas to its box. True when it changed (and was cleared). */
    fit() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(this.cv.clientWidth * dpr));
      const h = Math.max(1, Math.round(this.cv.clientHeight * dpr));
      if (this.cv.width === w && this.cv.height === h && this.col) return false;
      this.cv.width = w;
      this.cv.height = h;
      this.col = this.g.createImageData(1, h);
      for (let i = 3; i < this.col.data.length; i += 4) this.col.data[i] = 255;
      this.clear();
      return true;
    }
    clear() {
      this.g.fillStyle = C.deep;
      this.g.fillRect(0, 0, this.cv.width, this.cv.height);
    }
    /** How many columns to move after dt seconds. */
    steps(dt) {
      this.acc += SPEED * (window.devicePixelRatio || 1) * dt;
      const n = Math.min(40, Math.floor(this.acc));
      this.acc -= Math.floor(this.acc);
      return n;
    }
    push(n) {
      if (n <= 0) return;
      const w = this.cv.width;
      this.g.drawImage(this.cv, -n, 0);
      for (let i = 0; i < n; i++) this.g.putImageData(this.col, w - n + i, 0);
    }
    fill(r, g, b) {
      const d = this.col.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = r;
        d[i + 1] = g;
        d[i + 2] = b;
      }
    }
  }
  /** A canvas drawn in CSS pixels, sharp on any screen. Returns its context and size. */
  function sharp(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g, w, h };
  }

  const gram = new Scroller($('gram'));
  const strip = new Scroller($('strip'));
  const el = {
    name: $('nName'),
    oct: $('nOct'),
    cents: $('nCents'),
    hz: $('nHz'),
    needle: $('needle'),
    notePanel: $('notePanel'),
    regPanel: $('regPanel'),
    regName: $('regName'),
    regMark: $('regMark'),
    regWhy: $('regWhy'),
    regStats: $('regStats'),
    regScale: $('regScale'),
  };
  const set = (node, text) => {
    if (node.textContent !== text) node.textContent = text;
  };

  // ---------- state ----------
  let source = null; // { sr, win, read(buf), stop(), label }
  let buf = null;
  let spectrum = null;
  let pitch = null;
  let map = null; // spectrum bin at each pixel row's edge
  let frozen = false;
  let view = store.get('view', 'freq') === 'harm' ? 'harm' : 'freq';
  let a4 = Math.max(415, Math.min(466, +store.get('a4', 440) || 440));
  let cal = store.get('cal', {}) || {};
  let held = null; // the last sung frame, kept on screen after the voice stops
  let peakDb = -55;
  let run = 0;
  let lastT = 0;
  let capture = null;
  const sm = { n: 0, level: new Float32Array(MAX_N), snr: new Float32Array(MAX_N), f0: 0, idx: 0, fresh: true };

  // ---------- listening ----------
  function analyse(dt) {
    const p = pitch.detect(buf);
    const db = spectrum.compute(buf);
    let peak = -200;
    const i1 = Math.min(db.length - 1, Math.ceil(F_HI / spectrum.binHz));
    for (let i = Math.floor(F_LO / spectrum.binHz); i <= i1; i++) if (db[i] > peak) peak = db[i];
    peakDb = Math.max(peak, peakDb - 8 * dt, -55); // the picture's brightness follows the voice, not the room
    const ok = 20 * Math.log10(p.rms + 1e-9) > GATE_DB && p.clarity >= CLARITY && p.freq > 0;
    run = ok ? run + 1 : 0;
    if (!ok) sm.fresh = true;
    if (run < 2) return { voiced: false, db };

    const h = SG.measureHarmonics(db, spectrum.binHz, p.freq, { maxF: MAX_F, maxN: MAX_N });
    const jump = sm.fresh || !sm.f0 || Math.abs(1200 * Math.log2(p.freq / sm.f0)) > 80;
    sm.f0 = jump ? p.freq : sm.f0 * Math.pow(p.freq / sm.f0, 1 - Math.exp(-dt / 0.04));
    const a = 1 - Math.exp(-dt / 0.07);
    for (let k = 0; k < h.n; k++) {
      if (sm.fresh || k >= sm.n) {
        sm.level[k] = h.level[k];
        sm.snr[k] = h.snr[k];
      } else {
        sm.level[k] += a * (h.level[k] - sm.level[k]);
        sm.snr[k] += a * (h.snr[k] - sm.snr[k]);
      }
      h.level[k] = sm.level[k];
      h.snr[k] = sm.snr[k];
      h.present[k] = sm.snr[k] >= 12 ? 1 : 0;
    }
    sm.n = h.n;
    const feat = SG.voiceFeatures(h);
    const raw = SG.registerIndex(feat);
    const idx = SG.mapIndex(raw, cal);
    if (idx != null) sm.idx = sm.fresh ? idx : sm.idx + (1 - Math.exp(-dt / 0.15)) * (idx - sm.idx);
    sm.fresh = false;
    let top = -200;
    for (let k = 0; k < h.n; k++) if (h.level[k] > top) top = h.level[k];
    return { voiced: true, db, f0: sm.f0, h, top, feat, raw, idx: idx == null ? null : sm.idx };
  }

  // ---------- the note and the register ----------
  const signed = (v, d) => {
    const s = Math.abs(v).toFixed(d || 0);
    return (+s === 0 ? '' : v > 0 ? '+' : '−') + s;
  };
  function drawReadout(r) {
    el.notePanel.classList.toggle('idle', !r.voiced);
    el.regPanel.classList.toggle('idle', !r.voiced);
    if (!r.voiced) return;
    const n = SG.noteOf(r.f0, a4);
    const c = Math.round(n.cents);
    set(el.name, n.name);
    set(el.oct, String(n.octave));
    set(el.cents, c === 0 ? 'in tune' : `${Math.abs(c)} cents ${c > 0 ? 'sharp' : 'flat'}`);
    set(el.hz, r.f0.toFixed(1) + ' Hz');
    const col = Math.abs(n.cents) <= 10 ? C.hit : Math.abs(n.cents) <= 25 ? C.close : C.off;
    el.needle.style.left = 50 + Math.max(-50, Math.min(50, n.cents)) + '%';
    el.needle.style.background = col;
    el.cents.style.color = col;

    if (r.idx == null) return;
    const zone = SG.zoneOf(r.idx);
    set(el.regName, ZONE[zone]);
    el.regName.style.color = `rgb(${regRgb(r.idx)})`;
    el.regMark.style.left = r.idx * 100 + '%';
    el.regMark.style.opacity = '1';
    set(el.regWhy, WHY[zone]);
    const f = r.feat;
    set(
      el.regStats,
      `Overtones ${signed(f.overtone)} dB against the fundamental · H1−H2 ${signed(f.h1h2)} dB` + (f.tilt == null ? '' : ` · tilt ${signed(f.tilt)} dB/octave`) + ` · ${f.count} harmonics`
    );
  }
  function showScale() {
    set(el.regScale, SG.calibrated(cal) ? '· set to your voice' : '· generic scale');
  }

  // ---------- the bars ----------
  function drawBars() {
    const { g, w, h } = sharp($('bars'));
    const padL = 30;
    const padR = 6;
    const padT = 6;
    const padB = 46;
    const ph = h - padT - padB;
    if (ph < 20) return;
    g.font = `11px ${FONT}`;
    g.textBaseline = 'middle';
    g.textAlign = 'right';
    for (let d = 0; d <= BAR_RANGE; d += 20) {
      const y = padT + (d / BAR_RANGE) * ph;
      g.strokeStyle = 'rgba(147,161,184,' + (d === BAR_RANGE ? 0.5 : 0.15) + ')';
      g.beginPath();
      g.moveTo(padL, y + 0.5);
      g.lineTo(w - padR, y + 0.5);
      g.stroke();
      g.fillStyle = C.muted;
      g.fillText(d ? '−' + d : '0', padL - 6, y);
    }
    if (!held) {
      g.textAlign = 'center';
      g.fillStyle = C.muted;
      g.font = `14px ${FONT}`;
      g.fillText('Sing and hold a note: each bar is one overtone', padL + (w - padL - padR) / 2, padT + ph / 2);
      return;
    }
    const hm = held.h;
    const n = Math.min(hm.n, BARS);
    const slot = (w - padL - padR) / Math.max(n, 8);
    const bw = Math.max(2, Math.min(46, slot * 0.72));
    const every = Math.max(1, Math.ceil(30 / slot));
    g.globalAlpha = held.live ? 1 : 0.45;
    g.textAlign = 'center';
    for (let k = 1; k <= n; k++) {
      const x = padL + (k - 0.5) * slot;
      const u = Math.max(0, Math.min(1, (hm.level[k - 1] - held.top + BAR_RANGE) / BAR_RANGE));
      const bh = Math.max(1, u * ph);
      const here = hm.present[k - 1];
      g.fillStyle = k === 1 ? C.voice : C.brass;
      const alpha = g.globalAlpha;
      if (!here) g.globalAlpha = alpha * 0.22; // lost in the noise: its height means little
      g.beginPath();
      if (g.roundRect) g.roundRect(x - bw / 2, padT + ph - bh, bw, bh, [Math.min(3, bw / 2), Math.min(3, bw / 2), 0, 0]);
      else g.rect(x - bw / 2, padT + ph - bh, bw, bh);
      g.fill();
      g.globalAlpha = alpha;
      if (k !== 1 && k % every) continue;
      const note = SG.noteOf(k * held.f0, a4);
      const y0 = padT + ph + 11;
      g.fillStyle = C.muted;
      g.font = `11px ${FONT}`;
      g.fillText(k === 1 ? 'note' : String(k), x, y0);
      g.fillStyle = k === 1 ? C.voice : here ? C.text : C.muted;
      g.font = `600 12px ${FONT}`;
      g.fillText(note.name + note.octave, x, y0 + 14);
      g.fillStyle = C.muted;
      g.font = `11px ${FONT}`;
      g.fillText(signed(Math.round(note.cents)) + (slot >= 44 ? ' c' : ''), x, y0 + 27);
    }
    g.globalAlpha = 1;
  }

  // ---------- the picture ----------
  const yOf = (f, h) => h * (1 - Math.log(f / F_LO) / Math.log(F_HI / F_LO));
  function buildMap() {
    const h = gram.cv.height;
    map = new Float32Array(h + 1);
    for (let y = 0; y <= h; y++) map[y] = (F_HI * Math.pow(F_LO / F_HI, y / h)) / spectrum.binHz;
  }
  function freqColumn(db) {
    const d = gram.col.data;
    const h = gram.cv.height;
    const last = db.length - 1;
    for (let y = 0; y < h; y++) {
      const hi = map[y];
      const lo = map[y + 1];
      let v;
      if (hi - lo < 1) {
        const c = Math.min(last - 1, (hi + lo) / 2);
        const i = c | 0;
        v = db[i] + (db[i + 1] - db[i]) * (c - i);
      } else {
        v = -200;
        for (let i = Math.ceil(lo); i <= hi && i <= last; i++) if (db[i] > v) v = db[i];
      }
      const u = Math.max(0, Math.min(1, (v - peakDb + RANGE) / RANGE));
      const c = ((u * 255) | 0) * 3;
      d[y * 4] = LUT[c];
      d[y * 4 + 1] = LUT[c + 1];
      d[y * 4 + 2] = LUT[c + 2];
    }
  }
  function harmColumn(r) {
    const d = gram.col.data;
    const h = gram.cv.height;
    const rowH = h / ROWS;
    for (let y = 0; y < h; y++) {
      const k = ROWS - Math.floor(y / rowH); // the sung note at the bottom
      let u = 0;
      if (r.voiced && k >= 1 && k <= r.h.n && r.h.present[k - 1]) u = Math.max(0.1, Math.min(1, (r.h.level[k - 1] - r.top + 50) / 50));
      if (y % rowH < 1) u = 0; // a line between rows
      const c = ((u * 255) | 0) * 3;
      d[y * 4] = LUT[c];
      d[y * 4 + 1] = LUT[c + 1];
      d[y * 4 + 2] = LUT[c + 2];
    }
  }
  function pushColumns(r, dt) {
    if (gram.fit()) buildMap();
    strip.fit();
    const n = gram.steps(dt);
    if (!n) return;
    if (view === 'freq') freqColumn(r.db);
    else harmColumn(r);
    gram.push(n);
    if (r.voiced && r.idx != null) strip.fill(...regRgb(r.idx));
    else strip.fill(10, 19, 32);
    strip.push(n);
  }
  function drawOverlay(r) {
    const { g, w, h } = sharp($('gramOver'));
    g.font = `11px ${FONT}`;
    g.textBaseline = 'middle';
    const label = (text, x, y, col, align) => {
      g.textAlign = align;
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(10,19,32,0.85)';
      g.strokeText(text, x, y);
      g.fillStyle = col;
      g.fillText(text, x, y);
    };
    // a shaded margin on the right, so the labels read over the brightest part of the picture
    const shade = g.createLinearGradient(w - 84, 0, w, 0);
    shade.addColorStop(0, 'rgba(10,19,32,0)');
    shade.addColorStop(0.35, 'rgba(10,19,32,0.72)');
    shade.addColorStop(1, 'rgba(10,19,32,0.72)');
    g.fillStyle = shade;
    g.fillRect(w - 84, 0, 84, h);
    if (view === 'freq') {
      for (let oct = 1; oct <= 8; oct++) {
        const f = SG.freqOf(12 * (oct + 1), a4);
        if (f < F_LO || f > F_HI) continue;
        const y = yOf(f, h);
        g.fillStyle = 'rgba(230,235,243,0.10)';
        g.fillRect(0, Math.round(y), w, 1);
        label('C' + oct, 6, y, C.muted, 'left');
      }
      if (!r.voiced) return;
      let lastY = Infinity;
      for (let k = 1; k <= r.h.n; k++) {
        const y = yOf(k * r.f0, h);
        if (y < 6) break;
        g.fillStyle = k === 1 ? C.voice : r.h.present[k - 1] ? C.brass : 'rgba(212,178,106,0.3)';
        g.fillRect(w - 8, Math.round(y) - 1, 8, 2);
        if (lastY - y < 13) continue;
        lastY = y;
        const note = SG.noteOf(k * r.f0, a4);
        label((k === 1 ? '' : k + ' · ') + note.name + note.octave, w - 12, y, k === 1 ? C.voice : C.text, 'right');
      }
    } else {
      const rowH = h / ROWS;
      const every = Math.max(1, Math.ceil(13 / rowH));
      for (let k = 1; k <= ROWS; k++) {
        if (k !== 1 && k % every) continue;
        const y = h - (k - 0.5) * rowH;
        label(k === 1 ? 'note' : String(k), 6, y, C.muted, 'left');
        if (!r.voiced || k > r.h.n) continue;
        const note = SG.noteOf(k * r.f0, a4);
        label(note.name + note.octave, w - 6, y, k === 1 ? C.voice : C.text, 'right');
      }
    }
  }

  // ---------- every frame ----------
  let last = { voiced: false, db: null };
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, Math.max(0.001, (now - lastT) / 1000));
    lastT = now;
    if (source && !frozen) {
      source.read(buf);
      const r = analyse(dt);
      last = r;
      if (r.voiced) held = { h: r.h, top: r.top, f0: r.f0, live: true };
      else if (held) held.live = false;
      drawReadout(r);
      pushColumns(r, dt);
      if (capture) captureStep(r, dt);
    }
    drawBars();
    drawOverlay(last);
  }

  // ---------- sources ----------
  function use(src) {
    if (source) source.stop();
    source = src;
    if (src) {
      buf = new Float32Array(src.win);
      spectrum = new SG.Spectrum(src.sr, src.win);
      pitch = new SG.Pitch(src.sr, src.win);
      gram.fit();
      buildMap();
      sm.fresh = true;
      run = 0;
    }
    frozen = false;
    $('start').hidden = !!src;
    $('micBtn').textContent = src ? 'Stop' : 'Start';
    $('micBtn').classList.toggle('on', !!src);
    $('freezeBtn').disabled = !src;
    $('freezeBtn').setAttribute('aria-pressed', 'false');
    $('freezeBtn').textContent = 'Freeze';
    set($('micName'), src ? src.label : '');
    wake(!!src);
  }
  const ERR = {
    NotAllowedError: 'The browser blocked the microphone. Allow it for this site (the icon at the left of the address bar), then press Start again.',
    NotFoundError: 'No microphone found.',
    NotReadableError: 'The microphone would not open. Another program may be using it.',
  };
  async function startMic() {
    const msg = $('startMsg');
    msg.textContent = '';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg.textContent = 'The microphone only works on an https address or on localhost.';
      return;
    }
    const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
    const id = store.get('mic', '');
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: id ? Object.assign({ deviceId: { exact: id } }, base) : base });
      } catch (e) {
        if (!id || (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError')) throw e;
        stream = await navigator.mediaDevices.getUserMedia({ audio: base }); // the remembered mic is gone
      }
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      await ctx.resume();
      const an = ctx.createAnalyser();
      an.fftSize = ctx.sampleRate > 60000 ? 8192 : 4096;
      an.smoothingTimeConstant = 0;
      ctx.createMediaStreamSource(stream).connect(an);
      const track = stream.getAudioTracks()[0];
      use({
        sr: ctx.sampleRate,
        win: an.fftSize,
        label: track ? track.label : '',
        read: (b) => an.getFloatTimeDomainData(b),
        stop() {
          stream.getTracks().forEach((t) => t.stop());
          ctx.close().catch(() => {});
        },
      });
      listMics(track && track.getSettings ? track.getSettings().deviceId : id);
    } catch (e) {
      use(null);
      msg.textContent = ERR[e.name] || 'The microphone would not open (' + (e.message || e.name) + ').';
    }
  }
  /** A made-up voice, gliding from a chest-like low note to a head-like high one and back. */
  function demoSource() {
    const sr = 48000;
    const t0 = performance.now();
    return {
      sr,
      win: 4096,
      label: 'Made-up voice',
      stop() {},
      read(b) {
        const t = (performance.now() - t0) / 1000;
        const cyc = (t % 20) / 20;
        const u = 0.5 - 0.5 * Math.cos(2 * Math.PI * cyc);
        if (cyc < 0.04 || cyc > 0.96) {
          for (let i = 0; i < b.length; i++) b[i] = 1e-5 * (Math.random() * 2 - 1);
          return;
        }
        const f0 = 440 * Math.pow(2, (48 + 21 * u - 69 + 0.2 * Math.sin(2 * Math.PI * 5.5 * t)) / 12);
        const n = Math.floor(7000 / f0);
        const amp = new Float32Array(n);
        for (let k = 1; k <= n; k++) {
          const f = k * f0;
          const lift = (1 - u) * (18 * Math.exp(-Math.pow((f - 600) / 300, 2)) + 12 * Math.exp(-Math.pow((f - 2800) / 500, 2)));
          amp[k - 1] = 0.05 * Math.pow(10, ((-4 - 14 * u) * Math.log2(k) + lift) / 20);
        }
        const w = (2 * Math.PI * f0) / sr;
        for (let i = 0; i < b.length; i++) {
          let v = 1e-5 * (Math.random() * 2 - 1);
          for (let k = 1; k <= n; k++) v += amp[k - 1] * Math.sin(k * w * i + k * k);
          b[i] = v;
        }
      },
    };
  }
  let lock = null;
  async function wake(on) {
    try {
      if (on && navigator.wakeLock && document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen');
      else if (!on && lock) {
        lock.release();
        lock = null;
      }
    } catch (e) {
      /* the screen may sleep */
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (source && document.visibilityState === 'visible') wake(true);
  });

  async function listMics(current) {
    const sel = $('micSel');
    try {
      const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
      sel.textContent = '';
      sel.add(new Option('Default', ''));
      all.forEach((d, i) => sel.add(new Option(d.label || 'Microphone ' + (i + 1), d.deviceId)));
      const want = store.get('mic', '');
      sel.value = all.some((d) => d.deviceId === want) ? want : '';
      if (!sel.value && current && !want) sel.value = '';
    } catch (e) {
      /* the list stays as it is */
    }
  }

  // ---------- teaching it a voice ----------
  function showCal() {
    set($('calChestV'), cal.chest == null ? 'not set' : 'recorded');
    set($('calHeadV'), cal.head == null ? 'not set' : 'recorded');
    showScale();
  }
  function startCapture(which) {
    if (!source) {
      set($('calMsg'), 'Start the microphone first.');
      return;
    }
    capture = { which, t: 0, wait: 0, sum: 0, n: 0 };
    set($('calMsg'), `Sing a comfortable note in ${which} voice and hold it…`);
  }
  function captureStep(r, dt) {
    const c = capture;
    if (r.voiced && r.raw != null) {
      c.sum += r.raw;
      c.n++;
      c.t += dt;
      set($('calMsg'), `Listening… keep holding (${Math.max(0, 2 - c.t).toFixed(1)} s)`);
    } else if ((c.wait += dt) > 12) {
      capture = null;
      set($('calMsg'), 'No steady note heard. Press the button and try again.');
      return;
    }
    if (c.t < 2) return;
    capture = null;
    cal[c.which] = c.sum / c.n;
    store.set('cal', cal);
    showCal();
    if (cal.chest == null || cal.head == null) set($('calMsg'), `Got your ${c.which} voice. Now record ${c.which === 'chest' ? 'head' : 'chest'}.`);
    else if (!SG.calibrated(cal)) set($('calMsg'), 'Your two recordings came out too alike to tell apart, so the generic scale stays. Try again with a clearer difference, on the same vowel.');
    else set($('calMsg'), 'Done. The meter is now set to your voice.');
  }

  // ---------- controls ----------
  function setView(v) {
    view = v;
    store.set('view', v);
    for (const b of $('viewSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
    gram.clear();
  }
  function toggleFreeze() {
    if (!source) return;
    frozen = !frozen;
    $('freezeBtn').setAttribute('aria-pressed', String(frozen));
    $('freezeBtn').textContent = frozen ? 'Resume' : 'Freeze';
  }
  const toggleMic = () => (source ? use(null) : startMic());
  $('micBtn').onclick = toggleMic;
  $('startBtn').onclick = startMic;
  $('demoBtn').onclick = () => use(demoSource());
  $('freezeBtn').onclick = toggleFreeze;
  $('viewSeg').onclick = (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) setView(b.dataset.view);
  };
  $('setBtn').onclick = () => {
    set($('calMsg'), '');
    if (navigator.mediaDevices && source) listMics();
    $('settings').showModal();
  };
  $('micSel').onchange = (e) => {
    store.set('mic', e.target.value);
    if (source && source.label !== 'Made-up voice') startMic();
  };
  $('a4In').value = a4;
  $('a4In').onchange = (e) => {
    a4 = Math.max(415, Math.min(466, +e.target.value || 440));
    e.target.value = a4;
    store.set('a4', a4);
  };
  $('calChest').onclick = () => startCapture('chest');
  $('calHead').onclick = () => startCapture('head');
  $('calReset').onclick = () => {
    cal = {};
    capture = null;
    store.set('cal', cal);
    showCal();
    set($('calMsg'), 'Back on the generic scale.');
  };
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const open = $('settings').open;
    if (e.key === 's' || e.key === 'S') {
      if (open) $('settings').close();
      else $('setBtn').onclick();
    } else if (open) return;
    else if (e.key === ' ' && e.target.tagName !== 'BUTTON') {
      e.preventDefault();
      toggleFreeze();
    } else if (e.key === 'm' || e.key === 'M') toggleMic();
    else if (e.key === 'v' || e.key === 'V') setView(view === 'freq' ? 'harm' : 'freq');
  });

  setView(view);
  showCal();
  gram.fit();
  strip.fit();
  requestAnimationFrame(frame);
  if (/[?&]demo\b/.test(location.search)) use(demoSource());
})();
