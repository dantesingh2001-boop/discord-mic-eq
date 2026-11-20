(() => {
  'use strict';
  const MEQ = window.__MEQ;
  const KEY = 'meqSettings';
  const GAIN_TYPES = ['peaking', 'lowshelf', 'highshelf'];

  let settings = MEQ.mergeSettings(MEQ.DEFAULT_SETTINGS, null);
  let tabId = null;
  let saveTimer = null;
  let selected = -1;

  const $ = (id) => document.getElementById(id);
  const el = {
    enabled: $('enabled'), preamp: $('preamp'), preampVal: $('preampVal'),
    limiter: $('limiter'), softClip: $('softClip'), agc: $('disableBrowserAgc'), filterless: $('filterless'),
    boost: $('boost'), loudVal: $('loudVal'),
    preset: $('preset'), graph: $('graph'), bands: $('bands'), status: $('status'),
    addBand: $('addBand'), reset: $('reset'),
  };
  const ctx2d = el.graph.getContext('2d');
  const G = { w: 720, h: 300, pad: 30, fMin: 20, fMax: 20000, dbMin: -18, dbMax: 18 };

  const xOf = (f) => G.pad + (Math.log(f / G.fMin) / Math.log(G.fMax / G.fMin)) * (G.w - 2 * G.pad);
  const fOf = (x) => G.fMin * Math.pow(G.fMax / G.fMin, (x - G.pad) / (G.w - 2 * G.pad));
  const yOf = (db) => G.h - G.pad - ((db - G.dbMin) / (G.dbMax - G.dbMin)) * (G.h - 2 * G.pad);
  const dbOf = (y) => G.dbMin + ((G.h - G.pad - y) / (G.h - 2 * G.pad)) * (G.dbMax - G.dbMin);

  /* ---------- graph ---------- */
  function draw() {
    const c = ctx2d;
    c.fillStyle = '#0f1318';
    c.fillRect(0, 0, G.w, G.h);
    c.strokeStyle = '#20272f';
    c.fillStyle = '#5d6b7a';
    c.font = '16px "Segoe UI", sans-serif';
    c.lineWidth = 1;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = xOf(f);
      c.beginPath(); c.moveTo(x, G.pad); c.lineTo(x, G.h - G.pad); c.stroke();
      c.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), x + 3, G.h - 8);
    }
    for (let db = G.dbMin; db <= G.dbMax; db += 6) {
      const y = yOf(db);
      c.strokeStyle = db === 0 ? '#39434f' : '#20272f';
      c.beginPath(); c.moveTo(G.pad, y); c.lineTo(G.w - G.pad, y); c.stroke();
      c.fillStyle = '#5d6b7a';
      c.fillText((db > 0 ? '+' : '') + db, 4, y + 5);
    }

    c.beginPath();
    for (let x = G.pad; x <= G.w - G.pad; x += 2) {
      const db = MEQ.responseDb(settings, fOf(x), 48000);
      const y = yOf(Math.max(G.dbMin - 6, Math.min(G.dbMax + 6, db)));
      if (x === G.pad) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.strokeStyle = settings.enabled ? '#7cf5c4' : '#4a5563';
    c.lineWidth = 2.5;
    c.stroke();

    (settings.bands || []).forEach((b, i) => {
      const g = GAIN_TYPES.includes(b.type) ? b.gain || 0 : 0;
      const x = xOf(b.freq), y = yOf(Math.max(G.dbMin, Math.min(G.dbMax, g)));
      c.beginPath();
      c.arc(x, y, i === selected ? 8 : 6, 0, Math.PI * 2);
      c.fillStyle = i === selected ? '#7cf5c4' : '#1d8f6c';
      c.fill();
      c.lineWidth = 1.5;
      c.strokeStyle = '#0b0d10';
      c.stroke();
    });
  }

  /* ---------- persistence ---------- */
  function commit(immediate) {
    clearTimeout(saveTimer);
    const run = () => {
      chrome.storage.local.set({ [KEY]: settings });
      if (tabId != null) {
        chrome.tabs.sendMessage(tabId, { type: 'setSettings', settings }).catch(() => {});
      }
    };
    if (immediate) run(); else saveTimer = setTimeout(run, 60);
  }

  function renderValues() {
    el.enabled.checked = settings.enabled;
    el.preamp.value = settings.preampDb;
    el.preampVal.textContent = (settings.preampDb > 0 ? '+' : '') + Number(settings.preampDb).toFixed(1) + ' dB';
    el.limiter.checked = settings.limiter;
    el.softClip.checked = settings.softClip;
    el.agc.checked = settings.disableBrowserAgc;
    el.filterless.checked = settings.filterless;
    el.boost.value = String(settings.boost || 1);
    const tot = MEQ.totalGainDb(settings);
    el.loudVal.textContent = (tot > 0 ? '+' : '') + tot.toFixed(1) + ' dB';
    el.loudVal.className = tot >= 60 ? 'hot' : '';
  }

  function renderBoost() {
    el.boost.innerHTML = '';
    MEQ.BOOST_STEPS.forEach((s) => {
      const o = document.createElement('option');
      o.value = String(s.value); o.textContent = s.label;
      el.boost.appendChild(o);
    });
  }

  function renderBands() {
    el.bands.innerHTML = '';
    (settings.bands || []).forEach((b, i) => {
      const row = document.createElement('div');
      row.className = 'band';

      const type = document.createElement('select');
      for (const t of MEQ.FILTER_TYPES) {
        const o = document.createElement('option');
        o.value = t; o.textContent = t;
        if (t === b.type) o.selected = true;
        type.appendChild(o);
      }
      type.addEventListener('change', () => { b.type = type.value; selected = i; refresh(); });

      const mk = (val, step, min, max, key) => {
        const n = document.createElement('input');
        n.type = 'number'; n.value = val; n.step = step; n.min = min; n.max = max;
        n.title = key;
        n.addEventListener('input', () => { b[key] = Number(n.value); selected = i; refresh(); });
        return n;
      };
      const freq = mk(Math.round(b.freq), 10, 20, 20000, 'freq');
      const gain = mk(b.gain || 0, 0.5, -24, 24, 'gain');
      const q = mk(b.q || 1, 0.1, 0.1, 20, 'q');
      if (!GAIN_TYPES.includes(b.type)) gain.disabled = true;
      q.style.width = '52px';

      const del = document.createElement('button');
      del.textContent = '×';
      del.title = 'remove band';
      del.addEventListener('click', () => { settings.bands.splice(i, 1); selected = -1; renderBands(); refresh(); });

      row.append(type, freq, gain, q, del);
      el.bands.appendChild(row);
    });
  }

  function refresh() {
    draw();
    renderValues();
    commit(false);
  }

  /* ---------- interaction ---------- */
  el.enabled.addEventListener('change', () => { settings.enabled = el.enabled.checked; refresh(); });
  el.preamp.addEventListener('input', () => {
    settings.preampDb = Number(el.preamp.value);
    el.preampVal.textContent = (settings.preampDb > 0 ? '+' : '') + Number(settings.preampDb).toFixed(1) + ' dB';
    renderValues(); draw(); commit(false);
  });
  el.boost.addEventListener('change', () => { settings.boost = Number(el.boost.value); refresh(); });
  el.filterless.addEventListener('change', () => { settings.filterless = el.filterless.checked; refresh(); });
  el.limiter.addEventListener('change', () => { settings.limiter = el.limiter.checked; refresh(); });
  el.softClip.addEventListener('change', () => { settings.softClip = el.softClip.checked; refresh(); });
  el.agc.addEventListener('change', () => { settings.disableBrowserAgc = el.agc.checked; refresh(); });

  el.preset.addEventListener('change', () => {
    const p = MEQ.PRESETS[el.preset.value];
    if (!p) return;
    settings.bands = p.map((b) => Object.assign({}, b));
    selected = -1;
    renderBands();
    refresh();
  });

  el.addBand.addEventListener('click', () => {
    settings.bands.push({ type: 'peaking', freq: 1000, gain: 3, q: 1 });
    selected = settings.bands.length - 1;
    renderBands();
    refresh();
  });

  el.reset.addEventListener('click', () => {
    settings = MEQ.mergeSettings(MEQ.DEFAULT_SETTINGS, null);
    selected = -1;
    renderBands();
    refresh();
  });

  function pointerPos(ev) {
    const r = el.graph.getBoundingClientRect();
    return {
      x: ((ev.clientX - r.left) / r.width) * G.w,
      y: ((ev.clientY - r.top) / r.height) * G.h,
    };
  }
  const drag = { on: false, index: -1 };

  el.graph.addEventListener('pointerdown', (ev) => {
    const p = pointerPos(ev);
    let best = -1, bestD = 22;
    (settings.bands || []).forEach((b, i) => {
      const g = GAIN_TYPES.includes(b.type) ? b.gain || 0 : 0;
      const d = Math.hypot(xOf(b.freq) - p.x, yOf(g) - p.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best === -1) return;
    drag.on = true; drag.index = best; selected = best;
    el.graph.setPointerCapture(ev.pointerId);
    draw();
  });

  el.graph.addEventListener('pointermove', (ev) => {
    if (!drag.on) return;
    const p = pointerPos(ev);
    const b = settings.bands[drag.index];
    if (!b) return;
    b.freq = Math.round(Math.min(20000, Math.max(20, fOf(p.x))));
    if (GAIN_TYPES.includes(b.type)) {
      b.gain = Math.round(Math.min(24, Math.max(-24, dbOf(p.y))) * 10) / 10;
    } else {
      b.q = Math.round(10 ** (Math.min(1, Math.max(0, (G.h - G.pad - p.y) / (G.h - 2 * G.pad))) * 2 - 1) * 10) / 10;
    }
    renderBands();
    el.bands.children[drag.index]?.scrollIntoView({ block: 'nearest' });
    draw();
    commit(false);
  });

  el.graph.addEventListener('pointerup', () => { drag.on = false; });
  el.graph.addEventListener('dblclick', (ev) => {
    const p = pointerPos(ev);
    settings.bands.push({
      type: 'peaking',
      freq: Math.round(fOf(p.x)),
      gain: Math.round(dbOf(p.y) * 10) / 10,
      q: 1,
    });
    selected = settings.bands.length - 1;
    renderBands();
    refresh();
  });

  /* ---------- boot ---------- */
  chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const tab = tabs && tabs[0];
    tabId = tab ? tab.id : null;
    const url = tab ? tab.url || '' : '';
    if (/discord\.com/.test(url)) {
      el.status.textContent = 'live on this Discord tab';
      el.status.className = 'status ok';
    } else if (/localhost/.test(url)) {
      el.status.textContent = 'test page — chain active';
      el.status.className = 'status ok';
    } else {
      el.status.textContent = 'open discord.com in this tab to apply';
      el.status.className = 'status warn';
    }
  });

  chrome.storage.local.get(KEY).then((res) => {
    if (res && res[KEY]) settings = MEQ.mergeSettings(MEQ.DEFAULT_SETTINGS, res[KEY]);
    el.preset.innerHTML = '';
    renderBoost();
    Object.keys(MEQ.PRESETS).forEach((name) => {
      const o = document.createElement('option');
      o.value = name; o.textContent = name;
      el.preset.appendChild(o);
    });
    renderBands();
    renderValues();
    draw();
  });
})();
