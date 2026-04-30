import * as vscode from 'vscode';
import { AgentClient, ProtocolMessage } from './agentClient';
import { ChatPanel } from './chatPanel';
import { logger } from './logger';

/**
 * Handlers for IDE-bound messages coming from agent-core:
 *   - edit_file   → show an inline diff, let user accept/reject, reply
 *   - open_file   → reveal a file (+optional line/column)
 *   - run_terminal → spawn a visible terminal and send the command
 *   - show_diff   → open VSCode's diff view (M2.5)
 *
 * All handlers are designed to be resilient: a failure here must never
 * crash the extension or the backend — we just log and (for request-style
 * messages) reply with an accepted=false payload.
 */
export class IdeActions {

	private terminals = new Map<string, vscode.Terminal>();

	constructor(private readonly client: AgentClient) { }

	register(): vscode.Disposable {
		return this.client.onMessage(msg => this.route(msg));
	}

	private route(msg: ProtocolMessage) {
		switch (msg.type) {
			case 'edit_file': this.onEditFile(msg).catch(e => this.reject(msg, e)); break;
			case 'open_file': this.onOpenFile(msg).catch(e => logger.warn('open_file failed', (e as Error).message)); break;
			case 'run_terminal': this.onRunTerminal(msg); break;
			case 'show_diff': this.onShowDiff(msg).catch(e => logger.warn('show_diff failed', (e as Error).message)); break;
			case 'tool_approval_request': this.onToolApproval(msg).catch(e => this.replyApproval(msg, { approved: false, reason: e.message })); break;
			default: break;
		}
	}

	// ────────────── tool_approval_request ──────────────

	private async onToolApproval(msg: ProtocolMessage) {
		const p = (msg.payload || {}) as ToolApprovalPayload;
		const tool = p.tool || 'unknown';
		const risk = p.risk || 'caution';
		const preview = (p.preview || '').slice(0, 4000);

		// Bypass mode: auto-approve everything.
		const cfg = vscode.workspace.getConfiguration('genericAgent');
		if (cfg.get<boolean>('permission.bypassMode', false)) {
			return this.replyApproval(msg, { approved: true, reason: 'bypass-mode' });
		}

		// Prefer Cursor-style inline card in the chat panel. Fall back to a
		// native modal if the chat panel is not currently open.
		const panel = ChatPanel.current;
		if (panel) {
			const decision = await panel.requestToolApproval({ tool, risk, args: p.args, preview });
			if (decision.bypass_session) {
				try {
					await cfg.update('permission.bypassMode', true, vscode.ConfigurationTarget.Workspace);
				} catch (e) {
					logger.warn('failed to persist bypassMode', (e as Error).message);
				}
			}
			return this.replyApproval(msg, decision);
		}

		const riskLabel = risk === 'danger' ? '⛔ 高风险' : risk === 'caution' ? '⚠️ 中风险' : '✅ 低风险';
		const detail = preview || JSON.stringify(p.args || {}, null, 2).slice(0, 1500);
		const choice = await vscode.window.showWarningMessage(
			`${riskLabel} — Agent 请求执行 ${tool}`,
			{ modal: true, detail },
			'允许',
			'拒绝',
			'本会话全部允许 (Bypass)',
		);
		if (choice === '允许') {
			return this.replyApproval(msg, { approved: true });
		}
		if (choice === '本会话全部允许 (Bypass)') {
			return this.replyApproval(msg, { approved: true, bypass_session: true, reason: 'bypass-session' });
		}
		return this.replyApproval(msg, { approved: false, reason: '用户拒绝执行' });
	}

	private replyApproval(msg: ProtocolMessage, payload: object) {
		if (!msg.id) { return; }
		this.client.send({ type: 'tool_approval_response', id: msg.id, payload });
	}

	// ────────────── edit_file ──────────────

	private async onEditFile(msg: ProtocolMessage) {
		const p = (msg.payload || {}) as EditFilePayload;
		if (!p.path || typeof p.new_content !== 'string') {
			return this.reject(msg, new Error('edit_file: missing path or new_content'));
		}
		const abs = toAbsolute(p.path);
		logger.info('edit_file', { path: abs, mode: p.mode, bytes: p.new_content.length });

		// Build the target content according to mode (backend sends full content
		// for 'overwrite'; for prepend/append we combine with existing on disk).
		let oldContent = '';
		try { oldContent = (await vscode.workspace.fs.readFile(vscode.Uri.file(abs))).toString(); }
		catch { /* file may not exist yet — that's fine for overwrite/append */ }

		let finalContent: string;
		switch (p.mode) {
			case 'append':  finalContent = oldContent + p.new_content; break;
			case 'prepend': finalContent = p.new_content + oldContent; break;
			default:        finalContent = p.new_content; break;
		}

		// Show a diff view (read-only preview) then ask user to accept.
		const accepted = await showDiffAndConfirm(abs, oldContent, finalContent, p.reason || 'Agent edit');
		if (!accepted) {
			return this.reply(msg, { accepted: false, reason: '用户拒绝了修改' });
		}

		// Apply the edit via WorkspaceEdit so it participates in undo / dirty state.
		const uri = vscode.Uri.file(abs);
		const edit = new vscode.WorkspaceEdit();
		if (oldContent) {
			// Replace entire file contents.
			const doc = await vscode.workspace.openTextDocument(uri);
			const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
			edit.replace(uri, fullRange, finalContent);
		} else {
			edit.createFile(uri, { overwrite: true, contents: Buffer.from(finalContent, 'utf8') });
		}
		const ok = await vscode.workspace.applyEdit(edit);
		if (!ok) {
			return this.reply(msg, { accepted: false, reason: 'applyEdit returned false' });
		}
		// Save so the file actually lands on disk (agent expects this).
		try {
			const doc = await vscode.workspace.openTextDocument(uri);
			await doc.save();
		} catch (e) {
			logger.warn('save after applyEdit failed', (e as Error).message);
		}

		this.reply(msg, { accepted: true, final_content: finalContent });
	}

	private reject(msg: ProtocolMessage, err: Error) {
		logger.warn(`edit_file rejected: ${err.message}`);
		this.reply(msg, { accepted: false, reason: err.message });
	}

	private reply(msg: ProtocolMessage, payload: object) {
		if (!msg.id) { return; }
		this.client.send({ type: 'apply_edit_result', id: msg.id, payload });
	}

	// ────────────── open_file ──────────────

	private async onOpenFile(msg: ProtocolMessage) {
		const p = (msg.payload || {}) as OpenFilePayload;
		if (!p.path) { return; }
		const uri = vscode.Uri.file(toAbsolute(p.path));
		const opts: vscode.TextDocumentShowOptions = { preview: !!p.preview };
		if (typeof p.line === 'number') {
			const line = Math.max(0, (p.line | 0) - 1);
			const col = Math.max(0, ((p.column ?? 0) | 0));
			opts.selection = new vscode.Range(line, col, line, col);
		}
		await vscode.window.showTextDocument(uri, opts);
	}

	// ────────────── run_terminal ──────────────

	private onRunTerminal(msg: ProtocolMessage) {
		const p = (msg.payload || {}) as RunTerminalPayload;
		if (!p.cmd) { return; }
		const name = p.name || 'GenericAgent';
		let term = this.terminals.get(name);
		if (!term || (term as vscode.Terminal).exitStatus !== undefined) {
			term = vscode.window.createTerminal({ name, cwd: p.cwd });
			this.terminals.set(name, term);
		}
		term.show(true);
		term.sendText(p.cmd, true);
		logger.info('run_terminal dispatched', { name, cmd: p.cmd, cwd: p.cwd });
	}

	// ────────────── show_diff ──────────────

	private async onShowDiff(msg: ProtocolMessage) {
		const p = (msg.payload || {}) as ShowDiffPayload;
		if (!p.left_path || typeof p.right_content !== 'string') { return; }
		const left = vscode.Uri.file(toAbsolute(p.left_path));
		const right = await writeEphemeral(p.right_content, `show_diff_${Date.now()}.tmp`);
		await vscode.commands.executeCommand('vscode.diff', left, right, `GenericAgent: ${path(p.left_path)}`);
	}

	dispose() {
		for (const t of this.terminals.values()) {
			try { t.dispose(); } catch { /* noop */ }
		}
		this.terminals.clear();
	}
}

// ───────── payload shapes (kept in one place for easy audit) ─────────

interface EditFilePayload {
	path: string;
	new_content: string;
	mode?: 'overwrite' | 'append' | 'prepend';
	reason?: string;
}

interface OpenFilePayload {
	path: string;
	line?: number;
	column?: number;
	preview?: boolean;
}

interface RunTerminalPayload {
	cmd: string;
	cwd?: string;
	name?: string;
}

interface ShowDiffPayload {
	left_path: string;
	right_content: string;
}

interface ToolApprovalPayload {
	tool: string;
	risk: 'safe' | 'caution' | 'danger';
	args?: Record<string, unknown>;
	preview?: string;
}

// ───────── helpers ─────────

function toAbsolute(p: string): string {
	if (require('path').isAbsolute(p)) { return p; }
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	return root ? require('path').join(root, p) : p;
}

function path(p: string): string {
	return require('path').basename(p);
}

async function writeEphemeral(content: string, name: string): Promise<vscode.Uri> {
	const dir = vscode.Uri.file(require('os').tmpdir());
	const uri = vscode.Uri.joinPath(dir, name);
	await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
	return uri;
}

/**
 * Show a diff view comparing old vs new content and ask the user to accept.
 * Returns true on accept, false on reject/cancel.
 */
async function showDiffAndConfirm(
	absPath: string,
	oldContent: string,
	newContent: string,
	reason: string,
): Promise<boolean> {
	const fileName = require('path').basename(absPath);
	const leftUri = await writeEphemeral(oldContent, `agent-old-${Date.now()}-${fileName}`);
	const rightUri = await writeEphemeral(newContent, `agent-new-${Date.now()}-${fileName}`);
	await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri,
		`GenericAgent: ${fileName} (${reason})`);
	const pick = await vscode.window.showInformationMessage(
		`Apply GenericAgent edit to ${fileName}?\n${reason}`,
		{ modal: true },
		'Apply', 'Reject',
	);
	return pick === 'Apply';
}
