/* MAIN world: replaces navigator.mediaDevices.getUserMedia so Discord receives
 * our processed stream instead of the raw microphone. */
(function () {
  'use strict';
  if (window.__meqInstalled) return;
  window.__meqInstalled = true;

  const MEQ = window.__MEQ;
  if (!MEQ) return;

  let settings = MEQ.mergeSettings(MEQ.DEFAULT_SETTINGS, null);
  let ctx = null;
  const active = new Set();

  function getCtx() {
    if (!ctx || ctx.state === 'closed') {
      try {
        ctx = new AudioContext({ latencyHint: 'interactive' });
      } catch (e) {
        return null;
      }
    }
    return ctx;
  }

  function resume() {
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(function () {});
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, resume, { capture: true, passive: true });
  });

  function wantsAudio(c) {
    return !!c && (c === true || (typeof c === 'object' && !!c.audio));
  }

  function tuneConstraints(c) {
    if (!settings.disableBrowserAgc && !settings.filterless) return c;
    if (c === true) c = { audio: true };
    if (typeof c === 'object' && c.audio) {
      const audio = c.audio === true ? {} : Object.assign({}, c.audio);
      if (settings.disableBrowserAgc) audio.autoGainControl = false; // stop Chrome's AGC fighting our preamp
      if (settings.filterless) {
        // "filterless": raw full-band capture. Chrome otherwise band-limits the mic and
        // gates it, which is most of why a boosted mic still sounds thin.
        audio.noiseSuppression = false;
        audio.echoCancellation = false;
        audio.autoGainControl = false;
      }
      return Object.assign({}, c, { audio: audio });
    }
    return c;
  }

  /* Give the destination track the public surface of the real mic track, so
   * Discord's device code (getSettings/applyConstraints/label) keeps working. */
  function disguise(outTrack, rawTrack, entry) {
    const set = function (key, value) {
      try { outTrack[key] = value; } catch (e) { /* ignore */ }
    };
    set('getSettings', function () { return rawTrack.getSettings ? rawTrack.getSettings() : {}; });
    set('getCapabilities', function () { return rawTrack.getCapabilities ? rawTrack.getCapabilities() : {}; });
    set('getConstraints', function () { return rawTrack.getConstraints ? rawTrack.getConstraints() : {}; });
    set('applyConstraints', function () { return Promise.resolve(); });
    const realStop = outTrack.stop.bind(outTrack);
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
    } catch (e) { /* worst case Discord shows a generic device name */ }
    return outTrack;
  }

  function processStream(rawStream) {
    const c = getCtx();
    if (!c) return rawStream;
    resume();
    const rawTrack = rawStream.getAudioTracks()[0];
    if (!rawTrack) return rawStream;

    const source = c.createMediaStreamSource(rawStream);
    const chain = MEQ.createChain(c, settings);
    const dest = c.createMediaStreamDestination();
    source.connect(chain.input);
    chain.output.connect(dest);

    const outTrack = dest.stream.getAudioTracks()[0];
    const entry = { chain: chain, source: source, raw: rawStream, dest: dest };
    active.add(entry);
    disguise(outTrack, rawTrack, entry);
    rawTrack.addEventListener('ended', function () {
      try { entry.chain.dispose(); } catch (e) {}
      active.delete(entry);
    });
    return new MediaStream([outTrack]);
  }

  const devices = navigator.mediaDevices;
  if (!devices || !devices.getUserMedia) return;
  const original = devices.getUserMedia.bind(devices);

  devices.getUserMedia = function (constraints) {
    return original(tuneConstraints(constraints)).then(function (raw) {
      if (!settings.enabled || !wantsAudio(constraints)) return raw;
      try {
        return processStream(raw);
      } catch (e) {
        console.warn('[MicEQ] processing failed, falling back to raw mic', e);
        return raw;
      }
    });
  };

  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.meq !== 'settings') return;
    settings = MEQ.mergeSettings(MEQ.DEFAULT_SETTINGS, e.data.settings);
    for (const entry of active) {
      try { entry.chain.update(settings); } catch (err) {}
    }
    window.postMessage({ meq: 'applied', preampDb: settings.preampDb, boost: settings.boost, enabled: settings.enabled }, '*');
  });

  window.postMessage({ meq: 'hello' }, '*');
})();
