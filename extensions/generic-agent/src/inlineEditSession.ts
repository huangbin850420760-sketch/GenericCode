import * as vscode from 'vscode';
import { logger } from './logger';

/**
 * An in-document, Cursor-style inline-edit session.
 *
 * Layout inside the buffer while the session is live:
 *
 *   …unchanged prefix…
 *   <original lines>   ← full-line range, RED strikethrough
 *   <proposed lines>   ← full-line range, GREEN background (grows as deltas stream)
 *   …unchanged suffix…
 *
 * The user accepts by deleting the original region, or rejects by
 * deleting the proposed region.  Only ONE session may be active per
 * extension host at a time (tracked by `InlineEditSession.current`);
 * starting a new session auto-cancels the previous one.
 *
 * Range tracking invariants:
 *   • `originalRange` is a full-line range (start.character === 0,
 *     end is the start of the line AFTER the last original line).
 *   • `proposedLineCount` is the line-count of the currently-shown
 *     proposed block; the block occupies lines
 *     [originalRange.end.line, originalRange.end.line + proposedLineCount).
 *   • All edits performed by the session increment `_selfEditDepth` so
 *     the user-edit cancellation heuristic ignores them.
 */
export class InlineEditSession implements vscode.Disposable {
	/** The currently-active session, if any. */
	public static current: InlineEditSession | undefined;

	/** Emits when the session ends for ANY reason (accept, reject, cancel, dispose). */
	private readonly _onEnd = new vscode.EventEmitter<'accept' | 'reject' | 'cancel'>();
	public readonly onEnd = this._onEnd.event;

	public readonly documentUri: vscode.Uri;
	public readonly originalText: string;

	/**
	 * Full-line range of the original (about-to-be-removed) block.
	 * Mutated when the proposed region is inserted/replaced, because we
	 * need precise tracking for decoration refresh.
	 */
	private _originalRange: vscode.Range;
	/** Current full-line range of the proposed (green) block. */
	private _proposedRange: vscode.Range;
	/** Most recent proposed text (without trailing newline guarantee). */
	private _proposedText = '';
	private _ended = false;

	// Decorations are process-wide singletons — VSCode limits the
	// number of decoration types you can allocate, and these render
	// identically for every session.
	private static _deco?: {
		oldLines: vscode.TextEditorDecorationType;
		newLines: vscode.TextEditorDecorationType;
		gutterMarker: vscode.TextEditorDecorationType;
	};

	private static getDeco(): NonNullable<typeof InlineEditSession._deco> {
		if (!this._deco) {
			this._deco = {
				oldLines: vscode.window.createTextEditorDecorationType({
					isWholeLine: true,
					backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
					// line-through on the text itself to make deletion unambiguous
					textDecoration: 'line-through; opacity: 0.75;',
					overviewRulerColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
					overviewRulerLane: vscode.OverviewRulerLane.Full,
				}),
				newLines: vscode.window.createTextEditorDecorationType({
					isWholeLine: true,
					backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
					overviewRulerColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
					overviewRulerLane: vscode.OverviewRulerLane.Full,
				}),
				gutterMarker: vscode.window.createTextEditorDecorationType({
					isWholeLine: true,
					// Subtle left-border marker so the hunk stays findable
					// even when the user scrolls/folds nearby code.
					borderWidth: '0 0 0 2px',
					borderStyle: 'solid',
					borderColor: new vscode.ThemeColor('editorInfo.foreground'),
				}),
			};
		}
		return this._deco;
	}

	private _selfEditDepth = 0;
	private readonly _subs: vscode.Disposable[] = [];

	private constructor(
		private editor: vscode.TextEditor,
		originalRange: vscode.Range,
		originalText: string,
	) {
		this.documentUri = editor.document.uri;
		this._originalRange = originalRange;
		this.originalText = originalText;
		// Proposed region starts empty, immediately after the original.
		const atEnd = originalRange.end;
		this._proposedRange = new vscode.Range(atEnd, atEnd);

		// Cancel on user edits that we didn't cause, or on editor close.
		this._subs.push(
			vscode.workspace.onDidChangeTextDocument(e => {
				if (e.document.uri.toString() !== this.documentUri.toString()) { return; }
				if (this._selfEditDepth > 0) { return; }
				if (e.contentChanges.length === 0) { return; }
				// Ignore cosmetic edits entirely outside our hunk footprint.
				// If the user edits INSIDE our managed ranges we bail out —
				// we can't reliably keep decorations aligned after that.
				const touches = e.contentChanges.some(c =>
					rangesOverlap(c.range, this._originalRange)
					|| rangesOverlap(c.range, this._proposedRange),
				);
				if (touches) {
					logger.info('inline edit cancelled — user edited hunk');
					void this.cancel();
				}
			}),
			vscode.workspace.onDidCloseTextDocument(d => {
				if (d.uri.toString() === this.documentUri.toString()) {
					void this.cancel();
				}
			}),
		);

		this.refreshDecorations();
		void vscode.commands.executeCommand('setContext', 'genericAgent.inlineEdit.active', true);
	}

	/**
	 * Begin a session.  If one is already active it is cancelled first.
	 * The original range is normalised to full-line boundaries so
	 * decorations and deletions operate cleanly on entire lines.
	 */
	public static async start(
		editor: vscode.TextEditor,
		rawRange: vscode.Range,
	): Promise<InlineEditSession> {
		if (this.current) {
			await this.current.cancel();
		}
		const fullLine = expandToFullLines(editor.document, rawRange);
		const originalText = editor.document.getText(fullLine);
		const session = new InlineEditSession(editor, fullLine, originalText);
		this.current = session;
		return session;
	}

	public get originalRange(): vscode.Range { return this._originalRange; }
	public get proposedRange(): vscode.Range { return this._proposedRange; }
	public get proposedText(): string { return this._proposedText; }
	public get ended(): boolean { return this._ended; }

	/**
	 * Replace the contents of the proposed region with `text`.  The text
	 * is always stored with a trailing newline so the region occupies a
	 * whole number of lines.  No-op if the text hasn't changed.
	 */
	public async setProposedText(text: string): Promise<void> {
		if (this._ended) { return; }
		const normalised = text.endsWith('\n') ? text : (text + '\n');
		if (normalised === this._proposedText) { return; }
		// Every edit to the proposed region REPLACES the whole region.
		// That keeps range accounting dead simple at the cost of extra
		// work — fine because we already throttle callers to ~15fps.
		const newLineCount = normalised === '' ? 0 : countLines(normalised);
		await this.runSelfEdit(async edit => {
			edit.replace(this.documentUri, this._proposedRange, normalised);
		});
		// Recompute the proposed range based on what we just wrote.
		const startPos = this._proposedRange.start;
		const endLine = startPos.line + newLineCount;
		this._proposedRange = new vscode.Range(startPos, new vscode.Position(endLine, 0));
		this._proposedText = normalised;
		this.refreshDecorations();
	}

	/**
	 * Accept the proposed block: remove the original block and keep the
	 * proposed contents verbatim (minus the trailing extra newline if
	 * the original didn't have one — we preserve the user's EOL style).
	 */
	public async accept(): Promise<boolean> {
		if (this._ended) { return false; }
		// If the original chunk didn't end with a newline (last-line-in-file
		// selection) we should strip one trailing newline from the proposed
		// block so we don't introduce a spurious blank line.
		const originalHadTrailingNL = this.originalText.endsWith('\n');
		if (!originalHadTrailingNL && this._proposedText.endsWith('\n')) {
			// Rewrite the proposed region without trailing NL.  Do this
			// BEFORE deleting the original so position math is stable.
			const trimmed = this._proposedText.replace(/\n$/, '');
			await this.runSelfEdit(async edit => {
				edit.replace(this.documentUri, this._proposedRange, trimmed);
			});
			const start = this._proposedRange.start;
			const newLines = countLines(trimmed);
			this._proposedRange = new vscode.Range(
				start,
				new vscode.Position(
					start.line + (newLines === 0 ? 0 : newLines - 1),
					// end at EOL of last line
					this.editor.document.lineAt(start.line + Math.max(0, newLines - 1)).range.end.character,
				),
			);
		}
		await this.runSelfEdit(async edit => {
			edit.delete(this.documentUri, this._originalRange);
		});
		this.end('accept');
		return true;
	}

	/** Reject: delete the proposed block; original stays untouched. */
	public async reject(): Promise<boolean> {
		if (this._ended) { return false; }
		await this.runSelfEdit(async edit => {
			edit.delete(this.documentUri, this._proposedRange);
		});
		this.end('reject');
		return true;
	}

	/** Cancel is equivalent to reject plus an internal 'cancel' event. */
	public async cancel(): Promise<void> {
		if (this._ended) { return; }
		try {
			await this.runSelfEdit(async edit => {
				edit.delete(this.documentUri, this._proposedRange);
			});
		} catch { /* ignore */ }
		this.end('cancel');
	}

	public dispose(): void {
		if (!this._ended) { this.end('cancel'); }
	}

	// ── internals ──────────────────────────────────────────────────────

	private end(reason: 'accept' | 'reject' | 'cancel'): void {
		if (this._ended) { return; }
		this._ended = true;
		try {
			this.editor.setDecorations(InlineEditSession.getDeco().oldLines, []);
			this.editor.setDecorations(InlineEditSession.getDeco().newLines, []);
			this.editor.setDecorations(InlineEditSession.getDeco().gutterMarker, []);
		} catch { /* editor may be gone */ }
		this._subs.forEach(d => d.dispose());
		this._subs.length = 0;
		if (InlineEditSession.current === this) {
			InlineEditSession.current = undefined;
			void vscode.commands.executeCommand('setContext', 'genericAgent.inlineEdit.active', false);
		}
		this._onEnd.fire(reason);
		this._onEnd.dispose();
	}

	private refreshDecorations(): void {
		try {
			const d = InlineEditSession.getDeco();
			const oldRanges = this._originalRange.isEmpty ? [] : [this._originalRange];
			const newRanges = this._proposedRange.isEmpty ? [] : [this._proposedRange];
			this.editor.setDecorations(d.oldLines, oldRanges);
			this.editor.setDecorations(d.newLines, newRanges);
			// One gutter stripe spanning both blocks — gives the user a
			// persistent "here is the hunk" marker even on scroll.
			const spanStart = this._originalRange.start;
			const spanEnd = this._proposedRange.end.isAfter(this._originalRange.end)
				? this._proposedRange.end
				: this._originalRange.end;
			this.editor.setDecorations(d.gutterMarker, [new vscode.Range(spanStart, spanEnd)]);
		} catch (e) {
			logger.warn('decoration refresh failed', (e as Error).message);
		}
	}

	/**
	 * Apply a WorkspaceEdit while bumping the self-edit counter so our
	 * own mutation listener ignores it.  Throws only if applyEdit returns
	 * false AND we're past the initial insertion (so the caller can
	 * decide whether to surface the failure).
	 */
	private async runSelfEdit(build: (edit: vscode.WorkspaceEdit) => Promise<void>): Promise<void> {
		const edit = new vscode.WorkspaceEdit();
		await build(edit);
		this._selfEditDepth++;
		try {
			const ok = await vscode.workspace.applyEdit(edit);
			if (!ok) {
				logger.warn('inline edit WorkspaceEdit returned false');
			}
		} finally {
			// Let the onDidChangeTextDocument fire + settle before clearing.
			// We use a microtask so subsequent awaits still run after.
			queueMicrotask(() => { this._selfEditDepth = Math.max(0, this._selfEditDepth - 1); });
		}
	}
}

// ───────────────────────────────────────────────────────────────────────
// Pure helpers (exported for unit testing)
// ───────────────────────────────────────────────────────────────────────

/**
 * Expand an arbitrary range to cover entire lines.  If `range` is empty
 * the result covers a single line (the line the caret sits on).  If the
 * range ends exactly at the start of a line we leave it alone — that's
 * already a full-line range.
 */
export function expandToFullLines(
	doc: vscode.TextDocument,
	range: vscode.Range,
): vscode.Range {
	const startLine = range.start.line;
	let endLine = range.end.line;
	// If the range ends at column 0 of a line, it means the previous line
	// was the last "real" line included — step back so we don't devour
	// an extra row.
	if (range.end.character === 0 && endLine > startLine) { endLine--; }
	const lineCount = doc.lineCount;
	endLine = Math.min(endLine, lineCount - 1);
	const start = new vscode.Position(startLine, 0);
	// End at the start of the line AFTER the last line we want to cover,
	// UNLESS that would exceed EOF — in which case end at EOL of the last
	// line of the file.
	if (endLine + 1 < lineCount) {
		return new vscode.Range(start, new vscode.Position(endLine + 1, 0));
	}
	const lastLineLen = doc.lineAt(endLine).text.length;
	return new vscode.Range(start, new vscode.Position(endLine, lastLineLen));
}

/** Count the number of newline-terminated lines in `s`. */
export function countLines(s: string): number {
	if (!s) { return 0; }
	let n = 0;
	for (let i = 0; i < s.length; i++) { if (s.charCodeAt(i) === 10) { n++; } }
	// A trailing no-newline line still counts as a line.
	if (!s.endsWith('\n')) { n++; }
	return n;
}

export function rangesOverlap(a: vscode.Range, b: vscode.Range): boolean {
	// Touching (end of one equals start of the other) does NOT count as
	// overlap — we use this to tell "user typed next to our hunk" from
	// "user typed inside our hunk".
	if (a.end.isBeforeOrEqual(b.start)) { return false; }
	if (b.end.isBeforeOrEqual(a.start)) { return false; }
	return true;
}
