#!/usr/bin/env node
/*
 * M1 integration smoke test.
 *
 * Validates the full path that the VSCode extension will exercise at
 * activate():
 *   1. spawn python backend with GA_IDE_MODE=1 and --http-port 0 --ws-port 0
 *   2. parse stdout for the two "[webapp] ... on http(ws)://127.0.0.1:<n>" lines
 *   3. open a WebSocket to the reported port
 *   4. send {type:'hello', ...}, expect {type:'hello_ack', ...} within timeout
 *   5. clean shutdown
 *
 * Exits 0 on success, non-zero on any failure.  Prints a readable report.
 *
 * Usage:  node test/m1-smoke.js  [--core <agent-core-path>]  [--python <py-path>]
 */
'use strict';

const cp = require('child_process');
const path = require('path');
const fs = require('fs');
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
console.log(`[smoke] webapp = ${webappPy}`);

const child = cp.spawn(pyPath, [webappPy, '--http-port', '0', '--ws-port', '0'], {
	cwd: path.join(corePath, 'frontends'),
	env: { ...process.env, GA_IDE_MODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
	stdio: ['ignore', 'pipe', 'pipe'],
	windowsHide: true,
});

let ports = { http: 0, ws: 0 };
let wsClient;
let done = false;

function cleanup(code, msg) {
	if (done) { return; }
	done = true;
	console.log(msg);
	try { wsClient?.close(); } catch (_) {}
	try { child.kill('SIGTERM'); } catch (_) {}
	setTimeout(() => {
		try { if (!child.killed) { child.kill('SIGKILL'); } } catch (_) {}
		process.exit(code);
	}, 500);
}

const globalTimeout = setTimeout(() => cleanup(3, 'FAIL: overall timeout (45s)'), 45000);

function onLine(line) {
	console.log(`[py] ${line}`);
	const m1 = /\[webapp\] HTTP on http:\/\/127\.0\.0\.1:(\d+)/.exec(line);
	const m2 = /\[webapp\] WS on ws:\/\/127\.0\.0\.1:(\d+)/.exec(line);
	if (m1) { ports.http = parseInt(m1[1], 10); }
	if (m2) { ports.ws = parseInt(m2[1], 10); }
	if (ports.http && ports.ws && !wsClient) {
		console.log(`[smoke] ports ready: http=${ports.http} ws=${ports.ws}`);
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
	if (!done) { cleanup(4, `FAIL: python exited early (code=${code} signal=${signal})`); }
});
child.on('error', err => cleanup(5, `FAIL: spawn error — ${err.message}`));

function openWs() {
	const url = `ws://127.0.0.1:${ports.ws}`;
	console.log(`[smoke] connecting to ${url}`);
	wsClient = new WebSocket(url);

	const wsTimeout = setTimeout(() => {
		cleanup(6, 'FAIL: ws handshake did not complete within 5s');
	}, 5000);

	wsClient.on('open', () => {
		const hello = {
			type: 'hello',
			payload: {
				client: 'genericcode-ext',
				version: '0.1.0-smoke',
				proto: 1,
				features: ['edit_file', 'open_file', 'run_terminal', 'show_diff'],
			},
		};
		console.log('[smoke] → hello');
		wsClient.send(JSON.stringify(hello));
	});

	wsClient.on('message', raw => {
		let msg;
		try { msg = JSON.parse(raw.toString('utf8')); } catch (e) {
			console.warn('[smoke] bad json:', raw.toString('utf8').slice(0, 200));
			return;
		}
		if (msg.type !== 'hello_ack') { return; }
		clearTimeout(wsTimeout);
		clearTimeout(globalTimeout);
		const p = msg.payload || {};
		console.log('[smoke] ← hello_ack');
		console.log(`   server:   ${p.server}`);
		console.log(`   version:  ${p.version}`);
		console.log(`   proto:    ${p.proto}`);
		console.log(`   features: [${(p.features || []).join(', ')}]`);
		console.log(`   llm:      ${p.llm || '(none)'}`);
		if (p.proto !== 1) {
			return cleanup(7, `FAIL: proto mismatch — expected 1, got ${p.proto}`);
		}
		if (!Array.isArray(p.features) || p.features.length === 0) {
			return cleanup(8, 'FAIL: server advertised no features');
		}
		cleanup(0, '\nPASS: M1 smoke — spawn + port parsing + handshake OK');
	});

	wsClient.on('error', err => cleanup(9, `FAIL: ws error — ${err.message}`));
}
