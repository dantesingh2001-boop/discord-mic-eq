import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const srv = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(8850, r));
const b = await chromium.launch({ channel: 'chromium' });
const p = await b.newPage({ viewport: { width: 452, height: 760 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto('http://localhost:8850/test/panel-test.html');
await p.waitForFunction(() => document.title.startsWith('MEQ_PANEL'), null, { timeout: 30000 }).catch(() => {});
console.log('title:', await p.title());
await p.screenshot({ path: 'test/panel.png', fullPage: true });
await b.close(); srv.close();
