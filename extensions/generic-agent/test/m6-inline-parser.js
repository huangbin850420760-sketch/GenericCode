#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * M6 parser-inlining smoke test.
 *
 * Verifies that the same transform applied by `ChatPanel.loadAssistant
 * ParserSource()` to the compiled `assistantParser.js` produces code
 * that (a) has no CommonJS leftovers and (b) exposes the parser as
 * script-scope globals when eval'd in a webview-shaped sandbox.
 *
 * This catches regressions where a future tsc bump changes the CJS
 * preamble shape and breaks the inlining.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const compiled = fs.readFileSync(
	path.join(__dirname, '..', 'out', 'assistantParser.js'),
	'utf8',
);

// Apply the EXACT same transforms chatPanel.ts does.
let src = compiled;
src = src.replace(/^"use strict";\s*\n/, '');
src = src.replace(
	/Object\.defineProperty\(exports, "__esModule", \{ value: true \}\);\s*\n/,
	'',
);
src = src.replace(/exports\.([A-Za-z_$][\w$]*) = \1;\s*\n/g, '');

let failed = 0, total = 0;
function check(label, cond, extra) {
	total++;
	if (cond) { console.log(`✓ ${label}`); }
	else { console.error(`✗ ${label}${extra ? ' — ' + extra : ''}`); failed++; }
}

check('transformed source has no "use strict" prefix', !src.startsWith('"use strict"'));
check('transformed source has no __esModule defineProperty',
	!src.includes('"__esModule"'));
check('transformed source has no `exports.` assignments',
	!/\bexports\./.test(src));

// Now eval it in a sandbox without `exports` (webview doesn't have one)
// and verify the functions become globals.
const sandbox = {};
vm.createContext(sandbox);
try {
	vm.runInContext(src, sandbox);
} catch (e) {
	check('transformed source runs without ReferenceError', false, e.message);
}

check('parseAssistantSegments is defined after eval',
	typeof sandbox.parseAssistantSegments === 'function');
check('previewArgs is defined after eval',
	typeof sandbox.previewArgs === 'function');

// Sanity: run a realistic slice through the sandbox-exposed parser.
if (typeof sandbox.parseAssistantSegments === 'function') {
	const segs = sandbox.parseAssistantSegments(
		'**LLM Running (Turn 1) ...**\n\n<thinking>x</thinking>\nhello\n'
		+ '🛠️ Tool: `file_read`  📥 args:\n````text\n{"path":"a"}\n````\n'
		+ '`````\n[Action] Reading file: a\nhi\n[Status] ✅ Exit Code: 0\n`````\n'
	);
	const kinds = segs.map(s => s.kind);
	check('sandbox parser: turn divider present', kinds.includes('turn'));
	check('sandbox parser: thinking segment present', kinds.includes('thinking'));
	check('sandbox parser: tool segment present', kinds.includes('tool'));
	const tool = segs.find(s => s.kind === 'tool');
	check('sandbox parser: tool name correct', tool && tool.name === 'file_read');
	check('sandbox parser: tool status parsed', tool && tool.status === '✅');
}

if (typeof sandbox.previewArgs === 'function') {
	check('sandbox previewArgs picks path',
		sandbox.previewArgs('x', JSON.stringify({ path: 'a/b.txt' })) === 'a/b.txt');
}

if (failed) {
	console.error(`\n${failed} / ${total} FAILED`);
	process.exit(1);
}
console.log(`\n${total} / ${total} passed`);
