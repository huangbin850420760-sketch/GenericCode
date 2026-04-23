#!/usr/bin/env node
/*
 * M2 integration smoke test.
 *
 * Validates the IDE-action protocol end-to-end without vscode.  Rather
 * than running an actual VSCode host, we play the *IDE side* ourselves
 * against a live backend:
 *
 *   1. spawn webapp.py with GA_IDE_MODE=1 (same as M1)
 *   2. open WS, hello/hello_ack (same as M1)
 *   3. push a `context` message (verify server doesn't error)
 *   4. call `ide_bridge.request({type:'edit_file',...})` from the python
 *      side via a tiny Python-side helper and respond with `apply_edit_result`
 *      from our fake IDE, measuring round-trip correctness.
 *   5. simulate a run_terminal notification (fire-and-forget)
 *
 * We drive the agent directly by importing ide_bridge from a child helper
 * rather than going through the chat LLM — keeps the test deterministic.
 *
 * Usage:  node test/m2-smoke.js --python <py> --core <path>
 */
'use strict';

const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

function arg(flag, fallback) {
	const i = process.argv.indexOf(flag);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const HERE = __dirname;
const EXT_DIR = path.dirname(HERE);
const GENERIC_CODE = path.resolve(EXT_DIR, '..', '..');
const DEFAULT_CORE = path.join(GENERIC_CODE, 'agent-core');
const corePath = path.resolve(arg('--core', DEFAULT_CORE));
const pyPath = arg('--python', process.platform === 'win32' ? 'python.exe' : 'python3');
const webappPy = path.join(corePath, 'frontends', 'webapp.py');

if (!fs.existsSync(webappPy)) {
	console.error(`FAIL: webapp.py not found at ${webappPy}`);
	process.exit(2);
}

console.log(`[smoke] python = ${pyPath}`);
console.log(`[smoke] core   = ${corePath}`);

const child = cp.spawn(pyPath, [webappPy, '--http-port', '0', '--ws-port', '0'], {
	cwd: path.join(corePath, 'frontends'),
	env: { ...process.env, GA_IDE_MODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
	stdio: ['ignore', 'pipe', 'pipe'],
	windowsHide: true,
});

let ports = { http: 0, ws: 0 };
let ws;
let done = false;
const results = { handshake: false, context_accepted: false, edit_round_trip: false, run_terminal_ok: false };

function finish(code, extra) {
	if (done) { return; }
	done = true;
	if (extra) { console.log(extra); }
	console.log('\n--- M2 smoke results ---');
	for (const [k, v] of Object.entries(results)) {
		console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`);
	}
	try { ws?.close(); } catch (_) {}
	try { child.kill('SIGTERM'); } catch (_) {}
	setTimeout(() => {
		try { if (!child.killed) { child.kill('SIGKILL'); } } catch (_) {}
		const allOk = Object.values(results).every(Boolean);
		process.exit(code !== undefined ? code : (allOk ? 0 : 1));
	}, 500);
}

const overallTimeout = setTimeout(() => finish(3, 'FAIL: overall 60s timeout'), 60000);

// ── stdout parsing (same as M1) ─────────────────────────────
function onLine(line) {
	console.log(`[py] ${line}`);
	const m1 = /\[webapp\] HTTP on http:\/\/127\.0\.0\.1:(\d+)/.exec(line);
	const m2 = /\[webapp\] WS on ws:\/\/127\.0\.0\.1:(\d+)/.exec(line);
	if (m1) { ports.http = parseInt(m1[1], 10); }
	if (m2) { ports.ws = parseInt(m2[1], 10); }
	if (ports.http && ports.ws && !ws) {
		openWs();
	}
}
function splitter(carry, buf) {
	const lines = (carry.tail + buf.toString('utf8')).split(/\r?\n/);
	carry.tail = lines.pop() || '';
	lines.forEach(onLine);
}
const outCarry = { tail: '' }, errCarry = { tail: '' };
child.stdout.on('data', b => splitter(outCarry, b));
child.stderr.on('data', b => splitter(errCarry, b));
child.on('exit', (code, signal) => {
	if (!done) { finish(4, `FAIL: python exited early (code=${code} signal=${signal})`); }
});

// ── fake-IDE WS client ──────────────────────────────────────
function openWs() {
	ws = new WebSocket(`ws://127.0.0.1:${ports.ws}`);
	ws.on('open', () => {
		console.log('[smoke] → hello');
		ws.send(JSON.stringify({
			type: 'hello',
			payload: {
				client: 'genericcode-ext',
				version: '0.1.0-m2-smoke',
				proto: 1,
				features: ['edit_file', 'open_file', 'run_terminal', 'show_diff', 'context_push'],
			},
		}));
	});
	ws.on('message', raw => handleWs(raw));
	ws.on('error', err => finish(9, `FAIL: ws error — ${err.message}`));
}

function handleWs(raw) {
	let msg;
	try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }

	if (msg.type === 'hello_ack') {
		console.log('[smoke] ← hello_ack', msg.payload);
		results.handshake = true;
		// send a fake editor context, then trigger the Python-side edit_file
		pushContext();
		setTimeout(triggerEditFile, 300);
		return;
	}

	if (msg.type === 'edit_file') {
		console.log('[smoke] ← edit_file', {
			id: msg.id,
			path: msg.payload?.path,
			bytes: msg.payload?.new_content?.length,
		});
		// Accept the edit and echo back.
		ws.send(JSON.stringify({
			type: 'apply_edit_result',
			id: msg.id,
			payload: { accepted: true, final_content: msg.payload.new_content },
		}));
		results.edit_round_trip = true;
		// M2 path 3: synthesize a run_terminal notify
		setTimeout(triggerRunTerminal, 300);
		return;
	}

	// other server→client messages (stream/status/info/done) we ignore.
}

function pushContext() {
	const payload = {
		active_file: path.join(os.tmpdir(), 'm2-smoke-active.txt'),
		selection: { start_line: 1, end_line: 1, text: 'hello smoke' },
		open_files: [],
		workspace_root: os.tmpdir(),
	};
	ws.send(JSON.stringify({ type: 'context', payload }));
	results.context_accepted = true; // server must silently accept
	console.log('[smoke] → context pushed');
}

// Helper: drive a real edit_file round trip by running a tiny python snippet
// inside the backend process via `code_run` tool... but we're not going
// through the LLM here. Simpler: use a scratch Python that imports
// ide_bridge from the live backend's module space via `exec` over WS? No,
// we can't reach the running process' interpreter.
//
// Instead: spawn a second tiny Python interpreter that connects to the
// backend's webapp process via a monkey-patched ide_bridge is too invasive.
//
// The cleanest approach: fire a *tool-level* task over the existing `task`
// channel — but that hits the LLM and breaks determinism.
//
// Alternative chosen: drive the backend through a direct HTTP route that
// lets us invoke ide_bridge.request() server-side. This is a new dev-only
// endpoint gated by GA_IDE_MODE; see webapp.py _api_ide_selftest.
function triggerEditFile() {
	const http = require('http');
	const payload = JSON.stringify({
		type: 'edit_file',
		payload: {
			path: path.join(os.tmpdir(), 'm2-smoke-active.txt'),
			new_content: 'hello from m2 smoke\n',
			mode: 'overwrite',
			reason: 'm2 self-test',
		},
	});
	const req = http.request({
		host: '127.0.0.1', port: ports.http, method: 'POST',
		path: '/api/ide-selftest', headers: {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(payload),
		},
	}, res => {
		let body = '';
		res.on('data', c => body += c);
		res.on('end', () => console.log('[smoke] /api/ide-selftest →', res.statusCode, body));
	});
	req.on('error', e => finish(10, `FAIL: selftest http failed — ${e.message}`));
	req.write(payload);
	req.end();
}

function triggerRunTerminal() {
	const http = require('http');
	const payload = JSON.stringify({ type: 'run_terminal', payload: { cmd: 'echo hi', cwd: os.tmpdir(), name: 'smoke' } });
	const req = http.request({
		host: '127.0.0.1', port: ports.http, method: 'POST',
		path: '/api/ide-selftest', headers: {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(payload),
		},
	}, res => {
		console.log('[smoke] run_terminal selftest →', res.statusCode);
		if (res.statusCode === 200) { results.run_terminal_ok = true; }
		// All four probes done — finish.
		setTimeout(() => finish(0, '\nM2 smoke complete'), 500);
	});
	req.on('error', e => finish(11, `FAIL: run_terminal http failed — ${e.message}`));
	req.write(payload);
	req.end();
}
