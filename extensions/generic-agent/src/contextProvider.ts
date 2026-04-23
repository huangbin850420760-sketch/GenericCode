import * as vscode from 'vscode';
import { AgentClient } from './agentClient';
import { logger } from './logger';

/**
 * Pushes editor-side context to the agent-core backend whenever the user
 * changes the active editor or its selection, throttled to avoid spamming
 * the WebSocket with every keystroke.
 *
 * Payload shape (see docs/protocol.md §5.2):
 *   {
 *     active_file:    string | null,
 *     selection:      { start_line, end_line, text },
 *     open_files:     string[],
 *     workspace_root: string | null,
 *   }
 *
 * Gated by the 'context_push' feature negotiated during the hello/ack
 * handshake: if the server didn't advertise it we stay silent.
 */
export class ContextProvider implements vscode.Disposable {

	private readonly disposables: vscode.Disposable[] = [];
	private throttleTimer?: ReturnType<typeof setTimeout>;
	private lastPayloadJSON = '';
	private readonly THROTTLE_MS = 500;

	constructor(private readonly client: AgentClient) { }

	start(): void {
		// Only install listeners once the server has told us it supports it.
		const begin = () => {
			if (!this.client.hasFeature('context_push')) {
				logger.debug('context_push not negotiated — skipping listener install');
				return;
			}
			logger.info('context_push active — listening for editor changes');
			this.disposables.push(
				vscode.window.onDidChangeActiveTextEditor(() => this.schedulePush()),
				vscode.window.onDidChangeTextEditorSelection(() => this.schedulePush()),
				vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedulePush()),
				vscode.workspace.onDidOpenTextDocument(() => this.schedulePush()),
				vscode.workspace.onDidCloseTextDocument(() => this.schedulePush()),
			);
			// First push after a tick so the UI has settled.
			this.schedulePush(0);
		};

		if (this.client.ack) { begin(); }
		else {
			const h = this.client.onHelloAck(() => { begin(); h.dispose(); });
			this.disposables.push(h);
		}
	}

	private schedulePush(delay = this.THROTTLE_MS): void {
		if (this.throttleTimer) { clearTimeout(this.throttleTimer); }
		this.throttleTimer = setTimeout(() => this.push(), delay);
	}

	private push(): void {
		const editor = vscode.window.activeTextEditor;
		const selText = editor?.document.getText(editor.selection) ?? '';
		const activeFile = editor?.document.uri.fsPath ?? null;

		// Cap selection payload so we don't send massive blobs.
		const MAX_SEL = 8000;
		const clippedSel = selText.length > MAX_SEL
			? selText.slice(0, MAX_SEL) + '\n…[truncated]'
			: selText;

		const payload = {
			active_file: activeFile,
			selection: editor ? {
				start_line: editor.selection.start.line + 1,
				end_line: editor.selection.end.line + 1,
				text: clippedSel,
			} : null,
			open_files: vscode.workspace.textDocuments
				.filter(d => d.uri.scheme === 'file')
				.map(d => d.uri.fsPath),
			workspace_root: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
		};

		// De-dupe: skip sends where nothing meaningful changed.
		const json = JSON.stringify(payload);
		if (json === this.lastPayloadJSON) { return; }
		this.lastPayloadJSON = json;

		const ok = this.client.send({ type: 'context', payload });
		logger.debug('context pushed', { ok, file: activeFile, selLen: selText.length });
	}

	dispose(): void {
		if (this.throttleTimer) { clearTimeout(this.throttleTimer); }
		for (const d of this.disposables) {
			try { d.dispose(); } catch { /* noop */ }
		}
	}
}
