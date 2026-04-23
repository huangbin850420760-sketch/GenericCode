import * as vscode from 'vscode';
import { logger } from './logger';
import { BackendPorts } from './processManager';

/**
 * WebviewViewProvider for the sidebar chat panel.
 *
 * Strategy for M1 (minimum viable):
 *   The webview hosts a single full-size <iframe> pointing at the Python
 *   backend's HTTP port.  This reuses the existing `frontends/web/index.html`
 *   chat UI verbatim — zero re-implementation.  The iframe's JavaScript
 *   opens its own WebSocket to the backend; the extension's side-channel
 *   WebSocket (AgentClient) is orthogonal and only used for IDE actions.
 *
 * `portMapping` lets the webview reach the dynamically-chosen localhost port.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'genericAgent.chat';

	private view?: vscode.WebviewView;
	private pendingPorts?: BackendPorts;

	constructor(private readonly extensionUri: vscode.Uri) { }

	/** Called by extension.ts as soon as the backend reports its ports. */
	setBackendPorts(ports: BackendPorts): void {
		this.pendingPorts = ports;
		if (this.view) {
			this.renderHtml(this.view, ports);
		}
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			enableCommandUris: false,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
		};

		if (this.pendingPorts) {
			this.renderHtml(view, this.pendingPorts);
		} else {
			view.webview.html = this.loadingHtml('Starting GenericAgent backend…');
		}

		view.webview.onDidReceiveMessage(msg => {
			logger.debug('webview → extension', msg);
			// M2 will route certain messages back to AgentClient.
		});
	}

	private renderHtml(view: vscode.WebviewView, ports: BackendPorts): void {
		// portMapping allows the webview iframe to reach 127.0.0.1:<ports.http>.
		// WebviewOptions.portMapping is part of stable API since VSCode 1.40.
		view.webview.options = {
			...view.webview.options,
			portMapping: [{ webviewPort: ports.http, extensionHostPort: ports.http }],
		};

		const src = `http://localhost:${ports.http}/`;
		view.webview.html = this.iframeHtml(src);
		logger.info('chat webview rendered', { src });
	}

	private iframeHtml(src: string): string {
		const csp = [
			`default-src 'none'`,
			`frame-src http://localhost:* http://127.0.0.1:*`,
			`style-src 'unsafe-inline'`,
		].join('; ');
		return /* html */ `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<style>
		html, body, iframe { margin: 0; padding: 0; border: 0; width: 100%; height: 100vh; }
		body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
	</style>
</head>
<body>
	<iframe src="${src}" allow="clipboard-read; clipboard-write"></iframe>
</body>
</html>`;
	}

	private loadingHtml(msg: string): string {
		return /* html */ `<!doctype html>
<html><body style="font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-editor-foreground);">
	<div>${msg}</div>
</body></html>`;
	}
}
