#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * M4.3 smoke test — verifies the pure helpers in `inlineEdit.ts` behave
 * as expected.  We can `require` the compiled module directly since it
 * does not touch the DOM at import-time (only inside class methods).
 *
 * The `vscode` module is stubbed on first require() because it's a
 * runtime VSCode host dependency that doesn't exist under plain node.
 */

const path = require('path');
const Module = require('module');

// ─── stub `vscode` before requiring inlineEdit ──────────────────────────
const vscodeStub = {
	commands: { registerCommand: () => ({ dispose: () => {} }), executeCommand: async () => {} },
	window: {
		activeTextEditor: undefined,
		showInputBox: async () => undefined,
		showWarningMessage: () => {},
		showErrorMessage: () => {},
		showTextDocument: async () => {},
		setStatusBarMessage: () => ({ dispose: () => {} }),
		withProgress: (_opts, fn) => fn({ report: () => {} }, { onCancellationRequested: () => ({ dispose: () => {} }) }),
	},
	workspace: {
		fs: { readFile: async () => Buffer.from('') },
		workspaceFolders: [],
		registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
		openTextDocument: async () => ({ save: async () => {} }),
		applyEdit: async () => true,
	},
	Uri: {
		file: (fsPath) => ({ fsPath, path: fsPath, scheme: 'file', with(o) { return { ...this, ...o }; }, toString() { return this.scheme + '://' + this.path; } }),
	},
	Position: class { constructor(l, c) { this.line = l; this.character = c; } },
	Range: class { constructor(a, b, c, d) {
		if (typeof a === 'number') { this.start = { line: a, character: b }; this.end = { line: c, character: d }; }
		else { this.start = a; this.end = b; }
	} },
	WorkspaceEdit: class {
		constructor() { this._ops = []; }
		replace(u, r, v) { this._ops.push(['replace', u, r, v]); }
		insert(u, p, v) { this._ops.push(['insert', u, p, v]); }
		createFile(u, o) { this._ops.push(['create', u, o]); }
	},
	EventEmitter: class { constructor() { this.event = () => ({ dispose: () => {} }); } fire() {} dispose() {} },
	ProgressLocation: { Notification: 15 },
	ViewColumn: { Beside: -2 },
	Disposable: { from: () => ({ dispose: () => {} }) },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
	if (request === 'vscode') { return 'vscode'; }
	return origResolve.call(this, request, parent, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
	if (request === 'vscode') { return vscodeStub; }
	return origLoad.call(this, request, parent, ...rest);
};

// ─── target under test ─────────────────────────────────────────────────
const { buildInlinePrompt, extractCode } = require(path.join(__dirname, '..', 'out', 'inlineEdit.js'));

// ── extractCode fixtures ────────────────────────────────────────────────
const extractCases = [
	{
		name: 'strips <thinking> block',
		input: '<thinking>\nplanning...\n</thinking>\n\nhello\n',
		expect: 'hello\n',
	},
	{
		name: 'strips <summary> block',
		input: '<summary>here is a summary</summary>\nconst x = 1;\n',
		expect: 'const x = 1;\n',
	},
	{
		name: 'strips both thinking and summary',
		input: '<thinking>a</thinking><summary>b</summary>\ncode here\n',
		expect: 'code here\n',
	},
	{
		name: 'extracts from fenced block (takes last one)',
		input: 'preamble\n```python\nold code\n```\n\n```python\ndef f(): pass\n```\n',
		expect: 'def f(): pass\n',
	},
	{
		name: 'handles unterminated fence (stream truncated mid-output)',
		input: '<thinking>x</thinking>\n```js\nconst x = 1;\nconst y = 2;',
		expect: 'const x = 1;\nconst y = 2;\n',
	},
	{
		name: 'no fence, no tags — returns the text as-is (trimmed)',
		input: '   \n\nconst x = 1;\n\n\n',
		expect: 'const x = 1;\n',
	},
	{
		name: 'normalizes CRLF to LF',
		input: '```js\r\nconst x = 1;\r\n```\r\n',
		expect: 'const x = 1;\n',
	},
	{
		name: 'empty input',
		input: '',
		expect: '',
	},
	{
		name: 'preserves indentation inside fence',
		input: '```python\ndef f():\n    if x:\n        return 1\n```',
		expect: 'def f():\n    if x:\n        return 1\n',
	},
];

// ── buildInlinePrompt fixtures ─────────────────────────────────────────
const promptCases = [
	{
		name: 'includes instruction, code, language, filename',
		args: { instruction: 'refactor to async', code: 'def f(): pass', lang: 'python', file: 'main.py' },
		expect: [
			/INLINE CODE EDIT/,
			/Instruction: refactor to async/,
			/File: main\.py/,
			/language: python/,
			/```python\ndef f\(\): pass\n```/,
		],
	},
	{
		name: 'unknown language falls back to text tag',
		args: { instruction: 'tidy', code: 'foo', lang: '', file: 'a.txt' },
		expect: [
			/`text`/,
			/File: a\.txt/,
			/language: unknown/,
		],
	},
];

let failed = 0;
let total = 0;

for (const c of extractCases) {
	total++;
	const out = extractCode(c.input);
	if (out === c.expect) {
		console.log(`✓ extractCode: ${c.name}`);
	} else {
		console.error(`✗ extractCode: ${c.name}`);
		console.error(`  expected: ${JSON.stringify(c.expect)}`);
		console.error(`  actual:   ${JSON.stringify(out)}`);
		failed++;
	}
}

for (const c of promptCases) {
	total++;
	const out = buildInlinePrompt(c.args);
	let ok = true;
	for (const re of c.expect) {
		if (!re.test(out)) {
			console.error(`✗ buildInlinePrompt: ${c.name} — missing ${re}`);
			console.error(`  output: ${out}`);
			ok = false;
		}
	}
	if (ok) { console.log(`✓ buildInlinePrompt: ${c.name}`); } else { failed++; }
}

if (failed) {
	console.error(`\n${failed} / ${total} FAILED`);
	process.exit(1);
}
console.log(`\n${total} / ${total} passed`);
