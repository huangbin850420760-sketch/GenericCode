#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * M6 parser smoke — `parseAssistantSegments` against realistic
 * agent-core output fragments.  No vscode stub needed; assistantParser
 * is dependency-free.
 */

const path = require('path');
const { parseAssistantSegments, previewArgs } =
	require(path.join(__dirname, '..', 'out', 'assistantParser.js'));

let failed = 0, total = 0;
function check(label, cond, extra) {
	total++;
	if (cond) { console.log(`✓ ${label}`); }
	else { console.error(`✗ ${label}${extra ? ' — ' + JSON.stringify(extra).slice(0, 200) : ''}`); failed++; }
}

// ── 1. empty / narrative only ────────────────────────────────────────
{
	const segs = parseAssistantSegments('');
	check('empty input → no segments', segs.length === 0);
}
{
	const segs = parseAssistantSegments('Hello world.\nAnother line.');
	check('pure narrative → 1 segment', segs.length === 1 && segs[0].kind === 'narrative');
	check('narrative preserves internal newlines',
		segs[0].kind === 'narrative' && segs[0].text.includes('\nAnother line.'));
}

// ── 2. turn divider ──────────────────────────────────────────────────
{
	const raw = '**LLM Running (Turn 1) ...**\n\nHello';
	const segs = parseAssistantSegments(raw);
	check('turn divider at start', segs[0].kind === 'turn' && segs[0].n === 1);
	check('narrative follows turn', segs[1] && segs[1].kind === 'narrative' && segs[1].text.trim() === 'Hello');
}
{
	const raw = 'Prelude\n**LLM Running (Turn 3) ...**\nPost';
	const segs = parseAssistantSegments(raw);
	check('turn in the middle splits narrative',
		segs.map(s => s.kind).join(',') === 'narrative,turn,narrative',
		segs.map(s => s.kind));
	check('turn number parsed', segs[1].kind === 'turn' && segs[1].n === 3);
}

// ── 3. thinking blocks ───────────────────────────────────────────────
{
	const raw = 'before<thinking>secret reasoning</thinking>after';
	const segs = parseAssistantSegments(raw);
	check('thinking splits narrative',
		segs.map(s => s.kind).join(',') === 'narrative,thinking,narrative',
		segs.map(s => s.kind));
	check('thinking body captured',
		segs[1].kind === 'thinking' && segs[1].text === 'secret reasoning' && segs[1].closed === true);
}
{
	const raw = '<thinking>still going…';
	const segs = parseAssistantSegments(raw);
	check('unclosed thinking → closed=false',
		segs.length === 1 && segs[0].kind === 'thinking' && segs[0].closed === false);
	check('unclosed thinking body captured',
		segs[0].text === 'still going…');
}

// ── 4. summary blocks ────────────────────────────────────────────────
{
	const raw = 'intro <summary>one-liner</summary> tail';
	const segs = parseAssistantSegments(raw);
	check('summary detected',
		segs.some(s => s.kind === 'summary' && s.text === 'one-liner'),
		segs.map(s => s.kind));
}

// ── 5. verbose tool call ─────────────────────────────────────────────
{
	const raw =
		'🛠️ Tool: `file_read`  📥 args:\n' +
		'````text\n' +
		'{\n  "path": "ga.py",\n  "start": 1\n}\n' +
		'````\n' +
		'`````\n' +
		'[Action] Reading file: ga.py\n' +
		'content content content\n' +
		'[Status] ✅ Exit Code: 0\n' +
		'`````\n' +
		'done.\n';
	const segs = parseAssistantSegments(raw);
	check('verbose tool parsed to single tool segment',
		segs.filter(s => s.kind === 'tool').length === 1, segs.map(s => s.kind));
	const tool = segs.find(s => s.kind === 'tool');
	check('tool.name', tool && tool.name === 'file_read');
	check('tool.argsClosed', tool && tool.argsClosed === true);
	check('tool.args contains path', tool && tool.args.includes('"path": "ga.py"'));
	check('tool.output captured', tool && tool.output.includes('[Action] Reading file: ga.py'));
	check('tool.outputClosed', tool && tool.outputClosed === true);
	check('tool.status = ✅ from [Status] line', tool && tool.status === '✅');
	check('trailing narrative preserved',
		segs[segs.length - 1].kind === 'narrative' && segs[segs.length - 1].text.trim() === 'done.');
}

// ── 6. compact (non-verbose) tool call ───────────────────────────────
{
	const raw = '🛠️ file_read(path=ga.py)\n\n\nSome later text';
	const segs = parseAssistantSegments(raw);
	const t = segs.find(s => s.kind === 'tool');
	check('compact tool parsed', t && t.name === 'file_read' && t.args === 'path=ga.py');
	check('compact tool followed by narrative',
		segs[segs.length - 1].kind === 'narrative' && segs[segs.length - 1].text.includes('Some later text'));
}

// ── 7. partial stream: tool header without body yet ──────────────────
{
	const raw = '🛠️ Tool: `file_read`  📥 args:\n';
	const segs = parseAssistantSegments(raw);
	// During streaming we haven't yet got the fence; parser should not
	// crash and should NOT swallow the header as narrative — but it
	// accepts we might not emit a tool until args appear.  Either "no
	// tool yet, emit narrative" or "tool with empty args unclosed" is
	// acceptable — just don't lose the text.
	check('partial tool header does not drop text',
		segs.length > 0);
}

// ── 8. tool with unclosed args fence (mid-stream) ────────────────────
{
	const raw =
		'🛠️ Tool: `file_read`  📥 args:\n' +
		'````text\n' +
		'{\n  "path": "ga.py"';
	const segs = parseAssistantSegments(raw);
	const t = segs.find(s => s.kind === 'tool');
	check('unclosed args → argsClosed=false', t && t.argsClosed === false);
	check('unclosed args body captured', t && t.args.includes('"path": "ga.py"'));
}

// ── 9. multi-turn, multi-tool ─────────────────────────────────────────
{
	const raw =
		'**LLM Running (Turn 1) ...**\n\n' +
		'<thinking>planning</thinking>\n' +
		'I will read a file.\n' +
		'🛠️ Tool: `file_read`  📥 args:\n````text\n{"path":"a"}\n````\n`````\n[Action] Reading file: a\nhi\n`````\n\n' +
		'**LLM Running (Turn 2) ...**\n\n' +
		'🛠️ Tool: `code_run`  📥 args:\n````text\n{"code":"print(1)"}\n````\n`````\n[Action] Running python\n[Status] ✅ Exit Code: 0\n1\n`````\n' +
		'Done.\n';
	const segs = parseAssistantSegments(raw);
	const kinds = segs.map(s => s.kind);
	check('multi-turn: contains 2 turn dividers',
		kinds.filter(k => k === 'turn').length === 2, kinds);
	check('multi-turn: contains 2 tool segments',
		kinds.filter(k => k === 'tool').length === 2, kinds);
	check('multi-turn: contains 1 thinking segment',
		kinds.filter(k => k === 'thinking').length === 1, kinds);
	const tools = segs.filter(s => s.kind === 'tool');
	check('multi-turn: first tool is file_read', tools[0].name === 'file_read');
	check('multi-turn: second tool is code_run', tools[1].name === 'code_run');
	check('multi-turn: second tool status parsed', tools[1].status === '✅');
}

// ── 10. previewArgs helper ────────────────────────────────────────────
check('previewArgs empty → empty', previewArgs('x', '') === '');
check('previewArgs picks path', previewArgs('file_read', JSON.stringify({ path: 'a/b/c.txt', start: 1 })) === 'a/b/c.txt');
check('previewArgs picks query', previewArgs('search', JSON.stringify({ query: 'TODO' })) === 'TODO');
check('previewArgs falls back to full JSON for unknown shape',
	previewArgs('x', JSON.stringify({ weird: 42 })).startsWith('weird='));
check('previewArgs truncates long strings',
	(() => {
		const p = previewArgs('x', JSON.stringify({ path: 'a'.repeat(200) }));
		return p.length <= 80 && p.endsWith('…');
	})());
check('previewArgs handles non-JSON (compact form)',
	previewArgs('x', 'path=foo.txt').includes('path=foo.txt'));

// ── 11. segments have stable keys ─────────────────────────────────────
{
	const raw1 = '**LLM Running (Turn 1) ...**\nHi';
	const raw2 = raw1 + ' more';
	const a = parseAssistantSegments(raw1);
	const b = parseAssistantSegments(raw2);
	check('same prefix → same keys up to common length',
		a[0].key === b[0].key && a[1].key === b[1].key);
}

if (failed) {
	console.error(`\n${failed} / ${total} FAILED`);
	process.exit(1);
}
console.log(`\n${total} / ${total} passed`);
