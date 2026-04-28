/**
 * Parse an assistant streaming buffer (agent-core's verbose output) into
 * a sequence of structured segments suitable for Cursor-style rendering.
 *
 * The input grammar we recognise is produced by `agent_loop.py` in
 * verbose mode, plus a handful of specific markers from tool handlers:
 *
 *   **LLM Running (Turn N) ...**        ← turn divider
 *   <thinking>…</thinking>              ← reasoning block
 *   <summary>…</summary>                ← agent self-summary (shown inline)
 *   🛠️ Tool: `name`  📥 args:            ← tool call header, followed by
 *   ````text\n{JSON}\n````              ← args (4-backtick fence)
 *   `````\n…tool output…\n`````         ← output (5-backtick fence)
 *   🛠️ name(compact args)               ← non-verbose tool call header (no body)
 *
 * Every segment also carries the raw source offsets so the webview can
 * stably key them when re-rendering during streaming (preserves the
 * user's expand/collapse choices).
 *
 * This file has NO runtime dependencies so it can be loaded verbatim
 * into the chat webview by inlining the compiled `.js`.  Keep it pure.
 */

export type Segment =
	| { kind: 'narrative'; text: string; key: string }
	| { kind: 'thinking'; text: string; closed: boolean; key: string }
	| { kind: 'summary'; text: string; closed: boolean; key: string }
	| { kind: 'turn'; n: number; key: string }
	| {
		kind: 'tool';
		name: string;
		args: string;        // pretty-printed JSON string
		argsClosed: boolean; // whether the args fence closed
		output: string;      // raw output between the 5-backtick fences
		outputClosed: boolean;
		status?: string;     // derived from [Status] line in the output, e.g. '✅' / '❌'
		key: string;
	};

/** Regexes at module scope to avoid recompilation per call. */
const RE_TURN = /^\*\*LLM Running \(Turn (\d+)\) \.\.\.\*\*\s*\n?/;
// Verbose tool header looks like:  🛠️ Tool: `name`  📥 args:\n
const RE_TOOL_HEADER = new RegExp('^🛠️ Tool: `([^`]+)` {2}📥 args:\\s*\\n');
// Non-verbose tool header:  🛠️ name(compact args)\n
const RE_TOOL_COMPACT = /^🛠️ ([A-Za-z_][\w]*)\(([^\n]*)\)\s*\n+/;

/**
 * Parse the raw buffer into segments.  The parser is intentionally
 * forgiving: unclosed `<thinking>` / code fences are kept open and their
 * captured bodies are returned so streaming UIs can show partial content.
 */
export function parseAssistantSegments(raw: string): Segment[] {
	const out: Segment[] = [];
	let i = 0;
	let narrativeBuf = '';
	// We use a running key index per segment so webview can key DOM nodes
	// stably — stream updates produce the same keys for the same positions.
	let segIdx = 0;
	const nextKey = (tag: string) => tag + ':' + String(segIdx++);

	const flushNarrative = () => {
		if (narrativeBuf.length === 0) { return; }
		// Trim leading/trailing blank LINES only; keep internal whitespace
		// since markdown cares about it.
		const trimmed = narrativeBuf.replace(/^\n+/, '').replace(/\n+$/, '');
		if (trimmed.length > 0) {
			out.push({ kind: 'narrative', text: trimmed, key: nextKey('n') });
		}
		narrativeBuf = '';
	};

	while (i < raw.length) {
		const rest = raw.slice(i);

		// 1. Turn divider?
		const mTurn = RE_TURN.exec(rest);
		if (mTurn && isLineStart(raw, i)) {
			flushNarrative();
			out.push({ kind: 'turn', n: parseInt(mTurn[1], 10), key: nextKey('t') });
			i += mTurn[0].length;
			continue;
		}

		// 2. Thinking / summary blocks (line-anchored open recommended but not required).
		if (rest.startsWith('<thinking>')) {
			flushNarrative();
			const close = rest.indexOf('</thinking>');
			if (close >= 0) {
				const body = rest.slice('<thinking>'.length, close);
				out.push({ kind: 'thinking', text: body, closed: true, key: nextKey('k') });
				i += close + '</thinking>'.length;
			} else {
				const body = rest.slice('<thinking>'.length);
				out.push({ kind: 'thinking', text: body, closed: false, key: nextKey('k') });
				i = raw.length;
			}
			continue;
		}
		if (rest.startsWith('<summary>')) {
			flushNarrative();
			const close = rest.indexOf('</summary>');
			if (close >= 0) {
				const body = rest.slice('<summary>'.length, close);
				out.push({ kind: 'summary', text: body, closed: true, key: nextKey('s') });
				i += close + '</summary>'.length;
			} else {
				const body = rest.slice('<summary>'.length);
				out.push({ kind: 'summary', text: body, closed: false, key: nextKey('s') });
				i = raw.length;
			}
			continue;
		}

		// 3. Tool call — verbose form (line-anchored).
		if (isLineStart(raw, i)) {
			const mHdr = RE_TOOL_HEADER.exec(rest);
			if (mHdr) {
				flushNarrative();
				const name = mHdr[1];
				let cursor = i + mHdr[0].length;
				// Args are in a ````text ... ```` 4-backtick fence.  We
				// accept any 4-backtick open (language marker optional).
				const argsStart = raw.indexOf('````', cursor);
				let args = '';
				let argsClosed = false;
				if (argsStart === cursor || (argsStart >= 0 && /^\s*$/.test(raw.slice(cursor, argsStart)))) {
					const afterFence = raw.indexOf('\n', argsStart);
					if (afterFence >= 0) {
						const argEnd = raw.indexOf('\n````', afterFence);
						if (argEnd >= 0) {
							args = raw.slice(afterFence + 1, argEnd);
							argsClosed = true;
							cursor = argEnd + '\n````'.length;
							// Swallow any newline after the closing fence.
							if (raw[cursor] === '\n') { cursor++; }
						} else {
							args = raw.slice(afterFence + 1);
							cursor = raw.length;
						}
					}
				}
				// Output is in a ````` ... ````` 5-backtick fence.
				let output = '';
				let outputClosed = false;
				if (cursor < raw.length) {
					const outStart = raw.indexOf('`````', cursor);
					if (outStart >= 0 && /^\s*$/.test(raw.slice(cursor, outStart))) {
						const after = raw.indexOf('\n', outStart);
						if (after >= 0) {
							const outEnd = raw.indexOf('\n`````', after);
							if (outEnd >= 0) {
								output = raw.slice(after + 1, outEnd);
								outputClosed = true;
								cursor = outEnd + '\n`````'.length;
								if (raw[cursor] === '\n') { cursor++; }
							} else {
								output = raw.slice(after + 1);
								cursor = raw.length;
							}
						}
					}
				}
				const status = deriveStatus(output);
				out.push({
					kind: 'tool',
					name,
					args,
					argsClosed,
					output,
					outputClosed,
					status,
					key: nextKey('l'),
				});
				i = cursor;
				continue;
			}

			// Non-verbose compact tool header (no body follows).
			const mCompact = RE_TOOL_COMPACT.exec(rest);
			if (mCompact) {
				flushNarrative();
				out.push({
					kind: 'tool',
					name: mCompact[1],
					args: mCompact[2],
					argsClosed: true,
					output: '',
					outputClosed: true,
					key: nextKey('c'),
				});
				i += mCompact[0].length;
				continue;
			}
		}

		// Default: one character of narrative.  (We advance char-by-char
		// so the regexes above get a chance at every line-start position.)
		narrativeBuf += raw[i];
		i++;
	}
	flushNarrative();
	return out;
}

/** True if offset `i` in `s` sits at the start of a line. */
function isLineStart(s: string, i: number): boolean {
	return i === 0 || s[i - 1] === '\n';
}

/**
 * Look for a `[Status] ✅/❌/⏳ …` line inside tool output and return
 * the emoji if found.  Used to badge tool cards with success/failure
 * without having to surface the raw tail of stdout.
 */
function deriveStatus(output: string): string | undefined {
	const m = /\[Status\] (✅|❌|⏳)/.exec(output);
	return m ? m[1] : undefined;
}

/**
 * Short preview of tool args for the collapsed card header.  Tries to
 * show the most informative field (`path`, `query`, `code`, …) and
 * falls back to the whole JSON truncated.
 */
export function previewArgs(name: string, argsRaw: string): string {
	const s = (argsRaw || '').trim();
	if (!s) { return ''; }
	try {
		const obj = JSON.parse(s);
		if (obj && typeof obj === 'object') {
			const pick = ['path', 'file', 'query', 'keyword', 'code', 'command', 'url', 'pattern'];
			for (const k of pick) {
				if (typeof obj[k] === 'string' && obj[k].length > 0) {
					return truncate(String(obj[k]), 80);
				}
			}
			// Drop underscore-prefixed internals.
			const first = Object.entries(obj).find(([k]) => !k.startsWith('_'));
			if (first) { return truncate(first[0] + '=' + formatVal(first[1]), 80); }
		}
	} catch { /* not JSON — fall through */ }
	return truncate(s.replace(/\s+/g, ' '), 80);
}

function formatVal(v: unknown): string {
	if (typeof v === 'string') { return v; }
	if (v == null) { return String(v); }
	if (typeof v === 'object') { return JSON.stringify(v); }
	return String(v);
}

function truncate(s: string, n: number): string {
	if (s.length <= n) { return s; }
	return s.slice(0, n - 1) + '…';
}
