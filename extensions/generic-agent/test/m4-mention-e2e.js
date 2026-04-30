#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * M4.5 end-to-end: drive the real `AgentClient` (the same code the extension
 * runs) against an in-process WS server, and verify that mentions made in
 * the chat input produce a backend `task` message whose `files[]` carries
 * the correct absolute path(s) and whose content is readable from disk.
 *
 * No real backend required — the mock server stands in for agent-core just
 * to capture the wire message.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const WebSocketServerLib = require(path.join(__dirname, '..', 'node_modules', 'ws'));
const WebSocketServer = WebSocketServerLib.Server || WebSocketServerLib.WebSocketServer;

// ── vscode stub ────────────────────────────────────────────────────────
class EventEmitter {
	constructor() {
		this._subs = new Set();
		this.event = fn => { this._subs.add(fn); return { dispose: () => this._subs.delete(fn) }; };
	}
	fire(v) { for (const fn of this._subs) { try { fn(v); } catch { /* ignore */ } } }
	dispose() { this._subs.clear(); }
}
const vscodeStub = {
	workspace: {
		workspaceFolders: [],
		findFiles: async () => [],
		fs: { readFile: async () => Buffer.from('') },
		registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
		openTextDocument: async () => ({ save: async () => {} }),
		applyEdit: async () => true,
	},
	window: {
		showErrorMessage: () => {}, showWarningMessage: () => {},
		showInformationMessage: async () => undefined, showSaveDialog: async () => undefined,
		showTextDocument: async () => ({}),
		setStatusBarMessage: () => ({ dispose: () => {} }), activeTextEditor: undefined,
	},
	commands: { executeCommand: async () => {}, registerCommand: () => ({ dispose: () => {} }) },
	Uri: {
		file: p => ({
			fsPath: p, path: p, scheme: 'file',
			with(o) { return { ...this, ...o }; },
			toString() { return 'file://' + this.path; },
		}),
	},
	Position: class {}, Range: class {},
	WorkspaceEdit: class { replace(){} insert(){} createFile(){} },
	EventEmitter,
	ViewColumn: {}, ProgressLocation: {},
};
const origLoad = Module._load;
Module._load = function (req, parent, ...rest) {
	if (req === 'vscode') return vscodeStub;
	return origLoad.call(this, req, parent, ...rest);
};

const { AgentClient } = require(path.join(__dirname, '..', 'out', 'agentClient.js'));
const { resolveMentionPaths } = require(path.join(__dirname, '..', 'out', 'chatPanel.js'));

// ── tiny mock ws server ───────────────────────────────────────────────
function startServer() {
	return new Promise(resolve => {
		const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
		wss.once('listening', () => {
			resolve({ wss, port: wss.address().port });
		});
	});
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async function main() {
	// Workspace with one interesting file the mention points to.
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-mention-e2e-'));
	const relFile = 'docs/notes.md';
	const absFile = path.join(root, relFile);
	fs.mkdirSync(path.dirname(absFile), { recursive: true });
	const marker = `# mention-e2e-marker-${Date.now()}`;
	fs.writeFileSync(absFile, `${marker}\n\ncontent body\n`);

	const { wss, port } = await startServer();
	console.log('[e2e] mock ws server listening on', port);

	const received = [];
	let handshakeSeen = false;
	wss.on('connection', sock => {
		sock.on('message', raw => {
			let msg;
			try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
			if (msg.type === 'hello') {
				handshakeSeen = true;
				sock.send(JSON.stringify({
					type: 'hello_ack',
					payload: {
						server: 'mock', version: '0', proto: 1,
						features: msg.payload?.features || [], llm: 'mock-llm',
					},
				}));
				return;
			}
			received.push(msg);
		});
	});

	// Drive AgentClient exactly as the extension does.
	const client = new AgentClient(`ws://127.0.0.1:${port}`, '0.0.0-test');
	client.connect();

	// Wait for handshake.
	const deadline = Date.now() + 3000;
	while (!handshakeSeen && Date.now() < deadline) { await sleep(25); }
	if (!handshakeSeen) {
		console.error('✗ no handshake within 3s');
		process.exit(1);
	}

	// Simulate what the chat panel's 'send' handler does: the webview
	// posts `{ text, mentions }`, the extension resolves them to absolute
	// paths, then calls sendTask.
	const userText = `Please summarise @${relFile} for me`;
	const mentionsFromWebview = [{ rel: relFile.replace(/\\/g, '/'), abs: absFile }];
	const files = resolveMentionPaths(mentionsFromWebview, [root]);
	console.log('[e2e] resolved files:', files);
	client.sendTask(userText, { files });

	// Give the mock server a tick to receive.
	await sleep(200);

	let failed = 0, total = 0;
	function check(label, cond, extra) {
		total++;
		if (cond) { console.log(`✓ ${label}`); }
		else { console.error(`✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
	}

	// resolveMentionPaths should have produced exactly one absolute path.
	check('resolveMentionPaths returned one path', files.length === 1, JSON.stringify(files));
	check('resolved path is absolute', files[0] && path.isAbsolute(files[0]));
	check('resolved path points to the marker file',
		files[0] === path.resolve(absFile), `got=${files[0]}`);

	// The mock server must have received exactly one task message with
	// the absolute path in payload.files, and text preserved.
	const tasks = received.filter(m => m.type === 'task');
	check('exactly one task message received', tasks.length === 1, JSON.stringify(received));
	if (tasks.length === 1) {
		const p = tasks[0].payload || {};
		check('task.text preserved verbatim', p.text === userText, JSON.stringify(p.text));
		check('task.files is an array', Array.isArray(p.files), typeof p.files);
		check('task.files has exactly one entry', Array.isArray(p.files) && p.files.length === 1, JSON.stringify(p.files));
		check('task.files[0] is the absolute path',
			Array.isArray(p.files) && p.files[0] === path.resolve(absFile),
			JSON.stringify(p.files));
		check('task.images is an empty array', Array.isArray(p.images) && p.images.length === 0);

		// And finally — the real litmus test — the backend would read the
		// file content from that absolute path.  We simulate that here.
		if (Array.isArray(p.files) && p.files[0]) {
			try {
				const content = fs.readFileSync(p.files[0], 'utf8');
				check('file content readable at the path sent over WS', content.includes(marker),
					`content starts: ${content.slice(0, 60)}`);
			} catch (e) {
				check('file content readable at the path sent over WS', false, e.message);
			}
		}
	}

	// source tagging should default to 'chat' for sendTask without opts.source.
	check('client.currentSource tagged as chat', client.currentSource === 'chat',
		'got=' + String(client.currentSource));

	// Cleanup.
	client.dispose?.();
	wss.close();
	try { fs.rmSync(root, { recursive: true, force: true }); } catch {}

	if (failed) {
		console.error(`\n${failed} / ${total} FAILED`);
		process.exit(1);
	}
	console.log(`\n${total} / ${total} passed`);
	process.exit(0);
})().catch(e => {
	console.error('[e2e] fatal:', e);
	process.exit(1);
});
