/* Builds a GitHub-Pages-ready tree in docs/ from the single plugin source.
 *
 * Kettu supports two install paths, and this emits both:
 *   1. direct URL  -> docs/kettu/manifest.json + index.js   (paste .../kettu/)
 *   2. repo.json   -> docs/repo.json + docs/builds/<id>/...  (add .../ as a plugin repo)
 *
 * Run: node kettu/build-pages.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const docs = path.join(root, 'docs');

const PLUGIN_ID = 'miceq.mobile';
const VERSION = '1.0.0';

const js = fs.readFileSync(path.join(here, 'index.js'), 'utf8');
const hash = crypto.createHash('md5').update(js).digest('hex');

const vendorsManifest = {
  name: 'MicEQ Mobile',
  description: 'Filterless mic + native gain tiers for Discord mobile voice, with diagnostics for what your build exposes.',
  authors: [{ name: 'atomic' }],
  main: 'index.js',
  hash,
};

const bunnyManifest = {
  spec: 3,
  type: 'plugin',
  id: PLUGIN_ID,
  version: VERSION,
  display: {
    name: 'MicEQ Mobile',
    description: 'Filterless mic + native gain tiers for Discord mobile voice, with diagnostics for what your build exposes.',
    authors: [{ name: 'atomic' }],
  },
  main: 'index.js',
  extras: { bunny: {} },
};

const repo = {
  [PLUGIN_ID]: { version: VERSION },
  $meta: { name: 'MicEQ Mobile', description: 'Mic EQ for Discord mobile' },
};

const dirs = [
  path.join(docs, 'kettu'),
  path.join(docs, 'builds', PLUGIN_ID),
];
for (const d of dirs) fs.mkdirSync(d, { recursive: true });

const w = (p, body) => fs.writeFileSync(path.join(docs, p), body);
// tell GitHub Pages not to run Jekyll over the build output
if (!fs.existsSync(path.join(docs, '.nojekyll'))) fs.writeFileSync(path.join(docs, '.nojekyll'), '');
const wj = (p, obj) => w(p, JSON.stringify(obj, null, 2) + '\n');

w('kettu/index.js', js);
wj('kettu/manifest.json', vendorsManifest);
w(path.join('builds', PLUGIN_ID, 'index.js'), js);
wj(path.join('builds', PLUGIN_ID, 'manifest.json'), bunnyManifest);
wj('repo.json', repo);
w('index.html', [
  '<!doctype html><meta charset="utf-8">',
  '<title>MicEQ Mobile</title>',
  '<style>body{background:#0b0d10;color:#e6eaef;font:14px/1.5 system-ui;padding:32px;max-width:640px;margin:auto}',
  'code{color:#7cf5c4}a{color:#7cf5c4}</style>',
  '<h1>MicEQ Mobile</h1>',
  '<p>Kettu plugin. Add <code>' + PLUGIN_ID + '</code> by pasting the repo URL of this site,',
  ' or install directly from <code>/kettu/</code>.</p>',
  '<p>This build: <code>' + hash + '</code></p>',
  '',
].join('\n'));

console.log('wrote docs/');
console.log('  repo.json            -> ' + PLUGIN_ID + ' v' + VERSION);
console.log('  builds/' + PLUGIN_ID + '/ -> bunny spec 3');
console.log('  kettu/               -> direct-URL manifest, hash ' + hash);
