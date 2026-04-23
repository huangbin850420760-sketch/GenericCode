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

const EXT_PROTO_VERSION = 1;
const EXT_FEATURES = [
	'edit_file',
	'open_file',
	'run_terminal',
	'context_push',
	'diff_preview',
	'show_diff',
];

export class AgentClient implements vscode.Disposable {
	private ws?: WebSocket;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private backoffMs = 1000;
	private disposed = false;
	private readonly handlers = new Set<MessageHandler>();
	private readonly _onAck = new vscode.EventEmitter<HelloAck>();

	/** Fires once after a successful handshake with the backend. */
	readonly onHelloAck = this._onAck.event;

	/** Latest negotiated server capabilities. Undefined until handshake completes. */
	public ack?: HelloAck;

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

	dispose(): void {
		this.disposed = true;
		if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); }
		try { this.ws?.close(); } catch { /* noop */ }
		this._onAck.dispose();
		this.handlers.clear();
	}
}
