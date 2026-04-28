import * as vscode from 'vscode';
import * as path from 'path';
import { AgentClient } from './agentClient';
import { InlineEditSession } from './inlineEditSession';
import { InlineEditLensProvider } from './inlineEditLens';

/**
 * Ctrl+I / Cmd+I "inline edit" controller — Cursor-style.
 *
 * Flow:
 *   1. Active editor + selection (or current line if empty).
 *   2. Prompt the user for an instruction via `showInputBox`.
 *   3. Start an `InlineEditSession` in the live buffer: original lines
 *      keep their place with RED strikethrough decoration; proposed
 *      lines are inserted IMMEDIATELY BELOW with GREEN decoration.
 *   4. Stream the model's output into the proposed region (~15fps).
 *   5. User accepts (⏎ → delete original) or rejects (⎋ → delete
 *      proposed) via CodeLens or keybinding.  `Regenerate` restarts
 *      step 3 with the same instruction and selection.
 *
 * Only ONE inline edit can be in flight at a time — we guard on
 * both `client.currentSource` and `InlineEditSession.current`.
 */
export class InlineEditController implements vscode.Disposable {
	private disposables: vscode.Disposable[] = [];
	private client: AgentClient;
	private readonly lensProvider: InlineEditLensProvider;

	/** Tracks the IN-FLIGHT streaming turn, not the session.  Used by the
	 *  Regenerate path to know whether to abort first. */
	private streamSubs: vscode.Disposable[] = [];

	/** Remember the last invocation so "Regenerate" can replay it. */
	private lastRun?: {
		editorUri: vscode.Uri;
		range: vscode.Range;
		instruction: string;
		fileName: string;
		languageId: string;
	};

	constructor(client: AgentClient) {
		this.client = client;
		this.lensProvider = new InlineEditLensProvider();
	}

	/** Swap the underlying client (used on backend restart — the command
	 *  itself stays registered against the long-lived controller). */
	setClient(client: AgentClient): void {
		this.client = client;
	}

	register(ctx: vscode.ExtensionContext): void {
		ctx.subscriptions.push(
			vscode.commands.registerCommand('genericAgent.editWithAgent', () => this.run()),
			vscode.commands.registerCommand('genericAgent.inlineEdit.accept',
				() => this.acceptCurrent()),
			vscode.commands.registerCommand('genericAgent.inlineEdit.reject',
				() => this.rejectCurrent()),
			vscode.commands.registerCommand('genericAgent.inlineEdit.regenerate',
				() => this.regenerate()),
			vscode.languages.registerCodeLensProvider(
				{ scheme: 'file' },
				this.lensProvider,
			),
		);
		ctx.subscriptions.push(this.lensProvider);
	}

	async run(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			void vscode.window.showWarningMessage('GenericAgent: open a file to edit first.');
			return;
		}
		if (editor.document.uri.scheme !== 'file') {
			void vscode.window.showWarningMessage('GenericAgent: inline edit only supports on-disk files.');
			return;
		}
		if (this.client.currentSource) {
			void vscode.window.showWarningMessage(
				'GenericAgent: another task is already in flight — wait for it to finish or abort it.',
			);
			return;
		}

		const doc = editor.document;
		const sel = editor.selection;
		// Use the selection as-is, or fall back to the current line if
		// the user just punched Ctrl+I without selecting anything.  The
		// session will normalise this to full-line bounds.
		const range = sel.isEmpty
			? new vscode.Range(sel.active.line, 0, sel.active.line, doc.lineAt(sel.active.line).text.length)
			: new vscode.Range(sel.start, sel.end);
		const fileName = path.basename(doc.fileName);

		const instruction = await vscode.window.showInputBox({
			title: `Edit ${sel.isEmpty ? 'current line' : 'selection'} with GenericAgent`,
			prompt: `${fileName} • lines ${range.start.line + 1}–${range.end.line + 1}`,
			placeHolder: 'What should the agent do?  (e.g. "add type hints", "refactor to async/await")',
			ignoreFocusOut: true,
		});
		if (!instruction) { return; }

		this.lastRun = {
			editorUri: doc.uri,
			range,
			instruction,
			fileName,
			languageId: doc.languageId,
		};

		await this.startSessionAndStream(editor, range, instruction, fileName, doc.languageId);
	}

	private async startSessionAndStream(
		editor: vscode.TextEditor,
		range: vscode.Range,
		instruction: string,
		fileName: string,
		languageId: string,
	): Promise<void> {
		const session = await InlineEditSession.start(editor, range);
		this.lensProvider.refresh();
		// Refresh lenses whenever the session ends, so they disappear.
		session.onEnd(() => this.lensProvider.refresh());

		const originalText = session.originalText;
		const prompt = buildInlinePrompt({
			instruction,
			code: originalText,
			lang: languageId,
			file: fileName,
		});

		const result = await this.streamIntoSession(prompt, session);
		if (result === null) {
			// Cancelled (user hit Esc on progress, or error).  Session
			// already cleaned up via the error / cancel path — if not,
			// reject it to wipe the preview.
			if (!session.ended) { await session.cancel(); }
			this.lensProvider.refresh();
			return;
		}

		// Final pass — strip fences / thinking-blocks and normalise.
		const cleaned = extractCode(result);
		if (!session.ended) {
			await session.setProposedText(cleaned);
			this.lensProvider.refresh();
			void vscode.window.setStatusBarMessage(
				'$(sparkle) GenericAgent: review the diff — ⏎ Accept · ⎋ Reject',
				6000,
			);
		}
	}

	private async acceptCurrent(): Promise<void> {
		const s = InlineEditSession.current;
		if (!s) { return; }
		await s.accept();
		this.lensProvider.refresh();
	}

	private async rejectCurrent(): Promise<void> {
		const s = InlineEditSession.current;
		if (!s) { return; }
		await s.reject();
		this.lensProvider.refresh();
	}

	private async regenerate(): Promise<void> {
		const last = this.lastRun;
		if (!last) {
			void vscode.window.showWarningMessage('GenericAgent: no previous inline edit to regenerate.');
			return;
		}
		const editor = vscode.window.visibleTextEditors.find(
			e => e.document.uri.toString() === last.editorUri.toString(),
		) ?? vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.toString() !== last.editorUri.toString()) {
			void vscode.window.showWarningMessage('GenericAgent: open the original file first.');
			return;
		}
		// If a previous session is still live, reject it so the original
		// text is clean for a fresh insertion.
		if (InlineEditSession.current) {
			await InlineEditSession.current.reject();
		}
		// If a turn is still streaming, abort it.
		if (this.client.currentSource === 'inline') {
			this.client.sendAbort();
			await sleep(100);
		}
		await this.startSessionAndStream(
			editor,
			last.range,
			last.instruction,
			last.fileName,
			last.languageId,
		);
	}

	/**
	 * Pipe streaming deltas into the session's proposed region.  Resolves
	 * with the final raw buffer, or `null` on cancel / error.
	 */
	private streamIntoSession(
		prompt: string,
		session: InlineEditSession,
	): Promise<string | null> {
		// Tear down any previous stream subs first — belt-and-suspenders.
		this.streamSubs.forEach(d => d.dispose());
		this.streamSubs = [];
		return Promise.resolve(vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'GenericAgent: editing…',
				cancellable: true,
			},
			(progress, token) => new Promise<string | null>((resolve) => {
				let buffer = '';
				let lastRender = 0;
				const finish = (value: string | null) => {
					this.streamSubs.forEach(d => d.dispose());
					this.streamSubs = [];
					resolve(value);
				};

				this.streamSubs.push(this.client.onStream(ev => {
					if (this.client.currentSource !== 'inline') { return; }
					if (session.ended) { return; }
					buffer = ev.full || (buffer + (ev.delta || ''));
					const now = Date.now();
					if (now - lastRender > 66) {
						lastRender = now;
						const partial = extractCode(buffer);
						// Use .then() to avoid await here — throttling means
						// we never queue more than one in-flight edit.
						void session.setProposedText(partial);
					}
					const lines = buffer.split('\n').length;
					progress.report({ message: `${lines} line${lines === 1 ? '' : 's'}` });
				}));
				this.streamSubs.push(this.client.onDone(() => {
					if (this.client.currentSource !== null && this.client.currentSource !== 'inline') {
						return;
					}
					finish(buffer);
				}));
				this.streamSubs.push(this.client.onError(text => {
					if (this.client.currentSource !== null && this.client.currentSource !== 'inline') {
						return;
					}
					void vscode.window.showErrorMessage(`GenericAgent: ${text}`);
					finish(null);
				}));

				token.onCancellationRequested(() => {
					this.client.sendAbort();
					finish(null);
				});

				const ok = this.client.sendTask(prompt, { source: 'inline' });
				if (!ok) {
					void vscode.window.showErrorMessage(
						'GenericAgent: backend is not connected.',
					);
					finish(null);
				}
			}),
		));
	}

	dispose(): void {
		this.streamSubs.forEach(d => d.dispose());
		this.streamSubs = [];
		this.disposables.forEach(d => d.dispose());
		this.disposables = [];
		this.lensProvider.dispose();
		if (InlineEditSession.current) {
			void InlineEditSession.current.cancel();
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}

// ───────────────────────────────────────────────────────────────────────
// Pure helpers (exported for unit testing)
// ───────────────────────────────────────────────────────────────────────

export interface InlinePromptParams {
	instruction: string;
	code: string;
	lang: string;
	file: string;
}

/**
 * Prompt template that strongly biases the model toward emitting JUST the
 * rewritten code.  We still run `extractCode` on the response as a defense
 * in depth for models that insist on chattiness.
 */
export function buildInlinePrompt(p: InlinePromptParams): string {
	const fence = '```';
	return (
		'You are performing an INLINE CODE EDIT.  Respond with ONLY the rewritten code — no explanations, no preamble, no markdown prose.  ' +
		'Wrap your entire response in a single fenced code block using the ' +
		`language tag \`${p.lang || 'text'}\`.  Preserve indentation and line breaks.\n\n` +
		`File: ${p.file} (language: ${p.lang || 'unknown'})\n\n` +
		`Instruction: ${p.instruction}\n\n` +
		'Original code:\n' +
		`${fence}${p.lang || ''}\n${p.code}\n${fence}\n\n` +
		'Now output the rewritten code (ONLY the code, inside a single fenced block):'
	);
}

/**
 * Extract the payload code from an agent response.  The model may wrap its
 * answer in `<thinking>…</thinking>`, a `<summary>` block, and/or triple-
 * backtick fences.  We strip those layers off best-effort.
 *
 * Always returns a string (possibly empty).  Newline normalization is left
 * to the final `applyCodeToFile` step so line-ending heuristics stay in
 * one place.
 */
export function extractCode(raw: string): string {
	if (!raw) { return ''; }
	// Normalise line endings FIRST so all downstream regexes can assume \n.
	let s = raw.replace(/\r\n/g, '\n');

	// 1. Drop <thinking>…</thinking> and <summary>…</summary> blocks that
	//    agent-core's prompts occasionally induce.  Multiline, non-greedy.
	s = s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
	s = s.replace(/<summary>[\s\S]*?<\/summary>/gi, '');

	// 2. Extract the fenced code block's body, if any.  We require a PROPER
	//    line-anchored triple-backtick open (so stray ``````` style lines
	//    the agent sometimes emits as dividers aren't mistaken for fences).
	//    The info string is restricted to non-backtick chars, again to
	//    reject e.g. a 5-backtick "divider" as a fence opener.
	//
	//    Preference order:
	//      (a) the LAST fully-closed fence — handles "original ... new" style
	//          responses where the user wants the second one;
	//      (b) if no closed fence exists, the body of an UNCLOSED fence
	//          (mid-stream case).
	const closedRe = /(?:^|\n)[ \t]*```([^\n`]*)\n([\s\S]*?)\n[ \t]*```(?=\n|$)/g;
	const closedBodies: string[] = [];
	let cm: RegExpExecArray | null;
	while ((cm = closedRe.exec(s)) !== null) {
		closedBodies.push(cm[2]);
	}
	if (closedBodies.length > 0) {
		s = closedBodies[closedBodies.length - 1];
	} else {
		const openRe = /(?:^|\n)[ \t]*```([^\n`]*)\n([\s\S]*)$/;
		const om = openRe.exec(s);
		if (om) { s = om[2]; }
	}

	// 3. Normalise line endings, drop leading whitespace-only lines, and
	//    guarantee exactly one trailing newline.  Internal whitespace is
	//    preserved.
	s = s.replace(/\r\n/g, '\n');
	s = s.replace(/^(?:[ \t]*\n)+/, '');
	s = s.replace(/\n[ \t\n]*$/, '\n');
	if (!s.endsWith('\n')) { s += '\n'; }
	return s;
}
