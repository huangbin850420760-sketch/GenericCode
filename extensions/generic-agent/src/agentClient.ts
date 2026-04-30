import * as vscode from 'vscode';
import WebSocket from 'ws';
import { logger } from './logger';

/**
 * Side-channel WebSocket client from the extension host to agent-core.
 *
 * The main chat UI (webview iframe) has its OWN WebSocket connection directly
 * to the Python backend — this client is a separate connection used ONLY for
 * IDE-side-effect messages (edit_file, run_terminal, open_file, context push).
 *
 * The server distinguishes the two by inspecting the `hello.payload.client`
 * field; only connections tagged as 'genericcode-ext' receive IDE actions.
 */

export interface ProtocolMessage {
	type: string;
	id?: string;
	payload?: unknown;
}

export type MessageHandler = (msg: ProtocolMessage) => void;

export interface HelloAck {
	server: string;
	version: string;
	proto: number;
	features: string[];
	llm?: string;
}

export interface StreamEvent {
	delta: string;
	full: string;
}

export interface StatusPayload {
	llm?: string;
	llms?: { idx: number; name: string; current: boolean }[];
	running?: boolean;
	last_reply_time?: number;
	autonomous_enabled?: boolean;
	[k: string]: unknown;
}

const EXT_PROTO_VERSION = 1;
const EXT_FEATURES = [
	'edit_file',
	'open_file',
	'run_terminal',
	'context_push',
	'diff_preview',
	'show_diff',
	'tool_approval',
];

export class AgentClient implements vscode.Disposable {
	private ws?: WebSocket;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private backoffMs = 1000;
	private disposed = false;
	private readonly handlers = new Set<MessageHandler>();
	private readonly _onAck = new vscode.EventEmitter<HelloAck>();
	private readonly _onStream = new vscode.EventEmitter<StreamEvent>();
	private readonly _onDone = new vscode.EventEmitter<string>();
	private readonly _onInfo = new vscode.EventEmitter<string>();
	private readonly _onError = new vscode.EventEmitter<string>();
	private readonly _onStatus = new vscode.EventEmitter<StatusPayload>();
	private readonly _onAutoUser = new vscode.EventEmitter<string>();

	/** Fires once after a successful handshake with the backend. */
	readonly onHelloAck = this._onAck.event;
	/** Streaming assistant text: incremental delta + full snapshot so far. */
	readonly onStream = this._onStream.event;
	/** Task finished; payload is the final assistant message / reason. */
	readonly onDone = this._onDone.event;
	/** Informational toast (e.g. "⏹ 已停止", "已重新注入 N 条工具示范"). */
	readonly onInfo = this._onInfo.event;
	/** Backend-reported error string. */
	readonly onError = this._onError.event;
	/** Backend status snapshot (llm name, running flag, LLM list, ...). */
	readonly onStatus = this._onStatus.event;
	/** Synthetic user message broadcast by autonomous trigger (idle / manual). */
	readonly onAutoUser = this._onAutoUser.event;

	/** Latest negotiated server capabilities. Undefined until handshake completes. */
	public ack?: HelloAck;
	/** Latest status broadcast from the backend. */
	public status?: StatusPayload;

	/**
	 * Tag identifying who owns the current in-flight turn.  `'chat'` means
	 * the user-facing chat panel, `'inline'` means a Cmd+I / `editWithAgent`
	 * invocation whose streaming output should NOT be rendered in the chat.
	 * Cleared to `null` on `done` / `error`.
	 *
	 * This is purely an extension-side flag — agent-core doesn't know about
	 * it — so we rely on one task being in flight at a time (which is how
	 * the backend already behaves).
	 */
	public currentSource: 'chat' | 'inline' | null = null;

	constructor(private readonly wsUrl: string, private readonly extensionVersion: string) { }

	connect(): void {
		if (this.disposed) { return; }
		logger.info('connecting to agent', { wsUrl: this.wsUrl });
		const ws = new WebSocket(this.wsUrl);
		this.ws = ws;

		ws.on('open', () => {
			this.backoffMs = 1000;
			logger.info('ws open — sending hello');
			this.send({
				type: 'hello',
				payload: {
					client: 'genericcode-ext',
					version: this.extensionVersion,
					proto: EXT_PROTO_VERSION,
					features: EXT_FEATURES,
				},
			});
		});

		ws.on('message', raw => {
			let msg: ProtocolMessage;
			try { msg = JSON.parse(raw.toString('utf8')); }
			catch (e) {
				logger.warn('ws parse error', (e as Error).message);
				return;
			}
			if (msg.type === 'hello_ack') {
				this.ack = msg.payload as HelloAck;
				logger.info('handshake complete', this.ack);
				this._onAck.fire(this.ack);
				return;
			}
			// Fan out common backend events to typed emitters so subscribers
			// don't have to parse `msg.type` themselves.  The raw handler set
			// is still notified below for callers that need wire-level access
			// (e.g. the IDE-action bridge pattern-matches on `type` itself).
			switch (msg.type) {
				case 'stream':
					this._onStream.fire({
						delta: String((msg as { delta?: unknown }).delta ?? ''),
						full: String((msg as { full?: unknown }).full ?? ''),
					});
					break;
				case 'done':
					this._onDone.fire(String(msg.payload ?? ''));
					this.currentSource = null;
					break;
				case 'info':
					this._onInfo.fire(String(msg.payload ?? ''));
					break;
				case 'error':
					this._onError.fire(String(msg.payload ?? ''));
					this.currentSource = null;
					break;
				case 'status':
					this.status = msg.payload as StatusPayload;
					this._onStatus.fire(this.status);
					break;
				case 'auto_user':
					// Autonomous task fired — backend wants every UI to show this
					// synthetic user message and prepare an assistant placeholder.
					this._onAutoUser.fire(String(msg.payload ?? ''));
					break;
				case 'ping':
					// keepalive; ignore
					break;
			}
			for (const h of this.handlers) {
				try { h(msg); }
				catch (e) { logger.error('handler threw', (e as Error).message); }
			}
		});

		ws.on('close', (code, reason) => {
			logger.warn('ws closed', { code, reason: reason.toString() });
			this.scheduleReconnect();
		});

		ws.on('error', err => {
			logger.warn('ws error', err.message);
			// 'close' will follow; reconnect is handled there.
		});
	}

	private scheduleReconnect() {
		if (this.disposed) { return; }
		const delay = Math.min(this.backoffMs, 16000);
		this.backoffMs = Math.min(this.backoffMs * 2, 16000);
		logger.info(`reconnecting in ${delay}ms`);
		this.reconnectTimer = setTimeout(() => this.connect(), delay);
	}

	send(msg: ProtocolMessage): boolean {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			logger.debug('ws not open — dropping', { type: msg.type });
			return false;
		}
		this.ws.send(JSON.stringify(msg));
		return true;
	}

	onMessage(handler: MessageHandler): vscode.Disposable {
		this.handlers.add(handler);
		return { dispose: () => this.handlers.delete(handler) };
	}

	hasFeature(name: string): boolean {
		return this.ack?.features?.includes(name) ?? false;
	}

	// ─── Chat convenience API ─────────────────────────────────────────────
	// These are thin wrappers over `send()` that encode the task/abort/reset
	// protocol used by webapp.py (see ChatWS.handle).  Kept as methods — not
	// re-exported free functions — so we don't have to thread `AgentClient`
	// references through the chat UI wiring.

	/** Dispatch a user message.  `files` are absolute paths; `images` are
	 *  data-URL blobs (left as `unknown` since M3 doesn't support attachments
	 *  yet).  `source` tags the turn for subscriber-side filtering — see
	 *  `currentSource`.  Returns `true` if the WS write was attempted. */
	sendTask(
		text: string,
		opts?: { files?: string[]; images?: unknown[]; source?: 'chat' | 'inline' },
	): boolean {
		this.currentSource = opts?.source ?? 'chat';
		return this.send({
			type: 'task',
			payload: {
				text,
				files: opts?.files ?? [],
				images: opts?.images ?? [],
			},
		});
	}

	/** Request the backend to cancel the in-flight task. */
	sendAbort(): boolean {
		const ok = this.send({ type: 'abort' });
		// Clear the source optimistically; a `done` event will follow but we
		// don't want races where a second sendTask arrives while source is
		// still set to the aborted turn's tag.
		this.currentSource = null;
		return ok;
	}

	/** Wipe conversation history on the backend. */
	sendReset(): boolean {
		return this.send({ type: 'reset' });
	}

	/** Ask the backend to re-broadcast its current status. */
	requestStatus(): boolean {
		return this.send({ type: 'status' });
	}

	/** Switch the active LLM by index, or pass `-1` to cycle to the next.
	 *  Mirrors webapp.py `next_llm` message; backend re-broadcasts status. */
	sendNextLlm(idx: number): boolean {
		return this.send({ type: 'next_llm', payload: idx });
	}

	/** Trigger a sidebar-style action on the backend (e.g. `reinject_tools`,
	 *  `desktop_pet`, `idle_trigger`, `autonomous_toggle`).  See webapp.py
	 *  `_do_action` for the full set. */
	sendAction(name: string): boolean {
		return this.send({ type: 'action', payload: { name } });
	}

	dispose(): void {
		this.disposed = true;
		if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); }
		try { this.ws?.close(); } catch { /* noop */ }
		this._onAck.dispose();
		this._onStream.dispose();
		this._onDone.dispose();
		this._onInfo.dispose();
		this._onError.dispose();
		this._onStatus.dispose();
		this._onAutoUser.dispose();
		this.handlers.clear();
	}
}
