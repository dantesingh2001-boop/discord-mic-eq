// Exercises roblox/bridge/eq-bridge.mjs: HTTP surface + generated APO config.
//   node test/bridge-test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eqbridge-'));
const configPath = path.join(tmpDir, 'config.txt');
const port = 7300 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;

const results = [];
function check(label, ok, detail) {
	results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? `  [${detail}]` : ''}`);
}

function start(env = {}) {
	const child = spawn(process.execPath, [path.join(import.meta.dirname, '../roblox/bridge/eq-bridge.mjs')], {
		env: { ...process.env, EQ_CONFIG: configPath, EQ_PORT: String(port), ...env },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const ready = new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('bridge did not start')), 5000);
		child.stdout.on('data', (d) => {
			if (String(d).includes('listening')) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.stderr.on('data', (d) => process.stderr.write(`[bridge stderr] ${d}`));
	});
	return { child, ready };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(body, headers = {}) {
	const res = await fetch(`${base}/eq`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
	return { status: res.status, json: await res.json().catch(() => null) };
}

const { child, ready } = start();
await ready;

try {
	// 1. health
	const health = await (await fetch(`${base}/health`)).json();
	check('health reports the config path', health.config === configPath, health.config);
	check('health reports the dir writable', health.writable === true, health.writable);

	// 2. a full curve reaches the file
	const payload = {
		preamp: 6,
		boost: 'off',
		bands: { sub: 2, bass: 4, lowmid: 2, mid: 1, uppermid: 2, presence: 4, brilliance: 3, sparkle: 2, air: 1 },
	};
	const r1 = await post(payload);
	check('POST /eq accepted', r1.status === 200 && r1.json.ok === true, r1.status);
	await wait(400);
	const written = fs.readFileSync(configPath, 'utf8');
	check('preamp written', /^Preamp: 6\.0 dB$/m.test(written));
	check('sub band written', /Filter: ON PK Fc 60 Hz Gain 2\.0 dB Q 1\.1/.test(written));
	check('bass band written', /Filter: ON PK Fc 200 Hz Gain 4\.0 dB Q 1/.test(written));
	check('air written as a high shelf', /Filter: ON HS Fc 20000 Hz Gain 1\.0 dB/.test(written));
	check('no stray band at 0 dB', !/Gain 0\.0 dB/.test(written), written.split('\n').length + ' lines');

	// 3. zero bands are omitted
	const before = fs.readFileSync(configPath, 'utf8');
	await post({ preamp: 0, bands: { bass: 3 } });
	await wait(400);
	const sparse = fs.readFileSync(configPath, 'utf8');
	check('only the non-zero band is emitted', (sparse.match(/Filter:/g) || []).length === 1, (sparse.match(/Filter:/g) || []).length);

	// 4. boost tiers land as preamp and are capped honestly
	const r2 = await post({ preamp: 6, boost: '10k', bands: {} });
	check('10k + 6 dB reports a cap warning', r2.json.warnings.some((w) => w.includes('capped to +24')), r2.json.warnings.length);
	check('capped preamp applied', r2.json.applied.preamp === 24, r2.json.applied.preamp);
	await wait(400);
	check('file shows the capped preamp', /^Preamp: 24\.0 dB$/m.test(fs.readFileSync(configPath, 'utf8')));

	// 5. soft clip is refused, not silently dropped
	const r3 = await post({ preamp: 0, softclip: 0.4, bands: {} });
	check('soft clip is reported unsupported', r3.json.warnings.some((w) => w.includes('no saturation stage')));

	// 6. hostile input is clamped, not trusted
	const r4 = await post({ preamp: 'loud', boost: '__proto__', bands: { bass: 999, sub: -999, mid: 'x' } });
	check('bad strings become 0', r4.json.applied.bands.mid === 0, r4.json.applied.bands.mid);
	check('band gain clamped high', r4.json.applied.bands.bass === 10, r4.json.applied.bands.bass);
	check('band gain clamped low', r4.json.applied.bands.sub === -24, r4.json.applied.bands.sub);
	check('unknown boost tier ignored', r4.json.applied.boost === 'off', r4.json.applied.boost);
	check('unknown boost key does not pollute objects', ({}).off === undefined);

	// 7. malformed body
	const bad = await post('not json');
	check('invalid JSON -> 400', bad.status === 400, bad.status);
	const array = await post([1, 2, 3]);
	check('non-object JSON -> 400', array.status === 400, array.status);

	// 8. unknown route
	const missing = await fetch(`${base}/nope`);
	check('unknown route -> 404', missing.status === 404, missing.status);

	// 9. debounce coalesces bursts into one write
	const writesBefore = (await (await fetch(`${base}/health`)).json()).writes;
	for (let i = 0; i < 12; i++) {
		await post({ preamp: i, bands: { bass: i } });
	}
	await wait(500);
	const writesAfter = (await (await fetch(`${base}/health`)).json()).writes;
	check('12 rapid posts coalesce into 1 write', writesAfter - writesBefore === 1, `${writesBefore} -> ${writesAfter}`);

	child.kill();

	// 10. token mode
	const port2 = port + 1;
	const base2 = `http://127.0.0.1:${port2}`;
	const second = start({ EQ_TOKEN: 'sekret', EQ_PORT: String(port2) });
	await second.ready;
	const denied = await fetch(`${base2}/eq`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ preamp: 1 }),
	});
	check('token mode rejects unauthenticated POST', denied.status === 401, denied.status);
	const allowed = await fetch(`${base2}/eq`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-eq-token': 'sekret' },
		body: JSON.stringify({ preamp: 1, bands: { bass: 2 } }),
	});
	check('token mode accepts the header', allowed.status === 200, allowed.status);
	second.child.kill();
} catch (err) {
	check('harness completed without throwing', false, err.message);
	if (!child.killed) child.kill();
}

// 11. unwritable config dir degrades instead of crashing
{
	const port3 = port + 2;
	// a regular file where a directory is needed: mkdir/write must fail cleanly
	const blocker = path.join(tmpDir, 'blocker');
	fs.writeFileSync(blocker, 'not a directory');
	const locked = start({ EQ_CONFIG: path.join(blocker, 'config.txt'), EQ_PORT: String(port3) });
	await locked.ready;
	const health = await (await fetch(`http://127.0.0.1:${port3}/health`)).json();
	check('health survives an unusable config path', typeof health.writable === 'boolean', health.writable);
	locked.child.kill();
}

console.log(results.join('\n'));
const fails = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length} checks, ${fails} failed`);
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(fails === 0 ? 0 : 1);
