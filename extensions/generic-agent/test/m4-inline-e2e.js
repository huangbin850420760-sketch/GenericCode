#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * M4.3 end-to-end: connect to a running agent-core WS the same way
 * AgentClient does, send an inline-style task, stream the response into
 * our in-process buffer, apply the same `extractCode` extraction the real
 * extension does, and assert the cleaned output is non-empty code-shaped.
 *
 * Requires the backend to be running on the port discovered via the
 * http status endpoint.
 */

const http = require('http');
const WebSocket = require(require('path').join(__dirname, '..', 'node_modules', 'ws'));
const path = require('path');

// Stub vscode before requiring inlineEdit (just to access extractCode).
const Module = require('module');
const vscodeStub = {
	commands: { registerCommand: () => ({}), executeCommand: async () => {} },
	window: { showWarningMessage: () => {}, showErrorMessage: () => {}, withProgress: (_, f) => f({ report:()=>{} }, { onCancellationRequested:()=>({}) }) },
	workspace: { fs:{ readFile: async ()=>Buffer.from('') }, workspaceFolders: [], registerTextDocumentContentProvider: () => ({}), openTextDocument: async () => ({ save: async () => {} }), applyEdit: async () => true },
	Uri: { file: (p) => ({ fsPath: p, path: p, scheme: 'file', with(o){return {...this,...o};}, toString(){return this.scheme+'://'+this.path;} }) },
	Position: class {}, Range: class {}, WorkspaceEdit: class { replace(){} insert(){} createFile(){} },
	EventEmitter: class { constructor(){this.event=()=>({dispose:()=>{}});} fire(){} dispose(){} },
	ProgressLocation: { Notification: 15 }, ViewColumn: { Beside: -2 },
};
const origLoad = Module._load;
Module._load = function (req, parent, ...rest) {
	if (req === 'vscode') return vscodeStub;
	return origLoad.call(this, req, parent, ...rest);
};
const { extractCode, buildInlinePrompt } = require(path.join(__dirname, '..', 'out', 'inlineEdit.js'));

function httpGet(url) {
	return new Promise((resolve, reject) => {
		const req = http.get(url, res => {
			const chunks = [];
			res.on('data', c => chunks.push(c));
			res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
		});
		req.on('error', reject);
		req.setTimeout(3000, () => req.destroy(new Error('timeout')));
	});
}

async function discoverPorts() {
	const r = await httpGet('http://127.0.0.1:18520/api/status');
	if (r.status !== 200) throw new Error(`status ${r.status}`);
	// webapp.py's /api/status returns info about the LLM plus ws_port
	// (per ports.json inspection).  We grab 18521 as the default sibling.
	return { http: 18520, ws: 18521 };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async function main() {
	console.log('[e2e] discovering backend…');
	let ports;
	try { ports = await discoverPorts(); }
	catch (e) {
		console.error('[e2e] backend not running at 127.0.0.1:18520 —', e.message);
		console.error('[e2e] start it with .\\scripts\\code.bat first (or skip this test)');
		process.exit(2);
	}
	console.log('[e2e] ports:', ports);

	const ws = new WebSocket(`ws://127.0.0.1:${ports.ws}`);
	const timeout = setTimeout(() => {
		console.error('[e2e] TIMEOUT — no done event within 90s');
		ws.close();
		process.exit(1);
	}, 90000);

	let buffer = '';
	let deltas = 0;
	let handshaked = false;

	ws.on('open', () => console.log('[e2e] ws open'));
	ws.on('error', e => { console.error('[e2e] ws error', e.message); });

	ws.on('message', raw => {
		let msg;
		try { msg = JSON.parse(raw.toString()); }
		catch { return; }
		if (msg.type === 'hello_ack') {
			handshaked = true;
			console.log('[e2e] handshake', JSON.stringify(msg.payload).slice(0, 120));
			// Now send the inline edit task.
			const prompt = buildInlinePrompt({
				instruction: 'Rename the function to bar and change the return to 99',
				code: 'def foo():\n    return 42\n',
				lang: 'python',
				file: 'example.py',
			});
			console.log('[e2e] sending task, prompt length =', prompt.length);
			ws.send(JSON.stringify({
				type: 'task',
				payload: { text: prompt, files: [], images: [] },
			}));
			return;
		}
		if (msg.type === 'stream') {
			deltas++;
			buffer = String(msg.full ?? (buffer + String(msg.delta ?? '')));
			if (deltas % 10 === 0) {
				console.log(`[e2e] … ${deltas} deltas, ${buffer.length} chars`);
			}
			return;
		}
		if (msg.type === 'info') {
			console.log('[e2e] info:', String(msg.payload).slice(0, 80));
			return;
		}
		if (msg.type === 'error') {
			console.error('[e2e] backend error:', msg.payload);
			clearTimeout(timeout);
			ws.close();
			process.exit(1);
		}
		if (msg.type === 'done') {
			clearTimeout(timeout);
			console.log(`[e2e] done. ${deltas} deltas, buffer ${buffer.length} chars`);
			console.log('[e2e] raw buffer (first 400 chars):');
			console.log(buffer.slice(0, 400).replace(/\n/g, '\n    '));
			console.log('[e2e] --- cleaned ---');
			const cleaned = extractCode(buffer);
			console.log(cleaned.replace(/\n/g, '\n    '));
			console.log('[e2e] --- assertions ---');
			let fail = 0;
			const assert = (cond, label) => {
				console.log(`${cond ? '✓' : '✗'} ${label}`);
				if (!cond) fail++;
			};
			assert(buffer.length > 0, 'received non-empty stream');
			assert(cleaned.length > 0, 'extractCode returned non-empty code');
			assert(!/<thinking>/i.test(cleaned), 'cleaned code has no <thinking> tag');
			assert(!/<summary>/i.test(cleaned), 'cleaned code has no <summary> tag');
			assert(!/^```/.test(cleaned), 'cleaned code does not start with a fence');
			assert(cleaned.endsWith('\n'), 'cleaned code ends with a newline');
			assert(/def\s+bar/.test(cleaned) || /bar/.test(cleaned), 'LLM renamed foo -> bar (or mentioned bar)');
			assert(/99/.test(cleaned), 'LLM used the new return value 99');
			ws.close();
			process.exit(fail ? 1 : 0);
		}
	});

	// handshake
	await sleep(500);
	ws.send(JSON.stringify({
		type: 'hello',
		payload: {
			client: 'genericcode-ext',
			version: '0.1.0',
			proto: 1,
			features: ['edit_file', 'open_file', 'run_terminal', 'context_push', 'diff_preview', 'show_diff'],
		},
	}));
	await sleep(3000);
	if (!handshaked) {
		console.error('[e2e] no hello_ack within 3.5s');
		ws.close();
		process.exit(1);
	}
})().catch(e => {
	console.error('[e2e] fatal:', e);
	process.exit(1);
});
