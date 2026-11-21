#!/usr/bin/env node
// EQ Bridge — lets a Roblox executor drive Equalizer APO (or any APO config file)
// over localhost, so sliders moved inside Roblox change what OTHER PLAYERS hear.
//
//   node roblox/bridge/eq-bridge.mjs
//   EQ_CONFIG="C:\temp\config.txt" EQ_PORT=7331 node roblox/bridge/eq-bridge.mjs
//
// Equalizer APO hot-reloads its config file on change, so each POST rewrites the
// mic chain and the change is audible in the next voice packet.
//
// Zero dependencies. Binds 127.0.0.1 only.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.EQ_PORT || 7331);
const CONFIG_PATH = process.env.EQ_CONFIG || defaultConfigPath();
const TOKEN = process.env.EQ_TOKEN || '';
const DEBOUNCE_MS = Number(process.env.EQ_DEBOUNCE || 120);
const MAX_BODY = 8 * 1024;

const BAND_IDS = ['sub', 'bass', 'lowmid', 'mid', 'uppermid', 'presence', 'brilliance', 'sparkle', 'air'];
const BAND_CENTRES = [60, 200, 600, 1500, 3500, 7000, 13000, 17000, 20000];
const BAND_Q = [1.1, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];

const BOOST_DB = { off: 0, '100x': 40, '1k': 60, '2k': 66, '3k': 69.5, '4k': 72, '10k': 80 };

// APO has no saturation/limiter stage, so anything past this just clips the
// encoder input. We clamp and say so rather than writing +80 dB and pretending.
const PREAMP_CEILING = 24;
const PREAMP_FLOOR = -24;
const BAND_MIN = -24;
const BAND_MAX = 10;

function defaultConfigPath() {
	if (process.platform === 'win32') {
		return 'C:\\Program Files\\EqualizerAPO\\config\\config.txt';
	}
	return path.join(os.tmpdir(), 'equalizer-apo-config.txt');
}

const stats = { writes: 0, rejects: 0, lastError: null, lastWrite: null, lastPayload: null };

function clamp(value, lo, hi) {
	const n = Number(value);
	if (!Number.isFinite(n)) return 0;
	return Math.min(hi, Math.max(lo, n));
}

function sanitize(input) {
	const warnings = [];
	const state = { bands: {}, preamp: 0, boost: 'off', hpf: 0, softclip: 0 };

	if (input && typeof input === 'object' && input.bands && typeof input.bands === 'object') {
		for (let i = 0; i < BAND_IDS.length; i++) {
			state.bands[BAND_IDS[i]] = clamp(input.bands[BAND_IDS[i]], BAND_MIN, BAND_MAX);
		}
	}

	const rawPreamp = Number(input?.preamp ?? 0);
	const boost = typeof input?.boost === 'string' && Object.hasOwn(BOOST_DB, input.boost) ? input.boost : 'off';
	const total = (Number.isFinite(rawPreamp) ? rawPreamp : 0) + BOOST_DB[boost];

	state.boost = boost;
	state.preamp = clamp(total, PREAMP_FLOOR, PREAMP_CEILING);
	if (total > PREAMP_CEILING) {
		warnings.push(
			`preamp+boost ${total.toFixed(1)} dB capped to +${PREAMP_CEILING} dB (APO cannot limit; higher would just clip)`
		);
	}
	if (boost !== 'off') {
		warnings.push(`boost "${boost}" is a gain tier, not a curve — it lands as preamp, not saturation`);
	}

	// optional rumble filter, useful on headset mics
	if (input?.hpf) {
		state.hpf = clamp(input.hpf, 0, 200);
	}
	if (input?.softclip) {
		state.softclip = clamp(input.softclip, 0, 1);
		if (state.softclip > 0) {
			warnings.push('soft clip ignored: Equalizer APO has no saturation stage');
		}
	}

	return { state, warnings };
}

function render(state) {
	const lines = [];
	lines.push('# written by eq-bridge.mjs — edits here are overwritten');
	lines.push(`# ${new Date().toISOString()}`);
	lines.push('');
	lines.push(`Preamp: ${state.preamp.toFixed(1)} dB`);
	lines.push('');

	if (state.hpf > 0) {
		lines.push(`Filter: ON HP Fc ${state.hpf} Hz`);
	}

	for (let i = 0; i < BAND_IDS.length; i++) {
		const gain = state.bands[BAND_IDS[i]];
		if (!gain) continue; // a 0 dB band is a no-op; keep the file short
		const centre = BAND_CENTRES[i];
		if (centre >= 20000) {
			lines.push(`Filter: ON HS Fc ${centre} Hz Gain ${gain.toFixed(1)} dB`);
		} else {
			lines.push(`Filter: ON PK Fc ${centre} Hz Gain ${gain.toFixed(1)} dB Q ${BAND_Q[i]}`);
		}
	}

	lines.push('');
	return lines.join('\n');
}

function writeConfig(text) {
	const dir = path.dirname(CONFIG_PATH);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.eq-bridge-${process.pid}.tmp`);
	try {
		fs.writeFileSync(tmp, text, 'utf8');
		fs.renameSync(tmp, CONFIG_PATH);
	} catch (err) {
		// rename can fail if APO holds the file; fall back to an in-place write
		try {
			fs.writeFileSync(CONFIG_PATH, text, 'utf8');
			try {
				fs.unlinkSync(tmp);
			} catch {}
		} catch (err2) {
			stats.lastError = `${err2.code || 'ERR'}: ${err2.message}`;
			throw err2;
		}
	}
	stats.lastError = null;
	stats.writes++;
	stats.lastWrite = Date.now();
}

let pending = null;
let timer = null;

function schedule(state) {
	pending = state;
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		timer = null;
		const next = pending;
		pending = null;
		if (!next) return;
		try {
			writeConfig(render(next));
			console.log(`[bridge] wrote ${CONFIG_PATH} (${stats.writes})`);
		} catch (err) {
			console.error(`[bridge] write failed: ${err.message}`);
		}
	}, DEBOUNCE_MS);
}

function send(res, code, body) {
	const json = JSON.stringify(body);
	res.writeHead(code, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(json),
		'cache-control': 'no-store',
		'access-control-allow-origin': '*',
		'access-control-allow-headers': 'content-type',
		'access-control-allow-methods': 'GET, POST, OPTIONS',
	});
	res.end(json);
}

const server = http.createServer((req, res) => {
	if (req.method === 'OPTIONS') {
		return send(res, 204, {});
	}

	const url = new URL(req.url, 'http://127.0.0.1');

	if (TOKEN && req.headers['x-eq-token'] !== TOKEN) {
		stats.rejects++;
		return send(res, 401, { ok: false, error: 'bad or missing x-eq-token header' });
	}

	if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
		let writable = true;
		try {
			const dir = path.dirname(CONFIG_PATH);
			fs.mkdirSync(dir, { recursive: true });
			fs.accessSync(dir, fs.constants.W_OK);
		} catch (err) {
			writable = false;
		}
		return send(res, 200, {
			ok: true,
			config: CONFIG_PATH,
			writable,
			writes: stats.writes,
			rejects: stats.rejects,
			lastWrite: stats.lastWrite,
			lastError: stats.lastError,
			hint: writable
				? undefined
				: 'cannot write the APO config directory — run this as Administrator',
		});
	}

	if (req.method === 'POST' && url.pathname === '/eq') {
		let body = '';
		req.setEncoding('utf8');
		req.on('data', (chunk) => {
			body += chunk;
			if (body.length > MAX_BODY) {
				stats.rejects++;
				send(res, 413, { ok: false, error: 'body too large' });
				req.destroy();
			}
		});
		req.on('end', () => {
			if (res.writableEnded) return;
			let payload;
			try {
				payload = JSON.parse(body || '{}');
			} catch {
				stats.rejects++;
				return send(res, 400, { ok: false, error: 'invalid JSON' });
			}
			if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
				stats.rejects++;
				return send(res, 400, { ok: false, error: 'expected a JSON object' });
			}
			const { state, warnings } = sanitize(payload);
			stats.lastPayload = state;
			schedule(state);
			send(res, 200, { ok: true, applied: state, warnings, debounceMs: DEBOUNCE_MS });
		});
		return;
	}

	if (req.method === 'GET' && url.pathname === '/eq') {
		return send(res, 200, { ok: true, applied: stats.lastPayload });
	}

	stats.rejects++;
	return send(res, 404, { ok: false, error: 'unknown route' });
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`[bridge] listening on http://127.0.0.1:${PORT}`);
	console.log(`[bridge] config: ${CONFIG_PATH}`);
	console.log(`[bridge] token: ${TOKEN ? 'required' : 'none (loopback only)'}`);
	if (process.platform === 'win32' && CONFIG_PATH.toLowerCase().includes('program files')) {
		console.log('[bridge] note: writing under "Program Files" needs an elevated shell');
	}
});

for (const sig of ['SIGINT', 'SIGTERM']) {
	process.on(sig, () => {
		server.close(() => process.exit(0));
	});
}
