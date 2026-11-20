/* Smoke-test the Kettu plugin the same way Kettu loads it:
 * the file is injected as `vendetta => { return <file> }`.
 * Run: node test/kettu-plugin.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = fs.readFileSync(path.join(root, 'kettu/index.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'kettu/manifest.json'), 'utf8'));

let failures = 0;
const pass = (m) => console.log('pass  ' + m);
const fail = (m) => { failures++; console.log('FAIL  ' + m); };
const check = (ok, m) => (ok ? pass(m) : fail(m));

/* ---------- manifest ---------- */
check(manifest.name === 'MicEQ Mobile', 'manifest name');
check(manifest.main === 'index.js', 'manifest main points at index.js');
check(crypto.createHash('md5').update(src).digest('hex') === manifest.hash, 'manifest hash matches index.js');

/* ---------- GitHub Pages output (docs/) not stale ---------- */
const docs = path.join(root, 'docs');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(docs, p), 'utf8'));
const readText = (p) => fs.readFileSync(path.join(docs, p), 'utf8');
try {
  const repo = readJson('repo.json');
  check(!!repo['miceq.mobile'] && !!repo['miceq.mobile'].version, 'docs/repo.json lists the plugin with a version');
  const bm = readJson('builds/miceq.mobile/manifest.json');
  check(bm.spec === 3 && bm.type === 'plugin' && bm.main === 'index.js', 'docs bunny manifest is spec 3 / plugin / index.js');
  check(bm.version === repo['miceq.mobile'].version, 'repo.json and bunny manifest versions agree');
  const dm = readJson('kettu/manifest.json');
  check(crypto.createHash('md5').update(readText('kettu/index.js')).digest('hex') === dm.hash, 'docs direct-URL hash matches its index.js');
  check(readText('kettu/index.js') === src, 'docs direct-URL index.js is the current source');
  check(readText('builds/miceq.mobile/index.js') === src, 'docs bunny index.js is the current source');
} catch (e) {
  fail('docs/ missing or stale — run node kettu/build-pages.mjs (' + e.message + ')');
}

/* ---------- loader shape ---------- */
const load = (vendetta) => new Function('vendetta', 'return ' + src)(vendetta);

function fakeApp(opts = {}) {
  const calls = [];
  const mk = (id) => new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (!opts.methods.includes(prop)) return undefined;
      return (v) => calls.push({ id, method: prop, value: v });
    },
  });
  const modules = (opts.mods || [1]).map((n) => mk('m' + n));
  const storage = { settings: opts.settings };
  const app = {
    plugin: { id: 'MicEQMobile', storage },
    logger: { log() {}, error() {} },
    metro: {
      common: {},
      findByPropsAll: (...props) => modules.filter(() => props.length > 0),
    },
    ui: { toasts: { showToast() {} } },
  };
  return { app, calls, storage, modules };
}

try {
  const { app, calls } = fakeApp({ methods: ['setNoiseSuppression', 'setEchoCancellation', 'setAutomaticGainControl', 'setInputVolume'] });
  const plugin = load(app);
  check(plugin && typeof plugin.onLoad === 'function', 'plugin returns onLoad');
  check(typeof plugin.onUnload === 'function', 'plugin returns onUnload');
  check(typeof plugin.settings === 'function', 'plugin exposes settings component');

  plugin.onLoad();
  const off = calls.filter((c) => c.value === false).map((c) => c.method).sort();
  check(off.join(',') === 'setAutomaticGainControl,setEchoCancellation,setNoiseSuppression',
    'filterless turns NS/AEC/AGC off on load (' + off.join(', ') + ')');
  plugin.onUnload();
  check(calls.some((c) => c.method === 'setNoiseSuppression' && c.value === true), 'unload restores noise suppression');
  check(calls.some((c) => c.method === 'setInputVolume' && c.value === 1), 'unload resets input volume to 1');
} catch (e) {
  fail('plugin threw on load: ' + e.message);
}

/* ---------- gain handoff ---------- */
try {
  const { app, calls } = fakeApp({
    methods: ['setNoiseSuppression', 'setInputVolume'],
    settings: { enabled: true, filterless: true, boost: 1000, reapplyMs: 4000 },
  });
  const plugin = load(app);
  plugin.onLoad();
  const pushed = calls.filter((c) => c.method === 'setInputVolume').map((c) => c.value);
  check(pushed.includes(1000), 'boost tier is handed to the native input volume (' + pushed.join(',') + ')');
  plugin.onUnload();
} catch (e) {
  fail('gain handoff threw: ' + e.message);
}

/* ---------- no reachable voice module ---------- */
try {
  const { app, calls } = fakeApp({ methods: [], mods: [] });
  const plugin = load(app);
  plugin.onLoad();
  check(calls.length === 0, 'no voice module: does nothing, does not throw');
  plugin.onUnload();
} catch (e) {
  fail('empty-probe path threw: ' + e.message);
}

/* ---------- duplicate modules are not double-driven ---------- */
try {
  const seen = [];
  const mod = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'setNoiseSuppression') return (v) => seen.push(v);
      return undefined;
    },
  });
  const app = {
    plugin: { storage: {} },
    logger: { log() {}, error() {} },
    metro: { common: {}, findByPropsAll: () => [mod, mod, mod] },
  };
  load(app).onLoad();
  check(seen.filter((v) => v === false).length === 1, 'duplicate matches apply once, not three times');
} catch (e) {
  fail('dedupe path threw: ' + e.message);
}

/* ---------- disabled ---------- */
try {
  const { app, calls } = fakeApp({ methods: ['setNoiseSuppression'], settings: { enabled: false } });
  load(app).onLoad();
  check(calls.length === 0, 'disabled plugin makes no setter calls');
} catch (e) {
  fail('disabled path threw: ' + e.message);
}

/* ---------- settings UI degrades without React ---------- */
try {
  const { app } = fakeApp({ methods: ['setNoiseSuppression'] });
  const out = load(app).settings();
  check(out === null, 'settings component returns null when metro React is missing');
} catch (e) {
  fail('settings null path threw: ' + e.message);
}

console.log(failures === 0 ? '\nALL KETTU CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
