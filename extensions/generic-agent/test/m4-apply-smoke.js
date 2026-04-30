#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * M4.2 smoke test — verifies the webview-side markdown renderer produces
 * the expected Apply button structure for a variety of code-fence inputs.
 *
 * Strategy: we load the compiled extension bundle (out/chatPanel.js), find
 * the inline <script> inside the html() template, run the whole IIFE in
 * a node `vm` sandbox that stubs out the DOM + vscode API, and capture
 * the `renderMarkdown` function via a global hook we inject before the
 * IIFE runs.  Then we hit it with fixtures.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const COMPILED = path.join(__dirname, '..', 'out', 'chatPanel.js');
const PARSER = path.join(__dirname, '..', 'out', 'assistantParser.js');
if (!fs.existsSync(COMPILED)) {
	console.error(`FAIL: ${COMPILED} not found — run tsc first.`);
	process.exit(2);
}
if (!fs.existsSync(PARSER)) {
	console.error(`FAIL: ${PARSER} not found — run tsc first.`);
	process.exit(2);
}
const src = fs.readFileSync(COMPILED, 'utf8');

// Locate the inline <script>.
const scriptOpen = src.indexOf('<script nonce="${nonce}">');
const scriptClose = src.indexOf('</script>', scriptOpen);
if (scriptOpen < 0 || scriptClose < 0) {
	console.error('FAIL: could not locate inline <script> in compiled chatPanel.js');
	process.exit(2);
}
let js = src.substring(scriptOpen + '<script nonce="${nonce}">'.length, scriptClose);

// The surrounding context is a tsc-compiled template literal; inside the
// template, `\\` encodes a single `\` and `\`` encodes a backtick.  We
// invert those two escapes so the extracted string matches what will run
// in the browser webview.
//
// Note: the order matters — first un-escape backticks (so the following
// backslash-collapse doesn't chew into a 4-backslash sequence), then
// collapse `\\` -> `\`, and finally `\$` -> `$` (template expressions).
js = js.replace(/\\`/g, '`');
js = js.replace(/\\\\/g, '\\');
js = js.replace(/\\\$/g, '$');
let parserSrc = fs.readFileSync(PARSER, 'utf8');
parserSrc = parserSrc.replace(/^"use strict";\s*\n/, '');
parserSrc = parserSrc.replace(
	/Object\.defineProperty\(exports, "__esModule", \{ value: true \}\);\s*\n/,
	'',
);
parserSrc = parserSrc.replace(/exports\.([A-Za-z_$][\w$]*) = \1;\s*\n/g, '');
js = js.replace('${parserSrc}', parserSrc);

// We inject a hook at the top of the IIFE so we can export renderMarkdown
// without touching the IIFE source itself.
const hooked =
	'globalThis.__capture = function (name, fn) { globalThis.__captured[name] = fn; };\n' +
	'globalThis.__captured = {};\n' +
	js.replace(
		'function renderMarkdown(',
		'globalThis.__capture("renderMarkdown", renderMarkdown); function renderMarkdown(',
	);

// Run in a sandbox with minimal DOM stubs so addEventListener / focus etc.
// don't throw.  renderMarkdown itself is string-only.
const noop = () => {};
const stubEl = {
	className: '', textContent: '', innerHTML: '',
	dataset: {},
	appendChild: noop, removeChild: noop, insertBefore: noop,
	focus: noop, select: noop,
	addEventListener: noop,
	scrollIntoView: noop,
	classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
	style: {},
	closest: () => null,
	querySelector: () => null,
};
const sandbox = {
	acquireVsCodeApi: () => ({ postMessage: noop }),
	document: {
		getElementById: () => stubEl,
		createElement: () => ({ ...stubEl, style: {} }),
		body: { appendChild: noop, removeChild: noop },
	},
	navigator: {},
	setTimeout: () => 0, clearTimeout: noop,
	console: { log: noop, warn: noop, error: noop },
};
sandbox.addEventListener = noop;
sandbox.removeEventListener = noop;
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
try {
	vm.runInContext(hooked, sandbox);
} catch (e) {
	console.error('FAIL: IIFE threw:', e.message);
	fs.writeFileSync(path.join(__dirname, '_bundle.dump.js'), hooked);
	console.error('bundle dumped to test/_bundle.dump.js');
	process.exit(3);
}

const renderMarkdown = sandbox.__captured.renderMarkdown;
if (typeof renderMarkdown !== 'function') {
	console.error('FAIL: renderMarkdown not captured (__captured =', sandbox.__captured, ')');
	process.exit(3);
}

// ── Fixtures ────────────────────────────────────────────────────────────
const cases = [
	{
		name: 'python with filename (colon form)',
		input: '```python:src/sort.py\nprint(1)\n```',
		expect: [
			/<pre>/,
			/data-apply/,
			/data-file="src\/sort\.py"/,
			/data-lang="python"/,
			/python · src\/sort\.py/,
		],
	},
	{
		name: 'python with filename (space form)',
		input: '```python src/sort.py\nprint(1)\n```',
		expect: [/data-file="src\/sort\.py"/, /data-lang="python"/],
	},
	{
		name: 'bare python (no file) shows Apply, no data-file',
		input: '```python\nprint(1)\n```',
		expect: [/data-apply/, /data-lang="python"/],
		deny: [/data-file=/],
	},
	{
		name: 'plaintext fence — NO Apply button',
		input: '```text\nhello world\n```',
		deny: [/data-apply/],
	},
	{
		name: 'empty fence — NO Apply button',
		input: '```\nabc\n```',
		deny: [/data-apply/],
	},
	{
		name: 'filename-only fence (no lang) DOES show Apply',
		input: '``` notes/todo.md\n- item\n```',
		expect: [/data-apply/, /data-file="notes\/todo\.md"/],
	},
	{
		name: 'Copy button always present for code fences',
		input: '```js\nconsole.log(1)\n```',
		expect: [/data-copy/],
	},
	{
		name: 'HTML inside fence is escaped',
		input: '```html\n<script>x</script>\n```',
		expect: [/&lt;script&gt;x&lt;\/script&gt;/],
		deny: [/<script>x<\/script>/],
	},
	{
		name: 'XSS in info string is sanitized',
		input: '```"><img src=x onerror=alert(1)>\noops\n```',
		deny: [/onerror=/],
	},
	{
		name: 'basic markdown (heading/bold/em/inline)',
		input: '# Hi\n\nThis is **bold**, *em*, and `inline`.\n',
		expect: [
			/<h1>Hi<\/h1>/,
			/<strong>bold<\/strong>/,
			/<em>em<\/em>/,
			/<code>inline<\/code>/,
		],
	},
	{
		name: 'unordered list',
		input: '- a\n- b\n- c\n',
		expect: [/<ul>[\s\S]*<li>a<\/li>[\s\S]*<li>c<\/li>[\s\S]*<\/ul>/],
	},
];

let failed = 0;
for (const c of cases) {
	let out;
	try {
		out = renderMarkdown(c.input);
	} catch (e) {
		console.error(`✗ ${c.name} — THREW: ${e.message}`);
		failed++; continue;
	}
	let ok = true;
	for (const re of (c.expect || [])) {
		if (!re.test(out)) {
			console.error(`✗ ${c.name} — missing ${re}`);
			console.error(`  output: ${out}`);
			ok = false;
		}
	}
	for (const re of (c.deny || [])) {
		if (re.test(out)) {
			console.error(`✗ ${c.name} — forbidden match ${re}`);
			console.error(`  output: ${out}`);
			ok = false;
		}
	}
	if (ok) { console.log(`✓ ${c.name}`); } else { failed++; }
}

if (failed) {
	console.error(`\n${failed} / ${cases.length} FAILED`);
	process.exit(1);
}
console.log(`\n${cases.length} / ${cases.length} passed`);
