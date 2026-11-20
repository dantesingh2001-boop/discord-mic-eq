/**
 * @name MicEQ
 * @author atomic
 * @description Preamp boost (+24 dB) + 1k-10k hostile boost tiers + full parametric EQ + clip guard on your microphone, applied before Discord sends it.
 * @version 1.1.0
 */

'use strict';

/* ============================ DSP core ============================ */

const FILTER_TYPES = ['peaking', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'bandpass', 'notch', 'allpass'];

const DEFAULT_SETTINGS = {
  enabled: true,
  preampDb: 6,
  boost: 1,
  limiter: true,
  softClip: true,
  disableBrowserAgc: true,
  filterless: false,
  bands: [
    { type: 'highpass', freq: 85, q: 0.7, gain: 0 },
    { type: 'peaking', freq: 180, q: 1.0, gain: 2.5 },
    { type: 'peaking', freq: 420, q: 1.2, gain: -2.5 },
    { type: 'peaking', freq: 3000, q: 1.0, gain: 4.5 },
    { type: 'peaking', freq: 6500, q: 2.0, gain: -1.5 },
    { type: 'highshelf', freq: 9500, q: 0.7, gain: 1.5 },
  ],
};

/* Hostile-gain tiers, same idea as the patched Discord voice modules: multiply far past
 * full scale, then saturate back to ~0 dBFS. 1k = +60 dB, 10k = +80 dB. */
const BOOST_STEPS = [
  { value: 1, label: 'off (1x)' },
  { value: 100, label: '100x (+40 dB)' },
  { value: 1000, label: '1k (+60 dB)' },
  { value: 2000, label: '2k (+66 dB)' },
  { value: 3000, label: '3k (+69.5 dB)' },
  { value: 4000, label: '4k (+72 dB)' },
  { value: 5000, label: '5k (+74 dB)' },
  { value: 6000, label: '6k (+75.6 dB)' },
  { value: 7000, label: '7k (+76.9 dB)' },
  { value: 8000, label: '8k (+78 dB)' },
  { value: 9000, label: '9k (+79.1 dB)' },
  { value: 10000, label: '10k (+80 dB)' },
];

const PRESETS = {
  'Loud + Clear': DEFAULT_SETTINGS.bands,
  'Broadcast': [
    { type: 'highpass', freq: 100, q: 0.7, gain: 0 },
    { type: 'lowshelf', freq: 150, q: 0.7, gain: 1.5 },
    { type: 'peaking', freq: 250, q: 1.0, gain: 3 },
    { type: 'peaking', freq: 700, q: 1.4, gain: -3.5 },
    { type: 'peaking', freq: 2600, q: 1.1, gain: 5 },
    { type: 'peaking', freq: 5200, q: 2.0, gain: 2 },
  ],
  'Deep Radio': [
    { type: 'highpass', freq: 60, q: 0.7, gain: 0 },
    { type: 'lowshelf', freq: 120, q: 0.7, gain: 4 },
    { type: 'peaking', freq: 500, q: 1.2, gain: -4 },
    { type: 'peaking', freq: 2000, q: 1.0, gain: 3 },
    { type: 'highshelf', freq: 8000, q: 0.7, gain: 2 },
  ],
  'Clarity Max': [
    { type: 'highpass', freq: 120, q: 0.7, gain: 0 },
    { type: 'peaking', freq: 300, q: 1.2, gain: -6 },
    { type: 'peaking', freq: 3500, q: 1.2, gain: 6 },
    { type: 'peaking', freq: 7000, q: 2.0, gain: -3 },
  ],
  'Warm Bass Voice': [
    { type: 'lowshelf', freq: 150, q: 0.7, gain: 6 },
    { type: 'peaking', freq: 400, q: 1.2, gain: -3 },
    { type: 'peaking', freq: 3000, q: 1.0, gain: 2.5 },
    { type: 'highshelf', freq: 8500, q: 0.7, gain: -2 },
  ],
};

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function dbToLin(db) { return Math.pow(10, db / 20); }

/* Analytic magnitude (dB) of one band at an arbitrary frequency. Used by the graph
 * and by tests; verified against rendered audio to 0.35 dB. */
function biquadDb(b, freq, sr) {
  const w0 = 2 * Math.PI * clamp(b.freq || 1000, 1, sr / 2 * 0.999) / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const w = 2 * Math.PI * clamp(freq, 1, sr / 2 * 0.999) / sr;
  const ew = Math.cos(w), esw = Math.sin(w);
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const A = Math.pow(10, (b.gain || 0) / 40);
  const alpha = sw / (2 * clamp(b.q || 0.7, 0.05, 40));
  let b0, b1, b2, a0, a1, a2;
  switch (b.type) {
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    case 'lowshelf': {
      const sa = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cw + sa);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - sa);
      a0 = (A + 1) + (A - 1) * cw + sa;
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - sa; break;
    }
    case 'highshelf': {
      const sa = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + sa);
      b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - sa);
      a0 = (A + 1) - (A - 1) * cw + sa;
      a1 = 2 * ((A - 1) - (A + 1) * cw);
      a2 = (A + 1) - (A - 1) * cw - sa; break;
    }
    case 'lowpass':
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'highpass':
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'bandpass':
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'notch':
      b0 = 1; b1 = -2 * cw; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'allpass':
      b0 = 1 - alpha; b1 = -2 * cw; b2 = 1 + alpha;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    default:
      return 0;
  }
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  const nRe = b0 + b1 * ew + b2 * c2, nIm = -(b1 * esw + b2 * s2);
  const dRe = 1 + a1 * ew + a2 * c2, dIm = -(a1 * esw + a2 * s2);
  const num = Math.hypot(nRe, nIm), den = Math.hypot(dRe, dIm);
  if (den < 1e-12 || num < 1e-12) return -120;
  return 20 * Math.log10(num / den);
}

function responseDb(settings, freq, sr) {
  if (!settings.enabled) return 0;
  let db = totalGainDb(settings);
  for (const b of settings.bands || []) db += biquadDb(b, freq, sr);
  return db;
}

function boostDb(settings) {
  const b = settings && settings.boost ? settings.boost : 1;
  return b > 0 ? 20 * Math.log10(b) : 0;
}

function totalGain(settings) {
  if (!settings || !settings.enabled) return 1;
  return dbToLin(settings.preampDb || 0) * (settings.boost > 0 ? settings.boost : 1);
}

function totalGainDb(settings) {
  if (!settings || !settings.enabled) return 0;
  return (settings.preampDb || 0) + boostDb(settings);
}

/* Web Audio takes Q in dB for lowpass/highpass, linear for everything else. */
function nodeQ(type, q) {
  const qq = clamp(typeof q === 'number' ? q : 0.7, 0.05, 40);
  return (type === 'lowpass' || type === 'highpass') ? clamp(20 * Math.log10(qq), -40, 40) : qq;
}

function makeClipCurve(drive, ceiling) {
  const n = 2048, curve = new Float32Array(n), k = Math.max(1, drive), norm = Math.tanh(k);
  const top = typeof ceiling === 'number' ? ceiling : 1;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = top * Math.tanh(k * x) / norm;
  }
  return curve;
}

function mergeSettings(base, patch) {
  const out = Object.assign({}, base, patch || {});
  out.bands = (patch && patch.bands ? patch.bands : base.bands).map(function (b) { return Object.assign({}, b); });
  return out;
}

/* preamp -> N biquads -> soft clip -> limiter -> out */
function createChain(ctx, settings) {
  const preamp = ctx.createGain();
  const clip = ctx.createWaveShaper();
  clip.oversample = '4x';
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  const out = ctx.createGain();
  let nodes = [];

  function wire(bands) {
    for (const n of nodes) { try { n.disconnect(); } catch (e) {} }
    nodes = (bands || []).filter(function (b) { return FILTER_TYPES.indexOf(b.type) !== -1; }).map(function (b) {
      const f = ctx.createBiquadFilter();
      f.type = b.type;
      return f;
    });
    try { preamp.disconnect(); } catch (e) {}
    try { clip.disconnect(); } catch (e) {}
    try { limiter.disconnect(); } catch (e) {}
    preamp.connect(nodes[0] || clip);
    for (let i = 0; i < nodes.length; i++) nodes[i].connect(nodes[i + 1] || clip);
    clip.connect(limiter);
    limiter.connect(out);
  }

  function update(s) {
    const t = ctx.currentTime;
    preamp.gain.setTargetAtTime(totalGain(s), t, 0.02);
    const bands = s.enabled ? (s.bands || []) : [];
    if (bands.length !== nodes.length) wire(bands);
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i], f = nodes[i];
      if (!f) continue;
      if (f.type !== b.type) f.type = b.type;
      if (b.freq) f.frequency.setTargetAtTime(clamp(b.freq, 20, ctx.sampleRate / 2 - 100), t, 0.02);
      if (typeof b.q === 'number') f.Q.setTargetAtTime(nodeQ(b.type, b.q), t, 0.02);
      if (typeof b.gain === 'number') f.gain.setTargetAtTime(s.enabled ? b.gain : 0, t, 0.02);
    }
    const boost = s.boost > 0 ? s.boost : 1;
    const drive = clamp(1.6 + Math.log10(boost), 1.2, 8);
    const saturating = s.enabled && s.softClip && boost > 1;
    clip.curve = s.enabled && s.softClip ? makeClipCurve(drive, boost > 1 ? 0.85 : 1) : null;
    // Once the saturator owns the ceiling, a compressor after it only costs loudness.
    const guard = s.enabled && s.limiter && !saturating;
    limiter.threshold.setTargetAtTime(guard ? (boost > 1 ? -1.5 : -6) : 0, t, 0.02);
    limiter.ratio.setTargetAtTime(guard ? 20 : 1, t, 0.02);
  }

  wire(settings.bands || []);
  update(settings);

  return {
    input: preamp,
    output: out,
    update: update,
    dispose: function () {
      for (const n of nodes) { try { n.disconnect(); } catch (e) {} }
      try { preamp.disconnect(); clip.disconnect(); limiter.disconnect(); out.disconnect(); } catch (e) {}
    },
  };
}

/* ============================ The plugin ============================ */

class MicEQ {
  constructor(meta) {
    this.meta = meta || { name: 'MicEQ' };
    this.settings = this.loadSettings();
    this.ctx = null;
    this.active = new Set();
    this.originalGum = null;
    this.patched = false;
    this._protoPatch = false;
  }

  loadSettings() {
    let stored = null;
    try { stored = BdApi.Data.load(this.meta.name || 'MicEQ', 'settings'); } catch (e) { /* first run */ }
    return mergeSettings(DEFAULT_SETTINGS, stored);
  }

  saveSettings() {
    try { BdApi.Data.save(this.meta.name || 'MicEQ', 'settings', this.settings); } catch (e) {}
  }

  start() {
    this.patch();
    this.addStyle();
    const plugin = this;
    /* Electron can hand us a suspended AudioContext; resume on any real input. */
    this._resume = function () {
      if (plugin.ctx && plugin.ctx.state === 'suspended') plugin.ctx.resume().catch(function () {});
    };
    ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
      window.addEventListener(ev, plugin._resume, { capture: true, passive: true });
    });
    try {
      BdApi.UI.showToast(
        this.patched
          ? 'MicEQ: microphone hooked (preamp ' + (this.settings.preampDb > 0 ? '+' : '') + this.settings.preampDb +
            ' dB' + (this.settings.boost > 1 ? ', boost ' + this.settings.boost + 'x' : '') + ')'
          : 'MicEQ: failed to hook microphone',
        { type: this.patched ? 'success' : 'error' },
      );
    } catch (e) {}
  }

  stop() {
    this.unpatch();
    if (this._resume) {
      ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
        window.removeEventListener(ev, this._resume, { capture: true });
      }, this);
    }
    for (const entry of this.active) {
      try { entry.chain.dispose(); } catch (e) {}
      try { entry.source.disconnect(); } catch (e) {}
    }
    this.active.clear();
    if (this.ctx) {
      try { this.ctx.close(); } catch (e) {}
      this.ctx = null;
    }
    this.removeStyle();
  }

  /* ---------- mic interception ---------- */

  getCtx() {
    if (!this.ctx || this.ctx.state === 'closed') {
      try { this.ctx = new AudioContext({ latencyHint: 'interactive' }); } catch (e) { return null; }
    }
    return this.ctx;
  }

  wantsAudio(c) {
    return !!c && (c === true || (typeof c === 'object' && !!c.audio));
  }

  tuneConstraints(c) {
    if (!this.settings.disableBrowserAgc && !this.settings.filterless) return c;
    if (c === true) c = { audio: true };
    if (typeof c === 'object' && c.audio) {
      const audio = c.audio === true ? {} : Object.assign({}, c.audio);
      if (this.settings.disableBrowserAgc) audio.autoGainControl = false;
      if (this.settings.filterless) {
        // Raw full-band capture: no band-limiting, no gate, no AEC. Headphones only.
        audio.noiseSuppression = false;
        audio.echoCancellation = false;
        audio.autoGainControl = false;
      }
      return Object.assign({}, c, { audio: audio });
    }
    return c;
  }

  patch() {
    if (this.patched) return;
    const md = navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== 'function') {
      console.warn('[MicEQ] navigator.mediaDevices.getUserMedia is unavailable');
      return;
    }
    const plugin = this;
    this.originalFn = md.getUserMedia;
    this.originalGum = this.originalFn.bind(md);
    const patched = function (constraints) {
      return plugin.originalGum(plugin.tuneConstraints(constraints)).then(function (raw) {
        if (!plugin.settings.enabled || !plugin.wantsAudio(constraints)) return raw;
        try {
          return plugin.processStream(raw);
        } catch (e) {
          console.warn('[MicEQ] processing failed, passing raw mic through', e);
          return raw;
        }
      });
    };
    try {
      md.getUserMedia = patched;
      this.patched = true;
    } catch (e) {
      try {
        Object.defineProperty(Object.getPrototypeOf(md), 'getUserMedia', {
          value: patched, configurable: true, writable: true,
        });
        this.patched = true;
        this._protoPatch = true;
      } catch (e2) {
        console.warn('[MicEQ] could not replace getUserMedia', e2);
      }
    }
  }

  unpatch() {
    if (this._protoPatch) {
      try { delete Object.getPrototypeOf(navigator.mediaDevices).getUserMedia; } catch (e) {}
      this._protoPatch = false;
    } else if (this.originalFn) {
      try { navigator.mediaDevices.getUserMedia = this.originalFn; } catch (e) {}
    }
    this.patched = false;
  }

  disguise(outTrack, rawTrack, entry) {
    const set = function (key, value) {
      try { outTrack[key] = value; } catch (e) {}
    };
    set('getSettings', function () { return rawTrack.getSettings ? rawTrack.getSettings() : {}; });
    set('getCapabilities', function () { return rawTrack.getCapabilities ? rawTrack.getCapabilities() : {}; });
    set('getConstraints', function () { return rawTrack.getConstraints ? rawTrack.getConstraints() : {}; });
    set('applyConstraints', function () { return Promise.resolve(); });
    const realStop = outTrack.stop.bind(outTrack);
    const active = this.active;
    set('stop', function () {
      try { entry.chain.dispose(); } catch (e) {}
      try { entry.source.disconnect(); } catch (e) {}
      try { rawTrack.stop(); } catch (e) {}
      active.delete(entry);
      realStop();
    });
    try {
      Object.defineProperty(outTrack, 'label', { get: function () { return rawTrack.label; }, configurable: true });
      Object.defineProperty(outTrack, 'enabled', {
        get: function () { return rawTrack.enabled; },
        set: function (v) { rawTrack.enabled = v; },
        configurable: true,
      });
    } catch (e) {}
    return outTrack;
  }

  processStream(rawStream) {
    const ctx = this.getCtx();
    if (!ctx) return rawStream;
    if (ctx.state === 'suspended') ctx.resume().catch(function () {});
    const rawTrack = rawStream.getAudioTracks()[0];
    if (!rawTrack) return rawStream;

    const source = ctx.createMediaStreamSource(rawStream);
    const chain = createChain(ctx, this.settings);
    const dest = ctx.createMediaStreamDestination();
    source.connect(chain.input);
    chain.output.connect(dest);

    const outTrack = dest.stream.getAudioTracks()[0];
    const entry = { chain: chain, source: source, raw: rawStream, dest: dest };
    this.active.add(entry);
    this.disguise(outTrack, rawTrack, entry);
    const active = this.active;
    rawTrack.addEventListener('ended', function () {
      try { entry.chain.dispose(); } catch (e) {}
      active.delete(entry);
    });
    return new MediaStream([outTrack]);
  }

  /* ---------- settings ---------- */

  applySettings(patch, silent) {
    this.settings = mergeSettings(this.settings, patch || {});
    for (const entry of this.active) {
      try { entry.chain.update(this.settings); } catch (e) {}
    }
    if (!silent) {
      clearTimeout(this._saveTimer);
      const plugin = this;
      this._saveTimer = setTimeout(function () { plugin.saveSettings(); }, 150);
    }
    return this.settings;
  }

  applyPreset(name) {
    const bands = PRESETS[name];
    if (!bands) return this.settings;
    return this.applySettings({ bands: bands.map(function (b) { return Object.assign({}, b); }) });
  }

  /* ---------- styling ---------- */

  addStyle() {
    try {
      BdApi.DOM.addStyle('MicEQ', MIC_EQ_CSS);
    } catch (e) {
      if (!document.getElementById('MicEQ-style')) {
        const s = document.createElement('style');
        s.id = 'MicEQ-style';
        s.textContent = MIC_EQ_CSS;
        document.head.appendChild(s);
      }
    }
  }

  removeStyle() {
    try { BdApi.DOM.removeStyle('MicEQ'); } catch (e) {}
    const s = document.getElementById('MicEQ-style');
    if (s) s.remove();
  }
}

/* ============================ Settings UI ============================ */

const MIC_EQ_CSS = [
  '.miceq-panel{color:#e6eaef;font:12px/1.4 "Segoe UI",system-ui,sans-serif;width:100%;max-width:560px;box-sizing:border-box;}',
  '.miceq-panel *{box-sizing:border-box;}',
  '.miceq-panel .miceq-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0;}',
  '.miceq-panel .miceq-label{color:#8b97a6;font-size:11px;text-transform:uppercase;letter-spacing:.5px;}',
  '.miceq-panel .miceq-value{color:#7cf5c4;font-variant-numeric:tabular-nums;}',
  '.miceq-panel input[type=range]{width:100%;accent-color:#7cf5c4;}',
  '.miceq-panel .miceq-toggles{display:flex;gap:12px;flex-wrap:wrap;color:#8b97a6;font-size:11px;margin-top:4px;}',
  '.miceq-panel .miceq-toggles label{display:flex;align-items:center;gap:4px;}',
  '.miceq-panel .miceq-toggles input{accent-color:#7cf5c4;}',
  '.miceq-panel .miceq-loud{color:#8b97a6;font-size:11px;margin:2px 0 0;font-variant-numeric:tabular-nums;}',
  '.miceq-panel .miceq-hot{color:#ff7b6b;font-weight:600;}',
  '.miceq-panel canvas{width:100%;height:150px;display:block;background:#0f1318;border:1px solid #232a32;border-radius:8px;margin:8px 0;}',
  '.miceq-panel .miceq-bands{display:flex;flex-direction:column;gap:4px;max-height:262px;overflow-y:auto;}',
  '.miceq-panel .miceq-band{display:grid;grid-template-columns:96px 1fr 1fr 56px 18px;gap:4px;align-items:center;background:#14181d;border:1px solid #232a32;border-radius:6px;padding:4px 6px;}',
  '.miceq-panel select,.miceq-panel input[type=number]{background:#0f1318;color:#e6eaef;border:1px solid #232a32;border-radius:4px;padding:2px 4px;font-size:11px;width:100%;}',
  '.miceq-panel .miceq-del{background:none;border:none;color:#8b97a6;cursor:pointer;font-size:13px;padding:0;}',
  '.miceq-panel .miceq-del:hover{color:#ff7b7b;}',
  '.miceq-panel .miceq-footer{display:flex;gap:8px;margin-top:8px;}',
  '.miceq-panel .miceq-btn{flex:1;background:#14181d;color:#e6eaef;border:1px solid #232a32;border-radius:6px;padding:6px;font-size:11px;cursor:pointer;}',
  '.miceq-panel .miceq-btn:hover{border-color:#7cf5c4;color:#7cf5c4;}',
].join('');

function drawGraph(canvas, settings) {
  if (!canvas || !canvas.getContext) return;
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const w = canvas.clientWidth || 380;
  const hgt = canvas.clientHeight || 150;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
  }
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pad = 22, fMin = 20, fMax = 20000, dbMin = -18, dbMax = 18;
  const xOf = function (f) { return pad + (Math.log(f / fMin) / Math.log(fMax / fMin)) * (w - 2 * pad); };
  const fOf = function (x) { return fMin * Math.pow(fMax / fMin, (x - pad) / (w - 2 * pad)); };
  const yOf = function (db) { return hgt - pad - ((db - dbMin) / (dbMax - dbMin)) * (hgt - 2 * pad); };

  c.fillStyle = '#0f1318';
  c.fillRect(0, 0, w, hgt);
  c.font = '10px "Segoe UI",sans-serif';
  c.lineWidth = 1;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    c.strokeStyle = '#20272f';
    c.beginPath(); c.moveTo(xOf(f), pad); c.lineTo(xOf(f), hgt - pad); c.stroke();
    c.fillStyle = '#5d6b7a';
    c.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), xOf(f) + 2, hgt - 6);
  }
  for (let db = dbMin; db <= dbMax; db += 6) {
    c.strokeStyle = db === 0 ? '#39434f' : '#20272f';
    c.beginPath(); c.moveTo(pad, yOf(db)); c.lineTo(w - pad, yOf(db)); c.stroke();
    c.fillStyle = '#5d6b7a';
    c.fillText((db > 0 ? '+' : '') + db, 2, yOf(db) + 3);
  }
  c.beginPath();
  for (let x = pad; x <= w - pad; x += 2) {
    const db = Math.max(dbMin - 6, Math.min(dbMax + 6, responseDb(settings, fOf(x), 48000)));
    const y = yOf(db);
    if (x === pad) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.strokeStyle = settings.enabled ? '#7cf5c4' : '#4a5563';
  c.lineWidth = 2;
  c.stroke();
  (settings.bands || []).forEach(function (b) {
    const gain = (b.type === 'peaking' || b.type === 'lowshelf' || b.type === 'highshelf') ? (b.gain || 0) : 0;
    c.beginPath();
    c.arc(xOf(b.freq), yOf(Math.max(dbMin, Math.min(dbMax, gain))), 4.5, 0, Math.PI * 2);
    c.fillStyle = '#1d8f6c';
    c.fill();
  });
}

MicEQ.prototype.getSettingsPanel = function () {
  const plugin = this;
  const React = (typeof BdApi !== 'undefined' && BdApi.React) || null;
  if (!React) {
    console.error('[MicEQ] BdApi.React unavailable, cannot build settings panel');
    return null;
  }
  const h = React.createElement;
  const GAIN_TYPES = ['peaking', 'lowshelf', 'highshelf'];

  function mutate(bands, index, patch) {
    return bands.map(function (b, i) { return i === index ? Object.assign({}, b, patch) : Object.assign({}, b); });
  }

  function toggle(key, label, settings, commit) {
    return h('label', { key: key },
      h('input', {
        type: 'checkbox', checked: !!settings[key],
        onChange: function (e) { commit({ [key]: e.target.checked }); },
      }),
      label);
  }

  function Panel() {
    const [settings, setSettings] = React.useState(plugin.settings);
    const canvasRef = React.useRef(null);

    function commit(patch) {
      const next = plugin.applySettings(patch, true);
      plugin.saveSettings();
      setSettings(Object.assign({}, next, {
        bands: next.bands.map(function (b) { return Object.assign({}, b); }),
      }));
    }

    React.useEffect(function () { drawGraph(canvasRef.current, settings); }, [settings]);

    const rows = (settings.bands || []).map(function (b, i) {
      return h('div', { className: 'miceq-band', key: i },
        h('select', {
          value: b.type,
          onChange: function (e) { commit({ bands: mutate(settings.bands, i, { type: e.target.value }) }); },
        }, FILTER_TYPES.map(function (t) { return h('option', { key: t, value: t }, t); })),
        h('input', {
          type: 'number', value: Math.round(b.freq), step: 10, min: 20, max: 20000, title: 'frequency (Hz)',
          onChange: function (e) { commit({ bands: mutate(settings.bands, i, { freq: Number(e.target.value) }) }); },
        }),
        h('input', {
          type: 'number', value: b.gain || 0, step: 0.5, min: -24, max: 24, title: 'gain (dB)',
          disabled: GAIN_TYPES.indexOf(b.type) === -1,
          onChange: function (e) { commit({ bands: mutate(settings.bands, i, { gain: Number(e.target.value) }) }); },
        }),
        h('input', {
          type: 'number', value: b.q || 1, step: 0.1, min: 0.1, max: 20, title: 'Q',
          onChange: function (e) { commit({ bands: mutate(settings.bands, i, { q: Number(e.target.value) }) }); },
        }),
        h('button', {
          className: 'miceq-del', title: 'remove band',
          onClick: function () { commit({ bands: settings.bands.filter(function (_, j) { return j !== i; }) }); },
        }, '\u00d7'));
    });

    return h('div', { className: 'miceq-panel' },
      h('div', { className: 'miceq-row' },
        h('span', { className: 'miceq-label' }, 'Preamp'),
        h('span', { className: 'miceq-value' },
          (settings.preampDb > 0 ? '+' : '') + Number(settings.preampDb).toFixed(1) + ' dB')),
      h('input', {
        type: 'range', min: -24, max: 24, step: 0.5, value: settings.preampDb,
        onChange: function (e) { commit({ preampDb: Number(e.target.value) }); },
      }),
      h('div', { className: 'miceq-row' },
        h('span', { className: 'miceq-label' }, 'Boost'),
        h('select', {
          value: String(settings.boost || 1),
          onChange: function (e) { commit({ boost: Number(e.target.value) }); },
        }, BOOST_STEPS.map(function (s) { return h('option', { key: s.value, value: String(s.value) }, s.label); }))),
      h('div', { className: 'miceq-loud' }, 'total ', h('span', {
        className: totalGainDb(settings) >= 60 ? 'miceq-hot' : '',
      }, (totalGainDb(settings) > 0 ? '+' : '') + totalGainDb(settings).toFixed(1) + ' dB')),
      h('div', { className: 'miceq-toggles' },
        toggle('enabled', 'enabled', settings, commit),
        toggle('limiter', 'clip guard', settings, commit),
        toggle('softClip', 'soft clip', settings, commit),
        toggle('disableBrowserAgc', 'kill browser AGC', settings, commit),
        toggle('filterless', 'filterless mic', settings, commit)),
      h('div', { className: 'miceq-row', style: { marginTop: '10px' } },
        h('span', { className: 'miceq-label' }, 'Preset'),
        h('select', {
          defaultValue: '',
          onChange: function (e) {
            if (!e.target.value) return;
            const preset = PRESETS[e.target.value];
            if (preset) commit({ bands: preset.map(function (x) { return Object.assign({}, x); }) });
          },
        },
          h('option', { value: '' }, 'choose\u2026'),
          Object.keys(PRESETS).map(function (k) { return h('option', { key: k, value: k }, k); }))),
      h('canvas', { ref: canvasRef }),
      h('div', { className: 'miceq-bands' }, rows),
      h('div', { className: 'miceq-footer' },
        h('button', {
          className: 'miceq-btn',
          onClick: function () {
            commit({ bands: settings.bands.concat([{ type: 'peaking', freq: 1000, gain: 3, q: 1 }]) });
          },
        }, '+ band'),
        h('button', {
          className: 'miceq-btn',
          onClick: function () {
            commit({
              preampDb: DEFAULT_SETTINGS.preampDb,
              bands: DEFAULT_SETTINGS.bands.map(function (x) { return Object.assign({}, x); }),
            });
          },
        }, 'reset')));
  }

  return h(Panel);
};

/* ============================ exports ============================ */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MicEQ;
}
if (typeof window !== 'undefined') {
  window.MicEQPlugin = MicEQ;
  window.MicEQDsp = {
    responseDb: responseDb,
    createChain: createChain,
    totalGain: totalGain,
    totalGainDb: totalGainDb,
    BOOST_STEPS: BOOST_STEPS,
    PRESETS: PRESETS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    nodeQ: nodeQ,
  };
}
