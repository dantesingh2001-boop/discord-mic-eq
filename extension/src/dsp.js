/* Mic EQ DSP core.
 * Runs in three places: the Discord page (MAIN world), the popup, and the offline test harness.
 * Chain: preamp gain -> N biquads -> soft clip -> limiter -> destination.
 */
(function (root) {
  'use strict';
  if (root.__MEQ) return;

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

  /* Hostile-gain tiers, same idea as the patched Discord voice modules: multiply the
   * signal far past full scale, then saturate it back to ~0 dBFS so the receiver hears
   * a crushed, very loud voice instead of digital wrap-around. 1k = +60 dB, 10k = +80 dB. */
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

  function dbToLin(db) { return Math.pow(10, db / 20); }

  function boostDb(settings) {
    const b = settings && settings.boost ? settings.boost : 1;
    return b > 0 ? 20 * Math.log10(b) : 0;
  }

  /* Linear gain the preamp node actually applies (preamp * boost tier). */
  function totalGain(settings) {
    if (!settings || !settings.enabled) return 1;
    return dbToLin(settings.preampDb || 0) * (settings.boost > 0 ? settings.boost : 1);
  }

  function totalGainDb(settings) {
    if (!settings || !settings.enabled) return 0;
    return (settings.preampDb || 0) + boostDb(settings);
  }

  /* Analytic magnitude (dB) at a frequency, for the graph and for tests. */
  function biquadDb(b, freq, sr) {
    // w0 comes from the filter's own cutoff/Q; w is where we evaluate the response
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
    let db = settings.enabled ? totalGainDb(settings) : 0;
    if (!settings.enabled) return 0;
    for (const b of settings.bands || []) db += biquadDb(b, freq, sr);
    return db;
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

  /* Builds the live processing graph. Returns {input, output, update, dispose}. */
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
      nodes = (bands || []).filter((b) => FILTER_TYPES.includes(b.type)).map((b) => {
        const f = ctx.createBiquadFilter();
        f.type = b.type;
        return f;
      });
      preamp.disconnect();
      clip.disconnect();
      limiter.disconnect();
      preamp.connect(nodes[0] || clip);
      for (let i = 0; i < nodes.length; i++) nodes[i].connect(nodes[i + 1] || clip);
      clip.connect(limiter);
      limiter.connect(out);
    }

    function update(s) {
      const t = ctx.currentTime;
      preamp.gain.setTargetAtTime(totalGain(s), t, 0.02);
      const bands = s.enabled ? s.bands || [] : [];
      if (bands.length !== nodes.length) wire(bands);
      for (let i = 0; i < bands.length; i++) {
        const b = bands[i], f = nodes[i];
        if (!f) continue;
        if (f.type !== b.type) f.type = b.type;
        if (b.freq) f.frequency.setTargetAtTime(clamp(b.freq, 20, ctx.sampleRate / 2 - 100), t, 0.02);
        if (typeof b.q === 'number') f.Q.setTargetAtTime(nodeQ(b.type, b.q), t, 0.02);
        if (typeof b.gain === 'number') f.gain.setTargetAtTime(s.enabled ? b.gain : 0, t, 0.02);
      }
      // More boost -> harder knee, but tanh still tops out at full scale instead of wrapping
      const boost = s.boost > 0 ? s.boost : 1;
      const drive = clamp(1.6 + Math.log10(boost), 1.2, 8);
      const saturating = s.enabled && s.softClip && boost > 1;
      clip.curve = s.enabled && s.softClip ? makeClipCurve(drive, boost > 1 ? 0.85 : 1) : null;
      // A tanh saturator already holds the ceiling, so a compressor after it only
      // costs loudness. Keep the limiter for the flat/boost-without-clip paths.
      const guard = s.enabled && s.limiter && !saturating;
      limiter.threshold.setTargetAtTime(guard ? (boost > 1 ? -1.5 : -6) : 0, t, 0.02);
      limiter.ratio.setTargetAtTime(guard ? 20 : 1, t, 0.02);
    }

    wire(settings.bands || []);
    update(settings);

    return {
      input: preamp,
      output: out,
      update,
      dispose() {
        for (const n of nodes) { try { n.disconnect(); } catch (e) {} }
        try { preamp.disconnect(); clip.disconnect(); limiter.disconnect(); out.disconnect(); } catch (e) {}
      },
    };
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /* Web Audio is a trap: lowpass/highpass take Q in dB, every other type takes it linear.
   * Convert so a band's Q means the same thing everywhere. */
  function nodeQ(type, q) {
    const qq = clamp(typeof q === 'number' ? q : 0.7, 0.05, 40);
    return (type === 'lowpass' || type === 'highpass') ? clamp(20 * Math.log10(qq), -40, 40) : qq;
  }

  function mergeSettings(base, patch) {
    const out = Object.assign({}, base, patch || {});
    out.bands = (patch && patch.bands ? patch.bands : base.bands).map((b) => Object.assign({}, b));
    return out;
  }

  root.__MEQ = {
    FILTER_TYPES,
    DEFAULT_SETTINGS,
    BOOST_STEPS,
    PRESETS,
    boostDb,
    totalGain,
    totalGainDb,
    createChain,
    nodeQ,
    responseDb,
    mergeSettings,
    makeClipCurve,
  };
})(typeof window !== 'undefined' ? window : globalThis);
