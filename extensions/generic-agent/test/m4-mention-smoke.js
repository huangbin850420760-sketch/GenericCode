#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * M4.4 smoke test — covers two layers:
 *   (a) `resolveMentionPaths()` in chatPanel.ts (extension side).  We stub
 *       `vscode` before requiring the module, create a tiny temp-folder
 *       workspace, and feed it synthetic mentions.
 *   (b) The webview-side renderer still produces the popup DOM + attached
 *       files chip row we expect (sanity check on the embedded <script>).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// Stub `vscode` before requiring chatPanel.
const vscodeStub = {
	workspace: {
		workspaceFolders: [],
		findFiles: async () => [],
		registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
		fs: { readFile: async () => Buffer.from('') },
		openTextDocument: async () => ({ save: async () => {} }),
		applyEdit: async () => true,
	},
	window: {
		showErrorMessage: () => {},
		showWarningMessage: () => {},
		showInformationMessage: async () => undefined,
		showSaveDialog: async () => undefined,
		showTextDocument: async () => ({}),
		setStatusBarMessage: () => ({ dispose: () => {} }),
		activeTextEditor: undefined,
	},
	commands: { executeCommand: async () => {}, registerCommand: () => ({ dispose: () => {} }) },
	Uri: { file: p => ({ fsPath: p, path: p, scheme: 'file', with(o){return {...this,...o};}, toString(){return 'file://'+this.path;} }) },
	Position: class {}, Range: class {},
	WorkspaceEdit: class { replace(){} insert(){} createFile(){} },
	EventEmitter: class { constructor(){this.event=()=>({dispose:()=>{}});} fire(){} dispose(){} },
	ViewColumn: {}, ProgressLocation: {},
};
const origLoad = Module._load;
Module._load = function (req, parent, ...rest) {
	if (req === 'vscode') { return vscodeStub; }
	return origLoad.call(this, req, parent, ...rest);
};

const { resolveMentionPaths } = require(path.join(__dirname, '..', 'out', 'chatPanel.js'));

// Build a tiny temp workspace.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-mention-'));
const fileA = path.join(root, 'a.txt');
const fileB = path.join(root, 'sub', 'b.txt');
fs.writeFileSync(fileA, 'alpha');
fs.mkdirSync(path.join(root, 'sub'));
fs.writeFileSync(fileB, 'beta');
const outsideFile = path.join(os.tmpdir(), 'm4-mention-outside-' + Date.now() + '.txt');
fs.writeFileSync(outsideFile, 'escape');

let failed = 0;
let total = 0;

function check(label, cond, extra) {
	total++;
	if (cond) { console.log(`✓ ${label}`); }
	else { console.error(`✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}

// Case 1: absolute path inside workspace → accepted.
let got = resolveMentionPaths([{ rel: 'a.txt', abs: fileA }], [root]);
check('accepts absolute path inside workspace', got.length === 1 && got[0] === path.resolve(fileA), JSON.stringify(got));

// Case 2: nested path inside workspace via relative fallback.
got = resolveMentionPaths([{ rel: 'sub/b.txt', abs: '/nonexistent/sub/b.txt' }], [root]);
check('falls back to relative-under-workspace-root',
	got.length === 1 && got[0] === path.resolve(fileB), JSON.stringify(got));

// Case 3: path OUTSIDE workspace is rejected.
got = resolveMentionPaths([{ rel: 'evil.txt', abs: outsideFile }], [root]);
check('rejects absolute path outside workspace roots', got.length === 0, JSON.stringify(got));

// Case 4: duplicate mentions → dedup.
got = resolveMentionPaths([
	{ rel: 'a.txt', abs: fileA },
	{ rel: 'a.txt', abs: fileA },
	{ rel: './a.txt', abs: fileA },
], [root]);
check('dedups identical paths', got.length === 1, JSON.stringify(got));

// Case 5: non-existent file is silently dropped.
got = resolveMentionPaths([{ rel: 'missing.txt', abs: path.join(root, 'missing.txt') }], [root]);
check('drops non-existent file', got.length === 0, JSON.stringify(got));

// Case 6: directory (not file) is dropped.
got = resolveMentionPaths([{ rel: 'sub', abs: path.join(root, 'sub') }], [root]);
check('drops directory entries', got.length === 0, JSON.stringify(got));

// Case 7: empty / undefined input.
check('empty mentions → empty result', resolveMentionPaths([], [root]).length === 0);
check('undefined mentions → empty result', resolveMentionPaths(undefined, [root]).length === 0);

// Case 8: multiple workspaces — first match wins.
const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-mention2-'));
const fileC = path.join(root2, 'c.txt');
fs.writeFileSync(fileC, 'gamma');
got = resolveMentionPaths([{ rel: 'c.txt', abs: fileC }], [root, root2]);
check('resolves mention in secondary workspace root', got.length === 1 && got[0] === path.resolve(fileC), JSON.stringify(got));

// Case 9: path traversal in `rel` that escapes root → rejected.
got = resolveMentionPaths(
	[{ rel: '../outside.txt', abs: path.join(root, '..', 'outside.txt') }],
	[root],
);
check('rejects path-traversal attempts via rel', got.length === 0, JSON.stringify(got));

// ── Webview sanity: the compiled bundle still embeds the popup DOM and
//    the files_result handler.  These are cheap string greps but catch
//    accidental removal during future refactors.
const compiled = fs.readFileSync(path.join(__dirname, '..', 'out', 'chatPanel.js'), 'utf8');
check('popup DOM id present', compiled.includes('"mention-popup"'));
check('attached-files chip row present', compiled.includes('"attached-files"'));
check('files_query postMessage present', compiled.includes("kind: 'files_query'"));
check('files_result handler present', compiled.includes("case 'files_result'"));
check('mentions field attached to send message', /kind:\s*'send'[\s\S]{0,160}mentions:\s*[A-Za-z_$][\w$]*/.test(compiled));

// cleanup
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
try { fs.rmSync(root2, { recursive: true, force: true }); } catch {}
try { fs.unlinkSync(outsideFile); } catch {}

if (failed) {
	console.error(`\n${failed} / ${total} FAILED`);
	process.exit(1);
}
console.log(`\n${total} / ${total} passed`);
