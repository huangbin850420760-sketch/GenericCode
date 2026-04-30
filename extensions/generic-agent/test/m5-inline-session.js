#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * M5 smoke test — Cursor-style inline edit session.
 *
 * Two tiers:
 *   1. Pure helpers: `expandToFullLines`, `countLines`, `rangesOverlap`
 *      exercised against a minimal fake TextDocument.
 *   2. Session state machine: drives `InlineEditSession.start/setProposedText/
 *      accept/reject/cancel` against a fake editor+document whose
 *      `applyEdit` implementation mutates an in-memory buffer and emits
 *      the same `onDidChangeTextDocument` signal real VSCode would.
 *
 * No VSCode process required.
 */

const path = require('path');
const Module = require('module');

// ── Fake document ───────────────────────────────────────────────────────
class FakeDoc {
	constructor(uri, text) {
		this.uri = uri;
		this._text = text;
		this.version = 1;
	}
	get lineCount() {
		// Match VSCode: a string "a\nb" has 2 lines; "a\nb\n" has 3 (empty trailing).
		return this._text.split('\n').length;
	}
	getText(range) {
		if (!range) { return this._text; }
		const lines = this._text.split('\n');
		const { start, end } = range;
		if (start.line === end.line) {
			return lines[start.line].slice(start.character, end.character);
		}
		const out = [];
		out.push(lines[start.line].slice(start.character));
		for (let i = start.line + 1; i < end.line; i++) { out.push(lines[i]); }
		out.push(lines[end.line].slice(0, end.character));
		return out.join('\n');
	}
	lineAt(n) {
		const lines = this._text.split('\n');
		const t = lines[n] ?? '';
		return {
			text: t,
			range: {
				start: pos(n, 0),
				end: pos(n, t.length),
			},
		};
	}
	// Apply a single WorkspaceEdit-style change.
	applyChange(range, newText) {
		const lines = this._text.split('\n');
		// Convert positions to absolute offsets.
		const offsetOf = (p) => {
			let off = 0;
			for (let i = 0; i < p.line; i++) { off += lines[i].length + 1; }
			return off + p.character;
		};
		const a = offsetOf(range.start);
		const b = offsetOf(range.end);
		this._text = this._text.slice(0, a) + newText + this._text.slice(b);
		this.version++;
	}
}

function pos(line, character) { return new VP(line, character); }

class VP {
	constructor(line, character) { this.line = line; this.character = character; }
	isBefore(o) { return this.line < o.line || (this.line === o.line && this.character < o.character); }
	isBeforeOrEqual(o) { return this.isBefore(o) || (this.line === o.line && this.character === o.character); }
	isAfter(o) { return !this.isBeforeOrEqual(o); }
	isAfterOrEqual(o) { return this.isAfter(o) || (this.line === o.line && this.character === o.character); }
	isEqual(o) { return this.line === o.line && this.character === o.character; }
}

class VR {
	constructor(a, b, c, d) {
		if (typeof a === 'number') {
			this.start = new VP(a, b);
			this.end = new VP(c, d);
		} else {
			this.start = a; this.end = b;
		}
	}
	get isEmpty() { return this.start.isEqual(this.end); }
	isEqual(o) { return this.start.isEqual(o.start) && this.end.isEqual(o.end); }
}

// ── vscode stub ─────────────────────────────────────────────────────────
const listeners = { changeDoc: new Set(), closeDoc: new Set() };

class EventEmitter {
	constructor() { this._subs = new Set(); this.event = fn => { this._subs.add(fn); return { dispose: () => this._subs.delete(fn) }; }; }
	fire(v) { for (const fn of this._subs) { try { fn(v); } catch {} } }
	dispose() { this._subs.clear(); }
}

// A live FakeEditor tracks setDecorations calls so tests can assert state.
const decoCalls = []; // { name, rangesCount }
const applyEditsLog = []; // just audit

function makeFakeEditor(doc) {
	return {
		document: doc,
		setDecorations(type, ranges) {
			decoCalls.push({ name: type._name, rangesCount: ranges.length });
		},
	};
}

// Build applyEdit: supports replace + delete operations against fake docs.
const docs = new Map(); // uri.toString() → FakeDoc
function registerDoc(d) { docs.set(d.uri.toString(), d); }

class FakeWorkspaceEdit {
	constructor() { this.ops = []; }
	replace(uri, range, text) { this.ops.push({ kind: 'replace', uri, range, text }); }
	delete(uri, range) { this.ops.push({ kind: 'delete', uri, range }); }
	insert(uri, position, text) {
		this.ops.push({ kind: 'replace', uri, range: new VR(position, position), text });
	}
	createFile() {}
}

async function fakeApplyEdit(edit) {
	for (const op of edit.ops) {
		const d = docs.get(op.uri.toString());
		if (!d) { continue; }
		const before = d._text;
		if (op.kind === 'replace') { d.applyChange(op.range, op.text); }
		else if (op.kind === 'delete') { d.applyChange(op.range, ''); }
		applyEditsLog.push({ kind: op.kind, before, after: d._text });
		// Notify listeners.
		for (const fn of listeners.changeDoc) {
			try {
				fn({
					document: d,
					contentChanges: [{ range: op.range, text: op.kind === 'delete' ? '' : op.text }],
				});
			} catch {}
		}
	}
	return true;
}

const decoTypes = []; // for cleanup/uniqueness
let nextDecoId = 1;

const vscodeStub = {
	workspace: {
		workspaceFolders: [],
		findFiles: async () => [],
		fs: { readFile: async () => Buffer.from('') },
		registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
		openTextDocument: async () => ({ save: async () => {} }),
		applyEdit: async edit => fakeApplyEdit(edit),
		onDidChangeTextDocument(fn) { listeners.changeDoc.add(fn); return { dispose: () => listeners.changeDoc.delete(fn) }; },
		onDidCloseTextDocument(fn) { listeners.closeDoc.add(fn); return { dispose: () => listeners.closeDoc.delete(fn) }; },
	},
	window: {
		showErrorMessage: () => {}, showWarningMessage: () => {},
		showInformationMessage: async () => undefined, showSaveDialog: async () => undefined,
		showTextDocument: async () => ({}),
		setStatusBarMessage: () => ({ dispose: () => {} }), activeTextEditor: undefined,
		createTextEditorDecorationType(opts) {
			const t = { _name: `deco-${nextDecoId++}`, _opts: opts, dispose: () => {} };
			decoTypes.push(t);
			return t;
		},
	},
	commands: {
		executeCommand: async (cmd, ...args) => { commandLog.push({ cmd, args }); },
		registerCommand: () => ({ dispose: () => {} }),
	},
	Uri: {
		file: p => ({ fsPath: p, path: p, scheme: 'file',
			with(o) { return { ...this, ...o }; },
			toString() { return 'file://' + this.path; },
		}),
	},
	Position: VP, Range: VR,
	WorkspaceEdit: FakeWorkspaceEdit,
	EventEmitter,
	ViewColumn: {},
	ProgressLocation: { Notification: 15 },
	OverviewRulerLane: { Full: 7 },
	ThemeColor: class { constructor(id) { this.id = id; } },
	languages: { registerCodeLensProvider: () => ({ dispose: () => {} }) },
	CodeLens: class { constructor(range, cmd) { this.range = range; this.command = cmd; } },
};
const commandLog = [];

const origLoad = Module._load;
Module._load = function (req, parent, ...rest) {
	if (req === 'vscode') return vscodeStub;
	return origLoad.call(this, req, parent, ...rest);
};

const { InlineEditSession, expandToFullLines, countLines, rangesOverlap } =
	require(path.join(__dirname, '..', 'out', 'inlineEditSession.js'));

// ── helpers ─────────────────────────────────────────────────────────────
let failed = 0, total = 0;
function check(label, cond, extra) {
	total++;
	if (cond) { console.log(`✓ ${label}`); }
	else { console.error(`✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}

function makeDocWithEditor(uri, text) {
	const d = new FakeDoc(uri, text);
	registerDoc(d);
	return { doc: d, editor: makeFakeEditor(d) };
}

function uri(p) { return vscodeStub.Uri.file(p); }
function r(sl, sc, el, ec) { return new VR(sl, sc, el, ec); }

// ── 1. Pure helpers ─────────────────────────────────────────────────────
console.log('\n── pure helpers ──');

check('countLines: empty → 0', countLines('') === 0);
check('countLines: "a" → 1 (no trailing NL)', countLines('a') === 1);
check('countLines: "a\\n" → 1', countLines('a\n') === 1);
check('countLines: "a\\nb" → 2', countLines('a\nb') === 2);
check('countLines: "a\\nb\\n" → 2', countLines('a\nb\n') === 2);
check('countLines: "\\n" → 1', countLines('\n') === 1);

check('rangesOverlap: touching (a.end == b.start) → NOT overlap',
	rangesOverlap(r(0, 0, 1, 0), r(1, 0, 2, 0)) === false);
check('rangesOverlap: overlapping → overlap',
	rangesOverlap(r(0, 0, 2, 0), r(1, 0, 3, 0)) === true);
check('rangesOverlap: disjoint → NOT overlap',
	rangesOverlap(r(0, 0, 1, 0), r(2, 0, 3, 0)) === false);
check('rangesOverlap: nested → overlap',
	rangesOverlap(r(0, 0, 5, 0), r(1, 0, 2, 0)) === true);

// expandToFullLines: cover selection mid-line → full lines
{
	const { doc } = makeDocWithEditor(uri('/a/e1.txt'), 'aaa\nbbb\nccc\n');
	const ex = expandToFullLines(doc, r(0, 1, 1, 2));
	check('expandToFullLines: partial → full 2 lines',
		ex.start.isEqual(new VP(0, 0)) && ex.end.isEqual(new VP(2, 0)),
		`got ${JSON.stringify(ex)}`);
}
{
	const { doc } = makeDocWithEditor(uri('/a/e2.txt'), 'aaa\nbbb\n');
	const ex = expandToFullLines(doc, r(0, 0, 1, 0));
	check('expandToFullLines: line-aligned → unchanged',
		ex.start.isEqual(new VP(0, 0)) && ex.end.isEqual(new VP(1, 0)));
}
{
	const { doc } = makeDocWithEditor(uri('/a/e3.txt'), 'only\n');
	const ex = expandToFullLines(doc, r(0, 0, 0, 2));
	check('expandToFullLines: last-line-in-file, no trailing NL safe',
		ex.start.line === 0 && ex.end.line <= 1);
}

// ── 2. Session state machine ────────────────────────────────────────────
async function scenario(title, fn) {
	console.log(`\n── ${title} ──`);
	decoCalls.length = 0;
	applyEditsLog.length = 0;
	commandLog.length = 0;
	docs.clear();
	await fn();
}

async function run() {
	// 2a. Accept path: selection of one middle line is replaced entirely.
	await scenario('accept replaces selection with proposed', async () => {
		const { doc, editor } = makeDocWithEditor(uri('/s/a.txt'), 'line 0\nline 1\nline 2\n');
		const session = await InlineEditSession.start(editor, r(1, 0, 2, 0));
		check('original text captured', session.originalText === 'line 1\n');
		check('context key set', commandLog.some(c => c.cmd === 'setContext' && c.args[1] === true));

		await session.setProposedText('NEW A\nNEW B\n');
		check('doc after insert = prefix + original + proposed + suffix',
			doc._text === 'line 0\nline 1\nNEW A\nNEW B\nline 2\n',
			JSON.stringify(doc._text));
		check('proposedRange spans 2 lines',
			session.proposedRange.end.line - session.proposedRange.start.line === 2,
			JSON.stringify(session.proposedRange));

		await session.accept();
		check('after accept: original removed, proposed kept',
			doc._text === 'line 0\nNEW A\nNEW B\nline 2\n', JSON.stringify(doc._text));
		check('session ended', session.ended === true);
		check('context key cleared on end', commandLog.filter(c => c.cmd === 'setContext').pop().args[1] === false);
		check('InlineEditSession.current cleared', InlineEditSession.current === undefined);
	});

	// 2b. Reject path: proposed deleted, original untouched.
	await scenario('reject deletes proposed, keeps original', async () => {
		const { doc, editor } = makeDocWithEditor(uri('/s/b.txt'), 'a\nb\nc\n');
		const session = await InlineEditSession.start(editor, r(1, 0, 2, 0));
		await session.setProposedText('xx\nyy\n');
		check('doc after insert has proposed',
			doc._text === 'a\nb\nxx\nyy\nc\n', JSON.stringify(doc._text));
		await session.reject();
		check('after reject: doc restored',
			doc._text === 'a\nb\nc\n', JSON.stringify(doc._text));
		check('session ended after reject', session.ended === true);
	});

	// 2c. Multiple setProposedText calls grow/shrink the region cleanly.
	await scenario('streaming updates replace proposed region in place', async () => {
		const { doc, editor } = makeDocWithEditor(uri('/s/c.txt'), 'x\ny\nz\n');
		const session = await InlineEditSession.start(editor, r(0, 0, 1, 0));
		await session.setProposedText('p1\n');
		check('proposed region 1-line',
			doc._text === 'x\np1\ny\nz\n', JSON.stringify(doc._text));
		await session.setProposedText('p1\np2\np3\n');
		check('grown to 3 lines',
			doc._text === 'x\np1\np2\np3\ny\nz\n', JSON.stringify(doc._text));
		await session.setProposedText('only\n');
		check('shrunk back to 1 line',
			doc._text === 'x\nonly\ny\nz\n', JSON.stringify(doc._text));
		// And accept should still work after the last update.
		await session.accept();
		check('accept after multiple updates',
			doc._text === 'only\ny\nz\n', JSON.stringify(doc._text));
	});

	// 2d. Cancel from the outside.
	await scenario('cancel wipes proposed, ends session', async () => {
		const { doc, editor } = makeDocWithEditor(uri('/s/d.txt'), 'one\ntwo\n');
		const session = await InlineEditSession.start(editor, r(0, 0, 1, 0));
		await session.setProposedText('NEW\n');
		check('inserted', doc._text === 'one\nNEW\ntwo\n');
		await session.cancel();
		check('after cancel: doc back to original', doc._text === 'one\ntwo\n');
		check('session ended after cancel', session.ended === true);
	});

	// 2e. Starting a new session while one is active cancels the previous.
	await scenario('new start cancels previous session', async () => {
		const { doc, editor } = makeDocWithEditor(uri('/s/e.txt'), 'a\nb\nc\n');
		const first = await InlineEditSession.start(editor, r(0, 0, 1, 0));
		await first.setProposedText('FIRST\n');
		check('first session inserted', doc._text === 'a\nFIRST\nb\nc\n');

		const second = await InlineEditSession.start(editor, r(2, 0, 3, 0));
		check('first session ended on second start', first.ended === true);
		check('doc restored before second inserts',
			doc._text === 'a\nb\nc\n', JSON.stringify(doc._text));
		check('InlineEditSession.current is the new one', InlineEditSession.current === second);
		await second.reject();
	});

	// 2f. Accept preserves surrounding text and does not leave stray NLs.
	await scenario('accept at last-line-of-file preserves trailing state', async () => {
		const { doc, editor } = makeDocWithEditor(uri('/s/f.txt'), 'keep\ntail');
		// Select "tail" (no trailing newline in file).
		const session = await InlineEditSession.start(editor, r(1, 0, 1, 4));
		check('original text captured (no trailing NL)',
			session.originalText === 'tail', JSON.stringify(session.originalText));
		await session.setProposedText('NEW TAIL\n');
		await session.accept();
		// Expect no spurious blank line at EOF.
		check('no double-trailing-newline after accept',
			doc._text === 'keep\nNEW TAIL' || doc._text === 'keep\nNEW TAIL\n',
			JSON.stringify(doc._text));
	});

	// 2g. User edits inside hunk → session auto-cancels.
	await scenario('user edit inside hunk cancels session', async () => {
		const { doc, editor } = makeDocWithEditor(uri('/s/g.txt'), 'a\nb\nc\n');
		const session = await InlineEditSession.start(editor, r(1, 0, 2, 0));
		await session.setProposedText('P\n');
		// Simulate an external (not self) edit inside the original range.
		const edit = new FakeWorkspaceEdit();
		edit.replace(doc.uri, r(1, 0, 1, 1), 'X');
		await fakeApplyEdit(edit);
		// The session should have detected it and cancelled.  Give it a tick.
		await new Promise(r => setTimeout(r, 20));
		check('session ended due to user edit', session.ended === true);
	});

	if (failed) {
		console.error(`\n${failed} / ${total} FAILED`);
		process.exit(1);
	}
	console.log(`\n${total} / ${total} passed`);
	process.exit(0);
}

run().catch(e => { console.error('[m5] fatal', e); process.exit(1); });
