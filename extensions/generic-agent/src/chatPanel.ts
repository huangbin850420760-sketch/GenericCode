import * as vscode from 'vscode';
import * as fs from 'fs';
import * as nodePath from 'path';
import { logger } from './logger';
import { AgentClient, StatusPayload } from './agentClient';
import { BotKind, BotProcessManager } from './botProcessManager';

const BOT_KINDS = new Set<string>(['tg', 'qq', 'feishu', 'wecom', 'dingtalk', 'wechat']);
const SOPHUB_BASE = 'https://fudankw.cn/sophub';
const SOPHUB_KEY = 'genericAgent.sophubApiKey';

function isBotKind(value: string): value is BotKind {
	return BOT_KINDS.has(value);
}

/**
 * Editor-area WebviewPanel hosting a native chat UI.
 *
 * M3 design: we no longer iframe webapp.py.  The webview renders its own
 * minimal vanilla-JS chat UI (no React, no bundler) and communicates with
 * the extension host over `postMessage`.  The extension host, in turn,
 * already owns a single WebSocket to the Python backend via `AgentClient`,
 * so all IDE-action routing, handshake state and reconnection logic lives
 * in one place.  The webview is trusted content that we control.
 *
 * Singleton: reveal the existing panel instead of spawning duplicates.
 *
 * Protocol (webview ⇄ extension, via postMessage):
 *   ext → webview:
 *     { kind: 'reset' }                              // clear rendered history
 *     { kind: 'stream', delta, full }                // streaming assistant text
 *     { kind: 'done', payload }                      // turn finished
 *     { kind: 'info' | 'error', text }               // toast / banner
 *     { kind: 'status', status: StatusPayload }      // LLM name, running flag
 *   webview → ext:
 *     { kind: 'send', text }                         // user submitted a message
 *     { kind: 'abort' }
 *     { kind: 'reset' }
 *     { kind: 'ready' }                              // sent once on load
 */
export class ChatPanel {
	public static readonly viewType = 'genericAgent.chatPanel';
	static current?: ChatPanel;

	private readonly panel: vscode.WebviewPanel;
	private readonly ctx: vscode.ExtensionContext;
	private readonly httpPort: number;
	private botMgr?: BotProcessManager;
	private disposables: vscode.Disposable[] = [];

	public static createOrShow(extensionUri: vscode.Uri, client: AgentClient, httpPort: number, botMgr?: BotProcessManager, ctx?: vscode.ExtensionContext): void {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

		if (ChatPanel.current) {
			ChatPanel.current.botMgr = botMgr;
			ChatPanel.current.panel.reveal(column);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			ChatPanel.viewType,
			'GenericAgent',
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
			},
		);

		ChatPanel.current = new ChatPanel(panel, client, httpPort, botMgr, ctx);
	}

	private constructor(panel: vscode.WebviewPanel, client: AgentClient, httpPort: number, botMgr?: BotProcessManager, ctx?: vscode.ExtensionContext) {
		this.httpPort = httpPort;
		this.panel = panel;
		this.ctx = ctx ?? (botMgr as unknown as { context?: vscode.ExtensionContext })?.context ?? ({} as vscode.ExtensionContext);
		this.botMgr = botMgr;
		this.panel.webview.html = this.html();

		// ─── webview → extension ─────────────────────────────────────────
		panel.webview.onDidReceiveMessage((msg: {
			kind?: string;
			text?: string;
			code?: string;
			lang?: string;
			filename?: string;
			q?: string;
			seq?: number;
			mentions?: { rel: string; abs: string }[];
			// HTTP proxy fields (kind === 'apiCall')
			requestId?: string;
			method?: string;
			url?: string;
			body?: unknown;
			title?: string;
			content?: string;
			language?: string;
			sopName?: string;
		}) => {
			logger.debug('chat panel ← webview', { kind: msg?.kind });
			switch (msg?.kind) {
				case 'ready':
					// Webview just loaded / reloaded — push the latest known
					// status so the header isn't blank.
					if (client.status) {
						this.post({ kind: 'status', status: client.status });
					}
					client.requestStatus();
					break;
				case 'send':
					if (msg.text && msg.text.trim()) {
						const files = resolveMentionPaths(msg.mentions);
						client.sendTask(msg.text, { files });
					}
					break;
				case 'abort':
					client.sendAbort();
					break;
				case 'reset':
					client.sendReset();
					this.post({ kind: 'reset' });
					break;
				case 'apply':
					void this.handleApply(msg.code || '', msg.filename || '', msg.lang || '');
					break;
				case 'files_query':
					void this.handleFilesQuery(msg.q ?? '', msg.seq ?? 0);
					break;
				case 'apiCall':
					void this.handleApiCall(
						String(msg.requestId || ''),
						String(msg.method || 'GET').toUpperCase(),
						String(msg.url || ''),
						msg.body,
					);
					break;
				case 'next_llm':
					// idx === -1 cycles to next; otherwise selects by index.
					client.sendNextLlm(typeof (msg as { idx?: unknown }).idx === 'number' ? (msg as { idx: number }).idx : -1);
					break;
				case 'action':
					// Generic sidebar action passthrough (reinject_tools,
					// desktop_pet, idle_trigger, autonomous_toggle, ...).
					if ((msg as { name?: unknown }).name) {
						client.sendAction(String((msg as { name: string }).name));
					}
					break;
				case 'open_settings':
					// Bridge into VS Code's native Settings UI, pre-filtered
					// to the GenericAgent namespace.  This is the canonical
					// home for every option (request P4) and visually keeps
					// the user inside VS Code rather than a custom panel.
					void vscode.commands.executeCommand(
						'workbench.action.openSettings',
						'genericAgent',
					);
					break;
				case 'bot_status':
					this.post({ kind: 'bot_status', bots: this.botMgr?.status() || [], available: !!this.botMgr });
					break;
				case 'bot_start':
					void this.handleBotStart(String((msg as { bot?: unknown }).bot || ''));
					break;
				case 'bot_stop':
					this.handleBotStop(String((msg as { bot?: unknown }).bot || ''));
					break;
				case 'open_virtual_document':
					void this.openVirtualDocument(
						String(msg.title || 'GenericAgent'),
						String(msg.content || ''),
						String(msg.language || 'markdown'),
					);
					break;
				case 'open_sop_source':
					void this.openSopSource(String(msg.sopName || ''));
					break;
				case 'sophub': {
					const m = msg as { requestId?: string; op?: string; payload?: Record<string, unknown> };
					void this.handleSophub(
						String(m.requestId || ''),
						String(m.op || ''),
						(m.payload || {}) as Record<string, unknown>,
					);
					break;
				}
				case 'pick_files': {
					// Open the native VS Code file picker and return the
					// selected absolute paths to the webview so it can show
					// chips and inject @-tokens into the textarea.  Using
					// the real picker (not <input type=file>) means we get
					// actual filesystem paths rather than synthetic blobs,
					// which the agent backend can read directly.
					const reqId = String((msg as { requestId?: unknown }).requestId || '');
					const opts: vscode.OpenDialogOptions = {
						canSelectFiles: true,
						canSelectFolders: false,
						canSelectMany: true,
						openLabel: 'Attach',
					};
					if ((msg as { imagesOnly?: unknown }).imagesOnly) {
						opts.filters = { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] };
					}
					void vscode.window.showOpenDialog(opts).then(uris => {
						const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
						const out = (uris || []).map(u => {
							const abs = u.fsPath;
							const rel = wsRoot && abs.startsWith(wsRoot)
								? abs.slice(wsRoot.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
								: abs;
							return { abs, rel, name: rel.split('/').pop() || rel };
						});
						this.post({ kind: 'pick_files_result', requestId: reqId, files: out });
					});
					break;
				}
			}
		}, null, this.disposables);

		// ─── agent-core → webview ────────────────────────────────────────
		// We filter on `client.currentSource` so streaming output from an
		// inline-edit (Cmd+I) turn doesn't bleed into the chat transcript.
		// The source is cleared BEFORE `onDone` / `onError` fire on the
		// client side (see AgentClient), so we snapshot it right before the
		// respective emitter runs — here we just check "is this still chat?"
		// which, because events fire synchronously during message dispatch,
		// reflects the source at the moment the event was produced.
		const isChatTurn = () => client.currentSource === 'chat' || client.currentSource === null;
		this.disposables.push(
			client.onStream(ev => {
				if (client.currentSource !== 'chat') { return; }
				this.post({ kind: 'stream', delta: ev.delta, full: ev.full });
			}),
			client.onDone(payload => {
				// `currentSource` has just been reset to null by AgentClient,
				// so we use the loose check that tolerates null.
				if (!isChatTurn()) { return; }
				this.post({ kind: 'done', payload });
			}),
			client.onInfo(text => this.post({ kind: 'info', text })),
			client.onError(text => {
				if (!isChatTurn()) { return; }
				this.post({ kind: 'error', text });
			}),
			client.onStatus((status: StatusPayload) => this.post({ kind: 'status', status })),
			client.onAutoUser(text => this.post({ kind: 'auto_user', text })),
		);

		// Live-update the panel when the user edits genericAgent.* in
		// VS Code Settings — pushes a 'prefs' message so language /
		// theme / shortcut changes take effect without a panel reload.
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (!e.affectsConfiguration('genericAgent')) { return; }
				const cfg = vscode.workspace.getConfiguration('genericAgent');
				// Explicitly default to 'zh' to match package.json default
				const lang = cfg.get<string>('language');
				this.post({
					kind: 'prefs',
					prefs: {
						language: (lang === 'en') ? 'en' : 'zh',
						theme: cfg.get<string>('theme', 'auto'),
						collapseThinking: cfg.get<boolean>('collapseThinking', true),
						flattenSingleTurn: cfg.get<boolean>('flattenSingleTurn', true),
						sendShortcut: cfg.get<string>('sendShortcut', 'enter'),
					},
				});
			}),
		);

		panel.onDidDispose(() => this.dispose(), null, this.disposables);
	}

	private post(msg: unknown): void {
		void this.panel.webview.postMessage(msg);
	}

	/**
	 * Proxy HTTP calls from the webview to the local backend.
	 *
	 * Webview ↔ ext bridge avoids CORS: webviews run under
	 * `vscode-webview://` origin, but the bottle backend doesn't emit
	 * CORS headers, so direct fetch from the webview is blocked.  Routing
	 * through the extension host (a Node process) sidesteps that entirely
	 * and keeps the backend untouched.
	 *
	 * URL must start with `/api/`; absolute URLs and non-loopback hosts
	 * are rejected as a defensive measure.
	 */
	private async handleApiCall(requestId: string, method: string, url: string, body: unknown): Promise<void> {
		if (!requestId || !url.startsWith('/api/')) {
			this.post({ kind: 'apiResult', requestId, error: 'Invalid api url' });
			return;
		}
		const target = `http://127.0.0.1:${this.httpPort}${url}`;
		try {
			const init: RequestInit = { method };
			if (method !== 'GET' && method !== 'HEAD') {
				init.headers = { 'Content-Type': 'application/json' };
				init.body = JSON.stringify(body ?? {});
			}
			const r = await fetch(target, init);
			const text = await r.text();
			let data: unknown;
			try { data = text ? JSON.parse(text) : null; }
			catch { data = text; }
			if (!r.ok) {
				this.post({ kind: 'apiResult', requestId, error: `HTTP ${r.status}: ${text.slice(0, 200)}` });
				return;
			}
			this.post({ kind: 'apiResult', requestId, data });
		} catch (e) {
			this.post({ kind: 'apiResult', requestId, error: (e as Error).message });
		}
	}

	private async openVirtualDocument(_title: string, content: string, language: string): Promise<void> {
		const doc = await vscode.workspace.openTextDocument({
			content,
			language,
		});
		await vscode.window.showTextDocument(doc, {
			preview: true,
			viewColumn: vscode.ViewColumn.Active,
		});
	}

	private async openSopSource(name: string): Promise<void> {
		const file = resolveSopSource(name);
		if (!file) {
			vscode.window.showWarningMessage(`GenericAgent: SOP 源文件不存在: ${name}`);
			return;
		}
		const confirm = await vscode.window.showWarningMessage(
			`将打开可编辑源文件：${file}`,
			{ modal: true },
			'继续编辑',
		);
		if (confirm !== '继续编辑') { return; }
		const source = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
		await vscode.window.showTextDocument(source, { preview: false, viewColumn: vscode.ViewColumn.Active });
	}

	// ── Sophub marketplace ────────────────────────────────────────────
	// All HTTP calls to https://fudankw.cn/sophub are proxied through the
	// extension host so the API key stays in VS Code SecretStorage and
	// out of the webview.  The webview sends `{kind:'sophub', op, ...}`
	// and receives `{kind:'sophubResult', requestId, data|error}`.
	private async sophubKey(autoRegister: boolean): Promise<string | undefined> {
		const secrets = this.ctx?.secrets;
		if (!secrets) { return undefined; }
		let key = await secrets.get(SOPHUB_KEY);
		if (key || !autoRegister) { return key; }
		const displayName = (vscode.workspace.workspaceFolders?.[0]?.name) || 'GenericAgent';
		const r = await this.sophubFetch('POST', '/api/agents/register', undefined, {
			display_name: `${displayName} (VSCode)`,
		});
		const data = r.data as { api_key?: string; claim_code?: string } | undefined;
		if (!data?.api_key) { throw new Error('Sophub register failed'); }
		key = data.api_key;
		await secrets.store(SOPHUB_KEY, key);
		if (data.claim_code) {
			void vscode.window.showInformationMessage(
				`Sophub claim_code: ${data.claim_code} (用于 fudankw.cn /me/agents 认领)`,
				{ modal: false },
			);
		}
		return key;
	}

	private async sophubFetch(
		method: string, path: string, key: string | undefined, body?: unknown,
	): Promise<{ status: number; data: unknown; text: string }> {
		const url = SOPHUB_BASE + path;
		const headers: Record<string, string> = { 'Accept': 'application/json' };
		if (key) { headers['Authorization'] = `Bearer ${key}`; }
		const init: RequestInit = { method, headers };
		if (method !== 'GET' && method !== 'HEAD') {
			headers['Content-Type'] = 'application/json';
			init.body = JSON.stringify(body ?? {});
		}
		const r = await fetch(url, init);
		const text = await r.text();
		let data: unknown = text;
		try { data = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
		return { status: r.status, data, text };
	}

	private async pickSopWriteDir(): Promise<string | undefined> {
		const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
		for (const r of roots) {
			const p = nodePath.join(nodePath.dirname(r), 'GenericAgent', 'memory');
			if (fs.existsSync(p)) { return p; }
		}
		for (const r of roots) {
			const p = nodePath.join(r, 'memory');
			if (fs.existsSync(p)) { return p; }
		}
		// Fallback: create memory/ under first workspace root
		if (roots.length) {
			const p = nodePath.join(roots[0], 'memory');
			try { fs.mkdirSync(p, { recursive: true }); return p; } catch { return undefined; }
		}
		return undefined;
	}

	private sanitizeSopFilename(title: string, fileType: string): string {
		const base = String(title || 'sop').trim().replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'sop';
		const ext = fileType === 'python' ? '.py' : '.md';
		return base.endsWith(ext) ? base : base + ext;
	}

	private async handleSophub(requestId: string, op: string, payload: Record<string, unknown>): Promise<void> {
		const reply = (data?: unknown, error?: string): void => {
			this.post({ kind: 'sophubResult', requestId, data, error });
		};
		try {
			if (!this.ctx?.secrets) {
				reply(undefined, 'SecretStorage unavailable');
				return;
			}
			if (op === 'keyStatus') {
				const key = await this.ctx.secrets.get(SOPHUB_KEY);
				reply({ hasKey: !!key });
				return;
			}
			if (op === 'clearKey') {
				await this.ctx.secrets.delete(SOPHUB_KEY);
				reply({ ok: true });
				return;
			}
			if (op === 'search') {
				const key = await this.sophubKey(true);
				const q = encodeURIComponent(String(payload.q || ''));
				const page = Number(payload.page || 1);
				const ps = Number(payload.page_size || 24);
				const r = await this.sophubFetch('GET', `/api/sops?q=${q}&page=${page}&page_size=${ps}`, key);
				if (r.status >= 400) { reply(undefined, `HTTP ${r.status}: ${r.text.slice(0, 200)}`); return; }
				reply(r.data);
				return;
			}
			if (op === 'get') {
				const key = await this.sophubKey(true);
				const id = encodeURIComponent(String(payload.id || ''));
				const r = await this.sophubFetch('GET', `/api/sops/${id}`, key);
				if (r.status >= 400) { reply(undefined, `HTTP ${r.status}: ${r.text.slice(0, 200)}`); return; }
				reply(r.data);
				return;
			}
			if (op === 'upload') {
				const key = await this.sophubKey(true);
				const sopName = String(payload.sopName || '');
				const file = resolveSopSource(sopName);
				if (!file) { reply(undefined, `本地 SOP 不存在: ${sopName}`); return; }
				const content = fs.readFileSync(file, 'utf8');
				if (!content.trim()) { reply(undefined, '文件为空，拒绝上传'); return; }
				if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) {
					reply(undefined, '内容超过 1MB');
					return;
				}
				const title = String(payload.title || sopName.replace(/\.md$/i, ''));
				const r = await this.sophubFetch('POST', '/api/sops', key, {
					title: title.slice(0, 200),
					content,
					file_type: 'markdown',
				});
				if (r.status >= 400) { reply(undefined, `HTTP ${r.status}: ${r.text.slice(0, 200)}`); return; }
				reply(r.data);
				return;
			}
			if (op === 'download') {
				const key = await this.sophubKey(true);
				const id = String(payload.id || '');
				const r = await this.sophubFetch('GET', `/api/sops/${encodeURIComponent(id)}`, key);
				if (r.status >= 400) { reply(undefined, `HTTP ${r.status}: ${r.text.slice(0, 200)}`); return; }
				const sop = r.data as { title?: string; content?: string; file_type?: string } | undefined;
				if (!sop || typeof sop.content !== 'string') { reply(undefined, '响应缺少 content'); return; }
				const dir = await this.pickSopWriteDir();
				if (!dir) { reply(undefined, '未找到 memory/ 目录'); return; }
				const requested = String(payload.filename || '').trim();
				const filename = requested
					? this.sanitizeSopFilename(requested.replace(/\.(md|py)$/i, ''), sop.file_type || 'markdown')
					: this.sanitizeSopFilename(sop.title || 'sop', sop.file_type || 'markdown');
				const target = nodePath.join(dir, filename);
				if (fs.existsSync(target) && !payload.overwrite) {
					reply({ exists: true, target });
					return;
				}
				fs.writeFileSync(target, sop.content, 'utf8');
				reply({ ok: true, target, filename });
				return;
			}
			reply(undefined, `Unknown sophub op: ${op}`);
		} catch (e) {
			reply(undefined, (e as Error).message);
		}
	}

	private async handleBotStart(bot: string): Promise<void> {
		if (!this.botMgr || !isBotKind(bot)) {
			this.post({ kind: 'bot_error', error: 'Unknown bot: ' + bot });
			return;
		}
		try {
			await this.botMgr.start(bot, false);
			this.post({ kind: 'bot_status', bots: this.botMgr.status() });
		} catch (e) {
			this.post({ kind: 'bot_error', error: (e as Error).message });
			this.post({ kind: 'bot_status', bots: this.botMgr.status() });
		}
	}

	private handleBotStop(bot: string): void {
		if (!this.botMgr || !isBotKind(bot)) {
			this.post({ kind: 'bot_error', error: 'Unknown bot: ' + bot });
			return;
		}
		this.botMgr.stop(bot, false);
		this.post({ kind: 'bot_status', bots: this.botMgr.status() });
	}

	/**
	 * Apply a proposed code block to a file.  Opens a 3-way VSCode diff
	 * (current vs proposed), prompts Apply/Cancel, then overwrites the
	 * file via a single `WorkspaceEdit`.  Creates new files as needed.
	 */
	private async handleApply(code: string, filename: string, _lang: string): Promise<void> {
		if (!code) { return; }
		const target = await resolveApplyTarget(filename);
		if (!target) { return; }
		await applyCodeToFile(target.uri, code, target.isNew);
	}

	/**
	 * Answer a @-mention file query from the webview.  Uses
	 * `workspace.findFiles` with a permissive glob built from the query,
	 * trims the result down, and maps each hit to a relative/absolute pair
	 * the webview can round-trip on submit.
	 *
	 * Response shape:
	 *   { kind: 'files_result', seq, files: [{ rel, abs, name }, ...] }
	 */
	private async handleFilesQuery(q: string, seq: number): Promise<void> {
		const MAX = 15;
		// Exclude heavyweight / noisy directories that almost always
		// pollute workspace file listings.  The user can still type the
		// full path manually if they really want to.
		const exclude = '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/.vscode/**,**/.venv/**,**/__pycache__/**}';
		// Empty query: show the first N files at any depth.  Very-short
		// queries use a loose substring glob; longer ones anchor on the
		// substring to keep the noise low.
		const trimmed = q.trim();
		const include = trimmed
			? `**/*${trimmed.replace(/[\\/]/g, '/').replace(/[{}\[\]]/g, '')}*`
			: '**/*';

		let uris: vscode.Uri[] = [];
		try {
			uris = await vscode.workspace.findFiles(include, exclude, MAX * 3);
		} catch (e) {
			logger.warn('files_query failed', (e as Error).message);
		}

		const ws = vscode.workspace.workspaceFolders?.[0];
		const path = require('path') as typeof import('path');

		// Score: prefer paths where the query appears earlier in the
		// basename (classic substring-in-name wins over substring-in-path).
		const ql = trimmed.toLowerCase();
		const scored = uris.map(u => {
			const abs = u.fsPath;
			const rel = ws ? path.relative(ws.uri.fsPath, abs).replace(/\\/g, '/') : abs;
			const name = path.basename(abs);
			let score = 0;
			if (ql) {
				const n = name.toLowerCase();
				if (n === ql) { score = 1000; }
				else if (n.startsWith(ql)) { score = 500 - n.length; }
				else if (n.includes(ql)) { score = 300 - n.length; }
				else if (rel.toLowerCase().includes(ql)) { score = 100 - rel.length; }
			} else {
				score = -rel.length; // prefer shallow files when no query
			}
			return { rel, abs, name, score };
		});
		scored.sort((a, b) => b.score - a.score);
		const top = scored.slice(0, MAX).map(({ rel, abs, name }) => ({ rel, abs, name }));

		this.post({ kind: 'files_result', seq, files: top });
	}

	/**
	 * Load the compiled `assistantParser.js` and return a string of code
	 * safe to inline into the webview's `<script>` block.  The shipped
	 * bundle uses CommonJS `exports.x = ...`; we rewrite those into
	 * plain `var x = ...` so the functions become script-scope globals.
	 * Failures (unlikely — the file is emitted alongside `chatPanel.js`)
	 * fall back to a no-op stub so the webview still loads.
	 */
	private static loadAssistantParserSource(): string {
		try {
			const self = nodePath.join(__dirname, 'assistantParser.js');
			let src = fs.readFileSync(self, 'utf8');
			// Drop the CJS preamble — the webview isn't a module.
			src = src.replace(/^"use strict";\s*\n/, '');
			src = src.replace(
				/Object\.defineProperty\(exports, "__esModule", \{ value: true \}\);\s*\n/,
				'',
			);
			src = src.replace(/exports\.([A-Za-z_$][\w$]*) = \1;\s*\n/g, '');
			// Strip comments to reduce inlined size.
			src = src.replace(/\/\*[\s\S]*?\*\//g, '');
			src = src.replace(/^\s*\/\/.*$/gm, '');
			src = src.replace(/\s+\/\/.*$/gm, ' ');
			src = src.replace(/\n{3,}/g, '\n\n');
			return src;
		} catch (e) {
			logger.warn('failed to load assistantParser.js — falling back', (e as Error).message);
			return 'function parseAssistantSegments(raw){return raw?[{kind:"narrative",text:raw,key:"n:0"}]:[]}'
				+ 'function previewArgs(_n,a){return (a||"").slice(0,80);}';
		}
	}

	private html(): string {
		// Self-contained vanilla-JS chat UI.  Kept intentionally small so it's
		// easy to audit — no bundler, no external deps, no React.  Uses VSCode
		// theme CSS variables throughout for native feel in any theme.
		const nonce = getNonce();
		// httpPort now only used for diagnostic display; actual HTTP calls
		// are proxied through the extension host (see handleApiCall) to
		// avoid CORS — webviews live under vscode-webview:// origin but
		// the bottle backend emits no CORS headers.
		const httpPort = this.httpPort;
		const csp = [
			`default-src 'none'`,
			`style-src 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`,
			`img-src data:`,
		].join('; ');
		const parserSrc = ChatPanel.loadAssistantParserSource();
		// Pull user-configurable preferences from VS Code settings so the
		// webview can respect them on first paint — no flash of wrong
		// language / theme while waiting for a roundtrip.
		const cfg = vscode.workspace.getConfiguration('genericAgent');
		const lang = cfg.get<string>('language');
		const gaPrefs = JSON.stringify({
			language: (lang === 'en') ? 'en' : 'zh',
			theme: cfg.get<string>('theme', 'auto'),
			collapseThinking: cfg.get<boolean>('collapseThinking', true),
			flattenSingleTurn: cfg.get<boolean>('flattenSingleTurn', true),
			sendShortcut: cfg.get<string>('sendShortcut', 'enter'),
		}).replace(/</g, '\\u003c');
		return /* html */ `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<style>
		/* ═══════════════════════════════════════════════════
		   Design tokens · Cursor-grade dark theme over VS Code
		   ═══════════════════════════════════════════════════ */
		:root {
			--pad: 14px;
			--radius: 8px;
			--radius-lg: 12px;
			--radius-xl: 16px;
			/* Backplane */
			--bg-base:   #0a0a0e;
			--bg-elev1:  #11111a;
			--bg-elev2:  #181822;
			--bg-glass:  rgba(255,255,255,0.04);
			--bg-glass-hi: rgba(255,255,255,0.07);
			/* Foreground */
			--fg-strong: #f7f8fb;
			--fg:        #e4e6ec;
			--fg-muted:  #9ea4b6;
			--fg-dim:    #6b7080;
			/* Borders */
			--border:        rgba(255,255,255,0.08);
			--border-strong: rgba(255,255,255,0.14);
			/* Brand & accents */
			--brand:       #5aa5ff;
			--brand-2:     #a78bfa;
			--brand-grad:  linear-gradient(135deg, #5aa5ff, #a78bfa);
			--accent-pink: #ec4899;
			--mint:   #34d399;
			--amber:  #fbbf24;
			--danger: #fb7185;
			/* Effects */
			--shadow-soft: 0 4px 14px rgba(0,0,0,0.25);
			--shadow-pop:  0 16px 48px rgba(0,0,0,0.45);
			--shadow-brand: 0 6px 20px rgba(90,165,255,0.25);
		}
		/* Light theme override (toggled via [data-theme="light"] on <html>) */
		html[data-theme="light"] {
			--bg-base:   #f7f8fb;
			--bg-elev1:  #ffffff;
			--bg-elev2:  #f0f1f6;
			--bg-glass:  rgba(15,23,42,0.04);
			--bg-glass-hi: rgba(15,23,42,0.07);
			--fg-strong: #0f172a;
			--fg:        #1e293b;
			--fg-muted:  #475569;
			--fg-dim:    #94a3b8;
			--border:        rgba(15,23,42,0.10);
			--border-strong: rgba(15,23,42,0.16);
			--shadow-pop: 0 16px 48px rgba(15,23,42,0.18);
		}

		html, body {
			margin: 0; padding: 0; height: 100%;
			background: var(--bg-base);
			color: var(--fg);
			font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
			font-size: 13.5px;
			-webkit-font-smoothing: antialiased;
			-moz-osx-font-smoothing: grayscale;
		}
		body {
			display: flex; flex-direction: column; overflow: hidden;
			background:
				radial-gradient(ellipse 1200px 800px at 20% -10%, rgba(90,165,255,0.08), transparent 60%),
				radial-gradient(ellipse 900px 700px at 90% 100%, rgba(236,72,153,0.04), transparent 55%),
				var(--bg-base);
		}
		/* Subtle scrollbars throughout */
		::-webkit-scrollbar { width: 10px; height: 10px; }
		::-webkit-scrollbar-track { background: transparent; }
		::-webkit-scrollbar-thumb {
			background: rgba(255,255,255,0.08);
			border-radius: 5px;
			border: 2px solid transparent;
			background-clip: padding-box;
		}
		::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.16); background-clip: padding-box; }
		html[data-theme="light"] ::-webkit-scrollbar-thumb { background: rgba(15,23,42,0.12); background-clip: padding-box; }
		html[data-theme="light"] ::-webkit-scrollbar-thumb:hover { background: rgba(15,23,42,0.22); background-clip: padding-box; }
		/* Reusable kbd badge */
		kbd {
			display: inline-block;
			padding: 2px 7px;
			background: var(--bg-glass);
			border: 1px solid var(--border);
			border-radius: 4px;
			font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
			font-size: 10.5px;
			color: var(--fg);
			line-height: 1.4;
		}
		* { box-sizing: border-box; }
		[hidden] { display: none !important; }

		/* ── Header / top toolbar ────────────────────────────────────── */
		header {
			position: relative;
			display: flex; align-items: center; gap: 8px;
			padding: 8px 14px;
			border-bottom: 1px solid var(--border);
			background: rgba(13,13,18,0.78);
			backdrop-filter: blur(24px) saturate(160%);
			-webkit-backdrop-filter: blur(24px) saturate(160%);
			font-size: 12.5px;
			flex: 0 0 auto;
			z-index: 30;
		}
		html[data-theme="light"] header { background: rgba(255,255,255,0.85); }
		header .brand-mark {
			width: 22px; height: 22px; border-radius: 6px;
			background: var(--brand-grad);
			display: inline-flex; align-items: center; justify-content: center;
			color: #fff; font-weight: 700; font-size: 12px;
			box-shadow: 0 0 18px rgba(90,165,255,0.30);
			flex: 0 0 auto;
		}
		header .title {
			font-weight: 600; color: var(--fg-strong); letter-spacing: -0.01em;
			display: inline-flex; align-items: center; gap: 8px;
			min-width: 0; max-width: 32vw;
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		header .title .sep { color: var(--fg-dim); font-weight: 400; }
		header .title .convo {
			color: var(--fg-muted); font-weight: 400;
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		header .status-pill {
			display: inline-flex; align-items: center; gap: 6px;
			padding: 4px 10px;
			border-radius: 999px;
			background: rgba(52,211,153,0.08);
			border: 1px solid rgba(52,211,153,0.20);
			color: var(--mint);
			font-size: 11px; font-weight: 500;
			max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		header .status-pill.run { background: rgba(251,191,36,0.10); border-color: rgba(251,191,36,0.25); color: var(--amber); }
		header .status-pill.err { background: rgba(251,113,133,0.10); border-color: rgba(251,113,133,0.30); color: var(--danger); }
		header .status-pill .dot {
			width: 6px; height: 6px; border-radius: 50%;
			background: currentColor;
			box-shadow: 0 0 6px currentColor;
		}
		header .dot { /* legacy dot used by old JS — keep but hidden */ display: none; }
		header .llm { display: none; } /* legacy text — replaced by status-pill */
		header .spacer { flex: 1 1 auto; }
		header button {
			background: transparent; color: var(--fg-strong);
			border: 1px solid transparent;
			padding: 4px 10px; border-radius: 6px;
			cursor: pointer; font: inherit; font-size: 12px;
		}
		header button:hover { background: var(--bg-glass-hi); border-color: var(--border); }
		header button:disabled { opacity: 0.4; cursor: not-allowed; }

		/* ── Toolbar icon buttons (top-right cluster) ────────────────── */
		.toolbar-icon {
			width: 30px; height: 30px; padding: 0;
			background: transparent; color: var(--fg-muted);
			border: 1px solid transparent; border-radius: 7px;
			cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
			font-size: 14px; line-height: 1;
			transition: background 0.14s, color 0.14s, border-color 0.14s;
		}
		.toolbar-icon:hover { background: var(--bg-glass-hi); color: var(--fg-strong); }
		.toolbar-icon.active {
			background: rgba(90,165,255,0.12); color: var(--brand);
			border-color: rgba(90,165,255,0.25);
		}
		.toolbar-icon svg {
			width: 15px; height: 15px;
			stroke: currentColor; fill: none;
			stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round;
		}

		/* ── Top toolbar dropdown panels ─────────────────────────────── */
		.dropdown-panel {
			position: absolute; top: 46px; right: 10px;
			width: 380px; max-height: 70vh;
			background: rgba(20,20,28,0.94);
			backdrop-filter: blur(24px) saturate(160%);
			-webkit-backdrop-filter: blur(24px) saturate(160%);
			color: var(--fg);
			border: 1px solid var(--border-strong);
			border-radius: var(--radius-lg);
			box-shadow: var(--shadow-pop);
			display: none; flex-direction: column;
			overflow: hidden; z-index: 50;
			animation: panel-pop 0.16s ease-out;
		}
		html[data-theme="light"] .dropdown-panel { background: rgba(255,255,255,0.96); }
		@keyframes panel-pop {
			from { opacity: 0; transform: translateY(-4px) scale(0.98); }
			to   { opacity: 1; transform: translateY(0) scale(1); }
		}
		.dropdown-panel.show { display: flex; }
		.dropdown-head {
			display: flex; align-items: center; gap: 8px;
			padding: 10px 12px;
			border-bottom: 1px solid var(--border);
			flex: 0 0 auto;
		}
		.dropdown-head input {
			flex: 1 1 auto;
			background: var(--bg-glass);
			color: var(--fg-strong);
			border: 1px solid var(--border);
			border-radius: 6px;
			padding: 6px 10px;
			font: inherit; font-size: 12.5px;
			outline: none;
			transition: border-color 0.14s, background 0.14s;
		}
		.dropdown-head input:focus { border-color: var(--brand); background: var(--bg-glass-hi); }
		.dropdown-head input::placeholder { color: var(--fg-dim); }
		.dropdown-body {
			flex: 1 1 auto; overflow-y: auto; padding: 6px 0;
			display: flex; flex-direction: column;
		}
		.dropdown-section {
			font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em;
			color: var(--fg-dim);
			padding: 10px 14px 4px;
			font-weight: 600;
		}
		.dropdown-empty {
			padding: 18px 14px; text-align: center;
			color: var(--fg-dim); font-size: 12px;
		}
		.dropdown-row {
			padding: 8px 14px; cursor: pointer;
			display: flex; flex-direction: column; gap: 3px;
			border-left: 2px solid transparent;
			transition: background 0.10s, border-color 0.10s;
		}
		.dropdown-row:hover {
			background: var(--bg-glass-hi);
			border-left-color: var(--brand);
		}
		.dropdown-row.active {
			background: rgba(90,165,255,0.10);
			border-left-color: var(--brand);
			color: var(--fg-strong);
		}
		.dropdown-row .row-title {
			font-size: 13px; line-height: 1.35; font-weight: 500;
			color: var(--fg-strong);
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		.dropdown-row .row-meta {
			font-size: 11px; color: var(--fg-dim);
			display: flex; gap: 8px;
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		.dropdown-row .row-brief {
			font-size: 11px; color: var(--fg-dim); line-height: 1.4;
			display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
			overflow: hidden; text-overflow: ellipsis;
			max-width: 100%;
		}
		.dropdown-row.active .row-meta { color: var(--fg-muted); }
		.dropdown-row.active .row-brief { color: var(--fg-muted); }
		.dropdown-foot {
			padding: 10px 12px;
			border-top: 1px solid var(--border);
			display: flex; gap: 8px; flex: 0 0 auto;
		}
		.dropdown-foot button {
			flex: 1 1 auto; padding: 7px 10px; font-size: 12px; font-weight: 500;
			background: var(--brand-grad);
			color: #fff;
			border: 0; border-radius: 7px;
			cursor: pointer;
			box-shadow: var(--shadow-brand);
			transition: filter 0.12s, transform 0.06s;
		}
		.dropdown-foot button:hover { filter: brightness(1.08); }
		.dropdown-foot button:active { transform: scale(0.98); }
		.dropdown-foot button.secondary {
			background: var(--bg-glass-hi);
			color: var(--fg);
			border: 1px solid var(--border);
			box-shadow: none;
		}
		.dropdown-foot button.secondary:hover {
			background: var(--bg-glass);
			border-color: var(--border-strong);
			filter: none;
		}
		.dropdown-foot button:disabled { opacity: 0.5; cursor: not-allowed; }

		.sop-modal-backdrop {
			position: fixed; inset: 0; z-index: 100;
			background: rgba(0,0,0,0.42);
			display: none; align-items: center; justify-content: center;
			padding: 28px;
		}
		.sop-modal-backdrop.show { display: flex; }
		.sop-modal {
			width: min(860px, 94vw); height: min(760px, 86vh);
			background: rgba(20,20,28,0.97);
			color: var(--fg);
			border: 1px solid var(--border-strong);
			border-radius: 16px;
			box-shadow: var(--shadow-pop);
			display: flex; flex-direction: column;
			overflow: hidden;
		}
		html[data-theme="light"] .sop-modal { background: rgba(255,255,255,0.98); }
		.sop-modal-head {
			flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
			padding: 12px 14px; border-bottom: 1px solid var(--border);
		}
		.sop-modal-title {
			flex: 1 1 auto; min-width: 0;
			font-size: 14px; font-weight: 650; color: var(--fg-strong);
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		.sop-modal-close {
			width: 28px; height: 28px; padding: 0;
			border-radius: 8px; border: 1px solid transparent;
			background: transparent; color: var(--fg-muted); cursor: pointer;
		}
		.sop-modal-close:hover { background: var(--bg-glass-hi); color: var(--fg-strong); border-color: var(--border); }
		.sop-modal-body {
			flex: 1 1 auto; min-height: 0; overflow: auto;
			padding: 18px 22px;
		}
		.sop-modal-body .md { max-width: 780px; margin: 0 auto; }
		.sop-modal-foot {
			flex: 0 0 auto; display: flex; justify-content: flex-end; gap: 10px;
			padding: 12px 14px; border-top: 1px solid var(--border);
		}
		.sop-modal-foot button {
			padding: 7px 14px; border-radius: 8px;
			border: 1px solid var(--border); cursor: pointer;
			background: var(--bg-glass-hi); color: var(--fg);
		}
		.sop-modal-foot button.primary {
			background: var(--brand-grad); color: #fff; border-color: transparent;
			box-shadow: var(--shadow-brand);
		}

		/* ── Skills tabs (local / marketplace) ───────────────────────── */
		.skills-tabs { display: flex; gap: 6px; }
		.skills-tab {
			flex: 1 1 0; padding: 6px 10px; cursor: pointer;
			background: transparent; color: var(--fg-muted);
			border: 1px solid var(--border); border-radius: 8px;
			font-size: 12px; font-weight: 600;
		}
		.skills-tab:hover { background: var(--bg-glass); color: var(--fg); }
		.skills-tab.active {
			background: var(--bg-glass-hi); color: var(--fg-strong);
			border-color: var(--border-strong);
		}
		.skill-row .row-actions {
			display: flex; gap: 6px; margin-top: 4px;
		}
		.skill-row .row-action {
			padding: 2px 8px; font-size: 11px; border-radius: 6px;
			border: 1px solid var(--border); background: var(--bg-glass);
			color: var(--fg-muted); cursor: pointer;
		}
		.skill-row .row-action:hover { background: var(--bg-glass-hi); color: var(--fg-strong); }
		.row-stars { color: #f5b342; font-size: 11px; margin-left: 6px; }

		/* Marketplace cards (sophub style) */
		.market-card { padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); margin: 6px 0; background: var(--bg-glass); cursor: pointer; display: flex; flex-direction: column; gap: 6px; }
		.market-card:hover { background: var(--bg-glass-hi); border-color: var(--border-strong); }
		.market-card-head { display: flex; align-items: flex-start; gap: 6px; flex-wrap: wrap; }
		.market-badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; color: #fff; background: linear-gradient(135deg,#3b82f6,#6366f1); }
		.market-badge.official { background: linear-gradient(135deg,#ef4444,#f97316); }
		.market-title { font-size: 13px; font-weight: 650; color: var(--fg-strong); flex: 1 1 auto; line-height: 1.4; }
		.market-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 11px; color: var(--fg-muted); }
		.market-meta .stars { color: #f5b342; }
		.market-preview { font-size: 12px; color: var(--fg-muted); line-height: 1.5; max-height: 48px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; border-top: 1px dashed var(--border); padding-top: 6px; }

		/* Risk-confirm modal (upload warning) */
		.risk-modal-backdrop { position: fixed; inset: 0; z-index: 110; background: rgba(0,0,0,0.55); display: none; align-items: center; justify-content: center; }
		.risk-modal-backdrop.show { display: flex; }
		.risk-modal { width: min(520px, 92vw); background: rgba(20,20,28,0.98); color: var(--fg); border: 1px solid #ef4444; border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,0.55); padding: 18px 20px; }
		html[data-theme="light"] .risk-modal { background: rgba(255,255,255,0.99); }
		.risk-modal h3 { margin: 0 0 8px; font-size: 15px; color: #ef4444; display:flex; align-items:center; gap:6px; }
		.risk-modal ul { margin: 8px 0 12px; padding-left: 20px; line-height: 1.6; font-size: 12px; }
		.risk-modal .target { padding: 6px 8px; background: var(--bg-glass); border-radius: 6px; font-size: 12px; margin: 6px 0 10px; word-break: break-all; }
		.risk-modal label { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
		.risk-modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
		.risk-modal-foot button { padding: 7px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-glass-hi); color: var(--fg); cursor: pointer; font-size: 12px; }
		.risk-modal-foot button.danger { background: #ef4444; border-color: #ef4444; color: #fff; }
		.risk-modal-foot button.danger:disabled { opacity: 0.4; cursor: not-allowed; }

		/* Config editor modal */
		.config-modal-backdrop { position: fixed; inset: 0; z-index: 105; background: rgba(0,0,0,0.5); display: none; align-items: center; justify-content: center; padding: 24px; }
		.config-modal-backdrop.show { display: flex; }
		.config-modal { width: min(880px, 96vw); height: min(740px, 90vh); background: rgba(20,20,28,0.98); color: var(--fg); border: 1px solid var(--border-strong); border-radius: 16px; display: flex; flex-direction: column; overflow: hidden; }
		html[data-theme="light"] .config-modal { background: rgba(255,255,255,0.99); }
		.config-modal-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
		.config-modal-title { flex: 1 1 auto; font-size: 14px; font-weight: 650; color: var(--fg-strong); }
		.config-modal-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px 18px; }
		.config-modal-foot { padding: 10px 14px; border-top: 1px solid var(--border); display: flex; gap: 8px; justify-content: space-between; align-items: center; }
		.config-banner { padding: 10px 12px; border-radius: 10px; background: linear-gradient(135deg, rgba(245,158,11,0.18), rgba(239,68,68,0.18)); border: 1px solid rgba(245,158,11,0.45); color: var(--fg); font-size: 12px; line-height: 1.6; margin-bottom: 12px; }
		.cfg-session { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; background: var(--bg-glass); }
		.cfg-session-head { display:flex; gap:8px; align-items:center; margin-bottom: 8px; }
		.cfg-grid { display: grid; grid-template-columns: 110px 1fr; gap: 6px 10px; align-items: center; }
		.cfg-grid label { font-size: 11px; color: var(--fg-muted); }
		.cfg-grid input, .cfg-grid select, .cfg-grid textarea { width: 100%; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); font-size: 12px; font-family: inherit; }
		.cfg-grid .row-inline { display: flex; gap: 6px; }
		.cfg-grid .row-inline button { padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-glass-hi); color: var(--fg); cursor: pointer; font-size: 11px; }
		.cfg-section-title { font-size: 12px; font-weight: 600; color: var(--fg-strong); margin: 14px 0 6px; }
		.cfg-add-btn { padding: 6px 12px; border-radius: 8px; border: 1px dashed var(--border-strong); background: transparent; color: var(--fg-muted); cursor: pointer; font-size: 12px; width: 100%; }
		.cfg-add-btn:hover { background: var(--bg-glass); color: var(--fg); }
		.cfg-status { font-size: 11px; color: var(--fg-muted); }
		.cfg-banner-prompt { padding: 10px 14px; border-radius: 10px; margin: 10px 16px; background: linear-gradient(135deg, rgba(245,158,11,0.18), rgba(239,68,68,0.10)); border: 1px solid rgba(245,158,11,0.4); display: flex; align-items: center; gap: 10px; font-size: 12px; }
		.cfg-banner-prompt button { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border-strong); background: var(--brand-grad, #6366f1); color: #fff; cursor: pointer; font-size: 11px; font-weight: 600; }

		/* ── Welcome empty state ─────────────────────────────────────── */
		.welcome {
			flex: 1 1 auto; min-height: 0; overflow-y: auto;
			display: flex; flex-direction: column; align-items: center; justify-content: center;
			gap: 26px; padding: 48px 24px;
			color: var(--fg);
			animation: fade-in 0.24s ease-out;
		}
		@keyframes fade-in {
			from { opacity: 0; transform: translateY(6px); }
			to   { opacity: 1; transform: none; }
		}
		.welcome.hidden { display: none; }
		#log.hidden { display: none; }
		.welcome-logo {
			width: 64px; height: 64px; border-radius: 18px;
			background: var(--brand-grad);
			box-shadow: 0 0 60px rgba(90,165,255,0.30), inset 0 1px 0 rgba(255,255,255,0.30);
			display: flex; align-items: center; justify-content: center;
			color: #fff; font-size: 30px; font-weight: 700;
			letter-spacing: -0.02em;
		}
		.welcome-title {
			font-size: 28px; font-weight: 700; letter-spacing: -0.02em;
			background: linear-gradient(135deg, var(--fg-strong), var(--fg-muted));
			-webkit-background-clip: text; background-clip: text;
			-webkit-text-fill-color: transparent;
			text-align: center;
		}
		.welcome-sub {
			font-size: 13.5px; color: var(--fg-muted);
			text-align: center; max-width: 480px; line-height: 1.6;
		}
		.welcome-cards {
			display: grid; grid-template-columns: repeat(3, 1fr);
			gap: 12px; width: 100%; max-width: 640px;
		}
		.welcome-card {
			position: relative;
			padding: 16px 14px;
			background: var(--bg-glass);
			border: 1px solid var(--border);
			border-radius: var(--radius-lg);
			cursor: pointer;
			transition: border-color 0.18s, background 0.18s, transform 0.18s;
			display: flex; flex-direction: column; gap: 6px;
		}
		.welcome-card:hover {
			border-color: var(--border-strong);
			background: var(--bg-glass-hi);
			transform: translateY(-1px);
		}
		.welcome-card .ic {
			width: 30px; height: 30px; border-radius: 9px;
			display: flex; align-items: center; justify-content: center;
			background: rgba(255,255,255,0.06);
			color: var(--fg-strong);
			font-size: 16px;
			margin-bottom: 4px;
		}
		.welcome-card .ic.blue   { background: rgba(90,165,255,0.14);  color: var(--brand); }
		.welcome-card .ic.violet { background: rgba(167,139,250,0.14); color: var(--brand-2); }
		.welcome-card .ic.pink   { background: rgba(236,72,153,0.14);  color: var(--accent-pink); }
		.welcome-card .ttl { font-size: 13.5px; font-weight: 600; color: var(--fg-strong); }
		.welcome-card .desc { font-size: 11.5px; color: var(--fg-muted); line-height: 1.5; }
		.welcome-shortcuts {
			margin-top: 6px;
			display: flex; gap: 18px; align-items: center;
			color: var(--fg-dim); font-size: 11.5px;
		}
		.welcome-shortcuts .row { display: flex; gap: 8px; align-items: center; }

		/* ── Mode / model / autonomous pills (live INSIDE composer shell) ─ */
		.composer-meta {
			display: flex; align-items: center; gap: 4px;
			padding: 0;
			color: var(--fg-muted); font-size: 11px;
			flex-wrap: wrap;
		}
		.mode-trigger, .model-trigger, .auto-pill {
			display: inline-flex; align-items: center; gap: 4px;
			padding: 2px 8px; border-radius: 6px;
			background: transparent;
			border: 0;
			color: var(--fg-muted); font-size: 11px; font-weight: 500;
			cursor: pointer; user-select: none;
			transition: background 0.12s, color 0.12s;
		}
		.mode-trigger:hover, .model-trigger:hover, .auto-pill:hover {
			background: var(--bg-glass-hi);
			color: var(--fg-strong);
		}
		.mode-trigger .caret, .model-trigger .caret { opacity: 0.55; font-size: 9px; margin-left: 1px; }
		.auto-pill {
			color: var(--fg-muted);
		}
		.auto-pill.on {
			color: var(--mint);
			background: rgba(52,211,153,0.10);
			border-color: rgba(52,211,153,0.30);
		}
		.auto-pill .ico { font-size: 12px; }
		.auto-pill .countdown {
			font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
			font-size: 10.5px; opacity: 0.85;
		}
		.mode-menu {
			position: absolute; bottom: 100%; left: var(--pad); margin-bottom: 6px;
			min-width: 240px;
			background: rgba(20,20,28,0.96);
			backdrop-filter: blur(24px) saturate(160%);
			-webkit-backdrop-filter: blur(24px) saturate(160%);
			border: 1px solid var(--border-strong);
			border-radius: 10px;
			box-shadow: var(--shadow-pop);
			display: none; flex-direction: column; padding: 4px;
			z-index: 60;
			animation: panel-pop 0.14s ease-out;
		}
		html[data-theme="light"] .mode-menu { background: rgba(255,255,255,0.97); }
		.mode-menu.show { display: flex; }
		.mode-menu-item {
			padding: 8px 10px; cursor: pointer;
			display: flex; flex-direction: column; gap: 2px;
			border-radius: 6px;
		}
		.mode-menu-item:hover { background: var(--bg-glass-hi); }
		.mode-menu-item .t { font-size: 12.5px; font-weight: 500; color: var(--fg-strong); }
		.mode-menu-item .d { font-size: 11px; color: var(--fg-muted); }
		.mode-menu-item.active {
			background: rgba(90,165,255,0.12);
			color: var(--fg-strong);
		}
		.mode-menu-item.active .t { color: var(--brand); }
		.mode-menu-item.active .d { color: var(--fg-muted); }

		footer { position: relative; }
		@keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }

		/* ── Message log ────────────────────────────────────────────── */
		#log {
			flex: 1 1 auto; overflow-y: auto;
			padding: 18px 0;
			display: flex; flex-direction: column; gap: 18px;
			scroll-behavior: smooth;
		}
		.msg {
			display: flex; flex-direction: column; gap: 6px;
			max-width: min(820px, 100%);
			width: 100%;
			min-width: 0;
			margin: 0 auto;
			padding: 0 var(--pad);
			animation: msg-in 0.18s ease-out;
		}
		@keyframes msg-in {
			from { opacity: 0; transform: translateY(4px); }
			to   { opacity: 1; transform: none; }
		}
		.msg .meta { display: flex; align-items: center; gap: 8px; min-height: 18px; }
		.msg .who {
			font-size: 10.5px; color: var(--fg-dim);
			text-transform: uppercase; letter-spacing: 0.08em;
			font-weight: 600;
		}
		/* Cursor-style: hide noisy assistant meta cluster.
		   The summary badges (READY, 1 TURN, 1 THOUGHT, ...) duplicate
		   info already visible in the turn dividers below, so we drop
		   them entirely and let the body breathe.  Action buttons get
		   relocated to a hover-revealed footer toolbar (see below). */
		.msg.assistant > .meta {
			display: flex;
			order: 99;          /* push to bottom of column */
			justify-content: flex-end;
			min-height: 0;
			margin-top: 2px;
			opacity: 0;
			transition: opacity 0.14s ease-out;
		}
		.msg.assistant:hover > .meta,
		.msg.assistant:focus-within > .meta { opacity: 1; }
		.msg.assistant.streaming > .meta { opacity: 0 !important; }
		.msg.assistant > .meta > .who,
		.msg.assistant > .meta > .spacer,
		.msg.assistant > .meta > .msg-summary { display: none !important; }
		.msg.assistant > .body { order: 1; }

		.msg-summary {
			display: flex; align-items: center; flex-wrap: wrap;
			gap: 6px; min-width: 0;
		}
		.msg-summary:empty { display: none; }
		.msg-pill {
			display: inline-flex; align-items: center;
			height: 18px; padding: 0 8px;
			border-radius: 999px;
			border: 1px solid var(--border);
			background: var(--bg-glass);
			color: var(--fg-dim);
			font-size: 10px; letter-spacing: 0.04em;
			text-transform: uppercase; font-weight: 500;
		}
		.msg-pill.run { color: var(--amber); border-color: rgba(251,191,36,0.30); background: rgba(251,191,36,0.06); }
		.msg-pill.ok  { color: var(--mint);  border-color: rgba(52,211,153,0.30); background: rgba(52,211,153,0.06); }
		.msg .meta .spacer { flex: 1 1 auto; }

		/* Action toolbar — text-link style, hover-revealed at message bottom */
		.msg-actions {
			display: flex; align-items: center; flex-wrap: wrap; gap: 0;
		}
		.msg-actions button {
			background: transparent;
			color: var(--fg-dim);
			border: 0;
			border-radius: 6px;
			padding: 0 8px; height: 22px;
			cursor: pointer; font-size: 11px;
			font-family: inherit;
			transition: background 0.12s, color 0.12s;
		}
		.msg-actions button:hover:not(:disabled) {
			background: var(--bg-glass-hi);
			color: var(--fg-strong);
		}
		.msg-actions button:disabled { opacity: 0.40; cursor: not-allowed; }
		.msg-actions button.done { color: var(--mint); }
		.msg .body {
			word-wrap: break-word;
			min-width: 0;
			max-width: 100%;
			padding: 10px 14px;
			border-radius: var(--radius-lg);
			line-height: 1.6;
			color: var(--fg);
		}
		.msg.assistant .body {
			background: transparent;
			padding: 2px 0;
		}
		.msg.user .body, .msg.system .body, .msg.error .body {
			white-space: pre-wrap;
		}
		.msg.user { align-items: flex-end; }
		.msg.user .body {
			background: var(--bg-glass-hi);
			border: 1px solid var(--border);
			border-radius: 16px 16px 4px 16px;
			max-width: min(82%, 720px);
			color: var(--fg-strong);
		}
		/* Cursor-style: render system messages as tiny centered chips.
		   These are usually low-value (Conversation cleared, 已开启新对话,
		   etc.) so they shouldn't take a full message slot. */
		.msg.system {
			align-items: center;
			gap: 0;
		}
		.msg.system > .meta { display: none; }
		.msg.system .body {
			display: inline-flex; align-items: center; gap: 6px;
			background: var(--bg-glass);
			border: 1px solid var(--border);
			color: var(--fg-muted);
			font-style: normal;
			font-size: 11px;
			line-height: 1.4;
			padding: 3px 12px;
			border-radius: 999px;
			max-width: min(80%, 540px);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.msg.error .body {
			background: rgba(251,113,133,0.06);
			border: 1px solid rgba(251,113,133,0.25);
			color: var(--danger);
		}

		/* ── Markdown rendering (assistant messages) ──────────────── */
		.msg.assistant .body > *:first-child { margin-top: 0; }
		.msg.assistant .body > *:last-child  { margin-bottom: 0; }
		.msg.assistant .body p { margin: 0.55em 0; }
		.msg.assistant .body ul,
		.msg.assistant .body ol { margin: 0.55em 0; padding-left: 1.6em; }
		.msg.assistant .body li { margin: 0.2em 0; }
		.msg.assistant .body li::marker { color: var(--fg-dim); }
		.msg.assistant .body h1,
		.msg.assistant .body h2,
		.msg.assistant .body h3 {
			margin: 1em 0 0.45em; line-height: 1.3;
			color: var(--fg-strong); font-weight: 600;
			letter-spacing: -0.01em;
		}
		.msg.assistant .body h1 { font-size: 1.35em; }
		.msg.assistant .body h2 { font-size: 1.18em; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
		.msg.assistant .body h3 { font-size: 1.05em; }
		.msg.assistant .body a {
			color: var(--brand);
			text-decoration: none;
			border-bottom: 1px dashed transparent;
			transition: border-color 0.14s;
		}
		.msg.assistant .body a:hover { border-bottom-color: var(--brand); }
		.msg.assistant .body blockquote {
			margin: 0.55em 0; padding: 4px 12px;
			border-left: 3px solid var(--brand-2);
			background: rgba(167,139,250,0.05);
			color: var(--fg-muted);
			border-radius: 0 6px 6px 0;
		}
		.msg.assistant .body code {
			font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
			font-size: 0.88em;
			background: var(--bg-glass-hi);
			border: 1px solid var(--border);
			padding: 1.5px 6px;
			border-radius: 5px;
			color: var(--brand-2);
		}
		.msg.assistant .body pre {
			position: relative;
			margin: 0.7em 0;
			background: rgba(0,0,0,0.30);
			border: 1px solid var(--border);
			border-radius: var(--radius);
			overflow: auto;
			max-width: 100%;
		}
		html[data-theme="light"] .msg.assistant .body pre { background: rgba(15,23,42,0.04); }
		.msg.assistant .body pre > .codeblock-header {
			display: flex; align-items: center;
			padding: 6px 10px;
			font-size: 10.5px;
			color: var(--fg-dim);
			background: var(--bg-glass);
			border-bottom: 1px solid var(--border);
			letter-spacing: 0.04em; text-transform: uppercase;
		}
		.msg.assistant .body pre > .codeblock-header .lang {
			flex: 1 1 auto;
			color: var(--fg-muted);
			font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
			font-weight: 600;
		}
		.msg.assistant .body pre > .codeblock-header .copy,
		.msg.assistant .body pre > .codeblock-header .apply {
			background: transparent; color: var(--fg-muted);
			border: 1px solid var(--border);
			padding: 2px 10px; border-radius: 999px;
			cursor: pointer; font-size: 10.5px;
			font-family: inherit;
			margin-left: 6px;
			text-transform: none; letter-spacing: 0;
			transition: background 0.12s, color 0.12s, border-color 0.12s;
		}
		.msg.assistant .body pre > .codeblock-header .copy:hover {
			background: var(--bg-glass-hi); color: var(--fg-strong); border-color: var(--border-strong);
		}
		.msg.assistant .body pre > .codeblock-header .copy.copied {
			color: var(--mint); border-color: rgba(52,211,153,0.40); background: rgba(52,211,153,0.08);
		}
		.msg.assistant .body pre > .codeblock-header .apply {
			color: #fff;
			background: var(--brand-grad);
			border-color: transparent;
			box-shadow: 0 2px 8px rgba(90,165,255,0.30);
		}
		.msg.assistant .body pre > .codeblock-header .apply:hover { filter: brightness(1.10); }
		.msg.assistant .body pre > .codeblock-header .apply:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; }
		.msg.assistant .body pre > code {
			display: block;
			padding: 12px 14px;
			background: transparent;
			border-radius: 0;
			white-space: pre;
			overflow-x: auto;
			min-width: max-content;
			font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
			font-size: 12.5px;
			line-height: 1.55;
			color: var(--fg);
		}
		.msg.assistant.streaming .body::after {
			content: '';
			display: inline-block;
			width: 7px; height: 14px;
			margin-left: 4px; vertical-align: -2px;
			background: var(--brand);
			border-radius: 1px;
			animation: blink 1s steps(2, start) infinite;
			box-shadow: 0 0 8px var(--brand);
		}
		@keyframes blink { to { opacity: 0; } }

		/* ── Composer / footer ─────────────────────────────────────── */
		footer {
			flex: 0 0 auto;
			padding: 8px var(--pad) 10px;
			border-top: 1px solid var(--border);
			background: rgba(13,13,18,0.60);
			backdrop-filter: blur(20px) saturate(160%);
			-webkit-backdrop-filter: blur(20px) saturate(160%);
			display: flex; flex-direction: column; gap: 0;
			position: relative;
		}
		html[data-theme="light"] footer { background: rgba(255,255,255,0.70); }

		/* Cursor-style cohesive composer: a single rounded glass shell
		   wraps attachments, meta pills, the input row, and the status
		   bar — all sharing one border that lights up on focus.  Inner
		   children use no individual borders so the eye reads them as
		   one widget instead of three stacked rows. */
		.composer-shell {
			background: var(--bg-glass);
			border: 1px solid var(--border);
			border-radius: 16px;
			padding: 4px 4px 4px 4px;
			transition: border-color 0.16s, background 0.16s, box-shadow 0.16s;
			display: flex; flex-direction: column;
		}
		.composer-shell:focus-within {
			border-color: var(--brand);
			background: var(--bg-glass-hi);
			box-shadow: 0 0 0 3px rgba(90,165,255,0.15);
		}
		.composer-row {
			display: flex; gap: 4px; align-items: flex-end;
			background: transparent;
			border: 0;
			border-radius: 0;
			padding: 2px 2px 2px 6px;
			transition: none;
		}
		.composer-row:focus-within {
			background: transparent;
			border-color: transparent;
			box-shadow: none;
		}
		.composer-attach {
			display: flex; gap: 2px; align-items: center;
			padding-bottom: 4px;
			flex: 0 0 auto;
		}
		.composer-attach button {
			width: 30px; height: 30px;
			padding: 0; border: 0; border-radius: 7px;
			background: transparent; color: var(--fg-muted);
			cursor: pointer;
			display: inline-flex; align-items: center; justify-content: center;
			transition: background 0.12s, color 0.12s;
		}
		.composer-attach button:hover { background: var(--bg-glass-hi); color: var(--fg-strong); }
		.composer-attach svg { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

		/* ── @mention popup ──────────────────────────────────────── */
		.mention-popup {
			position: absolute;
			left: var(--pad); right: var(--pad);
			bottom: calc(100% + 6px);
			max-width: 480px; max-height: 280px;
			overflow-y: auto;
			background: rgba(20,20,28,0.96);
			backdrop-filter: blur(20px) saturate(160%);
			-webkit-backdrop-filter: blur(20px) saturate(160%);
			border: 1px solid var(--border-strong);
			border-radius: var(--radius-lg);
			box-shadow: var(--shadow-pop);
			z-index: 10;
			display: none;
			animation: panel-pop 0.14s ease-out;
		}
		html[data-theme="light"] .mention-popup { background: rgba(255,255,255,0.97); }
		.mention-popup.show { display: block; }
		.mention-popup .mitem {
			padding: 7px 12px;
			cursor: pointer;
			display: flex; flex-direction: column; gap: 2px;
			border-left: 2px solid transparent;
			font-size: 12.5px;
			transition: background 0.10s, border-color 0.10s;
		}
		.mention-popup .mitem:hover {
			background: var(--bg-glass-hi);
			border-left-color: var(--brand);
		}
		.mention-popup .mitem.active {
			background: rgba(90,165,255,0.10);
			border-left-color: var(--brand);
			color: var(--fg-strong);
		}
		.mention-popup .mitem .mname { font-weight: 500; color: var(--fg-strong); }
		.mention-popup .mitem .mpath {
			color: var(--fg-dim); font-size: 11px;
			font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
		}
		.mention-popup .empty {
			padding: 12px 12px;
			color: var(--fg-dim);
			font-style: italic; font-size: 12px;
		}
		.mention-popup .mhint {
			padding: 6px 12px;
			font-size: 10px;
			color: var(--fg-dim);
			border-top: 1px solid var(--border);
			background: var(--bg-glass);
			position: sticky; bottom: 0;
		}
		/* Chip-style attached files row above the input. */
		.attached-files {
			display: flex; flex-wrap: wrap; gap: 6px;
			font-size: 11px;
			min-height: 0;
		}
		.attached-files:empty { display: none; }
		.attached-files .chip {
			display: inline-flex; align-items: center; gap: 4px;
			background: rgba(167,139,250,0.10);
			border: 1px solid rgba(167,139,250,0.25);
			color: var(--brand-2);
			padding: 3px 9px; border-radius: 999px;
			font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
			font-size: 11px;
			max-width: 240px;
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		.attached-files .chip.image {
			background: rgba(236,72,153,0.10);
			border-color: rgba(236,72,153,0.25);
			color: var(--accent-pink);
		}
		.attached-files .chip .remove {
			margin-left: 2px; cursor: pointer; opacity: 0.65;
			font-size: 14px; line-height: 1;
		}
		.attached-files .chip .remove:hover { opacity: 1; }
		#input {
			flex: 1 1 auto;
			resize: none;
			min-height: 28px; max-height: 220px;
			background: transparent;
			color: var(--fg-strong);
			border: 0;
			padding: 4px 4px;
			font-family: inherit;
			font-size: 13.5px;
			line-height: 1.55;
			outline: none;
			align-self: center;
		}
		#input::placeholder { color: var(--fg-dim); }
		#send {
			width: 28px; height: 28px;
			padding: 0; border: 0;
			border-radius: 10px;
			background: var(--brand-grad);
			color: #fff;
			cursor: pointer;
			display: inline-flex; align-items: center; justify-content: center;
			box-shadow: 0 2px 8px rgba(90,165,255,0.35);
			flex: 0 0 auto;
			transition: filter 0.12s, transform 0.06s, box-shadow 0.12s;
			align-self: flex-end;
			margin-bottom: 2px;
		}
		#send svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
		#send:hover:not(:disabled) { filter: brightness(1.08); }
		#send:active:not(:disabled) { transform: scale(0.92); }
		#send:disabled {
			opacity: 0.4; cursor: not-allowed;
			background: var(--bg-glass-hi); color: var(--fg-dim);
			box-shadow: none;
		}
		#send.abort { background: linear-gradient(135deg, #ef4444, #f87171); box-shadow: 0 2px 8px rgba(239,68,68,0.35); }
		/* Bottom strip inside composer-shell: meta pills (left) + tiny
		   live status indicator (right).  Shares the shell's background
		   so the eye reads composer-row + composer-foot as one widget. */
		.composer-foot {
			display: flex; align-items: center; justify-content: space-between;
			gap: 8px;
			padding: 2px 8px 4px 8px;
			font-size: 11px; color: var(--fg-dim);
			user-select: none;
		}
		.composer-status-inline {
			display: inline-flex; align-items: center; gap: 6px;
			color: var(--fg-dim); font-size: 11px;
			padding: 2px 6px;
			white-space: nowrap;
		}
		.composer-status-inline .pulse {
			width: 5px; height: 5px; border-radius: 50%;
			background: currentColor;
		}
		.composer-status-inline.run { color: var(--amber); }
		.composer-status-inline.run .pulse {
			box-shadow: 0 0 6px currentColor;
			animation: pulse 1.4s ease-in-out infinite;
		}
		.composer-status-inline.err { color: var(--danger); }
		.composer-status-inline.ok  { color: var(--mint); }

		/* Drag overlay shown over composer when files are dragged in */
		.drag-overlay {
			position: absolute; inset: 6px;
			background: rgba(90,165,255,0.10);
			border: 2px dashed var(--brand);
			border-radius: 16px;
			display: none;
			align-items: center; justify-content: center;
			color: var(--brand);
			font-size: 13px; font-weight: 500;
			z-index: 12;
			pointer-events: none;
		}
		.drag-overlay.show { display: flex; }

		code, pre {
			font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
		}

		/* ── Turn dividers and tool / thinking cards ─────────────────── */
		.msg.assistant .body .narrative + .narrative { margin-top: 4px; }

		.turn-divider {
			display: flex; align-items: center; gap: 8px;
			margin: 14px 0 6px;
			font-size: 10px; letter-spacing: 0.10em;
			color: var(--fg-dim);
			text-transform: uppercase; font-weight: 600;
			cursor: pointer; user-select: none;
		}
		.turn-divider:hover { color: var(--fg-muted); }
		.turn-divider:focus-visible {
			outline: 2px solid var(--brand);
			outline-offset: 2px;
			border-radius: 6px;
		}
		.turn-divider::before, .turn-divider::after {
			content: '';
			flex: 1 1 auto;
			border-top: 1px dashed var(--border);
			opacity: 0.7;
		}
		.turn-divider .turn-chev {
			display: inline-block;
			width: 10px;
			color: var(--fg-dim);
			font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
			transition: transform 0.16s ease-out;
		}
		.turn-divider .turn-label { display: inline-flex; align-items: center; gap: 6px; }
		.turn-divider .turn-main { display: inline-flex; align-items: center; gap: 8px; min-width: 0; flex: 0 1 auto; }
		.turn-divider .turn-meta { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
		.turn-divider .turn-pill {
			display: inline-flex; align-items: center;
			height: 16px; padding: 0 7px;
			border-radius: 999px;
			border: 1px solid var(--border);
			background: var(--bg-glass);
			font-size: 10px; letter-spacing: 0.04em;
			color: var(--fg-muted);
		}
		.turn-divider .turn-pill.run {
			color: var(--amber);
			border-color: rgba(251,191,36,0.30);
			background: rgba(251,191,36,0.06);
		}
		.turn-divider .turn-preview {
			min-width: 0; max-width: min(48vw, 420px);
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
			text-transform: none; letter-spacing: 0;
			font-size: 11px;
			color: var(--fg-muted);
		}
		.turn-divider[data-state="closed"] .turn-preview { color: var(--fg); }
		.turn-divider .turn-preview.empty { opacity: 0.55; }
		.turn-divider[data-state="open"] .turn-chev { transform: rotate(90deg); color: var(--brand); }
		/* When the turn is expanded, the full summary already lives in the
		   first turn-block card below — drop the duplicate preview text
		   so the divider stays clean. */
		.turn-divider[data-state="open"] .turn-preview { display: none; }
		.turn-block {
			display: flex; flex-direction: column; gap: 10px;
			position: relative;
			margin: 0 0 8px 6px;
			padding: 2px 0 2px 14px;
			border-left: 1px solid var(--border);
		}
		.turn-block::before {
			content: '';
			position: absolute;
			left: -4px; top: 10px;
			width: 7px; height: 7px;
			border-radius: 50%;
			background: var(--brand);
			box-shadow: 0 0 0 3px var(--bg-base);
		}
		.turn-block[data-state="closed"] { display: none; }

		#jump-latest {
			position: fixed;
			left: 50%; bottom: 110px;
			transform: translate(-50%, 8px);
			opacity: 0; pointer-events: none;
			z-index: 8;
			background: var(--brand-grad);
			color: #fff;
			border: 0;
			border-radius: 999px;
			padding: 7px 14px;
			font-size: 12px; font-weight: 500;
			cursor: pointer;
			box-shadow: var(--shadow-brand), var(--shadow-pop);
			transition: opacity 0.16s, transform 0.16s, filter 0.12s;
		}
		#jump-latest.show {
			opacity: 1; pointer-events: auto;
			transform: translate(-50%, 0);
		}
		#jump-latest:hover { filter: brightness(1.10); }

		/* ── Tool / thinking cards (cursor-style collapsible blocks) ── */
		.tool-card, .thinking-card {
			margin: 8px 0;
			border: 1px solid var(--border);
			border-radius: var(--radius);
			background: var(--bg-glass);
			overflow: hidden;
			font-size: 12px;
			transition: border-color 0.16s, background 0.16s;
		}
		.tool-card { border-left: 3px solid var(--brand); }
		.thinking-card { border-left: 3px solid var(--brand-2); }
		.tool-card.active,
		.thinking-card.active {
			border-color: var(--border-strong);
			background: var(--bg-glass-hi);
			box-shadow: 0 4px 14px rgba(0,0,0,0.18);
		}
		.tool-card.status-ok  { border-left-color: var(--mint); }
		.tool-card.status-err { border-left-color: var(--danger); }
		.tool-card.status-run { border-left-color: var(--amber); }

		.tool-head, .thinking-head {
			display: flex; align-items: flex-start; gap: 10px;
			padding: 8px 12px;
			cursor: pointer; user-select: none;
			color: var(--fg);
			transition: background 0.10s;
		}
		.tool-head:hover, .thinking-head:hover { background: var(--bg-glass-hi); }
		.tool-chev {
			display: inline-block; width: 10px;
			color: var(--fg-dim);
			font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
			transition: transform 0.16s ease-out;
			margin-top: 2px;
		}
		[data-state="open"] > .tool-head > .tool-chev,
		[data-state="open"] > .thinking-head > .tool-chev { transform: rotate(90deg); color: var(--brand); }

		.tool-icon {
			width: 18px; height: 18px;
			display: inline-flex; align-items: center; justify-content: center;
			text-align: center; margin-top: 0;
			background: rgba(90,165,255,0.10);
			border-radius: 5px;
			color: var(--brand);
			font-size: 11px;
		}
		.thinking-card .tool-icon { background: rgba(167,139,250,0.10); color: var(--brand-2); }
		.tool-card.status-ok  .tool-icon { background: rgba(52,211,153,0.10); color: var(--mint); }
		.tool-card.status-err .tool-icon { background: rgba(251,113,133,0.10); color: var(--danger); }
		.tool-card.status-run .tool-icon { background: rgba(251,191,36,0.10); color: var(--amber); }
		.tool-head-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
		.tool-title-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
		.tool-badge {
			flex: 0 0 auto;
			padding: 1px 7px;
			border-radius: 999px;
			border: 1px solid var(--border);
			font-size: 10px; letter-spacing: 0.04em;
			text-transform: uppercase; font-weight: 600;
			color: var(--fg-dim);
			background: var(--bg-glass);
		}
		.tool-name {
			font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
			font-weight: 500;
			color: var(--fg-strong);
			min-width: 0;
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		.tool-preview {
			display: block;
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
			color: var(--fg-muted);
			font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
			font-size: 11px;
		}
		.tool-preview.empty { opacity: 0.45; }
		.tool-meta {
			flex: 0 0 auto;
			display: flex; align-items: center; gap: 6px;
			margin-left: auto; padding-top: 1px;
		}
		.tool-status {
			flex: 0 0 auto;
			padding: 1px 7px;
			border-radius: 999px;
			border: 1px solid var(--border);
			font-size: 10px; letter-spacing: 0.04em;
			text-transform: uppercase; font-weight: 600;
			color: var(--fg-dim); background: var(--bg-glass);
		}
		.tool-status.ok  { color: var(--mint);   border-color: rgba(52,211,153,0.30);  background: rgba(52,211,153,0.08); }
		.tool-status.err { color: var(--danger); border-color: rgba(251,113,133,0.30); background: rgba(251,113,133,0.08); }
		.tool-status.run { color: var(--amber);  border-color: rgba(251,191,36,0.30);  background: rgba(251,191,36,0.08); }
		.tool-spinner {
			display: inline-block; width: 10px; height: 10px;
			border: 1.5px solid var(--brand);
			border-top-color: transparent;
			border-radius: 50%;
			animation: spin 0.8s linear infinite;
		}
		@keyframes spin { to { transform: rotate(360deg); } }

		.tool-body, .thinking-body {
			display: none;
			border-top: 1px solid var(--border);
			background: rgba(0,0,0,0.20);
			padding: 8px 12px;
		}
		html[data-theme="light"] .tool-body,
		html[data-theme="light"] .thinking-body { background: rgba(15,23,42,0.03); }
		[data-state="open"] > .tool-body,
		[data-state="open"] > .thinking-body { display: block; }
		.thinking-card .tool-preview { color: var(--fg-muted); }

		.tool-body .section-label {
			font-size: 10px;
			color: var(--fg-dim);
			text-transform: uppercase;
			letter-spacing: 0.06em; font-weight: 600;
			margin: 6px 0 4px;
		}
		.tool-body .section-label:first-child { margin-top: 0; }
		.tool-body pre, .thinking-body pre {
			margin: 0;
			font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
			font-size: 12px;
			line-height: 1.5;
			white-space: pre-wrap;
			word-break: break-word;
			max-height: 320px;
			overflow-y: auto;
			padding: 4px 0;
			color: var(--fg);
		}
		.thinking-body pre {
			color: var(--fg-muted);
			font-style: italic;
		}

		/* ── Autonomous strip (header underline when active) ────────── */
		.auto-strip {
			display: flex; align-items: center; gap: 10px;
			padding: 6px 14px;
			background: linear-gradient(90deg, rgba(52,211,153,0.10), rgba(90,165,255,0.06));
			border-bottom: 1px solid var(--border);
			color: var(--mint);
			font-size: 11.5px; font-weight: 500;
			animation: fade-in 0.2s ease-out;
		}
		.auto-strip[hidden] { display: none; }
		.auto-strip .auto-dot {
			width: 7px; height: 7px; border-radius: 50%;
			background: var(--mint);
			box-shadow: 0 0 8px var(--mint);
			animation: pulse 1.4s ease-in-out infinite;
		}
		.auto-strip .auto-text { color: var(--mint); font-weight: 600; }
		.auto-strip .auto-countdown {
			color: var(--fg-muted);
			font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace;
			font-size: 11px;
		}
		.auto-strip .spacer { flex: 1 1 auto; }
		.auto-strip button {
			background: var(--bg-glass);
			border: 1px solid var(--border);
			color: var(--fg);
			padding: 3px 10px; border-radius: 999px;
			cursor: pointer; font-size: 11px; font-weight: 500;
			transition: background 0.12s, border-color 0.12s, color 0.12s;
		}
		.auto-strip button:hover {
			background: var(--bg-glass-hi);
			border-color: var(--border-strong);
			color: var(--fg-strong);
		}
		.bot-card { margin: 6px 8px 8px; padding: 10px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-glass); }
		.bot-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
		.bot-title { font-weight: 650; color: var(--fg-strong); }
		.bot-pill { margin-left: auto; font-size: 11px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border); color: var(--fg-muted); }
		.bot-card.running .bot-pill { color: var(--mint); border-color: rgba(52,211,153,0.35); background: rgba(52,211,153,0.10); }
		.bot-card.missing .bot-pill { color: var(--amber); border-color: rgba(251,191,36,0.35); background: rgba(251,191,36,0.10); }
		.bot-meta { color: var(--fg-muted); font-size: 12px; line-height: 1.45; margin-bottom: 9px; }
		.bot-actions { display: flex; gap: 8px; }
		.bot-actions button { flex: 1; height: 28px; border-radius: 8px; }
	</style>
</head>
<body>
	<header>
		<span class="brand-mark" aria-hidden="true">G</span>
		<span class="title">
			<span>GenericAgent</span>
			<span class="sep" id="title-sep" hidden>·</span>
			<span class="convo" id="convo-title" hidden></span>
		</span>
		<span class="status-pill" id="status-pill" title="Backend status">
			<span class="dot"></span><span id="status-llm">connecting…</span>
		</span>
		<!-- Legacy element kept for any remaining JS references -->
		<span class="dot" id="status-dot" hidden></span>
		<span class="spacer"></span>
		<button class="toolbar-icon" id="btn-new-chat" data-i18n-title="btn.newchat" title="New chat (Ctrl+Shift+L)" aria-label="New chat">
			<svg viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9"/></svg>
		</button>
		<button class="toolbar-icon" id="btn-history" data-i18n-title="btn.history" title="History" aria-label="History">
			<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.2 1.5"/></svg>
		</button>
		<button class="toolbar-icon" id="btn-skills" data-i18n-title="btn.skills" title="SOPs" aria-label="SOPs">
			<svg viewBox="0 0 16 16"><path d="M8 1.5l1.7 4.4 4.6.4-3.5 3 1.1 4.5L8 11.4 4.1 13.8l1.1-4.5-3.5-3 4.6-.4z"/></svg>
		</button>
		<button class="toolbar-icon" id="btn-bots" title="机器人管理" aria-label="机器人管理">
			<svg viewBox="0 0 16 16"><rect x="3" y="5" width="10" height="7" rx="2"/><path d="M8 5V2.8M5.5 2.8h5M5.5 8h.1M10.4 8h.1M6.2 11h3.6"/></svg>
		</button>
		<button class="toolbar-icon" id="btn-settings" data-i18n-title="btn.settings" title="Settings" aria-label="Settings">
			<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2"/><path d="M13 8a5 5 0 0 0-.1-1l1.4-1.1-1.5-2.6-1.7.6a5 5 0 0 0-1.7-1L9 1H7l-.4 1.9a5 5 0 0 0-1.7 1l-1.7-.6L1.7 5.9 3.1 7a5 5 0 0 0 0 2L1.7 10.1l1.5 2.6 1.7-.6a5 5 0 0 0 1.7 1L7 15h2l.4-1.9a5 5 0 0 0 1.7-1l1.7.6 1.5-2.6L12.9 9c.1-.3.1-.6.1-1z"/></svg>
		</button>
		<button class="toolbar-icon" id="btn-more" data-i18n-title="btn.more" title="More actions" aria-label="More">
			<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8"   cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>
		</button>
		<button class="toolbar-icon" id="btn-reset" data-i18n-title="btn.clear" title="Clear conversation" aria-label="Clear">
			<svg viewBox="0 0 16 16"><path d="M3 4h10M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M6 7v5M10 7v5M4 4l1 9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l1-9"/></svg>
		</button>

		<!-- Dropdown panels (shown on toolbar button click) -->
		<div class="dropdown-panel" id="panel-history" role="menu" aria-label="History">
			<div class="dropdown-head">
				<input id="history-search" type="text" placeholder="Search conversations…" />
			</div>
			<div class="dropdown-body" id="history-list">
				<div class="dropdown-empty">Loading…</div>
			</div>
			<div class="dropdown-foot">
				<button id="history-newchat">+ New chat</button>
			</div>
		</div>
		<div class="dropdown-panel" id="panel-skills" role="menu" aria-label="SOPs" style="width:380px;">
			<div class="dropdown-head" style="flex-direction:column;align-items:stretch;gap:6px;">
				<div class="skills-tabs" id="skills-tabs">
					<button class="skills-tab active" data-skills-tab="local">本地</button>
					<button class="skills-tab" data-skills-tab="market">市场</button>
				</div>
				<input id="skills-search" type="text" placeholder="Search SOPs…" />
			</div>
			<div class="dropdown-body" id="skills-list">
				<div class="dropdown-empty">Loading…</div>
			</div>
			<div class="dropdown-body" id="market-list" style="display:none;">
				<div class="dropdown-empty">输入关键词回车搜索市场 SOP</div>
			</div>
			<div class="dropdown-foot" id="skills-foot" style="justify-content:space-between;">
				<span class="row-meta" id="sophub-key-status" style="font-size:11px;">Sophub 未连接</span>
				<button id="sophub-clear-key" class="secondary" title="清除本地保存的 Sophub API Key">重置 Key</button>
			</div>
		</div>
		<div class="dropdown-panel" id="panel-settings" role="menu" aria-label="Settings">
			<div class="dropdown-head">
				<span id="settings-title" style="font-size:13px;font-weight:600;color:var(--fg-strong);">Settings</span>
			</div>
			<div class="dropdown-body" id="settings-body">
				<div class="dropdown-empty">Loading…</div>
			</div>
			<div class="dropdown-foot" style="display:flex;gap:6px;">
				<button id="settings-config" class="primary" style="background:var(--brand-grad);color:#fff;border-color:transparent;">打开配置编辑器</button>
				<button id="settings-reload">一键载入</button>
			</div>
		</div>
		<!-- Overflow / "more actions" menu -->
		<div class="dropdown-panel" id="panel-more" role="menu" aria-label="More actions" style="width:300px;">
			<div class="dropdown-body">
				<div class="dropdown-section" data-i18n="more.ops">Operations</div>
				<div class="dropdown-row" data-more-action="next_llm">
					<div class="row-title">⇄ <span data-i18n="more.next_llm">Switch backup LLM</span></div>
					<div class="row-meta" data-i18n="more.next_llm.d">Cycle to the next configured chain</div>
				</div>
				<div class="dropdown-row" data-more-action="reinject_tools">
					<div class="row-title">🔧 <span data-i18n="more.reinject">Re-inject tool examples</span></div>
					<div class="row-meta" data-i18n="more.reinject.d">Reload tool-usage history into prompt</div>
				</div>
				<div class="dropdown-row" data-more-action="desktop_pet">
					<div class="row-title">🐱 <span data-i18n="more.pet">Launch desktop pet</span></div>
					<div class="row-meta" data-i18n="more.pet.d">Spawn the floating pet companion</div>
				</div>
				<div class="dropdown-section" data-i18n="more.appearance">Appearance</div>
				<div class="dropdown-row" data-more-action="theme_toggle">
					<div class="row-title" id="theme-toggle-label">🌙 <span data-i18n="more.theme.dark">Switch to light theme</span></div>
					<div class="row-meta" data-i18n="more.theme.d">Toggle between dark and light</div>
				</div>
				<div class="dropdown-row" data-more-action="open_settings">
					<div class="row-title">⚙ <span data-i18n="more.openSettings">Open VS Code Settings</span></div>
					<div class="row-meta" data-i18n="more.openSettings.d">All GenericAgent options live there</div>
				</div>
			</div>
		</div>
	</header>

	<!-- Missing-config banner (shown when no LLM is configured) -->
	<div class="cfg-banner-prompt" id="cfg-prompt" hidden>
		<span style="font-size:16px;">⚠</span>
		<span style="flex:1 1 auto;">尚未检测到 LLM 配置，无法对话。请先配置 API Key。</span>
		<button id="cfg-prompt-open">打开配置</button>
		<button id="cfg-prompt-dismiss" style="background:transparent;color:var(--fg-muted);border-color:var(--border);">稍后</button>
	</div>

	<!-- Autonomous strip (visible when autonomous mode is on or running) -->
	<div class="auto-strip" id="auto-strip" hidden>
		<span class="auto-dot"></span>
		<span class="auto-text" data-i18n="auto.banner">Autonomous mode</span>
		<span class="auto-countdown" id="auto-countdown">idle 0s</span>
		<span class="spacer"></span>
		<button id="btn-auto-trigger" title="Trigger autonomous task now"><span data-i18n="auto.trigger">⚡ Trigger now</span></button>
		<button id="btn-auto-off" data-i18n="auto.off" title="Turn off autonomous mode">Off</button>
	</div>

	<!-- Welcome state (sibling to #log; toggled in JS) -->
	<div class="welcome" id="welcome">
		<div class="welcome-logo">G</div>
		<div class="welcome-title" data-i18n="welcome.title">Hello, GenericAgent</div>
		<div class="welcome-sub" data-i18n="welcome.sub">Ask, plan, edit — all in one place.</div>
		<div class="welcome-cards">
			<div class="welcome-card" data-action="new-chat">
				<div class="ic blue"><svg width="14" height="14" viewBox="0 0 16 16" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg></div>
				<div class="ttl" data-i18n="welcome.newChat">New Chat</div>
				<div class="desc" data-i18n="welcome.newChat.desc">Start a fresh conversation in Agent mode.</div>
			</div>
			<div class="welcome-card" data-action="open-history">
				<div class="ic violet"><svg width="14" height="14" viewBox="0 0 16 16" stroke="currentColor" fill="none" stroke-width="1.6"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.2 1.5"/></svg></div>
				<div class="ttl" data-i18n="welcome.recent">Recent</div>
				<div class="desc" data-i18n="welcome.recent.desc">Resume one of your recent conversations.</div>
			</div>
			<div class="welcome-card" data-action="open-skills">
				<div class="ic pink"><svg width="14" height="14" viewBox="0 0 16 16" stroke="currentColor" fill="none" stroke-width="1.6" stroke-linejoin="round"><path d="M8 1.5l1.7 4.4 4.6.4-3.5 3 1.1 4.5L8 11.4 4.1 13.8l1.1-4.5-3.5-3 4.6-.4z"/></svg></div>
				<div class="ttl" data-i18n="welcome.skills">Skills</div>
				<div class="desc" data-i18n="welcome.skills.desc">Browse SOPs available to the agent.</div>
			</div>
		</div>
		<div class="welcome-shortcuts">
			<div class="row"><kbd>Ctrl</kbd>+<kbd>Enter</kbd><span>Send</span></div>
			<div class="row"><kbd>Shift</kbd>+<kbd>Enter</kbd><span>New line</span></div>
			<div class="row"><kbd>Ctrl</kbd>+<kbd>I</kbd><span>Inline edit</span></div>
		</div>
	</div>
	<main id="log"></main>
	<button id="jump-latest" title="Jump to latest">↓ Jump to latest</button>
	<footer>
		<!-- Mode menu (popped from .mode-trigger) -->
		<div class="mode-menu" id="mode-menu" role="menu" aria-label="Mode">
			<div class="mode-menu-item active" data-mode="agent">
				<div class="t">Agent</div>
				<div class="d">Multi-step autonomous task</div>
			</div>
			<div class="mode-menu-item" data-mode="editor">
				<div class="t">Editor</div>
				<div class="d">Edit the active file only</div>
			</div>
		</div>
		<!-- LLM dropdown (popped from .model-trigger) -->
		<div class="mode-menu" id="llm-menu" role="menu" aria-label="LLM" style="min-width:280px;"></div>

		<div class="attached-files" id="attached-files"></div>
		<div class="mention-popup" id="mention-popup" role="listbox" aria-label="Mention files"></div>
		<div class="composer-shell">
			<div class="composer-row" id="composer-row">
				<div class="composer-attach">
					<button id="btn-attach-file" title="Attach file" aria-label="Attach file">
						<svg viewBox="0 0 24 24"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
					</button>
					<button id="btn-attach-image" title="Attach image" aria-label="Attach image">
						<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
					</button>
				</div>
				<textarea id="input" rows="1" data-i18n-placeholder="composer.placeholder" placeholder="Plan, @ for context, / for commands"></textarea>
				<button id="send" title="Send (Enter)" aria-label="Send">
					<svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>
				</button>
			</div>
			<div class="composer-foot">
				<div class="composer-meta">
					<span class="mode-trigger" id="mode-trigger" role="button" tabindex="0">
						<span id="mode-label">Agent</span><span class="caret">▾</span>
					</span>
					<span class="model-trigger" id="model-trigger" role="button" tabindex="0" title="Current model">
						<span id="model-label">Auto</span><span class="caret">▾</span>
					</span>
					<span class="auto-pill" id="auto-pill" role="button" tabindex="0" title="Toggle autonomous mode">
						<span class="ico">🤖</span><span data-i18n="auto.label">Auto</span>
						<span class="countdown" id="auto-pill-countdown" hidden></span>
					</span>
				</div>
				<span class="composer-status-inline" id="composer-status">
					<span class="pulse" id="composer-pulse"></span>
					<span id="composer-status-text" data-i18n="composer.ready">Ready</span>
				</span>
			</div>
		</div>
		<div class="drag-overlay" id="drag-overlay">
			<span>📎 Drop to attach</span>
		</div>
	</footer>
	<!-- Upload-risk confirmation modal (shown before pushing local SOP to marketplace) -->
	<div class="risk-modal-backdrop" id="risk-modal" role="dialog" aria-modal="true" aria-label="Upload Confirmation">
		<div class="risk-modal">
			<h3>⚠ 上传到 Sophub 市场</h3>
			<div class="cfg-status">即将公开发布以下 SOP：</div>
			<div class="target" id="risk-modal-target">—</div>
			<div class="cfg-status"><b>请逐条确认</b>，发布后内容将公开可见，可能被搜索引擎索引：</div>
			<ul>
				<li>不含 API Key、密码、证书等任何凭据</li>
				<li>不含个人信息（手机号、邮箱、身份证、地址）</li>
				<li>不含商业机密或他人未授权内容</li>
				<li>不违反法律法规、平台政策（无武器化代码、垃圾信息）</li>
			</ul>
			<label><input type="checkbox" id="risk-modal-agree"> 我已阅读 <a href="https://fudankw.cn/sophub/?source=official" target="_blank" rel="noopener">Sophub 政策</a> 并对内容负全责</label>
			<div class="risk-modal-foot">
				<button id="risk-modal-cancel">取消</button>
				<button id="risk-modal-confirm" class="danger" disabled>确认上传</button>
			</div>
		</div>
	</div>

	<!-- LLM config editor modal -->
	<div class="config-modal-backdrop" id="config-modal" role="dialog" aria-modal="true" aria-label="LLM 配置">
		<div class="config-modal">
			<div class="config-modal-head">
				<div class="config-modal-title">⚙ LLM 配置编辑器</div>
				<button class="sop-modal-close" id="config-modal-close" title="Close" aria-label="Close">×</button>
			</div>
			<div class="config-modal-body" id="config-modal-body"></div>
			<div class="config-modal-foot">
				<div class="left">
					<span class="cfg-status" id="config-status">未加载</span>
				</div>
				<div style="display:flex; gap:8px;">
					<button id="config-modal-cancel">关闭</button>
					<button id="config-modal-save">保存</button>
					<button id="config-modal-save-reload" class="primary" style="background:var(--brand-grad);color:#fff;border-color:transparent;">保存并一键载入</button>
				</div>
			</div>
		</div>
	</div>

	<div class="sop-modal-backdrop" id="sop-modal" role="dialog" aria-modal="true" aria-label="SOP Preview">
		<div class="sop-modal">
			<div class="sop-modal-head">
				<div class="sop-modal-title" id="sop-modal-title">SOP</div>
				<button class="sop-modal-close" id="sop-modal-close" title="Close" aria-label="Close">×</button>
			</div>
			<div class="sop-modal-body" id="sop-modal-body"></div>
			<div class="sop-modal-foot">
				<button id="sop-modal-download" class="primary" style="display:none;">下载到本地</button>
				<button id="sop-modal-upload" style="display:none;">上传到市场</button>
				<button id="sop-modal-use" class="primary">使用</button>
				<button id="sop-modal-edit">编辑</button>
				<button id="sop-modal-cancel">关闭</button>
			</div>
		</div>
	</div>

	<script nonce="${nonce}">
		// ── User preferences (frozen at panel-open time) ───────────────
		// Updated live via 'prefs' messages emitted from the extension
		// host whenever the user edits genericAgent.* in VS Code Settings.
		window.gaPrefs = ${gaPrefs};

		// ── i18n (zh default, en fallback) ─────────────────────────────
		// Tiny key→string lookup; missing keys fall back to English which
		// is also the source-of-truth for placeholder text.  The webview
		// applies translations on DOMContentLoaded by walking [data-i18n]
		// nodes and rewriting their textContent / placeholder.
		(function () {
			var dict = {
				en: {
					'welcome.title': 'Hello, GenericAgent',
					'welcome.sub':   'Ask, plan, edit — all in one place.',
					'welcome.newChat':    'New Chat',
					'welcome.newChat.desc':'Start a fresh conversation in Agent mode.',
					'welcome.recent':     'Recent',
					'welcome.recent.desc':'Resume one of your recent conversations.',
					'welcome.skills':     'SOPs',
					'welcome.skills.desc':'Browse SOPs available to the agent.',
					'composer.placeholder': 'Plan, @ for context, / for commands',
					'composer.send':  'Send',
					'composer.stop':  'Stop',
					'composer.ready': 'Ready',
					'composer.working': 'Working…',
					'shortcut.send':    'send',
					'shortcut.newline': 'newline',
					'auto.label':    'Auto',
					'auto.banner':   'Autonomous mode',
					'auto.trigger':  'Trigger now',
					'auto.off':      'Off',
					'btn.newchat':   'New chat',
					'btn.history':   'History',
					'btn.skills':    'SOPs',
					'btn.settings':  'Settings',
					'btn.more':      'More actions',
					'btn.clear':     'Clear conversation',
					'more.ops':         'Operations',
					'more.appearance':  'Appearance',
					'more.next_llm':    'Switch backup LLM',
					'more.next_llm.d':  'Cycle to the next configured chain',
					'more.reinject':    'Re-inject tool examples',
					'more.reinject.d':  'Reload tool-usage history into prompt',
					'more.pet':         'Launch desktop pet',
					'more.pet.d':       'Spawn the floating pet companion',
					'more.theme.dark':  'Switch to light theme',
					'more.theme.light': 'Switch to dark theme',
					'more.theme.d':     'Toggle between dark and light',
					'more.openSettings': 'Open VS Code Settings',
					'more.openSettings.d': 'All GenericAgent options live there',
					'sys.cleared':   'Conversation cleared.',
				},
				zh: {
					'welcome.title': '你好，GenericAgent',
					'welcome.sub':   '提问、规划、编辑 —— 一处搞定。',
					'welcome.newChat':    '新对话',
					'welcome.newChat.desc':'以 Agent 模式开启一段全新对话。',
					'welcome.recent':     '最近',
					'welcome.recent.desc':'继续最近一次的对话。',
					'welcome.skills':     'SOP',
					'welcome.skills.desc':'浏览可用的 SOP。',
					'composer.placeholder': '输入消息，@ 引用上下文，/ 调用命令',
					'composer.send':  '发送',
					'composer.stop':  '停止',
					'composer.ready': '就绪',
					'composer.working': '工作中…',
					'shortcut.send':    '发送',
					'shortcut.newline': '换行',
					'auto.label':    '自主',
					'auto.banner':   '自主模式',
					'auto.trigger':  '立即触发',
					'auto.off':      '关闭',
					'btn.newchat':   '新对话',
					'btn.history':   '历史',
					'btn.skills':    'SOP',
					'btn.settings':  '设置',
					'btn.more':      '更多操作',
					'btn.clear':     '清空对话',
					'more.ops':         '操作',
					'more.appearance':  '外观',
					'more.next_llm':    '切换备用 LLM',
					'more.next_llm.d':  '轮换到下一个配置的模型链',
					'more.reinject':    '重新注入工具示例',
					'more.reinject.d':  '把工具调用历史重新载入提示词',
					'more.pet':         '启动桌面宠物',
					'more.pet.d':       '召唤悬浮的桌面宠物',
					'more.theme.dark':  '切换为浅色主题',
					'more.theme.light': '切换为深色主题',
					'more.theme.d':     '在深色与浅色之间切换',
					'more.openSettings': '打开 VS Code 设置',
					'more.openSettings.d': '所有 GenericAgent 选项都在那里',
					'sys.cleared':   '对话已清空',
				}
			};
			window.gaT = function (key) {
				// Read language live so a 'prefs' message updating
				// window.gaPrefs.language is picked up on the next call
				// without rebuilding any closure.
				var lang = (window.gaPrefs && window.gaPrefs.language) || 'zh';
				return (dict[lang] && dict[lang][key]) || (dict.en[key]) || key;
			};
			window.gaApplyI18n = function () {
				document.querySelectorAll('[data-i18n]').forEach(function (el) {
					el.textContent = window.gaT(el.getAttribute('data-i18n'));
				});
				document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
					el.title = window.gaT(el.getAttribute('data-i18n-title'));
					el.setAttribute('aria-label', el.title);
				});
				document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
					el.placeholder = window.gaT(el.getAttribute('data-i18n-placeholder'));
				});
			};
			document.addEventListener('DOMContentLoaded', window.gaApplyI18n);
			// In case DOMContentLoaded already fired (race with inline scripts):
			if (document.readyState !== 'loading') { window.gaApplyI18n(); }
		})();

		// Apply theme preference up-front so we don't flash the wrong
		// palette while the rest of the JS boots.
		(function () {
			var theme = (window.gaPrefs && window.gaPrefs.theme) || 'auto';
			if (theme === 'light') { document.documentElement.setAttribute('data-theme', 'light'); }
			else if (theme === 'dark') { document.documentElement.setAttribute('data-theme', 'dark'); }
			// 'auto' = follow VS Code; we leave the attribute unset and
			// rely on var(--vscode-*) tokens / system preference.
		})();

		// ── Backend API client (postMessage proxy to extension host) ───
		// Direct fetch from a webview to http://127.0.0.1 hits CORS, so we
		// route every /api/* call through the extension host which is a
		// Node process and thus exempt.  Each call gets a unique requestId
		// so concurrent calls don't trample each other.
		window.__GA_HTTP_BASE__ = 'http://127.0.0.1:${httpPort}'; // diagnostic only
		window.gaApi = (function () {
			const _vscode = acquireVsCodeApi();
			// We can only call acquireVsCodeApi() once per webview, so we
			// stash the handle and re-use it; the chat IIFE later picks it
			// up from window.__GA_VSCODE__ to avoid double-acquisition.
			window.__GA_VSCODE__ = _vscode;
			const _pending = new Map(); // requestId → { resolve, reject }
			const _sophubPending = new Map();
			window.addEventListener('message', function (ev) {
				const m = ev.data;
				if (!m) { return; }
				if (m.kind === 'apiResult') {
					const p = _pending.get(m.requestId);
					if (!p) { return; }
					_pending.delete(m.requestId);
					if (m.error) { p.reject(new Error(m.error)); }
					else { p.resolve(m.data); }
					return;
				}
				if (m.kind === 'sophubResult') {
					const p = _sophubPending.get(m.requestId);
					if (!p) { return; }
					_sophubPending.delete(m.requestId);
					if (m.error) { p.reject(new Error(m.error)); }
					else { p.resolve(m.data); }
					return;
				}
			});
			let _seq = 0;
			function _call(method, url, body) {
				return new Promise(function (resolve, reject) {
					const requestId = 'r' + (++_seq) + '_' + Date.now();
					_pending.set(requestId, { resolve: resolve, reject: reject });
					_vscode.postMessage({ kind: 'apiCall', requestId: requestId, method: method, url: url, body: body });
					// Timeout safety so a lost reply doesn't leak forever.
					setTimeout(function () {
						if (_pending.has(requestId)) {
							_pending.delete(requestId);
							reject(new Error('API timeout: ' + url));
						}
					}, 15000);
				});
			}
			function _get(u) { return _call('GET', u); }
			function _post(u, body) { return _call('POST', u, body); }
			return {
				listSessions: function (q) { return _get('/api/sessions' + (q ? '?q=' + encodeURIComponent(q) : '')); },
				getSessionHistory: function (path) { return _get('/api/session/history?path=' + encodeURIComponent(path)).then(function (r) { return r.messages || []; }); },
				restoreSession: function (path) { return _post('/api/session/restore', { path: path }); },
				renameSession: function (path, title) { return _post('/api/session/rename', { path: path, title: title }); },
				deleteSession: function (path) { return _post('/api/session/delete', { path: path }); },
				listSkills: function () { return _get('/api/skills'); },
				getSop: function (name) { return _get('/api/skills/sop?name=' + encodeURIComponent(name)); },
				getStatus: function () { return _get('/api/status'); },
				getLLMConfig: function () { return _get('/api/llm-config'); },
				saveLLMConfig: function (data) { return _post('/api/llm-config', data); },
				reloadLLMConfig: function () { return _post('/api/llm-config/reload', {}); },
				listModels: function (apikey, apibase, proxy) { return _post('/api/llm-config/list-models', { apikey: apikey, apibase: apibase, proxy: proxy }); },
				sophub: function (op, payload) {
					return new Promise(function (resolve, reject) {
						const requestId = 's' + (++_seq) + '_' + Date.now();
						_sophubPending.set(requestId, { resolve: resolve, reject: reject });
						_vscode.postMessage({ kind: 'sophub', requestId: requestId, op: op, payload: payload || {} });
						setTimeout(function () {
							if (_sophubPending.has(requestId)) {
								_sophubPending.delete(requestId);
								reject(new Error('Sophub timeout: ' + op));
							}
						}, 30000);
					});
				},
			};
		})();

		// ── Inlined assistantParser.js (pure, dependency-free) ─────────
		` + parserSrc + `
		// ── Chat UI ────────────────────────────────────────────────────
		(function () {
			// Re-use the vscode API handle obtained by gaApi above —
			// acquireVsCodeApi() can only be called once per webview.
			const vscode = window.__GA_VSCODE__;
			const logEl = document.getElementById('log');
			const jumpBtn = document.getElementById('jump-latest');
			const inputEl = document.getElementById('input');
			const sendBtn = document.getElementById('send');
			const resetBtn = document.getElementById('btn-reset');
			const statusDot = document.getElementById('status-dot');
			const statusLlm = document.getElementById('status-llm');
			const popupEl = document.getElementById('mention-popup');
			const chipsEl = document.getElementById('attached-files');

			let running = false;
			let pendingAssistant = null; // { el, bodyEl }
			let unseenAssistantCount = 0;
			const jumpLabel = 'Jump to latest';

			// ─── @mention state ─────────────────────────────────────────
			// 'attachments' is an append-only map: relative path (as shown
			// in the textarea after '@') → absolute path.  We consult it on
			// submit to build the 'files' payload.  Removal only happens
			// when the user deletes the chip or clears the textarea.
			const attachments = new Map();
			// The popup is either hidden or showing a list tied to an active
			// @-trigger range in the textarea.  'trigger' tracks:
			//   start  — index of the '@' in the textarea value
			//   end    — index where the query ends (cursor position)
			//   items  — current suggestion list [{rel, abs, name}, ...]
			//   active — index of highlighted item
			//   seq    — monotonic query id (ignore stale responses)
			let trigger = null;
			let querySeq = 0;
			let queryTimer = null;

			function renderChips() {
				chipsEl.innerHTML = '';
				if (attachments.size === 0) { return; }
				for (const [rel, abs] of attachments) {
					const chip = document.createElement('span');
					chip.className = 'chip';
					chip.title = abs;
					chip.textContent = '@' + rel;
					const rm = document.createElement('span');
					rm.className = 'remove';
					rm.textContent = '×';
					rm.addEventListener('click', () => {
						attachments.delete(rel);
						// Also remove the token from the textarea text if it's
						// still there, so the two views stay in sync.
						const re = new RegExp('@' + rel.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + '(?=\\\\s|$)', 'g');
						inputEl.value = inputEl.value.replace(re, '').replace(/\\s{2,}/g, ' ').trimStart();
						renderChips();
						autoResize();
					});
					chip.appendChild(rm);
					chipsEl.appendChild(chip);
				}
			}

			function hidePopup() {
				trigger = null;
				popupEl.classList.remove('show');
				popupEl.innerHTML = '';
			}

			function renderPopup(items, activeIdx) {
				popupEl.innerHTML = '';
				if (!items || items.length === 0) {
					const empty = document.createElement('div');
					empty.className = 'empty';
					empty.textContent = 'No matching files.';
					popupEl.appendChild(empty);
				} else {
					for (let i = 0; i < items.length; i++) {
						const it = items[i];
						const row = document.createElement('div');
						row.className = 'mitem' + (i === activeIdx ? ' active' : '');
						row.setAttribute('role', 'option');
						row.dataset.idx = String(i);
						const n = document.createElement('span');
						n.className = 'mname';
						n.textContent = it.name;
						const p = document.createElement('span');
						p.className = 'mpath';
						p.textContent = it.rel;
						row.appendChild(n);
						row.appendChild(p);
						row.addEventListener('mousedown', ev => {
							// mousedown (not click) so it fires before the
							// textarea loses focus and we can keep the cursor.
							ev.preventDefault();
							selectMention(i);
						});
						popupEl.appendChild(row);
					}
				}
				const hint = document.createElement('div');
				hint.className = 'mhint';
				hint.textContent = '↑↓ navigate · ↵ select · esc cancel';
				popupEl.appendChild(hint);
				popupEl.classList.add('show');
			}

			// Detect whether the caret is sitting inside an @-trigger — i.e.
			// an '@' that isn't preceded by a non-whitespace char, and the
			// query so far (between '@' and caret) has no whitespace.
			function detectTrigger() {
				const pos = inputEl.selectionStart;
				const val = inputEl.value.slice(0, pos);
				const at = val.lastIndexOf('@');
				if (at < 0) { return null; }
				// Preceded by whitespace or BOL?
				if (at > 0 && !/\\s/.test(val[at - 1])) { return null; }
				const query = val.slice(at + 1);
				if (/\\s/.test(query)) { return null; }
				return { start: at, end: pos, query };
			}

			function queryFiles(q) {
				const seq = ++querySeq;
				clearTimeout(queryTimer);
				queryTimer = setTimeout(() => {
					vscode.postMessage({ kind: 'files_query', q, seq });
				}, 60); // debounce
			}

			function selectMention(idx) {
				if (!trigger || !trigger.items || !trigger.items[idx]) { return; }
				const it = trigger.items[idx];
				const val = inputEl.value;
				const before = val.slice(0, trigger.start);
				const after = val.slice(trigger.end);
				const insert = '@' + it.rel + ' ';
				inputEl.value = before + insert + after;
				const newPos = before.length + insert.length;
				inputEl.setSelectionRange(newPos, newPos);
				attachments.set(it.rel, it.abs);
				renderChips();
				hidePopup();
				autoResize();
				inputEl.focus();
			}

			function onInputChanged() {
				const t = detectTrigger();
				if (!t) { hidePopup(); return; }
				trigger = Object.assign({ items: trigger?.items || [], active: 0, seq: 0 }, t);
				queryFiles(t.query);
			}

			// Keyboard within the textarea — delegated to the popup when
			// it's open, otherwise falls through to the normal submit flow.
			function onInputKeyDown(e) {
				if (popupEl.classList.contains('show') && trigger && trigger.items && trigger.items.length > 0) {
					if (e.key === 'ArrowDown') {
						e.preventDefault();
						trigger.active = (trigger.active + 1) % trigger.items.length;
						renderPopup(trigger.items, trigger.active);
						return;
					}
					if (e.key === 'ArrowUp') {
						e.preventDefault();
						trigger.active = (trigger.active - 1 + trigger.items.length) % trigger.items.length;
						renderPopup(trigger.items, trigger.active);
						return;
					}
					if (e.key === 'Enter' || e.key === 'Tab') {
						e.preventDefault();
						selectMention(trigger.active);
						return;
					}
					if (e.key === 'Escape') {
						e.preventDefault();
						hidePopup();
						return;
					}
				}
				// normal submit-on-enter handling lives in the existing
				// keydown listener attached below.
			}

			// ─── Minimal safe markdown renderer ──────────────────────────
			// Strategy: escape ALL HTML first so LLM-produced markup can't
			// inject tags, then apply regex-based transforms over the escaped
			// text.  Output is a DOM fragment because innerHTML is still
			// used below — but every substitution inserts tags WE construct
			// ourselves, so the result is safe-by-construction.
			//
			// Supported:
			//   - fenced code blocks  \`\`\`lang\\n...\\n\`\`\`
			//   - inline code         \`x\`
			//   - headings            # / ## / ### at line start
			//   - blockquote          > ...
			//   - ordered/unordered   - / * / 1.
			//   - bold                **x** / __x__
			//   - italic              *x* / _x_
			//   - links               [label](url)   (url must be http/https)
			//   - horizontal rule     ---
			//   - paragraphs          blank-line separated
			function escapeHtml(s) {
				return s.replace(/[&<>"']/g, c => ({
					'&': '&amp;', '<': '&lt;', '>': '&gt;',
					'"': '&quot;', "'": '&#39;'
				}[c]));
			}
			function escapeAttr(s) { return escapeHtml(s); }

			function renderMarkdown(src, opts) {
				if (!src) { return ''; }
				opts = opts || {};
				// 1) Extract fenced code blocks FIRST so their contents skip
				//    all other transforms.  Stash with placeholders.
				const stash = [];
				const take = html => { stash.push(html); return '\\x00' + (stash.length - 1) + '\\x00'; };
				// Fence info grammar we accept (Cursor-compatible):
				//   \`\`\`lang
				//   \`\`\`lang:path/to/file.ext      (explicit target file)
				//   \`\`\`lang path/to/file.ext      (space-separated variant)
				//   \`\`\` path/to/file.ext          (no language)
				// The whole info string is anything up to end of line.
				let text = src.replace(/\`\`\`([^\\n]*)\\n([\\s\\S]*?)(?:\`\`\`|$)/g,
					(_m, info, body) => {
						const raw = (info || '').trim();
						// Split info into optional lang token + optional filename.
						// A lang is a \`\`word-ish'' token (letters/digits/-_+#.); if
						// present it's the first whitespace-or-colon-delimited piece.
						let lang = '';
						let filename = '';
						const mLangFile = /^([a-zA-Z0-9_+#.\\-]+)[:\\s]+(\\S.*)$/.exec(raw);
						const mLangOnly = /^([a-zA-Z0-9_+#.\\-]+)$/.exec(raw);
						if (mLangFile) {
							lang = mLangFile[1];
							filename = mLangFile[2].trim();
						} else if (mLangOnly) {
							lang = mLangOnly[1];
						} else if (raw && /[\\/.]/.test(raw)) {
							// No language but looks like a path
							filename = raw;
						} else {
							lang = raw; // unrecognized — treat as lang label
						}
						const safeLang = lang.toLowerCase().replace(/[^a-z0-9_+#.\\-]/g, '');
						const safeFile = filename.replace(/[<>"'\`]/g, ''); // strip html-unsafe chars (full escape below)
						const escaped = escapeHtml(body.replace(/\\n$/, ''));
						const langLabel = safeLang || 'text';
						const fileLabel = safeFile ? ' · ' + escapeHtml(safeFile) : '';
						// Apply is offered for anything that smells like code.
						// We skip purely descriptive fences (text/plaintext/output)
						// to reduce footgun risk.
						const APPLY_SKIP = ['text', 'txt', 'plaintext', 'output', 'stdout', 'stderr', ''];
						const showActions = opts.codeActions !== false;
						const showApply = showActions && (APPLY_SKIP.indexOf(safeLang) < 0 || !!safeFile);
						const applyBtn = showApply
							? '<button class="apply" data-apply' +
								(safeFile ? ' data-file="' + escapeAttr(safeFile) + '"' : '') +
								(safeLang ? ' data-lang="' + escapeAttr(safeLang) + '"' : '') +
							'>Apply</button>'
							: '';
						const copyBtn = showActions ? '<button class="copy" data-copy>Copy</button>' : '';
						return take(
							'<pre><div class="codeblock-header">' +
								'<span class="lang">' + langLabel + fileLabel + '</span>' +
								applyBtn +
								copyBtn +
							'</div><code>' + escaped + '</code></pre>'
						);
					});

				// 2) Escape remaining HTML in the rest of the text.
				text = escapeHtml(text);

				// 3) Inline transforms.
				//    Inline code — must come before bold/italic so '*' inside
				//    backticks is preserved.
				text = text.replace(/\`([^\`\\n]+?)\`/g, (_m, code) => {
					return take('<code>' + code + '</code>');
				});
				//    Links [label](http(s)://...) — only safe schemes.
				text = text.replace(/\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g,
					(_m, label, url) => '<a href="' + escapeAttr(url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>');
				//    Bold (**x** or __x__)  — non-greedy, no line break inside.
				text = text.replace(/\\*\\*([^\\n*][^\\n]*?)\\*\\*/g, '<strong>$1</strong>');
				text = text.replace(/(^|[\\s(])__([^\\n_][^\\n]*?)__(?=[\\s).,!?;:]|$)/g, '$1<strong>$2</strong>');
				//    Italic (*x* or _x_) — must avoid matching ** already consumed.
				text = text.replace(/(^|[\\s(*])\\*([^\\n*][^\\n]*?)\\*(?=[\\s).,!?;:]|$)/g, '$1<em>$2</em>');
				text = text.replace(/(^|[\\s(])_([^\\n_][^\\n]*?)_(?=[\\s).,!?;:]|$)/g, '$1<em>$2</em>');

				// 4) Block-level transforms — operate on lines.
				const lines = text.split('\\n');
				const out = [];
				let listType = null; // 'ul' | 'ol' | null
				const closeList = () => { if (listType) { out.push('</' + listType + '>'); listType = null; } };
				let inPara = false;
				const closePara = () => { if (inPara) { out.push('</p>'); inPara = false; } };

				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					// preserved code block placeholder — emit as its own block
					if (/^\\x00\\d+\\x00\\s*$/.test(line)) {
						closePara(); closeList();
						out.push(line);
						continue;
					}
					const h = /^(#{1,3})\\s+(.+)$/.exec(line);
					if (h) {
						closePara(); closeList();
						const lvl = h[1].length;
						out.push('<h' + lvl + '>' + h[2] + '</h' + lvl + '>');
						continue;
					}
					if (/^\\s*---+\\s*$/.test(line)) {
						closePara(); closeList();
						out.push('<hr>');
						continue;
					}
					const bq = /^\\s*&gt;\\s?(.*)$/.exec(line);
					if (bq) {
						closePara(); closeList();
						out.push('<blockquote>' + bq[1] + '</blockquote>');
						continue;
					}
					const ul = /^\\s*[-*]\\s+(.+)$/.exec(line);
					const ol = /^\\s*\\d+\\.\\s+(.+)$/.exec(line);
					if (ul || ol) {
						closePara();
						const want = ul ? 'ul' : 'ol';
						if (listType && listType !== want) { closeList(); }
						if (!listType) { listType = want; out.push('<' + want + '>'); }
						out.push('<li>' + (ul ? ul[1] : ol[1]) + '</li>');
						continue;
					}
					if (line.trim() === '') {
						closePara(); closeList();
						continue;
					}
					// plain line — fold into a paragraph
					if (!inPara) { out.push('<p>'); inPara = true; }
					else { out.push('<br>'); }
					out.push(line);
				}
				closePara(); closeList();

				// 5) Re-inflate stashed code fragments.
				return out.join('\\n').replace(/\\x00(\\d+)\\x00/g, (_m, idx) => stash[+idx]);
			}

			// ─── Cursor-style structured assistant render ────────────────
			// The assistant's raw buffer is parsed into typed segments
			// (turn / thinking / summary / tool / narrative) and each is
			// rendered as its own DOM node.  The open/closed state for
			// tool and thinking cards is remembered on the body element
			// itself — keyed by segment.key — so stream refreshes don't
			// clobber what the user has manually opened/closed.
			//
			//   bodyEl._segStates   Map<segKey, 'open'|'closed'>  (user override)
			//   bodyEl._segTouched  Set<segKey>                   (user toggled)
			function renderAssistantBody(bodyEl, raw, isFinal) {
				if (!bodyEl._segStates) { bodyEl._segStates = new Map(); }
				if (!bodyEl._segTouched) { bodyEl._segTouched = new Set(); }
				if (!bodyEl._turnStates) { bodyEl._turnStates = new Map(); }
				if (!bodyEl._turnTouched) { bodyEl._turnTouched = new Set(); }
				const rawSegs = parseAssistantSegments(raw || '');

				// Cursor-style minimalism: drop noise that the user almost
				// never wants to see.
				//   - Auto-generated summary cards just paraphrase the
				//     turn narrative, so kill them outright.
				//   - When the response uses no tools at all, the whole
				//     TURN-N / N-THOUGHT scaffolding is theatre, so we
				//     flatten the structure and render only the prose.
				const segs = rawSegs.filter(s => s.kind !== 'summary');
				const hasTools = segs.some(s => s.kind === 'tool');
				const flattenSingleTurn = !window.gaPrefs || window.gaPrefs.flattenSingleTurn !== false;
				const flatten = flattenSingleTurn && !hasTools;

				const turnSummaries = buildTurnSummaries(segs, isFinal);
				// Clear and re-emit.  Full rebuild is fine — we throttle
				// stream updates to ~15fps and the DOM stays modest.
				bodyEl.innerHTML = '';
				let turnBlock = null;
				segs.forEach((seg, i) => {
					if (flatten && seg.kind === 'turn') {
						// In flatten mode we drop the turn-divider entirely
						// and let subsequent segments flow at body level.
						turnBlock = null;
						return;
					}
					const isLast = i === segs.length - 1;
					const node = buildSegmentNode(seg, isLast, isFinal, bodyEl._segStates, bodyEl._segTouched, bodyEl._turnStates, bodyEl._turnTouched, turnSummaries);
					if (!node) { return; }
					if (seg.kind === 'turn') {
						bodyEl.appendChild(node);
						turnBlock = document.createElement('div');
						turnBlock.className = 'turn-block';
						turnBlock.dataset.turnKey = seg.key;
						turnBlock.dataset.state = node.dataset.state || 'open';
						bodyEl.appendChild(turnBlock);
						return;
					}
					if (turnBlock) { turnBlock.appendChild(node); }
					else { bodyEl.appendChild(node); }
				});
				updateAssistantMeta(bodyEl, segs, isFinal);
			}

			function desiredState(seg, isLast, isFinal, segStates, segTouched) {
				const user = segStates.get(seg.key);
				if (user && segTouched.has(seg.key)) { return user; }
				// Defaults: thinking/summary always closed, tool cards
				// open while actively streaming (last + unclosed output)
				// or if final and failed, closed otherwise.
				if (seg.kind === 'thinking' || seg.kind === 'summary') {
					const collapseThinking = !window.gaPrefs || window.gaPrefs.collapseThinking !== false;
					return collapseThinking ? 'closed' : 'open';
				}
				if (seg.kind === 'tool') {
					if (seg.status === '❌') { return 'open'; }
					if (!isFinal && isLast && !seg.outputClosed) { return 'open'; }
					return 'closed';
				}
				return 'open';
			}

			function buildCardHead(className, state, iconText, badgeText, titleText, previewText, statusText, statusTone, spinning) {
				const head = document.createElement('div');
				head.className = className;
				head.dataset.segToggle = '1';
				head.tabIndex = 0;
				head.setAttribute('role', 'button');
				head.setAttribute('aria-expanded', state === 'open' ? 'true' : 'false');
				const chev = document.createElement('span');
				chev.className = 'tool-chev';
				chev.textContent = '▸';
				const icon = document.createElement('span');
				icon.className = 'tool-icon';
				icon.textContent = iconText;
				const main = document.createElement('div');
				main.className = 'tool-head-main';
				const titleRow = document.createElement('div');
				titleRow.className = 'tool-title-row';
				const badge = document.createElement('span');
				badge.className = 'tool-badge';
				badge.textContent = badgeText;
				const title = document.createElement('span');
				title.className = 'tool-name';
				title.textContent = titleText;
				titleRow.appendChild(badge);
				titleRow.appendChild(title);
				const preview = document.createElement('div');
				preview.className = 'tool-preview';
				preview.textContent = previewText || 'No preview';
				if (!previewText) { preview.classList.add('empty'); }
				main.appendChild(titleRow);
				main.appendChild(preview);
				head.appendChild(chev);
				head.appendChild(icon);
				head.appendChild(main);
				if (statusText || spinning) {
					const meta = document.createElement('div');
					meta.className = 'tool-meta';
					if (statusText) {
						const status = document.createElement('span');
						status.className = 'tool-status' + (statusTone ? ' ' + statusTone : '');
						status.textContent = statusText;
						meta.appendChild(status);
					}
					if (spinning) {
						const spinner = document.createElement('span');
						spinner.className = 'tool-spinner';
						meta.appendChild(spinner);
					}
					head.appendChild(meta);
				}
				return head;
			}

			function summarizeInline(text, fallback) {
				const compact = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
				if (!compact) { return fallback || ''; }
				return compact.length <= 96 ? compact : compact.slice(0, 95) + '…';
			}

			function summarizeToolOutput(output) {
				const lines = String(output || '')
					.split(new RegExp('\\r?\\n'))
					.map(line => line.trim())
					.filter(line => line && !/^\[Status\]\s/.test(line));
				return lines.length > 0 ? summarizeInline(lines[0], '') : '';
			}

			function humanizeToolName(name) {
				const words = String(name || 'tool').split('_').filter(Boolean);
				if (words.length === 0) { return 'Tool'; }
				return words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
			}

			function getToolDisplay(seg, isFinal) {
				const lower = String(seg.name || '').toLowerCase();
				let icon = '🛠️';
				let badge = 'Tool';
				let title = humanizeToolName(seg.name);
				if (/(^|_)read(_|$)|file_read/.test(lower)) {
					icon = '📄';
					badge = 'Read';
					title = 'Read file';
				} else if (/write_to_file|(^|_)write(_|$)/.test(lower)) {
					icon = '✍️';
					badge = 'Write';
					title = 'Write file';
				} else if (/apply_patch|edit/.test(lower)) {
					icon = '✏️';
					badge = 'Edit';
					title = 'Edit file';
				} else if (/grep|search|find/.test(lower)) {
					icon = '🔎';
					badge = 'Search';
					title = 'Search workspace';
				} else if (/list_dir/.test(lower)) {
					icon = '📁';
					badge = 'Browse';
					title = 'Browse files';
				} else if (/run_command|command_status|code_run/.test(lower)) {
					icon = '⌘';
					badge = 'Run';
					title = 'Run command';
				} else if (/ask_user_question/.test(lower)) {
					icon = '❓';
					badge = 'Ask';
					title = 'Ask you';
				} else if (/browser_preview/.test(lower)) {
					icon = '🌐';
					badge = 'Preview';
					title = 'Open preview';
				} else if (/read_url_content|search_web/.test(lower)) {
					icon = '🌐';
					badge = 'Web';
					title = 'Browse web';
				} else if (/todo_list/.test(lower)) {
					icon = '☑️';
					badge = 'Plan';
					title = 'Update plan';
				} else if (/deploy_web_app/.test(lower)) {
					icon = '🚀';
					badge = 'Deploy';
					title = 'Deploy app';
				}
				let statusText = '';
				let statusTone = '';
				let spinning = false;
				if (seg.status === '✅') {
					statusText = 'Finished';
					statusTone = 'ok';
				} else if (seg.status === '❌') {
					statusText = 'Failed';
					statusTone = 'err';
				} else if (!seg.outputClosed) {
					statusText = 'Running';
					statusTone = 'run';
					spinning = true;
				} else if (isFinal) {
					statusText = seg.output ? 'Completed' : 'Called';
				} else {
					statusText = 'Pending';
				}
				return {
					icon,
					badge,
					title,
					preview: summarizeInline(previewArgs(seg.name, seg.args), '') || summarizeToolOutput(seg.output),
					statusText,
					statusTone,
					spinning,
				};
			}

			function getThinkingDisplay(seg) {
				const isSummary = seg.kind === 'summary';
				return {
					icon: isSummary ? '📝' : '💭',
					badge: isSummary ? 'Summary' : 'Thinking',
					title: isSummary ? 'Turn summary' : 'Reasoning',
					preview: summarizeInline(seg.text, seg.closed ? '' : 'Streaming…'),
					statusText: seg.closed ? '' : (isSummary ? 'Updating' : 'Thinking'),
					statusTone: 'run',
					spinning: !seg.closed,
				};
			}

			function buildTurnSummaries(segs, isFinal) {
				const out = new Map();
				let current = null;
				for (const seg of segs) {
					if (seg.kind === 'turn') {
						current = { tools: 0, thinking: 0, running: false, preview: '' };
						out.set(seg.key, current);
						continue;
					}
					if (!current) { continue; }
					if (seg.kind === 'narrative') {
						if (!current.preview) { current.preview = summarizeInline(seg.text, ''); }
						continue;
					}
					if (seg.kind === 'tool') {
						current.tools++;
						if (!current.preview) {
							const info = getToolDisplay(seg, isFinal);
							current.preview = info.preview || info.title;
						}
						if (!isFinal && !seg.outputClosed) { current.running = true; }
						continue;
					}
					if (seg.kind === 'thinking' || seg.kind === 'summary') {
						current.thinking++;
						if (!current.preview) {
							const info = getThinkingDisplay(seg);
							current.preview = info.preview || info.title;
						}
						if (!isFinal && !seg.closed) { current.running = true; }
					}
				}
				return out;
			}

			function buildSegmentNode(seg, isLast, isFinal, segStates, segTouched, turnStates, turnTouched, turnSummaries) {
				if (seg.kind === 'turn') {
					return buildTurnDivider(seg, turnStates, turnTouched, turnSummaries.get(seg.key));
				}
				if (seg.kind === 'narrative') {
					const el = document.createElement('div');
					el.className = 'narrative';
					el.dataset.segKey = seg.key;
					el.innerHTML = renderMarkdown(seg.text);
					return el;
				}
				if (seg.kind === 'thinking' || seg.kind === 'summary') {
					const el = document.createElement('div');
					el.className = 'thinking-card';
					if (!isFinal && isLast && !seg.closed) { el.classList.add('active'); }
					el.dataset.segKey = seg.key;
					const state = desiredState(seg, isLast, isFinal, segStates, segTouched);
					el.dataset.state = state;
					const info = getThinkingDisplay(seg);
					const head = buildCardHead(
						'thinking-head',
						state,
						info.icon,
						info.badge,
						info.title,
						info.preview,
						info.statusText,
						info.statusTone,
						info.spinning,
					);
					const body = document.createElement('div');
					body.className = 'thinking-body';
					const pre = document.createElement('pre');
					pre.textContent = seg.text || '';
					body.appendChild(pre);
					el.appendChild(head);
					el.appendChild(body);
					return el;
				}
				if (seg.kind === 'tool') {
					const el = document.createElement('div');
					el.className = 'tool-card';
					if (!isFinal && isLast && !seg.outputClosed) { el.classList.add('active'); }
					// Status → border colour class for at-a-glance scan.
					if (seg.status === '✅') { el.classList.add('status-ok'); }
					else if (seg.status === '❌') { el.classList.add('status-err'); }
					else if (!seg.outputClosed) { el.classList.add('status-run'); }
					el.dataset.segKey = seg.key;
					const state = desiredState(seg, isLast, isFinal, segStates, segTouched);
					el.dataset.state = state;
					const info = getToolDisplay(seg, isFinal);
					const head = buildCardHead(
						'tool-head',
						state,
						info.icon,
						info.badge,
						info.title,
						info.preview,
						info.statusText,
						info.statusTone,
						info.spinning,
					);
					const body = document.createElement('div');
					body.className = 'tool-body';
					if (seg.args) {
						const lbl = document.createElement('div');
						lbl.className = 'section-label';
						lbl.textContent = 'Arguments';
						body.appendChild(lbl);
						const pre = document.createElement('pre');
						pre.textContent = seg.args;
						body.appendChild(pre);
					}
					if (seg.output) {
						const lbl2 = document.createElement('div');
						lbl2.className = 'section-label';
						lbl2.textContent = 'Output';
						body.appendChild(lbl2);
						const pre2 = document.createElement('pre');
						pre2.textContent = seg.output;
						body.appendChild(pre2);
					}
					el.appendChild(head);
					el.appendChild(body);
					return el;
				}
				return null;
			}

			function escapeText(s) {
				return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
					'&': '&amp;', '<': '&lt;', '>': '&gt;',
					'"': '&quot;', "'": '&#39;'
				}[c]));
			}

			function setCardState(card, next) {
				card.dataset.state = next;
				const toggle = card.querySelector('[data-seg-toggle]');
				if (toggle) {
					toggle.setAttribute('aria-expanded', next === 'open' ? 'true' : 'false');
				}
				const bodyEl = card.closest('.body');
				const key = card.dataset.segKey;
				if (bodyEl && key) {
					if (!bodyEl._segStates) { bodyEl._segStates = new Map(); }
					if (!bodyEl._segTouched) { bodyEl._segTouched = new Set(); }
					bodyEl._segStates.set(key, next);
					bodyEl._segTouched.add(key);
				}
			}

			function toggleSegmentCard(card) {
				const cur = card.dataset.state || 'closed';
				setCardState(card, cur === 'open' ? 'closed' : 'open');
			}

			function isNearBottom() {
				return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
			}

			function refreshJumpButton() {
				const detached = !isNearBottom();
				if (!detached) { unseenAssistantCount = 0; }
				jumpBtn.classList.toggle('show', detached);
				jumpBtn.textContent = detached && unseenAssistantCount > 0
					? jumpLabel + ' · ' + unseenAssistantCount
					: jumpLabel;
			}

			function scrollToBottom(force) {
				if (force) { logEl.scrollTop = logEl.scrollHeight; }
				refreshJumpButton();
			}

			function summarizeAssistantSegments(segs, isFinal) {
				const turns = segs.filter(seg => seg.kind === 'turn').length;
				const tools = segs.filter(seg => seg.kind === 'tool').length;
				const thinking = segs.filter(seg => seg.kind === 'thinking' || seg.kind === 'summary').length;
				const running = segs.some(seg =>
					(seg.kind === 'tool' && !seg.outputClosed) ||
					((seg.kind === 'thinking' || seg.kind === 'summary') && !seg.closed));
				return { turns, tools, thinking, running: !isFinal && running };
			}

			function desiredTurnState(turnKey, turnStates, turnTouched) {
				const user = turnStates.get(turnKey);
				if (user && turnTouched.has(turnKey)) { return user; }
				return 'open';
			}

			function buildTurnDivider(seg, turnStates, turnTouched, summary) {
				const el = document.createElement('div');
				el.className = 'turn-divider';
				el.dataset.segKey = seg.key;
				el.dataset.turnToggle = '1';
				el.dataset.state = desiredTurnState(seg.key, turnStates, turnTouched);
				el.tabIndex = 0;
				el.setAttribute('role', 'button');
				el.setAttribute('aria-expanded', el.dataset.state === 'open' ? 'true' : 'false');
				const main = document.createElement('span');
				main.className = 'turn-main';
				const label = document.createElement('span');
				label.className = 'turn-label';
				const chev = document.createElement('span');
				chev.className = 'turn-chev';
				chev.textContent = '▸';
				const text = document.createElement('span');
				text.textContent = 'Turn ' + seg.n;
				label.appendChild(chev);
				label.appendChild(text);
				main.appendChild(label);
				const meta = document.createElement('span');
				meta.className = 'turn-meta';
				if (summary && summary.running) {
					const pill = document.createElement('span');
					pill.className = 'turn-pill run';
					pill.textContent = 'Running';
					meta.appendChild(pill);
				}
				if (summary && summary.tools) {
					const pill = document.createElement('span');
					pill.className = 'turn-pill';
					pill.textContent = summary.tools + ' tool' + (summary.tools > 1 ? 's' : '');
					meta.appendChild(pill);
				}
				if (summary && summary.thinking) {
					const pill = document.createElement('span');
					pill.className = 'turn-pill';
					pill.textContent = summary.thinking + ' thought' + (summary.thinking > 1 ? 's' : '');
					meta.appendChild(pill);
				}
				const preview = document.createElement('span');
				preview.className = 'turn-preview';
				preview.textContent = (summary && summary.preview) || 'No preview';
				if (!summary || !summary.preview) { preview.classList.add('empty'); }
				meta.appendChild(preview);
				main.appendChild(meta);
				el.appendChild(main);
				return el;
			}

			function updateAssistantMeta(bodyEl, segs, isFinal) {
				const msgEl = bodyEl.closest('.msg.assistant');
				if (!msgEl) { return; }
				const summaryEl = msgEl.querySelector('.msg-summary');
				if (!summaryEl) { return; }
				const summary = summarizeAssistantSegments(segs, isFinal);
				summaryEl.innerHTML = '';
				if (summary.running) {
					const pill = document.createElement('span');
					pill.className = 'msg-pill run';
					pill.textContent = 'Running';
					summaryEl.appendChild(pill);
				} else if (segs.length > 0) {
					const pill = document.createElement('span');
					pill.className = 'msg-pill ok';
					pill.textContent = 'Ready';
					summaryEl.appendChild(pill);
				}
				[
					[summary.turns, 'turn'],
					[summary.tools, 'tool'],
					[summary.thinking, 'thought'],
				].forEach(([count, label]) => {
					if (!count) { return; }
					const pill = document.createElement('span');
					pill.className = 'msg-pill';
					pill.textContent = count + ' ' + label + (count > 1 ? 's' : '');
					summaryEl.appendChild(pill);
				});
			}

			function setTurnState(divider, next) {
				divider.dataset.state = next;
				divider.setAttribute('aria-expanded', next === 'open' ? 'true' : 'false');
				const bodyEl = divider.closest('.body');
				const key = divider.dataset.segKey;
				const block = divider.nextElementSibling;
				if (block && block.classList && block.classList.contains('turn-block')) {
					block.dataset.state = next;
				}
				if (bodyEl && key) {
					if (!bodyEl._turnStates) { bodyEl._turnStates = new Map(); }
					if (!bodyEl._turnTouched) { bodyEl._turnTouched = new Set(); }
					bodyEl._turnStates.set(key, next);
					bodyEl._turnTouched.add(key);
				}
			}

			function toggleTurnBlock(divider) {
				const cur = divider.dataset.state || 'open';
				setTurnState(divider, cur === 'open' ? 'closed' : 'open');
			}

			function buildAssistantActions() {
				const wrap = document.createElement('div');
				wrap.className = 'msg-actions';
				const copy = document.createElement('button');
				copy.type = 'button';
				copy.setAttribute('data-msg-copy', '1');
				copy.textContent = 'Copy';
				const copyMd = document.createElement('button');
				copyMd.type = 'button';
				copyMd.setAttribute('data-msg-copy-md', '1');
				copyMd.textContent = 'Copy md';
				const insert = document.createElement('button');
				insert.type = 'button';
				insert.setAttribute('data-msg-insert', '1');
				insert.textContent = 'Insert';
				const quote = document.createElement('button');
				quote.type = 'button';
				quote.setAttribute('data-msg-quote', '1');
				quote.textContent = 'Quote';
				const expand = document.createElement('button');
				expand.type = 'button';
				expand.setAttribute('data-msg-expand', '1');
				expand.textContent = 'Expand';
				const collapse = document.createElement('button');
				collapse.type = 'button';
				collapse.setAttribute('data-msg-collapse', '1');
				collapse.textContent = 'Collapse';
				const retry = document.createElement('button');
				retry.type = 'button';
				retry.setAttribute('data-msg-retry', '1');
				retry.textContent = 'Retry';
				wrap.appendChild(copy);
				wrap.appendChild(copyMd);
				wrap.appendChild(insert);
				wrap.appendChild(quote);
				wrap.appendChild(expand);
				wrap.appendChild(collapse);
				wrap.appendChild(retry);
				return wrap;
			}

			function flashButton(btn, label, ms) {
				btn.classList.add('done');
				const prev = btn.textContent;
				btn.textContent = label;
				setTimeout(() => {
					btn.classList.remove('done');
					btn.textContent = prev;
				}, ms);
			}

			function copyText(text, onDone) {
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(text).then(onDone, () => fallback());
				} else {
					fallback();
				}
				function fallback() {
					const ta = document.createElement('textarea');
					ta.value = text;
					ta.style.position = 'fixed'; ta.style.opacity = '0';
					document.body.appendChild(ta);
					ta.select();
					try { document.execCommand('copy'); onDone(); }
					finally { document.body.removeChild(ta); }
				}
			}

			function getMessageRawText(msgEl) {
				const body = msgEl && msgEl.querySelector('.body');
				if (!body) { return ''; }
				return body.dataset.raw || body.innerText || body.textContent || '';
			}

			function getMessageDisplayText(msgEl) {
				const body = msgEl && msgEl.querySelector('.body');
				if (!body) { return ''; }
				return body.innerText || body.textContent || body.dataset.raw || '';
			}

			function insertReplyIntoComposer(msgEl) {
				const text = getMessageRawText(msgEl).trim();
				if (!text) { return false; }
				const needsGap = inputEl.value && !new RegExp('\\n\\s*$').test(inputEl.value);
				inputEl.value += (inputEl.value ? (needsGap ? '\\n\\n' : '') : '') + text;
				autoResize();
				inputEl.focus();
				const pos = inputEl.value.length;
				inputEl.setSelectionRange(pos, pos);
				onInputChanged();
				return true;
			}

			function quoteReplyIntoComposer(msgEl) {
				const text = getMessageDisplayText(msgEl).trim();
				if (!text) { return false; }
				const quoted = text.split(new RegExp('\\r?\\n')).map(line => line ? '> ' + line : '>').join('\\n');
				const needsGap = inputEl.value && !new RegExp('\\n\\s*$').test(inputEl.value);
				inputEl.value += (inputEl.value ? (needsGap ? '\\n\\n' : '') : '') + quoted + '\\n\\n';
				autoResize();
				inputEl.focus();
				const pos = inputEl.value.length;
				inputEl.setSelectionRange(pos, pos);
				onInputChanged();
				return true;
			}

			function setAssistantCardsState(msgEl, next) {
				const cards = msgEl
					? Array.from(msgEl.querySelectorAll('.tool-card, .thinking-card'))
					: [];
				cards.forEach(card => setCardState(card, next));
				return cards.length;
			}

			function getRetryPayload(msgEl) {
				let cur = msgEl ? msgEl.previousElementSibling : null;
				while (cur) {
					if (cur.classList && cur.classList.contains('user')) {
						let mentions = [];
						if (cur.dataset.userMentions) {
							try { mentions = JSON.parse(cur.dataset.userMentions); }
							catch { mentions = []; }
						}
						return {
							text: cur.dataset.userText || (cur.querySelector('.body')?.textContent || ''),
							mentions: Array.isArray(mentions) ? mentions : [],
						};
					}
					cur = cur.previousElementSibling;
				}
				return null;
			}

			function markAssistantUpdateUnseen() {
				if (!pendingAssistant || pendingAssistant.unseenMarked) { return; }
				pendingAssistant.unseenMarked = true;
				unseenAssistantCount++;
				refreshJumpButton();
			}

			function sendChat(text, mentions, clearComposer) {
				const files = Array.isArray(mentions) ? mentions : [];
				addMessage('user', text, { mentions: files });
				if (clearComposer) {
					inputEl.value = '';
					autoResize();
					attachments.clear();
					renderChips();
					hidePopup();
				}
				vscode.postMessage({
					kind: 'send',
					text,
					mentions: files,
				});
				pendingAssistant = addMessage('assistant', '');
				setRunning(true);
				refreshJumpButton();
			}

			function addMessage(role, text, extra) {
				// Hide welcome state on first message of any kind.
				const w = document.getElementById('welcome');
				if (w) { w.classList.add('hidden'); }
				if (logEl) { logEl.classList.remove('hidden'); }
				const stick = role === 'user' || role === 'assistant' || isNearBottom();
				const el = document.createElement('div');
				el.className = 'msg ' + role;
				const meta = document.createElement('div');
				meta.className = 'meta';
				const who = document.createElement('div');
				who.className = 'who';
				who.textContent =
					role === 'user' ? 'You' :
					role === 'assistant' ? 'Assistant' :
					role === 'error' ? 'Error' : 'System';
				meta.appendChild(who);
				if (role === 'assistant') {
					const summary = document.createElement('div');
					summary.className = 'msg-summary';
					meta.appendChild(summary);
				}
				const spacer = document.createElement('span');
				spacer.className = 'spacer';
				meta.appendChild(spacer);
				if (role === 'assistant') {
					meta.appendChild(buildAssistantActions());
				}
				const body = document.createElement('div');
				body.className = 'body';
				if (role === 'assistant') {
					body.dataset.raw = text || '';
					// For replayed / final assistant messages we treat them
					// as already-complete so tool cards collapse.
					renderAssistantBody(body, text, true);
				} else {
					body.textContent = text;
				}
				if (role === 'user') {
					el.dataset.userText = text;
					el.dataset.userMentions = JSON.stringify((extra && extra.mentions) || []);
				}
				el.appendChild(meta);
				el.appendChild(body);
				logEl.appendChild(el);
				scrollToBottom(stick);
				return { el, bodyEl: body };
			}

			// Event-delegate all code-block button clicks so dynamically-
			// added blocks are handled without re-binding on every re-render.
			logEl.addEventListener('click', ev => {
				const t = ev.target;
				if (!t || !t.closest) { return; }
				const turnToggle = t.closest('[data-turn-toggle]');
				if (turnToggle) {
					toggleTurnBlock(turnToggle);
					return;
				}
				const msgCopyBtn = t.closest('[data-msg-copy]');
				if (msgCopyBtn) {
					const msg = msgCopyBtn.closest('.msg.assistant');
					const text = getMessageDisplayText(msg);
					if (!text) { return; }
					copyText(text, () => flashButton(msgCopyBtn, 'Copied', 1200));
					return;
				}
				const msgCopyMdBtn = t.closest('[data-msg-copy-md]');
				if (msgCopyMdBtn) {
					const msg = msgCopyMdBtn.closest('.msg.assistant');
					const text = getMessageRawText(msg);
					if (!text) { return; }
					copyText(text, () => flashButton(msgCopyMdBtn, 'Copied md', 1200));
					return;
				}
				const msgInsertBtn = t.closest('[data-msg-insert]');
				if (msgInsertBtn) {
					if (!insertReplyIntoComposer(msgInsertBtn.closest('.msg.assistant'))) { return; }
					flashButton(msgInsertBtn, 'Inserted', 900);
					return;
				}
				const msgQuoteBtn = t.closest('[data-msg-quote]');
				if (msgQuoteBtn) {
					if (!quoteReplyIntoComposer(msgQuoteBtn.closest('.msg.assistant'))) { return; }
					flashButton(msgQuoteBtn, 'Quoted', 900);
					return;
				}
				const msgExpandBtn = t.closest('[data-msg-expand]');
				if (msgExpandBtn) {
					const count = setAssistantCardsState(msgExpandBtn.closest('.msg.assistant'), 'open');
					if (!count) { return; }
					flashButton(msgExpandBtn, 'Expanded', 900);
					return;
				}
				const msgCollapseBtn = t.closest('[data-msg-collapse]');
				if (msgCollapseBtn) {
					const count = setAssistantCardsState(msgCollapseBtn.closest('.msg.assistant'), 'closed');
					if (!count) { return; }
					flashButton(msgCollapseBtn, 'Collapsed', 900);
					return;
				}
				const msgRetryBtn = t.closest('[data-msg-retry]');
				if (msgRetryBtn) {
					if (running) { return; }
					const payload = getRetryPayload(msgRetryBtn.closest('.msg.assistant'));
					if (!payload || !payload.text) { return; }
					sendChat(payload.text, payload.mentions, false);
					flashButton(msgRetryBtn, 'Retried', 900);
					return;
				}
				// Tool / thinking card expand/collapse toggle.
				const toggle = t.closest('[data-seg-toggle]');
				if (toggle) {
					const card = toggle.closest('[data-seg-key]');
					if (card) { toggleSegmentCard(card); }
					return;
				}
				const applyBtn = t.closest('[data-apply]');
				if (applyBtn) {
					const pre = applyBtn.closest('pre');
					const codeEl = pre && pre.querySelector('code');
					if (!codeEl) { return; }
					vscode.postMessage({
						kind: 'apply',
						code: codeEl.textContent || '',
						lang: applyBtn.getAttribute('data-lang') || '',
						filename: applyBtn.getAttribute('data-file') || '',
					});
					// Visual feedback; re-enable after a short moment so the
					// user can retry if the flow was dismissed.
					applyBtn.disabled = true;
					const prev = applyBtn.textContent;
					applyBtn.textContent = 'Opening diff…';
					setTimeout(() => {
						applyBtn.disabled = false;
						applyBtn.textContent = prev;
					}, 2500);
					return;
				}
				const btn = t.closest('[data-copy]');
				if (!btn) { return; }
				const pre = btn.closest('pre');
				const code = pre && pre.querySelector('code');
				if (!code) { return; }
				const text = code.textContent || '';
				copyText(text, () => {
					btn.classList.add('copied');
					const prev = btn.textContent;
					btn.textContent = 'Copied';
					setTimeout(() => {
						btn.classList.remove('copied');
						btn.textContent = prev;
					}, 1200);
				});
			});
			logEl.addEventListener('keydown', ev => {
				const t = ev.target;
				if (!t || !t.closest) { return; }
				const turnToggle = t.closest('[data-turn-toggle]');
				if (turnToggle) {
					if (ev.key !== 'Enter' && ev.key !== ' ') { return; }
					ev.preventDefault();
					toggleTurnBlock(turnToggle);
					return;
				}
				const toggle = t.closest('[data-seg-toggle]');
				if (!toggle) { return; }
				if (ev.key !== 'Enter' && ev.key !== ' ') { return; }
				ev.preventDefault();
				const card = toggle.closest('[data-seg-key]');
				if (card) { toggleSegmentCard(card); }
			});
			logEl.addEventListener('scroll', refreshJumpButton);
			jumpBtn.addEventListener('click', () => {
				scrollToBottom(true);
			});

			// Two icon SVGs that swap inside the send button without
			// touching the surrounding circle styling.  Setting
			// .textContent (as the legacy code did) wiped the icon and
			// stacked the word "Send" on top of the gradient disc.
			const SEND_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>';
			const ABORT_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="4" width="8" height="8" rx="1.2"/></svg>';

			function setRunning(r) {
				running = r;
				if (r) {
					sendBtn.innerHTML = ABORT_ICON_SVG;
					sendBtn.title = 'Stop generation';
					sendBtn.setAttribute('aria-label', 'Stop');
					sendBtn.classList.add('abort');
					statusDot.className = 'dot run';
					if (pendingAssistant) { pendingAssistant.el.classList.add('streaming'); }
				} else {
					sendBtn.innerHTML = SEND_ICON_SVG;
					sendBtn.title = 'Send (Enter)';
					sendBtn.setAttribute('aria-label', 'Send');
					sendBtn.classList.remove('abort');
					statusDot.className = 'dot ok';
					if (pendingAssistant) { pendingAssistant.el.classList.remove('streaming'); }
				}
			}

			function submit() {
				if (running) {
					vscode.postMessage({ kind: 'abort' });
					return;
				}
				const text = inputEl.value.trim();
				if (!text) return;
				// Collect only the mentions that currently survive in the
				// textarea AND that we have a recorded absolute path for.
				// Users can type '@' literally without using the popup — those
				// are ignored.
				const mentioned = [];
				if (attachments.size > 0) {
					for (const [rel, abs] of attachments) {
						if (text.indexOf('@' + rel) >= 0) {
							mentioned.push({ rel, abs });
						}
					}
				}
				sendChat(text, mentioned, true);
			}

			function autoResize() {
				inputEl.style.height = 'auto';
				inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
			}

			sendBtn.addEventListener('click', submit);
			resetBtn.addEventListener('click', () => {
				vscode.postMessage({ kind: 'reset' });
			});
			inputEl.addEventListener('input', () => {
				autoResize();
				onInputChanged();
			});
			inputEl.addEventListener('click', onInputChanged);
			inputEl.addEventListener('keyup', ev => {
				// Caret-only moves (arrows, Home/End) don't fire 'input'.
				if (ev.key && ev.key.indexOf('Arrow') === 0) { onInputChanged(); }
			});
			inputEl.addEventListener('blur', () => {
				// Hide popup when the textarea loses focus, but do it on the
				// next tick so a click on a popup item still fires.
				setTimeout(() => hidePopup(), 150);
			});
			inputEl.addEventListener('keydown', e => {
				// Popup-owned keys first.
				onInputKeyDown(e);
				if (e.defaultPrevented) { return; }
				if (e.key !== 'Enter' || e.isComposing) { return; }
				const shortcut = (window.gaPrefs && window.gaPrefs.sendShortcut) || 'enter';
				const wantsSend = shortcut === 'ctrl-enter'
					? (e.ctrlKey || e.metaKey)
					: !e.shiftKey && !e.ctrlKey && !e.metaKey;
				if (wantsSend) {
					e.preventDefault();
					submit();
				}
			});

			window.addEventListener('message', e => {
				const m = e.data || {};
				switch (m.kind) {
					case 'stream': {
						const stick = isNearBottom();
						if (!pendingAssistant) {
							pendingAssistant = addMessage('assistant', '');
							pendingAssistant.el.classList.add('streaming');
						}
						const full = m.full || (pendingAssistant.bodyEl.dataset.raw || '') + (m.delta || '');
						pendingAssistant.bodyEl.dataset.raw = full;
						renderAssistantBody(pendingAssistant.bodyEl, full, false);
						if (!stick) { markAssistantUpdateUnseen(); }
						scrollToBottom(stick);
						break;
					}
					case 'done': {
						const stick = isNearBottom();
						if (pendingAssistant) {
							pendingAssistant.el.classList.remove('streaming');
							// Re-render in 'final' mode so the last active
							// tool card auto-collapses (unless the user has
							// deliberately toggled it open).
							const full = pendingAssistant.bodyEl.dataset.raw || '';
							renderAssistantBody(pendingAssistant.bodyEl, full, true);
							if (!stick) { markAssistantUpdateUnseen(); }
						}
						pendingAssistant = null;
						setRunning(false);
						scrollToBottom(stick);
						break;
					}
					case 'info':
						addMessage('system', m.text || '');
						break;
					case 'error':
						addMessage('error', m.text || '(unknown error)');
						if (pendingAssistant) {
							pendingAssistant.el.classList.remove('streaming');
						}
						pendingAssistant = null;
						setRunning(false);
						break;
					case 'status': {
						const s = m.status || {};
						statusLlm.textContent = s.llm || '(no LLM)';
						setRunning(!!s.running);
						// Mirror current LLM into the model trigger label.
						const ml = document.getElementById('model-label');
						if (ml && s.llm) { ml.textContent = String(s.llm); }
						break;
					}
					case 'reset':
						logEl.innerHTML = '';
						pendingAssistant = null;
						setRunning(false);
						addMessage('system', 'Conversation cleared.');
						scrollToBottom(true);
						break;
					case 'files_result': {
						// Drop stale responses that arrived out of order, and
						// drop responses that arrived after the user dismissed
						// the trigger.
						if (!trigger) { break; }
						if (typeof m.seq === 'number' && m.seq < querySeq) { break; }
						trigger.items = Array.isArray(m.files) ? m.files : [];
						trigger.active = 0;
						renderPopup(trigger.items, 0);
						break;
					}
					case 'bot_status':
						renderBotStatus(Array.isArray(m.bots) ? m.bots : []);
						break;
					case 'bot_error':
						renderBotError(m.error || 'Bot operation failed');
						break;
				}
			});

			// ── Toolbar dropdowns / Welcome / Mode (Cursor-style) ─────────
			const newChatBtn = document.getElementById('btn-new-chat');
			const historyBtn = document.getElementById('btn-history');
			const skillsBtn = document.getElementById('btn-skills');
			const botsBtn = document.getElementById('btn-bots');
			const settingsBtn = document.getElementById('btn-settings');
			const panelHistory = document.getElementById('panel-history');
			const panelSkills = document.getElementById('panel-skills');
			const panelSettings = document.getElementById('panel-settings');
			const historyListEl = document.getElementById('history-list');
			const historySearchEl = document.getElementById('history-search');
			const historyNewChatBtn = document.getElementById('history-newchat');
			const skillsListEl = document.getElementById('skills-list');
			const skillsSearchEl = document.getElementById('skills-search');
			const settingsBodyEl = document.getElementById('settings-body');
			const settingsTitleEl = document.getElementById('settings-title');
			const settingsReloadBtn = document.getElementById('settings-reload');
			const sopModalEl = document.getElementById('sop-modal');
			const sopModalTitleEl = document.getElementById('sop-modal-title');
			const sopModalBodyEl = document.getElementById('sop-modal-body');
			const sopModalCloseEl = document.getElementById('sop-modal-close');
			const sopModalUseEl = document.getElementById('sop-modal-use');
			const sopModalEditEl = document.getElementById('sop-modal-edit');
			const sopModalCancelEl = document.getElementById('sop-modal-cancel');
			const sopModalDownloadEl = document.getElementById('sop-modal-download');
			const sopModalUploadEl = document.getElementById('sop-modal-upload');
			const skillsTabsEl = document.getElementById('skills-tabs');
			const marketListEl = document.getElementById('market-list');
			const sophubKeyStatusEl = document.getElementById('sophub-key-status');
			const sophubClearKeyEl = document.getElementById('sophub-clear-key');
			const welcomeEl = document.getElementById('welcome');
			const modeTriggerEl = document.getElementById('mode-trigger');
			const modeLabelEl = document.getElementById('mode-label');
			const modeMenuEl = document.getElementById('mode-menu');
			const modelTriggerEl = document.getElementById('model-trigger');
			const modelLabelEl = document.getElementById('model-label');

			let currentMode = 'agent';
			let activeSessionPath = null;
			let allSkills = { tools: [], sops: [] };
			let skillsLoaded = false;
			let activeSop = null;
			let activeSopMode = 'local'; // 'local' | 'market'
			let currentSkillTab = 'local';
			let marketResults = [];
			let marketSearchSeq = 0;
			let settingsLoaded = false;

			// ── Welcome state visibility ──────────────────────────────────
			function refreshWelcome() {
				if (!welcomeEl) { return; }
				const hasMessages = !!logEl.querySelector('.msg');
				welcomeEl.classList.toggle('hidden', hasMessages);
				logEl.classList.toggle('hidden', !hasMessages);
			}
			refreshWelcome();

			// ── Toolbar dropdown manager ──────────────────────────────────
			const allPanels = [panelHistory, panelSkills, panelSettings];
			function closeAllPanels() {
				allPanels.forEach(function (p) { p.classList.remove('show'); });
				[historyBtn, skillsBtn, botsBtn, settingsBtn].forEach(function (b) { b.classList.remove('active'); });
			}
			function togglePanel(panel, btn, onOpen) {
				const willOpen = !panel.classList.contains('show');
				closeAllPanels();
				if (willOpen) {
					panel.classList.add('show');
					btn.classList.add('active');
					if (onOpen) { onOpen(); }
				}
			}
			document.addEventListener('click', function (e) {
				const inPanel = e.target.closest('.dropdown-panel');
				const inTrigger = e.target.closest('#btn-history, #btn-skills, #btn-bots, #btn-settings');
				if (!inPanel && !inTrigger) { closeAllPanels(); }
			});
			document.addEventListener('keydown', function (e) {
				if (e.key === 'Escape') { closeAllPanels(); modeMenuEl.classList.remove('show'); }
			});

			historyBtn.addEventListener('click', function (e) {
				e.stopPropagation();
				togglePanel(panelHistory, historyBtn, function () {
					loadSessions(historySearchEl.value);
					setTimeout(function () { historySearchEl.focus(); }, 0);
				});
			});
			skillsBtn.addEventListener('click', function (e) {
				e.stopPropagation();
				togglePanel(panelSkills, skillsBtn, function () {
					if (!skillsLoaded) { loadSkills(); }
					setTimeout(function () { skillsSearchEl.focus(); }, 0);
				});
			});
			botsBtn.addEventListener('click', function (e) {
				e.stopPropagation();
				togglePanel(panelSettings, botsBtn, function () {
					if (settingsTitleEl) { settingsTitleEl.textContent = '机器人管理'; }
					loadSettings().then(function () {
						vscode.postMessage({ kind: 'bot_status' });
					});
				});
			});
			settingsBtn.addEventListener('click', function (e) {
				e.stopPropagation();
				if (settingsTitleEl) { settingsTitleEl.textContent = 'Settings'; }
				vscode.postMessage({ kind: 'open_settings' });
			});

			// ── Welcome card actions ──────────────────────────────────────
			welcomeEl.addEventListener('click', function (e) {
				const card = e.target.closest('.welcome-card');
				if (!card) { return; }
				// Prevent the document-level panel-closer from
				// immediately closing the dropdown we're about to open.
				e.stopPropagation();
				const action = card.dataset.action;
				if (action === 'new-chat') { newChat(); inputEl.focus(); }
				else if (action === 'open-history') { historyBtn.click(); }
				else if (action === 'open-skills') { skillsBtn.click(); }
			});

			function fmtMtime(ts) {
				if (!ts) { return ''; }
				const d = new Date(ts * 1000);
				const now = new Date();
				const sameDay = d.toDateString() === now.toDateString();
				if (sameDay) {
					return d.toTimeString().slice(0, 5);
				}
				const yesterday = new Date(now);
				yesterday.setDate(now.getDate() - 1);
				if (d.toDateString() === yesterday.toDateString()) { return 'Yesterday'; }
				const oneWeek = 7 * 24 * 3600 * 1000;
				if (now - d < oneWeek) {
					return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
				}
				return (d.getMonth() + 1) + '/' + d.getDate();
			}

			function renderSessions(items) {
				if (!items || items.length === 0) {
					historyListEl.innerHTML = '<div class="dropdown-empty">No conversations yet</div>';
					return;
				}
				historyListEl.innerHTML = '';
				// Group by recency: Today / Yesterday / Previous 7 days / Older
				const buckets = { today: [], yesterday: [], week: [], older: [] };
				const now = new Date();
				const today = now.toDateString();
				const ydt = new Date(now); ydt.setDate(now.getDate() - 1);
				const yesterday = ydt.toDateString();
				const oneWeek = 7 * 24 * 3600 * 1000;
				items.forEach(function (s) {
					const t = (s.mtime || 0) * 1000;
					const d = new Date(t);
					if (d.toDateString() === today) { buckets.today.push(s); }
					else if (d.toDateString() === yesterday) { buckets.yesterday.push(s); }
					else if ((now - d) < oneWeek) { buckets.week.push(s); }
					else { buckets.older.push(s); }
				});
				const sectionDef = [
					['Today', buckets.today],
					['Yesterday', buckets.yesterday],
					['Previous 7 days', buckets.week],
					['Older', buckets.older],
				];
				sectionDef.forEach(function (def) {
					const label = def[0]; const list = def[1];
					if (!list.length) { return; }
					const h = document.createElement('div');
					h.className = 'dropdown-section';
					h.textContent = label;
					historyListEl.appendChild(h);
					list.forEach(function (s) {
						const el = document.createElement('div');
						el.className = 'dropdown-row';
						if (s.path === activeSessionPath) { el.classList.add('active'); }
						el.dataset.path = s.path;
						const title = document.createElement('div');
						title.className = 'row-title';
						title.textContent = s.preview || s.title || '(empty)';
						const meta = document.createElement('div');
						meta.className = 'row-meta';
						const r = document.createElement('span');
						r.textContent = (s.rounds || 0) + ' turn' + ((s.rounds || 0) === 1 ? '' : 's');
						const t = document.createElement('span');
						t.textContent = fmtMtime(s.mtime);
						meta.appendChild(r);
						meta.appendChild(t);
						el.appendChild(title);
						el.appendChild(meta);
						el.addEventListener('click', function () { openSession(s.path); closeAllPanels(); });
						historyListEl.appendChild(el);
					});
				});
			}

			async function loadSessions(query) {
				try {
					const items = await window.gaApi.listSessions(query || '');
					allSessions = Array.isArray(items) ? items : [];
					renderSessions(allSessions);
				} catch (e) {
					historyListEl.innerHTML = '<div class="dropdown-empty">Failed: ' + escapeHtml(e.message || String(e)) + '</div>';
				}
			}

			async function openSession(path) {
				try {
					activeSessionPath = path;
					Array.from(historyListEl.querySelectorAll('.dropdown-row')).forEach(function (el) {
						el.classList.toggle('active', el.dataset.path === path);
					});
					logEl.innerHTML = '';
					let restored = null;
					try { restored = await window.gaApi.restoreSession(path); } catch (_) {}
					const messages = restored && Array.isArray(restored.history)
						? restored.history
						: await window.gaApi.getSessionHistory(path);
					renderHistoryMessages(messages || []);
					if (!logEl.children.length) {
						appendHistoryMessage('system', 'This session has no renderable messages.');
					}
					refreshWelcome();
					refreshJumpButton();
					scrollToBottom(true);
				} catch (e) {
					logEl.innerHTML = '';
					appendHistoryMessage('system', 'Failed to open session: ' + (e.message || e));
					refreshWelcome();
					vscode.postMessage({ kind: 'info', text: 'Failed to open session: ' + (e.message || e) });
				}
			}

			function historyMessageContent(m) {
				if (m.content != null) {
					return typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2);
				}
				if (!Array.isArray(m.parts)) { return ''; }
				return m.parts.map(function (p) {
					if (!p || typeof p !== 'object') { return ''; }
					if (p.type === 'user_text' || p.type === 'text') {
						return p.content || '';
					}
					if (p.type === 'thinking') { return '<thinking>' + (p.content || '') + '</thinking>'; }
					if (p.type === 'tool_result') { return formatToolOutput(p.content || ''); }
					if (p.type === 'tool_use') {
						return formatToolUse(p);
					}
					return p.content || '';
				}).filter(Boolean).join('\\n\\n');
			}

			function renderHistoryMessages(messages) {
				let pendingAssistant = null;
				const flushAssistant = function () {
					if (pendingAssistant) {
						appendHistoryMessage('assistant', pendingAssistant);
						pendingAssistant = null;
					}
				};
				(messages || []).forEach(function (m) {
					if (!m || !m.role) { return; }
					if (m.role === 'assistant') {
						flushAssistant();
						pendingAssistant = historyMessageContent(m);
						return;
					}
					if (m.role === 'user' && Array.isArray(m.parts)) {
						const toolResults = m.parts.filter(function (p) { return p && p.type === 'tool_result'; });
						const userTexts = m.parts.filter(function (p) { return p && p.type !== 'tool_result'; });
						if (toolResults.length && pendingAssistant) {
							pendingAssistant += '\\n' + toolResults.map(function (p) { return formatToolOutput(p.content || ''); }).join('\\n');
						}
						if (userTexts.length) {
							flushAssistant();
							appendHistoryMessage('user', historyMessageContent({ role: 'user', parts: userTexts }));
						}
						return;
					}
					flushAssistant();
					appendHistoryMessage(m.role, historyMessageContent(m));
				});
				flushAssistant();
			}

			function formatToolUse(p) {
				const fence = String.fromCharCode(96).repeat(4);
				return '🛠️ Tool: ' + String.fromCharCode(96) + (p.name || '?') + String.fromCharCode(96) + '  📥 args:\\n'
					+ fence + 'text\\n'
					+ JSON.stringify(p.input || {}, null, 2) + '\\n'
					+ fence;
			}

			function formatToolOutput(content) {
				const fence = String.fromCharCode(96).repeat(5);
				return fence + '\\n' + String(content || '') + '\\n' + fence;
			}

			function appendHistoryMessage(role, content) {
				if (role === 'user') {
					const el = document.createElement('div');
					el.className = 'msg user';
					const body = document.createElement('div');
					body.className = 'body';
					body.textContent = String(content);
					el.appendChild(body);
					logEl.appendChild(el);
				} else if (role === 'assistant') {
					const el = document.createElement('div');
					el.className = 'msg assistant';
					const body = document.createElement('div');
					body.className = 'body';
					el.appendChild(body);
					logEl.appendChild(el);
					try { renderAssistantBody(body, String(content), true); }
					catch (e) { body.textContent = String(content); }
				} else {
					const el = document.createElement('div');
					el.className = 'msg system';
					const body = document.createElement('div');
					body.className = 'body';
					body.textContent = String(content);
					el.appendChild(body);
					logEl.appendChild(el);
				}
			}

			function newChat() {
				activeSessionPath = null;
				Array.from(historyListEl.querySelectorAll('.dropdown-row')).forEach(function (el) {
					el.classList.remove('active');
				});
				vscode.postMessage({ kind: 'reset' });
				logEl.innerHTML = '';
				refreshWelcome();
				inputEl.focus();
				setTimeout(function () { loadSessions(historySearchEl.value); }, 500);
			}
			newChatBtn.addEventListener('click', newChat);
			historyNewChatBtn.addEventListener('click', function () { newChat(); closeAllPanels(); });

			let _historySearchTimer = null;
			historySearchEl.addEventListener('input', function () {
				clearTimeout(_historySearchTimer);
				const q = historySearchEl.value;
				_historySearchTimer = setTimeout(function () { loadSessions(q); }, 200);
			});

			function setSkillsTab(tab) {
				currentSkillTab = (tab === 'market') ? 'market' : 'local';
				Array.from(skillsTabsEl.querySelectorAll('.skills-tab')).forEach(function (b) {
					b.classList.toggle('active', b.getAttribute('data-skills-tab') === currentSkillTab);
				});
				skillsListEl.style.display = (currentSkillTab === 'local') ? '' : 'none';
				marketListEl.style.display = (currentSkillTab === 'market') ? '' : 'none';
				skillsSearchEl.placeholder = (currentSkillTab === 'market') ? '搜索市场 SOP（回车）…' : 'Search SOPs…';
			}
			skillsTabsEl.addEventListener('click', function (e) {
				const t = e.target && e.target.closest('[data-skills-tab]');
				if (!t) { return; }
				setSkillsTab(t.getAttribute('data-skills-tab'));
				if (currentSkillTab === 'market' && marketResults.length === 0) {
					searchMarket('');
				}
			});

			function renderSkills(filter) {
				const f = (filter || '').trim().toLowerCase();
				const sops = (allSkills.sops || []).filter(function (it) {
					if (!f) { return true; }
					const hay = ((it.name || '') + ' ' + (it.desc || it.summary || '')).toLowerCase();
					return hay.indexOf(f) >= 0;
				});
				if (sops.length === 0) {
					skillsListEl.innerHTML = '<div class="dropdown-empty">No matching SOPs</div>';
					return;
				}
				skillsListEl.innerHTML = '';
				const h = document.createElement('div');
				h.className = 'dropdown-section';
				h.textContent = 'SOPs (' + sops.length + ')';
				skillsListEl.appendChild(h);
				sops.forEach(function (it) {
					const row = document.createElement('div');
					row.className = 'dropdown-row skill-row';
					const t = document.createElement('div');
					t.className = 'row-title';
					t.textContent = it.title || it.name || '(unnamed)';
					row.appendChild(t);
					const brief = it.brief || it.desc || it.summary;
					if (brief) {
						const d = document.createElement('div');
						d.className = 'row-brief';
						d.textContent = String(brief).slice(0, 120);
						row.appendChild(d);
					}
					const acts = document.createElement('div');
					acts.className = 'row-actions';
					const upBtn = document.createElement('button');
					upBtn.className = 'row-action';
					upBtn.textContent = '↑ 上传到市场';
					upBtn.addEventListener('click', function (ev) {
						ev.stopPropagation();
						uploadLocalSop(it);
					});
					acts.appendChild(upBtn);
					row.appendChild(acts);
					row.addEventListener('click', function (e) {
						if (e.altKey || e.shiftKey) {
							insertAtCursor(inputEl, '@sop:' + (it.name || ''));
							closeAllPanels();
							return;
						}
						openSopModal(it, 'local');
						closeAllPanels();
					});
					skillsListEl.appendChild(row);
				});
			}

			function timeAgo(iso) {
				if (!iso) { return ''; }
				const d = new Date(iso);
				if (isNaN(d.getTime())) { return ''; }
				const s = Math.max(1, Math.floor((Date.now() - d.getTime()) / 1000));
				if (s < 60) { return s + ' 秒前'; }
				if (s < 3600) { return Math.floor(s / 60) + ' 分钟前'; }
				if (s < 86400) { return Math.floor(s / 3600) + ' 小时前'; }
				if (s < 86400 * 30) { return Math.floor(s / 86400) + ' 天前'; }
				if (s < 86400 * 365) { return Math.floor(s / 86400 / 30) + ' 个月前'; }
				return Math.floor(s / 86400 / 365) + ' 年前';
			}

			function renderMarketList() {
				if (!marketResults.length) {
					marketListEl.innerHTML = '<div class="dropdown-empty">无结果</div>';
					return;
				}
				marketListEl.innerHTML = '';
				const h = document.createElement('div');
				h.className = 'dropdown-section';
				h.textContent = '市场 SOP (' + marketResults.length + ')';
				marketListEl.appendChild(h);
				marketResults.forEach(function (it) {
					const card = document.createElement('div');
					card.className = 'market-card';

					const head = document.createElement('div');
					head.className = 'market-card-head';
					const isOfficial = (it.author_type === 'official') || (String(it.author_name || it.author || '').toLowerCase() === 'sophub') || it.is_official;
					if (isOfficial) {
						const b = document.createElement('span');
						b.className = 'market-badge official';
						b.textContent = '官方';
						head.appendChild(b);
					} else if (it.author_type) {
						const b = document.createElement('span');
						b.className = 'market-badge';
						b.textContent = it.author_type === 'agent' ? 'Agent' : it.author_type;
						head.appendChild(b);
					}
					const ttl = document.createElement('div');
					ttl.className = 'market-title';
					ttl.textContent = it.title || ('SOP #' + it.id);
					head.appendChild(ttl);
					card.appendChild(head);

					const meta = document.createElement('div');
					meta.className = 'market-meta';
					const author = it.author_name || it.author || (it.author_type === 'agent' ? 'agent' : '匿名');
					const a = document.createElement('span');
					a.textContent = '@' + author;
					meta.appendChild(a);
					const stars = (typeof it.avg_stars === 'number') ? it.avg_stars : (typeof it.average_stars === 'number' ? it.average_stars : null);
					if (stars && stars > 0) {
						const s = document.createElement('span');
						s.className = 'stars';
						s.textContent = '★ ' + Number(stars).toFixed(1);
						meta.appendChild(s);
					}
					const reviews = it.review_count || it.reviews;
					if (typeof reviews === 'number' && reviews > 0) {
						const r = document.createElement('span');
						r.textContent = '💬 ' + reviews;
						meta.appendChild(r);
					}
					const views = it.view_count || it.views;
					if (typeof views === 'number' && views > 0) {
						const v = document.createElement('span');
						v.textContent = '👁 ' + views;
						meta.appendChild(v);
					}
					const ago = timeAgo(it.updated_at || it.created_at);
					if (ago) {
						const t = document.createElement('span');
						t.textContent = ago;
						meta.appendChild(t);
					}
					if (it.file_type && it.file_type !== 'markdown') {
						const ft = document.createElement('span');
						ft.textContent = it.file_type;
						meta.appendChild(ft);
					}
					card.appendChild(meta);

					const previewText = it.preview || it.summary || it.content_preview || '';
					if (previewText) {
						const p = document.createElement('div');
						p.className = 'market-preview';
						p.textContent = String(previewText).replace(/\\s+/g, ' ').trim();
						card.appendChild(p);
					}

					const acts = document.createElement('div');
					acts.className = 'row-actions';
					const dl = document.createElement('button');
					dl.className = 'row-action';
					dl.textContent = '↓ 下载';
					dl.addEventListener('click', function (ev) {
						ev.stopPropagation();
						downloadMarketSop(it);
					});
					acts.appendChild(dl);
					card.appendChild(acts);

					card.addEventListener('click', function () {
						openSopModal(it, 'market');
						closeAllPanels();
					});
					marketListEl.appendChild(card);
				});
			}

			async function searchMarket(q) {
				const seq = ++marketSearchSeq;
				marketListEl.innerHTML = '<div class="dropdown-empty">搜索中…</div>';
				try {
					const r = await window.gaApi.sophub('search', { q: q || '', page: 1, page_size: 24 });
					if (seq !== marketSearchSeq) { return; }
					marketResults = (r && r.items) || [];
					renderMarketList();
					refreshSophubKeyStatus(true);
				} catch (e) {
					if (seq !== marketSearchSeq) { return; }
					marketListEl.innerHTML = '<div class="dropdown-empty">市场搜索失败：' + escapeHtml(e.message || String(e)) + '</div>';
				}
			}

			const riskModalEl = document.getElementById('risk-modal');
			const riskModalTargetEl = document.getElementById('risk-modal-target');
			const riskModalAgreeEl = document.getElementById('risk-modal-agree');
			const riskModalConfirmEl = document.getElementById('risk-modal-confirm');
			const riskModalCancelEl = document.getElementById('risk-modal-cancel');
			let _riskPendingItem = null;

			function closeRiskModal() {
				_riskPendingItem = null;
				riskModalAgreeEl.checked = false;
				riskModalConfirmEl.disabled = true;
				riskModalEl.classList.remove('show');
			}
			riskModalAgreeEl.addEventListener('change', function () {
				riskModalConfirmEl.disabled = !riskModalAgreeEl.checked;
			});
			riskModalCancelEl.addEventListener('click', closeRiskModal);
			riskModalEl.addEventListener('click', function (e) {
				if (e.target === riskModalEl) { closeRiskModal(); }
			});
			riskModalConfirmEl.addEventListener('click', async function () {
				const it = _riskPendingItem;
				if (!it || !riskModalAgreeEl.checked) { return; }
				riskModalConfirmEl.disabled = true;
				riskModalConfirmEl.textContent = '上传中…';
				try {
					const r = await window.gaApi.sophub('upload', { sopName: it.name, title: it.title || it.name });
					closeRiskModal();
					alert('上传成功：' + (r && (r.title || r.id) || ''));
					refreshSophubKeyStatus(true);
				} catch (e) {
					alert('上传失败：' + (e.message || e));
				} finally {
					riskModalConfirmEl.disabled = false;
					riskModalConfirmEl.textContent = '确认上传';
				}
			});

			function uploadLocalSop(it) {
				_riskPendingItem = it;
				riskModalTargetEl.textContent = (it.title || it.name || '(unnamed)');
				riskModalAgreeEl.checked = false;
				riskModalConfirmEl.disabled = true;
				riskModalConfirmEl.textContent = '确认上传';
				riskModalEl.classList.add('show');
			}

			async function downloadMarketSop(it, overwrite) {
				try {
					const r = await window.gaApi.sophub('download', {
						id: it.id,
						filename: it.title || ('sop-' + it.id),
						overwrite: !!overwrite,
					});
					if (r && r.exists) {
						if (confirm('已存在 ' + r.target + '\\n是否覆盖？')) {
							return downloadMarketSop(it, true);
						}
						return;
					}
					alert('已下载到：' + (r && r.target));
					if (typeof loadSkills === 'function') { loadSkills(); }
				} catch (e) {
					alert('下载失败：' + (e.message || e));
				}
			}

			function setModalMode(mode) {
				activeSopMode = mode;
				const isLocal = (mode === 'local');
				sopModalUseEl.style.display = isLocal ? '' : 'none';
				sopModalEditEl.style.display = isLocal ? '' : 'none';
				sopModalUploadEl.style.display = isLocal ? '' : 'none';
				sopModalDownloadEl.style.display = isLocal ? 'none' : '';
			}

			function closeSopModal() {
				activeSop = null;
				sopModalEl.classList.remove('show');
			}

			async function openSopModal(it, mode) {
				activeSop = it;
				setModalMode(mode || 'local');
				sopModalTitleEl.textContent = it.title || it.name || 'SOP';
				sopModalBodyEl.innerHTML = '<div class="dropdown-empty">Loading SOP…</div>';
				sopModalEl.classList.add('show');
				try {
					let content = '';
					if (activeSopMode === 'local') {
						const sop = await window.gaApi.getSop(it.name || '');
						content = sop && (sop.content || sop.text || sop.markdown) ? (sop.content || sop.text || sop.markdown) : '';
					} else {
						const sop = await window.gaApi.sophub('get', { id: it.id });
						content = sop && (sop.content || sop.text || sop.markdown) ? (sop.content || sop.text || sop.markdown) : '';
					}
					sopModalBodyEl.innerHTML = '<div class="md">' + renderMarkdown(content || '(empty)', { codeActions: false }) + '</div>';
				} catch (err) {
					sopModalBodyEl.innerHTML = '<div class="dropdown-empty">Failed to load SOP: ' + escapeHtml(err.message || String(err)) + '</div>';
				}
			}

			sopModalCloseEl.addEventListener('click', closeSopModal);
			sopModalCancelEl.addEventListener('click', closeSopModal);
			sopModalEl.addEventListener('click', function (e) {
				if (e.target === sopModalEl) { closeSopModal(); }
			});
			sopModalUseEl.addEventListener('click', function () {
				if (!activeSop || activeSopMode !== 'local') { return; }
				insertAtCursor(inputEl, '@sop:' + (activeSop.name || ''));
				closeSopModal();
				inputEl.focus();
			});
			sopModalEditEl.addEventListener('click', function () {
				if (!activeSop || activeSopMode !== 'local') { return; }
				vscode.postMessage({ kind: 'open_sop_source', sopName: activeSop.name || '' });
			});
			sopModalUploadEl.addEventListener('click', function () {
				if (!activeSop || activeSopMode !== 'local') { return; }
				uploadLocalSop(activeSop);
			});
			sopModalDownloadEl.addEventListener('click', function () {
				if (!activeSop || activeSopMode !== 'market') { return; }
				downloadMarketSop(activeSop);
			});

			async function refreshSophubKeyStatus(connected) {
				if (!sophubKeyStatusEl) { return; }
				if (connected) {
					sophubKeyStatusEl.textContent = 'Sophub 已连接';
					return;
				}
				try {
					const r = await window.gaApi.sophub('keyStatus', {});
					sophubKeyStatusEl.textContent = (r && r.hasKey) ? 'Sophub 已连接' : 'Sophub 未连接（首次搜索时自动注册）';
				} catch { /* ignore */ }
			}
			if (sophubClearKeyEl) {
				sophubClearKeyEl.addEventListener('click', async function () {
					try {
						await window.gaApi.sophub('clearKey', {});
						alert('已清除 Sophub Key');
						refreshSophubKeyStatus(false);
					} catch (e) { alert('清除失败：' + (e.message || e)); }
				});
			}

			async function loadSkills() {
				try {
					const data = await window.gaApi.listSkills();
					allSkills = {
						tools: (data && data.tools) || [],
						sops: (data && data.sops) || [],
					};
					renderSkills('');
					skillsLoaded = true;
					refreshSophubKeyStatus(false);
				} catch (e) {
					skillsListEl.innerHTML = '<div class="dropdown-empty">Failed: ' + escapeHtml(e.message || String(e)) + '</div>';
				}
			}
			skillsSearchEl.addEventListener('input', function () {
				if (currentSkillTab === 'local') { renderSkills(skillsSearchEl.value); }
			});
			skillsSearchEl.addEventListener('keydown', function (e) {
				if (e.key === 'Enter' && currentSkillTab === 'market') {
					e.preventDefault();
					searchMarket(skillsSearchEl.value);
				}
			});

			function insertAtCursor(el, text) {
				const start = el.selectionStart || 0;
				const end = el.selectionEnd || 0;
				const before = el.value.slice(0, start);
				const after = el.value.slice(end);
				const sep = before && !/\\s$/.test(before) ? ' ' : '';
				el.value = before + sep + text + ' ' + after;
				const pos = (before + sep + text + ' ').length;
				el.setSelectionRange(pos, pos);
				el.focus();
				autoResize();
				onInputChanged();
			}

			function renderBotError(text) {
				const el = document.getElementById('bot-error');
				if (el) { el.textContent = text; el.hidden = false; }
			}

			function renderBotStatus(bots) {
				const host = document.getElementById('bot-list');
				if (!host) { return; }
				host.innerHTML = '';
				if (!bots.length) {
					host.innerHTML = '<div class="dropdown-empty">机器人管理器未连接，请重载窗口后重试。</div>';
					return;
				}
				bots.forEach(function (bot) {
					const card = document.createElement('div');
					card.className = 'bot-card' + (bot.running ? ' running' : '') + (!bot.configured ? ' missing' : '');
					const head = document.createElement('div');
					head.className = 'bot-head';
					const title = document.createElement('div');
					title.className = 'bot-title';
					title.textContent = bot.label || bot.kind;
					const pill = document.createElement('div');
					pill.className = 'bot-pill';
					pill.textContent = bot.running ? '运行中' : (!bot.configured ? '未配置' : '已停止');
					head.appendChild(title); head.appendChild(pill);
					const meta = document.createElement('div');
					meta.className = 'bot-meta';
					meta.textContent = bot.running ? ('pid ' + bot.pid) : (!bot.configured ? ('缺少: ' + (bot.missingKeys || []).join(', ')) : '可随时启动/停止');
					const actions = document.createElement('div');
					actions.className = 'bot-actions';
					const toggle = document.createElement('button');
					toggle.textContent = bot.running ? '停止' : '启动';
					toggle.disabled = !bot.running && !bot.configured;
					toggle.addEventListener('click', function (e) {
						e.stopPropagation();
						toggle.disabled = true;
						vscode.postMessage({ kind: bot.running ? 'bot_stop' : 'bot_start', bot: bot.kind });
						setTimeout(function () { vscode.postMessage({ kind: 'bot_status' }); }, 800);
					});
					actions.appendChild(toggle);
					card.appendChild(head); card.appendChild(meta); card.appendChild(actions);
					host.appendChild(card);
				});
			}

			async function loadSettings() {
				try {
					settingsBodyEl.innerHTML = '';
					settingsBodyEl.innerHTML = '<div class="dropdown-section">机器人管理</div><div id="bot-error" class="dropdown-empty" style="text-align:left;color:var(--danger);" hidden></div><div id="bot-list"><div class="dropdown-empty">Loading bots…</div></div><div class="dropdown-section">LLM Profiles</div>';
					let cfg = null;
					try { cfg = await window.gaApi.getLLMConfig(); } catch (_) {}
					const llms = (cfg && cfg.llms) || [];
					if (!llms.length) {
						settingsBodyEl.insertAdjacentHTML('beforeend', '<div class="dropdown-empty">No LLM profiles configured</div>');
					} else {
						const sec = document.createElement('div');
						sec.className = 'dropdown-section';
						sec.textContent = 'LLM Profiles (' + llms.length + ')';
						llms.forEach(function (p) {
							const row = document.createElement('div');
							row.className = 'dropdown-row';
							const title = document.createElement('div');
							title.className = 'row-title';
							title.textContent = p.name || p.id || '(unnamed)';
							row.appendChild(title);
							const meta = document.createElement('div');
							meta.className = 'row-meta';
							meta.textContent = (p.model || '') + (p.apibase ? ' · ' + p.apibase : '');
							row.appendChild(meta);
							settingsBodyEl.appendChild(row);
						});
						const hint = document.createElement('div');
						hint.className = 'dropdown-empty';
						hint.style.textAlign = 'left';
						hint.style.lineHeight = '1.6';
						hint.innerHTML = 'Edit credentials in <code>mykey.py</code>, then click <b>Reload</b>.';
						settingsBodyEl.appendChild(hint);
					}
					settingsLoaded = true;
				} catch (e) {
					settingsBodyEl.innerHTML = '<div class="dropdown-empty">Failed: ' + escapeHtml(e.message || String(e)) + '</div>';
				}
			}
			settingsReloadBtn.addEventListener('click', async function () {
				settingsReloadBtn.disabled = true;
				const orig = settingsReloadBtn.textContent;
				settingsReloadBtn.textContent = 'Reloading…';
				try {
					const r = await window.gaApi.reloadLLMConfig();
					settingsReloadBtn.textContent = (r && r.error) ? ('Error: ' + r.error) : 'Reloaded ✓';
					checkLlmConfigured();
				} catch (e) {
					settingsReloadBtn.textContent = 'Failed';
				}
				setTimeout(function () {
					settingsReloadBtn.disabled = false;
					settingsReloadBtn.textContent = orig;
					loadSettings();
				}, 1500);
			});

			// ── LLM Config editor ─────────────────────────────────────────
			const configModalEl = document.getElementById('config-modal');
			const configModalBodyEl = document.getElementById('config-modal-body');
			const configModalCloseEl = document.getElementById('config-modal-close');
			const configModalCancelEl = document.getElementById('config-modal-cancel');
			const configModalSaveEl = document.getElementById('config-modal-save');
			const configModalSaveReloadEl = document.getElementById('config-modal-save-reload');
			const configStatusEl = document.getElementById('config-status');
			const settingsConfigBtn = document.getElementById('settings-config');
			const cfgPromptEl = document.getElementById('cfg-prompt');
			const cfgPromptOpenEl = document.getElementById('cfg-prompt-open');
			const cfgPromptDismissEl = document.getElementById('cfg-prompt-dismiss');

			let configState = { sessions: [], mixin: null, readonly: false };

			const SESSION_TYPES = [
				{ value: 'native_claude', label: 'Native Claude (Anthropic 协议 + 原生工具)' },
				{ value: 'native_oai', label: 'Native OAI (OpenAI 协议 + 原生工具)' },
				{ value: 'claude', label: 'Claude (文本协议工具，deprecated)' },
				{ value: 'oai', label: 'OAI (文本协议工具，deprecated)' },
			];
			// Provider presets: one-click templates that fill apibase + sensible defaults.
			// Order matters: first item is shown first; last item is the "custom" fallback.
			const PROVIDER_PRESETS = [
				{ id: 'openai',     icon: '🟢', label: 'OpenAI',         hint: 'GPT-4o / GPT-5 / o-series',                  type: 'native_oai',    apibase: 'https://api.openai.com/v1',                  model: 'gpt-4o' },
				{ id: 'anthropic',  icon: '🟣', label: 'Anthropic',      hint: 'Claude Sonnet 4.5 / Opus / Haiku',           type: 'native_claude', apibase: 'https://api.anthropic.com',                  model: 'claude-sonnet-4-5-20250929' },
				{ id: 'kimi',       icon: '🟡', label: 'Kimi (Moonshot)', hint: '国内访问，长上下文，价格友好',                type: 'native_oai',    apibase: 'https://api.moonshot.cn/v1',                 model: 'kimi-k2-turbo-preview' },
				{ id: 'deepseek',   icon: '🔵', label: 'DeepSeek',       hint: '极致性价比，适合 agent 长会话',                type: 'native_oai',    apibase: 'https://api.deepseek.com/v1',                model: 'deepseek-chat' },
				{ id: 'zhipu',      icon: '🟠', label: '智谱 GLM',        hint: 'GLM-4.5 / GLM-4-flash',                      type: 'native_oai',    apibase: 'https://open.bigmodel.cn/api/paas/v4',       model: 'glm-4.5' },
				{ id: 'minimax',    icon: '🔴', label: 'MiniMax',        hint: 'M1 / abab6.5',                              type: 'native_oai',    apibase: 'https://api.minimax.chat/v1',                model: 'MiniMax-M1' },
				{ id: 'qwen',       icon: '🟤', label: '通义千问',         hint: 'qwen-max / qwen-plus，阿里云 DashScope',      type: 'native_oai',    apibase: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max' },
				{ id: 'siliconflow', icon: '⚪', label: 'SiliconFlow',    hint: '聚合多家开源模型，便宜实惠',                  type: 'native_oai',    apibase: 'https://api.siliconflow.cn/v1',              model: 'deepseek-ai/DeepSeek-V3' },
				{ id: 'custom',     icon: '⚙️', label: '自定义 / 中转',   hint: '兼容 OpenAI 协议的任意 endpoint',             type: 'native_oai',    apibase: '',                                            model: '' },
			];
			function makeSessionFromPreset(preset) {
				const baseKey = preset.id === 'custom' ? 'native_oai_config' : (preset.id + '_config');
				let n = 1;
				const used = new Set(configState.sessions.map(function (s) { return s._key; }));
				while (used.has(baseKey + n)) { n++; }
				return {
					_type: preset.type,
					_key: baseKey + n,
					name: preset.label,
					apikey: '',
					apibase: preset.apibase,
					model: preset.model,
				};
			}

			const ADVANCED_FIELDS = [
				{ key: 'reasoning_effort', label: 'reasoning_effort', placeholder: 'none|minimal|low|medium|high|xhigh' },
				{ key: 'thinking_type', label: 'thinking_type', placeholder: 'adaptive|enabled|disabled' },
				{ key: 'thinking_budget_tokens', label: 'thinking_budget_tokens', placeholder: 'int', type: 'number' },
				{ key: 'fake_cc_system_prompt', label: 'fake_cc_system_prompt', type: 'checkbox' },
				{ key: 'temperature', label: 'temperature', placeholder: 'float (default 1.0)', type: 'number', step: '0.1' },
				{ key: 'max_tokens', label: 'max_tokens', placeholder: 'int (default 8192)', type: 'number' },
				{ key: 'context_win', label: 'context_win', placeholder: 'int', type: 'number' },
				{ key: 'max_retries', label: 'max_retries', placeholder: 'int', type: 'number' },
				{ key: 'connect_timeout', label: 'connect_timeout', placeholder: 'sec', type: 'number' },
				{ key: 'read_timeout', label: 'read_timeout', placeholder: 'sec', type: 'number' },
				{ key: 'api_mode', label: 'api_mode', placeholder: 'chat_completions|responses' },
				{ key: 'proxy', label: 'proxy', placeholder: 'http://127.0.0.1:2082' },
				{ key: 'stream', label: 'stream', type: 'checkbox' },
			];

			function maskKey(s) {
				const v = String(s || '');
				if (v.length <= 8) { return '••••'; }
				return v.slice(0, 4) + '••••' + v.slice(-4);
			}

			function buildSessionCard(idx) {
				const s = configState.sessions[idx] || {};
				const wrap = document.createElement('div');
				wrap.className = 'cfg-session';
				wrap.dataset.idx = String(idx);

				const head = document.createElement('div');
				head.className = 'cfg-session-head';
				const typeSel = document.createElement('select');
				SESSION_TYPES.forEach(function (t) {
					const o = document.createElement('option');
					o.value = t.value; o.textContent = t.label;
					if ((s._type || 'native_oai') === t.value) { o.selected = true; }
					typeSel.appendChild(o);
				});
				typeSel.addEventListener('change', function () {
					configState.sessions[idx]._type = typeSel.value;
				});
				head.appendChild(typeSel);
				const nameInput = document.createElement('input');
				nameInput.placeholder = '内部 key（如 native_oai_config1）';
				nameInput.value = s._key || '';
				nameInput.style.flex = '1 1 auto';
				nameInput.addEventListener('input', function () {
					configState.sessions[idx]._key = nameInput.value.trim();
				});
				head.appendChild(nameInput);
				const delBtn = document.createElement('button');
				delBtn.className = 'row-action';
				delBtn.textContent = '删除';
				delBtn.addEventListener('click', function () {
					configState.sessions.splice(idx, 1);
					renderConfigEditor();
				});
				head.appendChild(delBtn);
				wrap.appendChild(head);

				const grid = document.createElement('div');
				grid.className = 'cfg-grid';
				function addField(label, key, opts) {
					const lab = document.createElement('label');
					lab.textContent = label;
					grid.appendChild(lab);
					if (opts && opts.inline) {
						grid.appendChild(opts.inline);
					} else {
						const inp = document.createElement('input');
						inp.type = (opts && opts.type) || 'text';
						if (opts && opts.placeholder) { inp.placeholder = opts.placeholder; }
						if (opts && opts.step) { inp.step = opts.step; }
						const v = s[key];
						if (opts && opts.type === 'checkbox') {
							inp.checked = !!v;
							inp.addEventListener('change', function () { configState.sessions[idx][key] = inp.checked; });
						} else {
							inp.value = (v === undefined || v === null) ? '' : String(v);
							inp.addEventListener('input', function () {
								let val = inp.value;
								if (opts && opts.type === 'number') {
									if (val === '') { delete configState.sessions[idx][key]; return; }
									const n = Number(val);
									configState.sessions[idx][key] = isNaN(n) ? val : n;
								} else {
									configState.sessions[idx][key] = val;
								}
							});
						}
						grid.appendChild(inp);
					}
				}
				const nameRow = document.createElement('input');
				nameRow.placeholder = 'name (展示用，可与 key 一致)';
				nameRow.value = s.name || '';
				nameRow.addEventListener('input', function () { configState.sessions[idx].name = nameRow.value; });
				addField('name', 'name', { inline: nameRow });

				// API key with show/hide
				const keyWrap = document.createElement('div');
				keyWrap.className = 'row-inline';
				const keyInput = document.createElement('input');
				keyInput.type = 'password';
				keyInput.placeholder = 'sk-...';
				keyInput.value = s.apikey || '';
				keyInput.style.flex = '1 1 auto';
				keyInput.addEventListener('input', function () { configState.sessions[idx].apikey = keyInput.value; });
				keyWrap.appendChild(keyInput);
				const eyeBtn = document.createElement('button');
				eyeBtn.type = 'button';
				eyeBtn.textContent = '显示';
				eyeBtn.addEventListener('click', function () {
					if (keyInput.type === 'password') { keyInput.type = 'text'; eyeBtn.textContent = '隐藏'; }
					else { keyInput.type = 'password'; eyeBtn.textContent = '显示'; }
				});
				keyWrap.appendChild(eyeBtn);
				addField('apikey', 'apikey', { inline: keyWrap });

				addField('apibase', 'apibase', { placeholder: 'https://api.openai.com/v1' });

				// Model with test/list button
				const modelWrap = document.createElement('div');
				modelWrap.className = 'row-inline';
				const modelInput = document.createElement('input');
				modelInput.placeholder = 'gpt-4o / claude-opus-4-7 ...';
				modelInput.value = s.model || '';
				modelInput.style.flex = '1 1 auto';
				modelInput.addEventListener('input', function () { configState.sessions[idx].model = modelInput.value; });
				modelWrap.appendChild(modelInput);
				const testBtn = document.createElement('button');
				testBtn.type = 'button';
				testBtn.textContent = '测试 / 列模型';
				testBtn.addEventListener('click', async function () {
					testBtn.disabled = true;
					testBtn.textContent = '测试中…';
					try {
						const r = await window.gaApi.listModels(s.apikey || '', s.apibase || '', s.proxy || '');
						const models = (r && r.models) || [];
						if (!models.length) {
							alert('连通成功，但未返回模型列表');
						} else {
							const pick = prompt('连通成功，请粘贴或选择模型：\\n\\n' + models.slice(0, 30).join('\\n'), modelInput.value || models[0]);
							if (pick) { modelInput.value = pick; configState.sessions[idx].model = pick; }
						}
					} catch (e) {
						alert('测试失败：' + (e.message || e));
					}
					testBtn.disabled = false;
					testBtn.textContent = '测试 / 列模型';
				});
				modelWrap.appendChild(testBtn);
				addField('model', 'model', { inline: modelWrap });

				// Advanced (collapsed by default)
				const advWrap = document.createElement('details');
				advWrap.style.gridColumn = '1 / -1';
				advWrap.style.marginTop = '4px';
				const adv = document.createElement('summary');
				adv.textContent = '高级选项';
				adv.style.cursor = 'pointer';
				adv.style.fontSize = '11px';
				adv.style.color = 'var(--fg-muted)';
				advWrap.appendChild(adv);
				const advGrid = document.createElement('div');
				advGrid.className = 'cfg-grid';
				advGrid.style.marginTop = '6px';
				ADVANCED_FIELDS.forEach(function (f) {
					const lab = document.createElement('label');
					lab.textContent = f.label;
					advGrid.appendChild(lab);
					const inp = document.createElement('input');
					inp.type = f.type || 'text';
					if (f.placeholder) { inp.placeholder = f.placeholder; }
					if (f.step) { inp.step = f.step; }
					const v = s[f.key];
					if (f.type === 'checkbox') {
						inp.checked = !!v;
						inp.addEventListener('change', function () { configState.sessions[idx][f.key] = inp.checked; });
					} else {
						inp.value = (v === undefined || v === null) ? '' : String(v);
						inp.addEventListener('input', function () {
							const val = inp.value;
							if (f.type === 'number') {
								if (val === '') { delete configState.sessions[idx][f.key]; return; }
								const n = Number(val);
								configState.sessions[idx][f.key] = isNaN(n) ? val : n;
							} else if (val === '') {
								delete configState.sessions[idx][f.key];
							} else {
								configState.sessions[idx][f.key] = val;
							}
						});
					}
					advGrid.appendChild(inp);
				});
				advWrap.appendChild(advGrid);

				wrap.appendChild(grid);
				wrap.appendChild(advWrap);
				return wrap;
			}

			function renderConfigEditor() {
				configModalBodyEl.innerHTML = '';
				const banner = document.createElement('div');
				banner.className = 'config-banner';
				banner.innerHTML = '🔒 <b>所有 API Key 仅保存在本机 <code>mykey.json</code></b>，不会上传或外发。建议为本工具单独申请额度受限的 Key，并定期轮换。' +
					(configState.readonly ? '<br><b>⚠ 当前检测到 mykey.py 同时存在</b>，保存到 mykey.json 后建议在编辑器中删除或重命名 mykey.py 以避免冲突。' : '');
				configModalBodyEl.appendChild(banner);

				const sec = document.createElement('div');
				sec.className = 'cfg-section-title';
				sec.textContent = 'LLM Sessions';
				configModalBodyEl.appendChild(sec);

				if (!configState.sessions.length) {
					// First-run onboarding: provider preset cards instead of bare empty hint.
					const wizard = document.createElement('div');
					wizard.style.cssText = 'padding: 4px 0 6px;';
					const wizTitle = document.createElement('div');
					wizTitle.style.cssText = 'font-size:13px;font-weight:600;color:var(--fg-strong);margin-bottom:6px;';
					wizTitle.textContent = '👋 第一次使用？选择你的 LLM 供应商一键开始：';
					wizard.appendChild(wizTitle);
					const wizSub = document.createElement('div');
					wizSub.className = 'cfg-status';
					wizSub.style.cssText = 'margin-bottom:10px;';
					wizSub.textContent = '点击预设 → 自动填好 endpoint 和默认参数，你只需粘贴 API Key 并点测试。';
					wizard.appendChild(wizSub);

					const grid = document.createElement('div');
					grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;margin-bottom:8px;';
					PROVIDER_PRESETS.forEach(function (preset) {
						const card = document.createElement('button');
						card.type = 'button';
						card.style.cssText = 'padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--bg-glass);color:var(--fg);cursor:pointer;text-align:left;display:flex;flex-direction:column;gap:4px;transition:background 0.15s;';
						card.onmouseenter = function () { card.style.background = 'var(--bg-glass-hi)'; };
						card.onmouseleave = function () { card.style.background = 'var(--bg-glass)'; };
						const ttl = document.createElement('div');
						ttl.style.cssText = 'font-size:13px;font-weight:600;color:var(--fg-strong);';
						ttl.textContent = preset.icon + ' ' + preset.label;
						card.appendChild(ttl);
						const desc = document.createElement('div');
						desc.style.cssText = 'font-size:11px;color:var(--fg-muted);line-height:1.4;';
						desc.textContent = preset.hint;
						card.appendChild(desc);
						card.addEventListener('click', function () {
							configState.sessions.push(makeSessionFromPreset(preset));
							renderConfigEditor();
						});
						grid.appendChild(card);
					});
					wizard.appendChild(grid);

					const customBtn = document.createElement('button');
					customBtn.className = 'cfg-add-btn';
					customBtn.style.marginTop = '4px';
					customBtn.textContent = '+ 我要自定义（高级用户）';
					customBtn.addEventListener('click', function () {
						configState.sessions.push(makeSessionFromPreset(PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]));
						renderConfigEditor();
					});
					wizard.appendChild(customBtn);

					configModalBodyEl.appendChild(wizard);
				} else {
					configState.sessions.forEach(function (_, idx) {
						configModalBodyEl.appendChild(buildSessionCard(idx));
					});
					const addBtn = document.createElement('button');
					addBtn.className = 'cfg-add-btn';
					addBtn.textContent = '+ 添加 Session';
					addBtn.addEventListener('click', function () {
						// Re-show preset picker as a dropdown if user wants to add another.
						const choice = window.prompt('选择供应商预设：\\n' + PROVIDER_PRESETS.map(function (p, i) { return (i + 1) + '. ' + p.label; }).join('\\n') + '\\n\\n输入编号（默认 1: OpenAI）：', '1');
						const i = Math.max(1, Math.min(PROVIDER_PRESETS.length, parseInt(choice || '1', 10) || 1)) - 1;
						configState.sessions.push(makeSessionFromPreset(PROVIDER_PRESETS[i]));
						renderConfigEditor();
					});
					configModalBodyEl.appendChild(addBtn);
				}

				// Mixin section
				const msec = document.createElement('div');
				msec.className = 'cfg-section-title';
				msec.textContent = 'Mixin 故障转移（可选）';
				configModalBodyEl.appendChild(msec);

				const mixWrap = document.createElement('div');
				mixWrap.className = 'cfg-session';
				const mg = document.createElement('div');
				mg.className = 'cfg-grid';
				const mlabel = document.createElement('label');
				mlabel.textContent = 'llm_nos';
				mg.appendChild(mlabel);
				const mInput = document.createElement('input');
				mInput.placeholder = '逗号分隔 name 列表，如 gpt-native, cc-relay-1';
				const cur = configState.mixin && configState.mixin.llm_nos;
				mInput.value = Array.isArray(cur) ? cur.join(', ') : (cur || '');
				mInput.addEventListener('input', function () {
					if (!configState.mixin) { configState.mixin = { _key: 'mixin_config' }; }
					const arr = mInput.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
					configState.mixin.llm_nos = arr;
				});
				mg.appendChild(mInput);
				mixWrap.appendChild(mg);
				configModalBodyEl.appendChild(mixWrap);
			}

			async function openConfigEditor() {
				configStatusEl.textContent = '加载中…';
				configModalEl.classList.add('show');
				configModalBodyEl.innerHTML = '<div class="dropdown-empty">加载中…</div>';
				try {
					const r = await window.gaApi.getLLMConfig();
					configState = {
						sessions: ((r && r.sessions) || []).map(function (s) { return Object.assign({}, s); }),
						mixin: (r && r.mixin) ? Object.assign({}, r.mixin) : null,
						readonly: !!(r && r.readonly),
					};
					configStatusEl.textContent = '已加载 ' + configState.sessions.length + ' 个会话';
					renderConfigEditor();
				} catch (e) {
					configModalBodyEl.innerHTML = '<div class="dropdown-empty">加载失败：' + escapeHtml(e.message || String(e)) + '</div>';
					configStatusEl.textContent = '加载失败';
				}
			}

			function closeConfigEditor() { configModalEl.classList.remove('show'); }

			async function saveConfig(reloadAfter) {
				configStatusEl.textContent = '保存中…';
				try {
					const body = {
						sessions: configState.sessions.map(function (s) {
							const o = {};
							Object.keys(s).forEach(function (k) {
								const v = s[k];
								if (v === '' || v === null || v === undefined) { return; }
								o[k] = v;
							});
							return o;
						}),
						mixin: (configState.mixin && configState.mixin.llm_nos && configState.mixin.llm_nos.length) ? configState.mixin : null,
					};
					await window.gaApi.saveLLMConfig(body);
					configStatusEl.textContent = '已保存到 mykey.json';
					if (reloadAfter) {
						configStatusEl.textContent = '保存成功，载入中…';
						const rr = await window.gaApi.reloadLLMConfig();
						if (rr && rr.error) {
							configStatusEl.textContent = '载入失败：' + rr.error;
							alert('载入失败：' + rr.error);
						} else {
							configStatusEl.textContent = '✓ 载入完成（' + ((rr && rr.count) || 0) + ' 个 LLM）';
							checkLlmConfigured();
							setTimeout(closeConfigEditor, 800);
						}
					}
				} catch (e) {
					configStatusEl.textContent = '保存失败：' + (e.message || e);
					alert('保存失败：' + (e.message || e));
				}
			}

			configModalCloseEl.addEventListener('click', closeConfigEditor);
			configModalCancelEl.addEventListener('click', closeConfigEditor);
			configModalEl.addEventListener('click', function (e) {
				if (e.target === configModalEl) { closeConfigEditor(); }
			});
			configModalSaveEl.addEventListener('click', function () { saveConfig(false); });
			configModalSaveReloadEl.addEventListener('click', function () { saveConfig(true); });
			if (settingsConfigBtn) { settingsConfigBtn.addEventListener('click', function () { closeAllPanels(); openConfigEditor(); }); }

			// Missing-config detection + banner
			async function checkLlmConfigured() {
				try {
					const r = await window.gaApi.getLLMConfig();
					const ok = !!(r && r.sessions && r.sessions.length);
					cfgPromptEl.hidden = ok;
				} catch {
					cfgPromptEl.hidden = false;
				}
			}
			if (cfgPromptOpenEl) { cfgPromptOpenEl.addEventListener('click', openConfigEditor); }
			if (cfgPromptDismissEl) { cfgPromptDismissEl.addEventListener('click', function () { cfgPromptEl.hidden = true; }); }
			setTimeout(checkLlmConfigured, 1500);

			// ── Mode dropdown (Agent / Editor) ────────────────────────────
			function applyMode(name) {
				currentMode = name;
				modeLabelEl.textContent = name === 'editor' ? 'Editor' : 'Agent';
				Array.from(modeMenuEl.querySelectorAll('.mode-menu-item')).forEach(function (it) {
					it.classList.toggle('active', it.dataset.mode === currentMode);
				});
				inputEl.placeholder = currentMode === 'editor'
					? 'Describe an edit for the active file…'
					: 'Plan, @ for context, / for commands';
			}
			modeTriggerEl.addEventListener('click', function (e) {
				e.stopPropagation();
				modeMenuEl.classList.toggle('show');
			});
			modeMenuEl.addEventListener('click', function (e) {
				const item = e.target.closest('.mode-menu-item');
				if (!item) { return; }
				applyMode(item.dataset.mode);
				modeMenuEl.classList.remove('show');
			});
			document.addEventListener('click', function (e) {
				if (!e.target.closest('#mode-menu, #mode-trigger')) {
					modeMenuEl.classList.remove('show');
				}
			});

			// ── Model label tracks status ─────────────────────────────────
			function updateModelLabel(status) {
				if (status && status.llm) { modelLabelEl.textContent = String(status.llm); }
			}
			modelTriggerEl.addEventListener('click', function () {
				vscode.postMessage({ kind: 'info', text: 'Model switching: edit mykey.py and Reload from Settings.' });
			});

			// Initial loads
			loadSessions('');

			// ═══════════════════════════════════════════════════════════
			// New-feature wiring (P3-P9): autonomous mode, ops menu,
			// file/image attach, LLM dropdown, theme toggle, status pill.
			// Kept self-contained so the original chat plumbing above is
			// untouched and still passes its protocol-boundary tests.
			// ═══════════════════════════════════════════════════════════
			(function wireExtras() {
				var $$ = function (id) { return document.getElementById(id); };

				// ── Status pill + conversation title ──────────────────
				var statusPillEl  = $$('status-pill');
				var statusLlmEl   = $$('status-llm');
				var convoTitleEl  = $$('convo-title');
				var titleSepEl    = $$('title-sep');
				var composerStat  = $$('composer-status');
				var composerStatTxt = $$('composer-status-text');

				function setStatusPill(state, text) {
					if (!statusPillEl) return;
					statusPillEl.classList.remove('run', 'err');
					if (state === 'run') statusPillEl.classList.add('run');
					else if (state === 'err') statusPillEl.classList.add('err');
					if (text && statusLlmEl) statusLlmEl.textContent = text;
				}
				function setComposerStatus(state, text) {
					if (!composerStat) return;
					composerStat.classList.remove('run', 'err', 'ok');
					if (state) composerStat.classList.add(state);
					if (text && composerStatTxt) composerStatTxt.textContent = text;
				}
				function setConvoTitle(t) {
					if (!convoTitleEl) return;
					if (t && t.trim()) {
						convoTitleEl.textContent = t;
						convoTitleEl.hidden = false;
						if (titleSepEl) titleSepEl.hidden = false;
					} else {
						convoTitleEl.hidden = true;
						if (titleSepEl) titleSepEl.hidden = true;
					}
				}

				// ── More menu (overflow) ──────────────────────────────
				var btnMore     = $$('btn-more');
				var panelMore   = $$('panel-more');
				if (btnMore && panelMore) {
					btnMore.addEventListener('click', function (e) {
						e.stopPropagation();
						// Hide other dropdowns
						document.querySelectorAll('.dropdown-panel.show').forEach(function (p) {
							if (p !== panelMore) p.classList.remove('show');
						});
						panelMore.classList.toggle('show');
					});
					document.addEventListener('click', function (e) {
						if (!e.target.closest('#panel-more, #btn-more')) panelMore.classList.remove('show');
					});
				}
				// Route data-more-action clicks
				document.querySelectorAll('[data-more-action]').forEach(function (row) {
					row.addEventListener('click', function () {
						var act = row.getAttribute('data-more-action');
						if (panelMore) panelMore.classList.remove('show');
						if (act === 'next_llm') {
							vscode.postMessage({ kind: 'next_llm', idx: -1 });
						} else if (act === 'reinject_tools' || act === 'desktop_pet') {
							vscode.postMessage({ kind: 'action', name: act });
						} else if (act === 'theme_toggle') {
							toggleTheme();
						} else if (act === 'open_settings') {
							vscode.postMessage({ kind: 'open_settings' });
						}
					});
				});

				// ── Theme toggle ──────────────────────────────────────
				function toggleTheme() {
					var html = document.documentElement;
					var current = html.getAttribute('data-theme') || 'dark';
					var next = current === 'dark' ? 'light' : 'dark';
					html.setAttribute('data-theme', next);
					var lab = $$('theme-toggle-label');
					if (lab) {
						lab.textContent = next === 'dark'
							? '🌙 Switch to light theme'
							: '☀ Switch to dark theme';
					}
					try { localStorage.setItem('ga_theme', next); } catch (e) {}
				}
				// Restore previous choice
				try {
					var savedTheme = localStorage.getItem('ga_theme');
					if (savedTheme === 'light') {
						document.documentElement.setAttribute('data-theme', 'light');
						var lab2 = $$('theme-toggle-label');
						if (lab2) lab2.textContent = '☀ Switch to dark theme';
					}
				} catch (e) {}

				// ── Autonomous mode ───────────────────────────────────
				var autoPill        = $$('auto-pill');
				var autoPillCount   = $$('auto-pill-countdown');
				var autoStrip       = $$('auto-strip');
				var autoCountdown   = $$('auto-countdown');
				var btnAutoTrigger  = $$('btn-auto-trigger');
				var btnAutoOff      = $$('btn-auto-off');
				var autonomousOn    = false;
				var lastReplyTime   = 0;

				function updateAutoUI() {
					if (autoPill) autoPill.classList.toggle('on', autonomousOn);
					if (autoStrip) autoStrip.hidden = !autonomousOn;
					updateAutoCountdown();
				}
				function fmtIdle(secs) {
					if (secs < 60) return 'idle ' + secs + 's';
					var m = Math.floor(secs / 60);
					var s = secs % 60;
					return 'idle ' + m + 'm' + (s ? ' ' + s + 's' : '');
				}
				function updateAutoCountdown() {
					if (!lastReplyTime) {
						if (autoPillCount) autoPillCount.hidden = true;
						if (autoCountdown) autoCountdown.textContent = 'idle —';
						return;
					}
					var elapsed = Math.max(0, Math.floor(Date.now() / 1000 - lastReplyTime));
					var txt = fmtIdle(elapsed);
					if (autoCountdown) autoCountdown.textContent = txt;
					if (autoPillCount && autonomousOn) {
						autoPillCount.hidden = false;
						autoPillCount.textContent = txt.replace('idle ', '');
					} else if (autoPillCount) {
						autoPillCount.hidden = true;
					}
				}
				setInterval(updateAutoCountdown, 1000);

				if (autoPill) {
					autoPill.addEventListener('click', function () {
						vscode.postMessage({ kind: 'action', name: 'autonomous_toggle' });
					});
				}
				if (btnAutoTrigger) {
					btnAutoTrigger.addEventListener('click', function () {
						vscode.postMessage({ kind: 'action', name: 'idle_trigger' });
					});
				}
				if (btnAutoOff) {
					btnAutoOff.addEventListener('click', function () {
						vscode.postMessage({ kind: 'action', name: 'autonomous_toggle' });
					});
				}

				// ── LLM dropdown (popped from .model-trigger) ─────────
				var modelTriggerEl2 = $$('model-trigger');
				var llmMenuEl       = $$('llm-menu');
				var modeMenuEl2     = $$('mode-menu');
				var llmList = [];
				function renderLlmMenu() {
					if (!llmMenuEl) return;
					if (!llmList.length) {
						llmMenuEl.innerHTML = '<div class="mode-menu-item" style="opacity:.6;cursor:default;"><div class="t">No LLMs configured</div><div class="d">Open settings to add one</div></div>';
						return;
					}
					var html = '';
					for (var i = 0; i < llmList.length; i++) {
						var m = llmList[i];
						var name = (m && (m.name || m.llm)) || ('LLM ' + i);
						var idx = (m && typeof m.idx === 'number') ? m.idx : i;
						var cur = m && m.current;
						html += '<div class="mode-menu-item ' + (cur ? 'active' : '') + '" data-llm-idx="' + idx + '">'
							+ '<div class="t">' + escapeHtml(name) + '</div>'
							+ '<div class="d">' + (cur ? 'Active' : 'Click to switch') + '</div>'
							+ '</div>';
					}
					llmMenuEl.innerHTML = html;
					llmMenuEl.querySelectorAll('[data-llm-idx]').forEach(function (el) {
						el.addEventListener('click', function () {
							var idx = parseInt(el.getAttribute('data-llm-idx'), 10);
							vscode.postMessage({ kind: 'next_llm', idx: idx });
							llmMenuEl.classList.remove('show');
						});
					});
				}
				function escapeHtml(s) {
					return String(s == null ? '' : s)
						.replace(/&/g, '&amp;').replace(/</g, '&lt;')
						.replace(/>/g, '&gt;').replace(/"/g, '&quot;');
				}
				if (modelTriggerEl2 && llmMenuEl) {
					// Override the legacy click that just shows an info toast.
					modelTriggerEl2.addEventListener('click', function (e) {
						e.stopPropagation();
						if (modeMenuEl2) modeMenuEl2.classList.remove('show');
						renderLlmMenu();
						llmMenuEl.classList.toggle('show');
					}, true /* capture so we run before the legacy listener */);
					document.addEventListener('click', function (e) {
						if (!e.target.closest('#llm-menu, #model-trigger')) llmMenuEl.classList.remove('show');
					});
				}

				// ── File / image attachments ──────────────────────────
				// We use VS Code's native file picker (via 'pick_files'
				// extension passthrough) so we get real absolute paths
				// rather than the synthetic blob URLs produced by
				// <input type=file>.  The picked file's workspace-relative
				// path is then injected as an "@<rel>" token at the cursor
				// position, which the existing chat send pipeline already
				// handles transparently.
				var btnFile     = $$('btn-attach-file');
				var btnImage    = $$('btn-attach-image');
				var inputEl2    = $$('input');
				var pickReqs    = {};
				var pickReqSeq  = 0;

				function insertMentionToken(rel) {
					if (!inputEl2 || !rel) return;
					var token = '@' + rel;
					var pos = inputEl2.selectionStart || 0;
					var before = inputEl2.value.slice(0, pos);
					var after = inputEl2.value.slice(pos);
					var sep = (before && !/\s$/.test(before)) ? ' ' : '';
					var trail = (after && !/^\s/.test(after)) ? ' ' : '';
					inputEl2.value = before + sep + token + trail + after;
					var newPos = (before + sep + token + trail).length;
					inputEl2.setSelectionRange(newPos, newPos);
					inputEl2.focus();
					// Trigger input event so existing chat logic re-parses
					// @-mentions and keeps its attachment map in sync.
					inputEl2.dispatchEvent(new Event('input', { bubbles: true }));
				}

				function pickFiles(imagesOnly) {
					var rid = 'pick' + (++pickReqSeq);
					pickReqs[rid] = true;
					vscode.postMessage({ kind: 'pick_files', requestId: rid, imagesOnly: !!imagesOnly });
				}

				if (btnFile)  btnFile .addEventListener('click', function () { pickFiles(false); });
				if (btnImage) btnImage.addEventListener('click', function () { pickFiles(true); });

				// ── Drag & drop visual feedback ───────────────────────
				// Real drag-drop attachment is awkward in webviews because
				// File objects don't expose absolute paths.  We show the
				// overlay for affordance and route the drop to the same
				// native picker; the user just clicks through, which is
				// still strictly faster than menu-diving.
				var composerRow = $$('composer-row');
				var dragOverlay = $$('drag-overlay');
				var dragDepth = 0;
				if (composerRow && dragOverlay) {
					composerRow.addEventListener('dragenter', function (e) {
						e.preventDefault(); dragDepth++;
						dragOverlay.classList.add('show');
					});
					composerRow.addEventListener('dragover', function (e) { e.preventDefault(); });
					composerRow.addEventListener('dragleave', function () {
						dragDepth = Math.max(0, dragDepth - 1);
						if (dragDepth === 0) dragOverlay.classList.remove('show');
					});
					composerRow.addEventListener('drop', function (e) {
						e.preventDefault(); dragDepth = 0;
						dragOverlay.classList.remove('show');
						// Webviews can't read OS file paths from a drop, so
						// fall back to the picker pre-filtered for images
						// when the dragged item smells like one.
						var files = e.dataTransfer && e.dataTransfer.files;
						var isImg = false;
						if (files && files[0] && files[0].type && files[0].type.indexOf('image/') === 0) {
							isImg = true;
						}
						pickFiles(isImg);
					});
				}

				// ── Listen for backend messages we care about ─────────
				window.addEventListener('message', function (ev) {
					var m = ev.data;
					if (!m) return;
					if (m.kind === 'status') {
						var s = m.status || {};
						autonomousOn = !!s.autonomous_enabled;
						lastReplyTime = s.last_reply_time || 0;
						llmList = Array.isArray(s.llms) ? s.llms : [];
						updateAutoUI();
						// Reflect run state in pills
						if (s.running) {
							setStatusPill('run', s.llm || window.gaT('composer.working'));
							setComposerStatus('run', window.gaT('composer.working'));
						} else {
							setStatusPill('', s.llm || window.gaT('composer.ready'));
							setComposerStatus('', window.gaT('composer.ready'));
						}
					} else if (m.kind === 'auto_user') {
						// Synthetic user message broadcast by autonomous trigger.
						// We can't safely call the legacy chat helpers from
						// outside their IIFE, so dispatch a synthetic 'send'
						// echo through the existing log: stash the text into
						// the textarea, simulate Enter, then clear.  Actually,
						// the simpler path is to render a system message via
						// a custom DOM insertion.  The agent stream that
						// follows will then build up the assistant reply
						// normally via the existing on_stream handling.
						var logEl = $$('log');
						if (logEl) {
							var el = document.createElement('div');
							el.className = 'msg user';
							el.innerHTML = '<div class="meta"><span class="who">Auto</span></div><div class="body"></div>';
							el.querySelector('.body').textContent = String(m.text || '');
							logEl.appendChild(el);
							el.scrollIntoView({ block: 'end' });
						}
					} else if (m.kind === 'error') {
						setComposerStatus('err', String(m.text || window.gaT('composer.ready')).slice(0, 120));
					} else if (m.kind === 'done') {
						setComposerStatus('ok', 'Done');
						setTimeout(function () { setComposerStatus('', window.gaT('composer.ready')); }, 1500);
					} else if (m.kind === 'pick_files_result') {
						if (!pickReqs[m.requestId]) return;
						delete pickReqs[m.requestId];
						var files = Array.isArray(m.files) ? m.files : [];
						for (var i = 0; i < files.length; i++) {
							var f = files[i];
							if (f && f.rel) insertMentionToken(f.rel);
						}
					} else if (m.kind === 'prefs') {
						// Live preference update from VS Code Settings.
						window.gaPrefs = Object.assign(window.gaPrefs || {}, m.prefs || {});
						var th = window.gaPrefs.theme || 'auto';
						if (th === 'light') document.documentElement.setAttribute('data-theme', 'light');
						else if (th === 'dark')  document.documentElement.setAttribute('data-theme', 'dark');
						else document.documentElement.removeAttribute('data-theme');
						// Re-walk the i18n attributes; gaT() reads the new
						// language on each call so this rewrites every
						// translatable string in place.
						if (typeof window.gaApplyI18n === 'function') {
							window.gaApplyI18n();
						}
						// Refresh the dynamic ready/working/done status
						// label to reflect the new language too.
						setComposerStatus('', window.gaT('composer.ready'));
					}
				});

				// Initial composer status (uses i18n now)
				setComposerStatus('', window.gaT ? window.gaT('composer.ready') : 'Ready');
			})();

			vscode.postMessage({ kind: 'ready' });
			refreshJumpButton();
			inputEl.focus();
		})();
	</script>
</body>
</html>`;
	}

	/** Public so `extension.ts` can force-close the panel during a backend
	 *  restart (the AgentClient the panel was wired to is gone; easiest to
	 *  tear down and let the user reopen against the new client). */
	public dispose(): void {
		ChatPanel.current = undefined;
		this.panel.dispose();
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return out;
}

// ───────────────────────────────────────────────────────────────────────
// Apply-flow plumbing
//
// Proposed code lives in a virtual document served by a TextDocumentContent-
// Provider registered on the custom scheme `generic-agent-apply`.  The same
// in-memory map backs both the "proposed" right-hand side of the diff and
// the "empty-baseline" left-hand side used when creating a new file.
// ───────────────────────────────────────────────────────────────────────

const APPLY_SCHEME = 'generic-agent-apply';
const proposedDocs = new Map<string, string>();

class ProposedContentProvider implements vscode.TextDocumentContentProvider {
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this._onDidChange.event;
	provideTextDocumentContent(uri: vscode.Uri): string {
		return proposedDocs.get(uri.toString()) ?? '';
	}
	refresh(uri: vscode.Uri): void { this._onDidChange.fire(uri); }
}

let _providerInstance: ProposedContentProvider | undefined;
export function registerApplyProvider(ctx: vscode.ExtensionContext): void {
	if (_providerInstance) { return; }
	_providerInstance = new ProposedContentProvider();
	ctx.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(APPLY_SCHEME, _providerInstance),
	);
}

interface ApplyTarget { uri: vscode.Uri; isNew: boolean; }

async function resolveApplyTarget(filename: string): Promise<ApplyTarget | undefined> {
	const path = require('path') as typeof import('path');
	const fs = require('fs') as typeof import('fs');

	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

	if (filename) {
		const isAbsolute = path.isAbsolute(filename);
		let full: string;
		if (isAbsolute) {
			full = filename;
		} else if (workspaceFolder) {
			full = path.join(workspaceFolder.uri.fsPath, filename);
		} else {
			void vscode.window.showErrorMessage(
				`GenericAgent: code block targets "${filename}" but no workspace folder is open.`,
			);
			return undefined;
		}
		const uri = vscode.Uri.file(full);
		const isNew = !fs.existsSync(full);
		return { uri, isNew };
	}

	const active = vscode.window.activeTextEditor?.document;
	if (active && active.uri.scheme === 'file') {
		return { uri: active.uri, isNew: false };
	}

	// No filename, no active file: ask the user to pick / save-as.
	const picked = await vscode.window.showSaveDialog({
		defaultUri: workspaceFolder?.uri,
		title: 'Apply code block to…',
	});
	return picked ? { uri: picked, isNew: !require('fs').existsSync(picked.fsPath) } : undefined;
}

async function readTextSafe(uri: vscode.Uri): Promise<string> {
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		return Buffer.from(bytes).toString('utf8');
	} catch {
		return '';
	}
}

function resolveSopSource(name: string): string | undefined {
	const safe = nodePath.basename(name || '');
	if (!safe.endsWith('.md')) { return undefined; }
	const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
	const candidates: string[] = [];
	for (const root of roots) {
		candidates.push(nodePath.join(root, 'memory', safe));
		candidates.push(nodePath.join(nodePath.dirname(root), 'GenericAgent', 'memory', safe));
	}
	for (const p of candidates) {
		try {
			if (fs.existsSync(p) && fs.statSync(p).isFile()) { return p; }
		} catch {}
	}
	return undefined;
}

/**
 * Resolve an array of webview-side mention objects to a list of absolute
 * file paths.  We defensively check that each claimed `abs` path exists
 * AND that it resolves within a workspace folder (no path escapes).  If
 * the absolute path isn't valid we try to re-resolve via the relative
 * path against the first workspace folder as a fallback.
 *
 * Exported for unit testing.
 */
export function resolveMentionPaths(
	mentions: { rel: string; abs: string }[] | undefined,
	workspaceRoots: string[] = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
): string[] {
	if (!mentions || mentions.length === 0) { return []; }
	const fs = require('fs') as typeof import('fs');
	const path = require('path') as typeof import('path');
	const out: string[] = [];
	const seen = new Set<string>();
	for (const m of mentions) {
		if (!m || typeof m.abs !== 'string') { continue; }
		const candidates: string[] = [];
		if (path.isAbsolute(m.abs)) { candidates.push(m.abs); }
		// Fallback: resolve `rel` under each workspace root.
		if (m.rel && !path.isAbsolute(m.rel)) {
			for (const root of workspaceRoots) {
				candidates.push(path.join(root, m.rel));
			}
		}
		for (const c of candidates) {
			const norm = path.resolve(c);
			// Keep only paths that sit under a workspace root.  Don't use
			// fs.realpathSync here — symlinked workspaces are a valid setup
			// and we shouldn't follow out of them behind the user's back.
			const inWorkspace = workspaceRoots.length === 0
				|| workspaceRoots.some(r => norm === r || norm.startsWith(r + path.sep));
			if (!inWorkspace) { continue; }
			if (seen.has(norm)) { continue; }
			try {
				if (fs.existsSync(norm) && fs.statSync(norm).isFile()) {
					out.push(norm);
					seen.add(norm);
					break;
				}
			} catch { /* ignore */ }
		}
	}
	return out;
}

// ───────────────────────────────────────────────────────────────────────
// Shared apply-flow helpers (reused by InlineEditController)
// ───────────────────────────────────────────────────────────────────────

/**
 * URI of the virtual "proposed content" document for a given real file.
 * Stable per file so in-flight streaming (inline-edit) can update the
 * same document and the diff view auto-refreshes.
 */
export function proposedUriFor(uri: vscode.Uri): vscode.Uri {
	return uri.with({ scheme: APPLY_SCHEME, path: uri.path + '.proposed' });
}

/** URI of the (virtual, always-empty) baseline document used as the left-
 *  hand side of the diff when the target file doesn't exist yet. */
export function emptyBaselineUriFor(uri: vscode.Uri): vscode.Uri {
	return uri.with({ scheme: APPLY_SCHEME, path: uri.path + '.empty' });
}

/** Update the contents of a proposed-document URI and notify VSCode so any
 *  open diff view re-renders.  Safe to call many times per second — we
 *  only fire `onDidChange` when content actually changed. */
export function setProposedContent(uri: vscode.Uri, content: string): void {
	const key = uri.toString();
	if (proposedDocs.get(key) === content) { return; }
	proposedDocs.set(key, content);
	_providerInstance?.refresh(uri);
}

/** Drop a proposed-document entry; called once the apply flow finishes. */
export function clearProposedContent(uri: vscode.Uri): void {
	proposedDocs.delete(uri.toString());
}

/**
 * Open the proposed-vs-current diff, then prompt the user to Apply or
 * Cancel.  Returns `true` iff the edit was applied and saved.
 *
 *   range === undefined  →  overwrite / create the whole file
 *   range !== undefined  →  replace a specific range (inline-edit use case)
 */
export async function applyCodeToFile(
	uri: vscode.Uri,
	code: string,
	isNew: boolean,
	range?: vscode.Range,
): Promise<boolean> {
	const path = require('path') as typeof import('path');
	const proposedUri = proposedUriFor(uri);
	setProposedContent(proposedUri, code);
	if (isNew) {
		setProposedContent(emptyBaselineUriFor(uri), '');
	}

	const title = `Apply → ${path.basename(uri.fsPath)}${isNew ? ' (new file)' : range ? ' (selection)' : ''}`;
	try {
		await vscode.commands.executeCommand(
			'vscode.diff',
			isNew ? emptyBaselineUriFor(uri) : uri,
			proposedUri,
			title,
			{ preview: true },
		);
	} catch (e) {
		logger.warn('failed to open diff', (e as Error).message);
	}

	const choice = await vscode.window.showInformationMessage(
		`Apply proposed changes to ${path.basename(uri.fsPath)}${range ? ' (selection)' : ''}?`,
		{ modal: false, detail: uri.fsPath },
		'Apply',
		'Cancel',
	);
	if (choice !== 'Apply') {
		clearProposedContent(proposedUri);
		return false;
	}

	try {
		const edit = new vscode.WorkspaceEdit();
		if (isNew) {
			edit.createFile(uri, { overwrite: false, ignoreIfExists: false });
			edit.insert(uri, new vscode.Position(0, 0), code);
		} else if (range) {
			edit.replace(uri, range, code);
		} else {
			const fullRange = new vscode.Range(
				new vscode.Position(0, 0),
				new vscode.Position(Number.MAX_SAFE_INTEGER, 0),
			);
			edit.replace(uri, fullRange, code);
		}
		const ok = await vscode.workspace.applyEdit(edit);
		if (!ok) {
			void vscode.window.showErrorMessage('GenericAgent: apply rejected by the editor.');
			return false;
		}
		const doc = await vscode.workspace.openTextDocument(uri);
		await doc.save();
		await vscode.window.showTextDocument(doc, { preview: false });
		void vscode.window.setStatusBarMessage(
			`$(check) Applied to ${path.basename(uri.fsPath)}`, 4000,
		);
		return true;
	} catch (e) {
		logger.error('apply failed', (e as Error).message);
		void vscode.window.showErrorMessage(`GenericAgent apply failed: ${(e as Error).message}`);
		return false;
	} finally {
		clearProposedContent(proposedUri);
		if (isNew) { clearProposedContent(emptyBaselineUriFor(uri)); }
	}
}

// Expose the helpers that need the active editor to callers in other files.
export { resolveApplyTarget, readTextSafe };
