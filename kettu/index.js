(() => {
  /* MicEQ Mobile — Kettu / Bunny / Vendetta plugin.
   *
   * What this can and cannot do is decided by the platform, not by effort:
   * Discord mobile captures your mic in native WebRTC code. A JS plugin cannot create
   * an AudioContext, so there is no biquad EQ and no tanh gain stage here — those live in
   * the browser extension and the BetterDiscord plugin, where Web Audio exists.
   *
   * What a plugin *can* reach is whatever the app exposes through Metro modules. So this
   * probes for the native voice setters (noise suppression, echo cancellation, AGC, mic
   * volume) and drives them. That is the real half of the desktop chain: "filterless" plus
   * a gain value handed to the native input volume.
   *
   * If your build does not expose those setters, the panel says so instead of pretending.
   */
  const app = (typeof vendetta !== 'undefined' && vendetta) || (typeof window !== 'undefined' ? window.bunny : null);
  if (!app) return { onLoad() {}, onUnload() {} };

  const DEFAULTS = {
    enabled: true,
    filterless: true,
    boost: 1,
    reapplyMs: 4000,
  };

  const BOOSTS = [
    { value: 1, label: 'off' },
    { value: 100, label: '100x' },
    { value: 1000, label: '1k' },
    { value: 2000, label: '2k' },
    { value: 5000, label: '5k' },
    { value: 10000, label: '10k' },
  ];

  /* Setters we know how to drive, and what we set them to when "filterless" is on. */
  const FILTER_SETTERS = [
    ['setNoiseSuppression', false],
    ['setNoiseCancellation', false],
    ['setEchoCancellation', false],
    ['setAutomaticGainControl', false],
  ];
  const ALL_METHODS = FILTER_SETTERS.map(([m]) => m).concat(['setInputVolume', 'setMicVolume']);
  const PROBE_GROUPS = [
    ['setNoiseSuppression'],
    ['setNoiseCancellation'],
    ['setEchoCancellation', 'setAutomaticGainControl'],
    ['setInputVolume'],
    ['setMicVolume'],
    ['setEchoCancellation'],
    ['setAutomaticGainControl'],
  ];

  const storage = (app.plugin && app.plugin.storage) || {};
  const log = (msg, ...rest) => { try { app.logger && app.logger.log(msg, ...rest); } catch (e) {} };
  const logErr = (msg) => { try { app.logger && app.logger.error(msg); } catch (e) {} };

  let settings = Object.assign({}, DEFAULTS, storage.settings || null);
  let cached = null;
  let timer = null;
  let lastRun = null;

  /* ---------- native voice discovery ---------- */

  function probe() {
    if (cached) return cached;
    const found = new Map();
    const metro = app.metro;
    if (!metro || typeof metro.findByPropsAll !== 'function') return (cached = []);
    for (const props of PROBE_GROUPS) {
      let list = [];
      try { list = metro.findByPropsAll(...props) || []; } catch (e) { list = []; }
      for (const mod of list) {
        if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) continue;
        if (found.has(mod)) continue;
        const methods = ALL_METHODS.filter((m) => typeof mod[m] === 'function');
        if (methods.length) found.set(mod, methods);
      }
    }
    cached = Array.from(found.entries()).map(([mod, methods]) => ({ mod, methods }));
    return cached;
  }

  function diagnostics() {
    const apis = probe();
    const methods = new Set();
    for (const a of apis) a.methods.forEach((m) => methods.add(m));
    return {
      apis: apis.length,
      methods: ALL_METHODS.filter((m) => methods.has(m)),
      lastRun,
    };
  }

  function call(mod, method, value) {
    if (!mod || typeof mod[method] !== 'function') return 0;
    try {
      mod[method](value);
      return 1;
    } catch (e) {
      logErr('[MicEQ] ' + method + ' failed: ' + (e && e.message));
      return 0;
    }
  }

  function applyNow(why) {
    if (!settings.enabled) return { calls: 0, why: 'disabled' };
    const apis = probe();
    let calls = 0;
    for (const { mod } of apis) {
      if (settings.filterless) {
        for (const [method, value] of FILTER_SETTERS) calls += call(mod, method, value);
      }
      const boost = Number(settings.boost) || 1;
      if (boost > 1) {
        calls += call(mod, 'setInputVolume', boost);
        calls += call(mod, 'setMicVolume', boost);
      } else {
        // leave the app's own level alone, but undo a previous push if it is reachable
        calls += call(mod, 'setInputVolume', 1);
      }
    }
    lastRun = { at: Date.now(), why: why || 'manual', calls, apis: apis.length };
    log('[MicEQ] applied (' + lastRun.why + '): ' + calls + ' setter calls across ' + apis.length + ' module(s)');
    return lastRun;
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(() => { applyNow('timer'); }, Math.max(1500, Number(settings.reapplyMs) || 4000));
  }

  function save() {
    try { storage.settings = Object.assign({}, settings); } catch (e) {}
  }

  /* ---------- settings UI ---------- */

  function Settings() {
    const React = app.metro && app.metro.common && app.metro.common.React;
    const RN = app.metro && app.metro.common && app.metro.common.ReactNative;
    if (!React || !RN) return null;
    const h = React.createElement;
    const { View, Text, Switch, Pressable, ScrollView } = RN;

    const [state, setState] = React.useState(() => Object.assign({}, settings));
    const [, force] = React.useState(0);

    const update = (patch) => {
      const next = Object.assign({}, state, patch);
      setState(next);
      settings = next;
      save();
      applyNow('settings');
    };

    const diag = diagnostics();
    const d = diag;

    return h(ScrollView, { style: { padding: 16 } },
      h(View, { style: { backgroundColor: '#14181d', borderColor: '#232a32', borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 10 } },
        h(View, { style: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' } },
          h(Text, { style: { color: '#e6eaef', fontSize: 15, fontWeight: '600' } }, 'MicEQ Mobile'),
          h(Switch, { value: !!state.enabled, onValueChange: (v) => update({ enabled: v }) })),
        h(Text, { style: { color: '#8b97a6', fontSize: 11, marginTop: 4 } },
          'Filterless mic + native gain tiers. No EQ here: mobile Discord captures in native code.')),

      h(View, { style: { backgroundColor: '#14181d', borderColor: '#232a32', borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 10 } },
        h(View, { style: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' } },
          h(Text, { style: { color: '#8b97a6', fontSize: 11, letterSpacing: 0.5 } }, 'FILTERLESS'),
          h(Switch, { value: !!state.filterless, onValueChange: (v) => update({ filterless: v }) })),
        h(Text, { style: { color: '#8b97a6', fontSize: 11, marginTop: 6 } },
          'Turns noise suppression, echo cancellation and AGC off on the native voice engine, when your build exposes those setters.')),

      h(View, { style: { backgroundColor: '#14181d', borderColor: '#232a32', borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 10 } },
        h(Text, { style: { color: '#8b97a6', fontSize: 11, letterSpacing: 0.5, marginBottom: 8 } }, 'BOOST · native input volume'),
        h(View, { style: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 } },
          BOOSTS.map((b) => h(Pressable, {
            key: b.value,
            onPress: () => update({ boost: b.value }),
            style: {
              paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1,
              borderColor: Number(state.boost) === b.value ? '#7cf5c4' : '#232a32',
              backgroundColor: Number(state.boost) === b.value ? '#123a2d' : '#0f1318',
            },
          }, h(Text, {
            style: { color: Number(state.boost) === b.value ? '#7cf5c4' : '#8b97a6', fontSize: 12 },
          }, b.label)))),
        h(Text, { style: { color: '#8b97a6', fontSize: 11, marginTop: 8 } },
          'The value is handed to the native setter as-is. Most builds clamp input volume to 1.0, so 1k may behave exactly like 100x. Check the diagnostics below.')),

      h(View, { style: { backgroundColor: '#14181d', borderColor: '#232a32', borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 10 } },
        h(Text, { style: { color: '#8b97a6', fontSize: 11, letterSpacing: 0.5, marginBottom: 6 } }, 'DIAGNOSTICS'),
        h(Text, { style: { color: '#e6eaef', fontSize: 12 } },
          'voice modules found: ' + d.apis + '\n' +
          'setters: ' + (d.methods.length ? d.methods.join(', ') : 'none') + '\n' +
          'last apply: ' + (d.lastRun ? d.lastRun.why + ', ' + d.lastRun.calls + ' calls' : 'not yet')),
        h(Pressable, {
          onPress: () => { cached = null; applyNow('reprobe'); force((n) => n + 1); },
          style: { marginTop: 10, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#232a32', alignItems: 'center' },
        }, h(Text, { style: { color: '#7cf5c4', fontSize: 12 } }, 'Re-probe + apply now')),
        d.apis === 0
          ? h(Text, { style: { color: '#ffb86b', fontSize: 11, marginTop: 8 } },
              'No voice module matched. Your Discord build hides those setters from JS, so this plugin cannot change anything on it.')
          : null));
  }

  /* ---------- plugin lifecycle ---------- */

  return {
    onLoad() {
      applyNow('load');
      schedule();
    },
    onUnload() {
      clearInterval(timer);
      timer = null;
      // hand the mic back: re-enable processing rather than leaving it off globally
      for (const { mod } of probe()) {
        call(mod, 'setNoiseSuppression', true);
        call(mod, 'setEchoCancellation', true);
        call(mod, 'setAutomaticGainControl', true);
        call(mod, 'setInputVolume', 1);
      }
    },
    settings: Settings,
  };
})()
