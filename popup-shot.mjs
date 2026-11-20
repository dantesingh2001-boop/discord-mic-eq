import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ext = path.resolve('extension');
const dir = path.resolve('test/.profile-popup');
const args = [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-first-run'];

let ctx = await chromium.launchPersistentContext(dir, {
  channel: 'chromium', headless: false, args, ignoreDefaultArgs: ['--disable-extensions'],
  viewport: { width: 400, height: 900 },
});
let page = await ctx.newPage();
await page.goto('about:blank');
await page.waitForTimeout(1500);
await ctx.close();

function findId() {
  for (const f of ['Default/Preferences', 'Default/Secure Preferences']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const settings = j.extensions && j.extensions.settings;
      if (!settings) continue;
      for (const [id, v] of Object.entries(settings)) {
        if (v && v.path && path.resolve(v.path) === ext) return id;
      }
    } catch (e) { console.log('parse fail', f, e.message); }
  }
  return null;
}
const id = findId();
console.log('extension id from profile:', id);
if (!id) process.exit(1);

ctx = await chromium.launchPersistentContext(dir, {
  channel: 'chromium', headless: false, args, ignoreDefaultArgs: ['--disable-extensions'],
  viewport: { width: 400, height: 900 },
});
page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[popup error]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text()); });
await page.goto(`chrome-extension://${id}/src/popup.html`);
await page.waitForTimeout(1200);
await page.screenshot({ path: 'test/popup.png', fullPage: true });
console.log('bands rendered:', await page.locator('.band').count());
console.log('status:', await page.locator('#status').innerText());
console.log('preamp label:', await page.locator('#preampVal').innerText());
await ctx.close();
