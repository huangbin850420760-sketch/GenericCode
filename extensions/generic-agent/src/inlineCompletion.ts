/**
 * Inline (ghost-text) code completion provider for GenericAgent.
 *
 * Calls the backend `/api/complete` endpoint with file prefix/suffix around the
 * cursor. The backend picks the cheapest OAI-compatible model from mykey.json,
 * runs a single-shot chat completion (no agent loop, no tools), and returns
 * raw text to insert.
 *
 * UX rules:
 *  - Disabled by default; toggled via `genericAgent.inlineCompletion.enabled`
 *  - Debounced 250 ms after each keystroke
 *  - Aborts in-flight request when user keeps typing
 *  - Skipped on plain-text / markdown / git-commit / scm input documents
 */
import * as vscode from 'vscode';
import { logger } from './logger';

const SKIP_LANGS = new Set(['plaintext', 'markdown', 'git-commit', 'scminput', 'log']);
const DEBOUNCE_MS = 250;
const PREFIX_CHARS = 3000;
const SUFFIX_CHARS = 1000;
const MAX_TOKENS = 80;

let currentAbort: AbortController | null = null;
let lastReqAt = 0;

interface CompleteResponse {
	completion?: string;
	error?: string;
	model?: string;
}

async function postComplete(
	httpPort: number,
	body: { prefix: string; suffix: string; lang: string; max_tokens: number },
	signal: AbortSignal,
): Promise<CompleteResponse> {
	const url = `http://127.0.0.1:${httpPort}/api/complete`;
	const r = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal,
	});
	return (await r.json()) as CompleteResponse;
}

function buildContext(document: vscode.TextDocument, position: vscode.Position) {
	const startOffset = Math.max(0, document.offsetAt(position) - PREFIX_CHARS);
	const endOffset = document.offsetAt(position) + SUFFIX_CHARS;
	const startPos = document.positionAt(startOffset);
	const endPos = document.positionAt(Math.min(endOffset, document.getText().length));
	const prefix = document.getText(new vscode.Range(startPos, position));
	const suffix = document.getText(new vscode.Range(position, endPos));
	return { prefix, suffix };
}

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
	private getHttpPort: () => number | undefined;
	constructor(getHttpPort: () => number | undefined) {
		this.getHttpPort = getHttpPort;
	}
	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_ctx: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionItem[] | null> {
		const cfg = vscode.workspace.getConfiguration('genericAgent');
		if (!cfg.get<boolean>('inlineCompletion.enabled', false)) {
			return null;
		}
		if (SKIP_LANGS.has(document.languageId)) {
			return null;
		}
		const port = this.getHttpPort();
		if (!port) {
			return null;
		}
		// Debounce: only fire on the most recent invocation.
		const myReqAt = Date.now();
		lastReqAt = myReqAt;
		await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS));
		if (myReqAt !== lastReqAt || token.isCancellationRequested) {
			return null;
		}

		// Cancel any in-flight request from a stale keystroke.
		if (currentAbort) {
			try { currentAbort.abort(); } catch { /* ignore */ }
		}
		currentAbort = new AbortController();
		const abortSignal = currentAbort.signal;
		token.onCancellationRequested(() => {
			try { currentAbort?.abort(); } catch { /* ignore */ }
		});

		const { prefix, suffix } = buildContext(document, position);
		// Don't bother on tiny files (< 4 chars before cursor) — usually noise.
		if (prefix.trim().length < 4) {
			return null;
		}

		try {
			const data = await postComplete(
				port,
				{ prefix, suffix, lang: document.languageId, max_tokens: MAX_TOKENS },
				abortSignal,
			);
			if (token.isCancellationRequested) { return null; }
			if (data.error) {
				logger.debug('inline completion error', data.error);
				return null;
			}
			let text = data.completion || '';
			if (!text.trim()) { return null; }
			// Trim a leading newline if the prefix already ends with one (avoid blank line).
			if (prefix.endsWith('\n') && text.startsWith('\n')) {
				text = text.replace(/^\n+/, '');
			}
			return [
				new vscode.InlineCompletionItem(text, new vscode.Range(position, position)),
			];
		} catch (e) {
			const err = e as Error;
			if (err.name === 'AbortError') { return null; }
			logger.debug('inline completion fetch failed', err.message);
			return null;
		}
	}
}

export function registerInlineCompletion(
	ctx: vscode.ExtensionContext,
	getHttpPort: () => number | undefined,
): vscode.Disposable {
	const provider = new InlineCompletionProvider(getHttpPort);
	const sub = vscode.languages.registerInlineCompletionItemProvider(
		{ pattern: '**' },
		provider,
	);
	ctx.subscriptions.push(sub);

	// Status bar item: click to jump straight to the setting (user-friendly,
	// no command palette needed). Tooltip explains how to verify.
	const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
	statusItem.command = {
		command: 'workbench.action.openSettings',
		title: 'Open GenericAgent Inline Completion settings',
		arguments: ['genericAgent.inlineCompletion.enabled'],
	};
	const refreshStatus = (): void => {
		const cfg = vscode.workspace.getConfiguration('genericAgent');
		const on = cfg.get<boolean>('inlineCompletion.enabled', false);
		statusItem.text = on ? '$(sparkle) GA Complete: ON' : '$(sparkle) GA Complete: OFF';
		statusItem.tooltip = new vscode.MarkdownString(
			(on ? '**行内补全已开启**' : '**行内补全已关闭**') +
			'\n\n点击打开设置页切换。\n\n验证：在 .py/.ts/.js 文件里写半句代码停顿 0.3 秒，灰色补全将出现，按 `Tab` 接受。',
		);
		statusItem.show();
	};
	refreshStatus();
	ctx.subscriptions.push(
		statusItem,
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('genericAgent.inlineCompletion.enabled')) {
				refreshStatus();
			}
		}),
	);

	return sub;
}
