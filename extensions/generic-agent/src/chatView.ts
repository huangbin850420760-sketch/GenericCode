import * as vscode from 'vscode';
import { logger } from './logger';
import { BackendPorts } from './processManager';

export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'genericAgent.chat';

	private view?: vscode.WebviewView;
	private ports?: BackendPorts;
	private lastError?: string;

	constructor(private readonly extensionUri: vscode.Uri) { }

	setBackendPorts(ports: BackendPorts): void {
		this.ports = ports;
		this.lastError = undefined;
		this.refresh();
	}

	setBackendError(message: string): void {
		this.lastError = message;
		this.ports = undefined;
		this.refresh();
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			enableCommandUris: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
		};
		this.refresh();

		view.webview.onDidReceiveMessage(msg => {
			logger.debug('sidebar webview → extension', msg);
			if (msg?.command === 'openPanel') {
				vscode.commands.executeCommand('genericAgent.openInPanel');
			} else if (msg?.command === 'openSettings') {
				vscode.commands.executeCommand('workbench.action.openSettings', 'genericAgent');
			} else if (msg?.command === 'openLogs') {
				vscode.commands.executeCommand('genericAgent.showLogs');
			} else if (msg?.command === 'restart') {
				vscode.commands.executeCommand('genericAgent.restartBackend');
			}
		});
	}

	private refresh(): void {
		if (!this.view) { return; }
		this.view.webview.html = this.html();
	}

	private html(): string {
		const state = this.ports ? 'ready' : this.lastError ? 'error' : 'starting';
		const title = state === 'ready' ? 'GenericAgent 就绪' : state === 'error' ? 'GenericAgent 启动失败' : 'GenericAgent 启动中';
		const detail = this.ports
			? `已连接本地后端 · http:${this.ports.http} · ws:${this.ports.ws}`
			: this.lastError
				? escapeHtml(this.lastError)
				: '正在启动本地 Agent 后端…';
		const cardAction = this.ports ? `onclick="send('openPanel')"` : '';

		return /* html */ `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
	<style>
		html, body { background: var(--vscode-sideBar-background, transparent); }
		body {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			padding: 10px;
			margin: 0;
		}
		.card {
			display: grid;
			grid-template-columns: 18px 1fr;
			gap: 8px;
			align-items: start;
			padding: 10px;
			border-radius: 8px;
			border: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
			background: var(--vscode-sideBarSectionHeader-background, transparent);
			cursor: default;
		}
		.card.ready { cursor: pointer; }
		.card.ready:hover { background: var(--vscode-list-hoverBackground); }
		.dot {
			width: 8px;
			height: 8px;
			border-radius: 50%;
			margin-top: 5px;
			background: var(--vscode-testing-iconQueued);
		}
		.ready .dot { background: var(--vscode-testing-iconPassed); }
		.error .dot { background: var(--vscode-testing-iconFailed); }
		.starting .dot { animation: pulse 1.2s ease-in-out infinite; }
		@keyframes pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
		.title { font-weight: 600; margin-bottom: 3px; }
		.detail {
			color: var(--vscode-descriptionForeground);
			font-size: 11px;
			line-height: 1.45;
			word-break: break-word;
		}
		.actions {
			display: grid;
			gap: 2px;
			margin-top: 10px;
		}
		button {
			width: 100%;
			text-align: left;
			padding: 5px 7px;
			border: 0;
			border-radius: 5px;
			background: transparent;
			color: var(--vscode-foreground);
			cursor: pointer;
			font-family: inherit;
			font-size: inherit;
		}
		button:hover { background: var(--vscode-list-hoverBackground); }
	</style>
</head>
<body>
	<div class="card ${state}" ${cardAction}>
		<span class="dot"></span>
		<div>
			<div class="title">${title}</div>
			<div class="detail">${detail}</div>
		</div>
	</div>
	<div class="actions">
		<button onclick="send('openPanel')">💬 聚焦聊天</button>
		<button onclick="send('openSettings')">⚙ 打开设置</button>
		<button onclick="send('restart')">↻ 重启后端</button>
		<button onclick="send('openLogs')">▣ 查看日志</button>
	</div>
	<script>
		const vscode = acquireVsCodeApi();
		function send(command) { vscode.postMessage({ command }); }
	</script>
</body>
</html>`;
	}
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
