import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ext = path.join(root, 'extension');
const PORT = 8848;
const HEADED = process.env.HEADED === '1';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wav': 'audio/wav', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, urlPath);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('nope'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

let failures = 0;
const fail = (msg) => { failures++; console.log('FAIL  ' + msg); };
const pass = (msg) => console.log('pass  ' + msg);

/* ---------- A: DSP chain accuracy in an OfflineAudioContext ---------- */
{
  const browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`http://localhost:${PORT}/test/chain-test.html`);
  await page.waitForFunction(() => document.title.startsWith('MEQ_'), null, { timeout: 180000 }).catch(() => {});
  const title = await page.title();
  const text = await page.$eval('#out', (e) => e.textContent);
  await browser.close();

  if (!title.startsWith('MEQ_') || title === 'MEQ_ERROR') {
    fail('chain test did not finish: ' + text.slice(0, 800));
  } else {
    const data = JSON.parse(text);
    const s = data.summary;
    console.log(`\n== DSP accuracy: ${s.passed}/${s.total} checks passed ==`);
    for (const f of s.failures) {
      fail(`${f.name}: expected ${f.expected} dB, measured ${f.measured} dB (diff ${f.diff})`);
    }
    if (s.failed === 0) pass(`all ${s.total} response checks within tolerance`);
  }
}

/* ---------- B: the fake microphone actually feeds processed audio ---------- */
{
  const userDataDir = path.join(here, '.profile');
  const args = [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${path.join(here, 'tone.wav')}`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(userDataDir, { channel: 'chromium', headless: !HEADED, args, ignoreDefaultArgs: ['--disable-extensions'] });
    console.log('extension flags:', args.filter(a => a.includes('extension')).join(' '));
  } catch (e) {
    console.log('launch failed, retrying headed:', e.message.split('\n')[0]);
    ctx = await chromium.launchPersistentContext(userDataDir, { channel: 'chromium', headless: false, args, ignoreDefaultArgs: ['--disable-extensions'] });
  }
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text()); });
  await page.goto(`http://localhost:${PORT}/test/mic-harness.html`);
  await page.waitForFunction(() => document.title === 'MEQ_HARNESS_READY', null, { timeout: 30000 });

  const hooked = await page.evaluate(() => window.__meqInstalled === true && !!window.__MEQ);
  hooked ? pass('getUserMedia hook installed in page MAIN world') : fail('hook NOT installed (extension did not inject)');

  const flatChain = { enabled: true, preampDb: 6, limiter: false, softClip: false, disableBrowserAgc: true, bands: [] };
  const flatChainFilterless = Object.assign({}, flatChain, { filterless: true });
  const raw = await page.evaluate(() => window.measure({ enabled: false, bands: [] }, 1500));
  const processed = await page.evaluate((s) => window.measure(s, 1500), flatChain);
  console.log(`raw dBFS ${raw.db.toFixed(2)}  processed dBFS ${processed.db.toFixed(2)}  delta ${(processed.db - raw.db).toFixed(2)} dB`);
  console.log(`track label "${processed.label}" settings ${processed.settings}`);

  if (raw.rms < 1e-4) fail('fake mic produced silence — harness broken, not the EQ');
  else {
    const delta = processed.db - raw.db;
    if (Math.abs(delta - 6) <= 1.0) pass(`preamp applied to the captured stream: ${delta.toFixed(2)} dB (want 6.0)`);
    else fail(`preamp delta ${delta.toFixed(2)} dB, wanted ~6.0`);
  }

  const eq = { enabled: true, preampDb: 0, limiter: false, softClip: false, bands: [{ type: 'highpass', freq: 2000, q: 0.7, gain: 0 }] };
  const eqOut = await page.evaluate((s) => window.measure(s, 1500), eq);
  const eqDelta = eqOut.db - raw.db;
  // 440 Hz source through a 2 kHz high-pass must lose a lot of level
  if (eqDelta < -20) pass(`filter reaches the wire: 2 kHz high-pass on a 440 Hz tone = ${eqDelta.toFixed(1)} dB`);
  else fail(`filter did not apply, delta ${eqDelta.toFixed(1)} dB`);

  // boost tiers: a "1k" chain must be far louder than a bare +6 dB preamp, and clipped-safe
  const boosted = await page.evaluate((s) => window.measure(s, 1500),
    { enabled: true, preampDb: 0, boost: 1000, limiter: true, softClip: true, disableBrowserAgc: true, bands: [] });
  if (boosted.rms > 0 && boosted.db > processed.db + 10) pass(`1k boost is genuinely louder: ${boosted.db.toFixed(1)} dBFS vs ${processed.db.toFixed(1)} dBFS`);
  else fail(`1k boost not louder: ${boosted.db.toFixed(1)} dBFS vs ${processed.db.toFixed(1)} dBFS`);

  // filterless must reach the actual microphone constraints
  const fl = await page.evaluate((s) => window.measure(s, 900), flatChainFilterless);
  const flSet = JSON.parse(fl.settings || '{}');
  if (flSet.echoCancellation === false && flSet.noiseSuppression === false && flSet.autoGainControl === false)
    pass('filterless mic constraints reach the device (AEC/NS/AGC off)');
  else fail(`filterless constraints missing: ${fl.settings}`);

  await ctx.close();
}


/* ---------- C: BetterDiscord plugin, same audio proof ---------- */
{
  const bdProfile = path.join(here, '.profile-bd');
  const ctx = await chromium.launchPersistentContext(bdProfile, {
    channel: 'chromium',
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${path.join(here, 'tone.wav')}`,
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
    ],
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[plugin pageerror]', e.message));
  await page.goto(`http://localhost:${PORT}/test/plugin-harness.html`);
  await page.waitForFunction(() => document.title === 'MEQ_PLUGIN_READY', null, { timeout: 30000 });

  const patched = await page.evaluate(() => window.__plugin.patched === true);
  patched ? pass('BD plugin hooked getUserMedia') : fail('BD plugin did NOT hook getUserMedia');

  const raw = await page.evaluate(() => window.measure({ enabled: false, bands: [] }, 1500));
  const processed = await page.evaluate(() => window.measure({ enabled: true, preampDb: 6, limiter: false, softClip: false, bands: [] }, 1500));
  const delta = processed.db - raw.db;
  console.log(`BD raw ${raw.db.toFixed(2)} dBFS, processed ${processed.db.toFixed(2)} dBFS, delta ${delta.toFixed(2)} dB`);
  if (Math.abs(delta - 6) <= 1.0) pass(`BD preamp lands on the wire: ${delta.toFixed(2)} dB (want 6.0)`);
  else fail(`BD preamp delta ${delta.toFixed(2)} dB, wanted ~6.0`);
  raw.label === processed.label
    ? pass(`BD track keeps the real device label ("${processed.label}")`)
    : fail(`BD label mismatch: "${raw.label}" vs "${processed.label}"`);

  const eq = await page.evaluate(() => window.measure({ enabled: true, preampDb: 0, limiter: false, softClip: false, bands: [{ type: 'highpass', freq: 2000, q: 0.7, gain: 0 }] }, 1500));
  const eqDelta = eq.db - raw.db;
  if (eqDelta < -20) pass(`BD filter reaches the wire: 2 kHz HP = ${eqDelta.toFixed(1)} dB`);
  else fail(`BD filter did not apply: ${eqDelta.toFixed(1)} dB`);

  // boost tiers must actually be loud, and filterless must reach the device
  const boosted = await page.evaluate(() => window.measure({ enabled: true, preampDb: 0, boost: 1000, limiter: true, softClip: true, bands: [] }, 1500));
  if (boosted.rms > 0 && boosted.db > processed.db + 10) pass(`BD 1k boost is genuinely louder: ${boosted.db.toFixed(1)} dBFS vs ${processed.db.toFixed(1)} dBFS`);
  else fail(`BD 1k boost not louder: ${boosted.db.toFixed(1)} dBFS vs ${processed.db.toFixed(1)} dBFS`);

  const fl = await page.evaluate(() => window.measure({ enabled: true, preampDb: 6, limiter: false, softClip: false, disableBrowserAgc: true, filterless: true, bands: [] }, 900));
  const flSet = JSON.parse(fl.settings || '{}');
  if (flSet.echoCancellation === false && flSet.noiseSuppression === false && flSet.autoGainControl === false)
    pass('BD filterless mic constraints reach the device (AEC/NS/AGC off)');
  else fail(`BD filterless constraints missing: ${fl.settings}`);

  const panel = await page.evaluate(() => {
    try { return { ok: true, value: window.__plugin.getSettingsPanel() === null ? 'null (no BdApi.React)' : 'element' }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  panel.ok ? pass(`getSettingsPanel survives missing BdApi.React: ${panel.value}`) : fail('getSettingsPanel threw: ' + panel.error);

  const restored = await page.evaluate(() => {
    window.__plugin.stop();
    return { patched: window.__plugin.patched, same: navigator.mediaDevices.getUserMedia === window.__origGumFn };
  });
  (restored.patched === false && restored.same)
    ? pass('stop() restores the original getUserMedia')
    : fail('stop() did not restore getUserMedia');

  await ctx.close();
}

server.close();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
