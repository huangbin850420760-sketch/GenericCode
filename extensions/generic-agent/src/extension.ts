import * as vscode from 'vscode';
import { initLogger, logger } from './logger';
import { PythonProcessManager } from './processManager';
import { AgentClient } from './agentClient';
import { ChatViewProvider } from './chatView';
import { ChatPanel, registerApplyProvider } from './chatPanel';
import { IdeActions } from './ideActions';
import { ContextProvider } from './contextProvider';
import { InlineEditController } from './inlineEdit';
import { registerInlineCompletion } from './inlineCompletion';
import { BotKind, BotProcessManager } from './botProcessManager';

let processMgr: PythonProcessManager | undefined;
let agentClient: AgentClient | undefined;
let inlineEdit: InlineEditController | undefined;
let lastHttpPort: number | undefined;
let botMgr: BotProcessManager | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
	initLogger();
	logger.info('GenericAgent extension activating', { version: ctx.extension.packageJSON?.version });

	// Register the virtual document provider used by the "Apply" flow.  Must
	// happen once, before any chat panel opens; the provider is disposed
	// automatically with the extension context.
	registerApplyProvider(ctx);
	botMgr = new BotProcessManager(ctx);
	ctx.subscriptions.push(botMgr);

	// 1. Webview provider registered immediately; it will show a loading state
	//    until the backend reports its ports.
	const chat = new ChatViewProvider(ctx.extensionUri);
	ctx.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
			webviewOptions: { retainContextWhenHidden: true },
		})
	);

	// 2. Commands
	ctx.subscriptions.push(
		vscode.commands.registerCommand('genericAgent.showChat', () =>
			vscode.commands.executeCommand('genericAgent.chat.focus')),
		vscode.commands.registerCommand('genericAgent.openInPanel', () => {
			// The panel talks to the backend through `agentClient`, so we just
			// need the handshake to have started.  `AgentClient` queues `send`
			// attempts until the socket is open, so even the first click right
			// after startup works as long as `bootstrapBackend` completed.
			if (!agentClient || lastHttpPort === undefined) {
				vscode.window.showWarningMessage('GenericAgent: backend not ready yet.');
				return;
			}
			ChatPanel.createOrShow(ctx.extensionUri, agentClient, lastHttpPort, botMgr, ctx);
		}),
		vscode.commands.registerCommand('genericAgent.showLogs', () => logger.show()),
		vscode.commands.registerCommand('genericAgent.startBot', async () => {
			if (!botMgr) { return; }
			const picked = await pickBot('启动哪个机器人？');
			if (!picked) { return; }
			try {
				await botMgr.start(picked);
			} catch (e) {
				const msg = (e as Error).message;
				logger.error('start bot failed', msg);
				vscode.window.showErrorMessage(`GenericAgent: ${msg}`);
			}
		}),
		vscode.commands.registerCommand('genericAgent.stopBot', async () => {
			if (!botMgr) { return; }
			const picked = await pickBot('停止哪个机器人？');
			if (!picked) { return; }
			botMgr.stop(picked);
		}),
		vscode.commands.registerCommand('genericAgent.showBotStatus', () => {
			if (!botMgr) { return; }
			vscode.window.showInformationMessage(botMgr.statusText(), { modal: true });
		}),
		vscode.commands.registerCommand('genericAgent.openMockup', async () => {
			// Show the static design mockup (media/mockup.html) in a webview.
			// Pure UI preview �?no backend wiring �?so the user can confirm
			// the design before we apply it to ChatPanel.
			const panel = vscode.window.createWebviewPanel(
				'genericAgentMockup',
				'GenericAgent · Design Mockup',
				vscode.ViewColumn.Active,
				{ enableScripts: true, retainContextWhenHidden: true },
			);
			const fileUri = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'mockup.html');
			const bytes = await vscode.workspace.fs.readFile(fileUri);
			panel.webview.html = new TextDecoder().decode(bytes);
		}),
		vscode.commands.registerCommand('genericAgent.restartBackend', async () => {
			logger.info('restart requested by user');
			processMgr?.dispose();
			agentClient?.dispose();
			await bootstrapBackend(ctx, chat);
		}),
	);

	/* genericAgent.inlineCompletion: registered once during activate */
	registerInlineCompletion(ctx, () => lastHttpPort);

	// 3. Cursor-style first paint: show the chat shell immediately,
	// before the Python backend finishes booting.  The real backend
	// client replaces this offline placeholder once ready.
	const cfg = vscode.workspace.getConfiguration('genericAgent');
	if (cfg.get<boolean>('autoOpenChat', true)) {
		const version: string = ctx.extension.packageJSON?.version || '0.0.0';
		agentClient = new AgentClient('ws://127.0.0.1:9', version);
		lastHttpPort = 0;
		ctx.subscriptions.push(agentClient);
		ChatPanel.createOrShow(ctx.extensionUri, agentClient, lastHttpPort, botMgr, ctx);
	}
	botMgr.startEnabled().catch(e => logger.error('start enabled bots failed', (e as Error).message));

	// 4. Kick off the backend
	try {
		await bootstrapBackend(ctx, chat);
	} catch (e) {
		const msg = (e as Error).message;
		logger.error('backend bootstrap failed', msg);
		chat.setBackendError(msg);
		lastHttpPort = 0;
		if (!agentClient) {
			const version: string = ctx.extension.packageJSON?.version || '0.0.0';
			agentClient = new AgentClient('ws://127.0.0.1:9', version);
			ctx.subscriptions.push(agentClient);
		}
		ChatPanel.createOrShow(ctx.extensionUri, agentClient, lastHttpPort ?? 0, botMgr, ctx);
		vscode.window.showErrorMessage(`GenericAgent: backend failed to start �?${msg}`);
	}
}

async function bootstrapBackend(ctx: vscode.ExtensionContext, chat: ChatViewProvider): Promise<void> {
	processMgr = new PythonProcessManager(ctx);
	ctx.subscriptions.push(processMgr);

	const ports = await processMgr.start();
	lastHttpPort = ports.http;
	chat.setBackendPorts(ports);
	// Note: the chat panel, if already open, keeps its existing AgentClient
	// reference �?that reference is updated below by constructing a fresh
	// `agentClient`.  If the panel needs to pick up the new client (e.g. on
	// a manual `Restart Backend`), we dispose and re-show it.
	if (ChatPanel.current) {
		ChatPanel.current.dispose();
	}

	const version: string = ctx.extension.packageJSON?.version || '0.0.0';
	agentClient = new AgentClient(`ws://127.0.0.1:${ports.ws}`, version);
	ctx.subscriptions.push(agentClient);

	agentClient.onHelloAck(ack => {
		logger.info('negotiated features', ack.features);
		vscode.window.setStatusBarMessage(
			`$(robot) GenericAgent ${ack.llm ?? ''}`.trim(),
			5000,
		);
		// Cursor-style "no friction" entry: auto-open the chat panel on
		// first successful backend handshake so the user lands directly in
		// the chat instead of having to click "Open Chat in Editor" in the
		// sidebar.  Respects an explicit user preference to opt out.
		const cfg = vscode.workspace.getConfiguration('genericAgent');
		const autoOpen = cfg.get<boolean>('autoOpenChat', true);
		if (autoOpen && !ChatPanel.current && agentClient && lastHttpPort !== undefined) {
			try {
				ChatPanel.createOrShow(ctx.extensionUri, agentClient, lastHttpPort, botMgr, ctx);
			} catch (e) {
				logger.warn('auto-open chat panel failed', (e as Error).message);
			}
		}
	});

	// M2: wire IDE actions (edit_file / open_file / run_terminal / show_diff)
	// and begin pushing editor context once the handshake succeeds.
	const actions = new IdeActions(agentClient);
	ctx.subscriptions.push(actions.register());
	ctx.subscriptions.push({ dispose: () => actions.dispose() });

	const ctxProvider = new ContextProvider(agentClient);
	ctxProvider.start();
	ctx.subscriptions.push(ctxProvider);

	// Cmd+I inline edit.  Registered once; reuses the long-lived client.
	// Safe to re-register on backend restart because the command name
	// stays the same �?but VSCode errors on duplicate registration, so we
	// only register on the first bootstrap.
	if (!inlineEdit) {
		inlineEdit = new InlineEditController(agentClient);
		inlineEdit.register(ctx);
		ctx.subscriptions.push(inlineEdit);
	} else {
		inlineEdit.setClient(agentClient);
	}

	agentClient.connect();
}

export function deactivate(): void {
	logger.info('deactivating');
	agentClient?.dispose();
	processMgr?.dispose();
	botMgr?.dispose();
}

async function pickBot(placeHolder: string): Promise<BotKind | undefined> {
	const picked = await vscode.window.showQuickPick(
		BotProcessManager.specs().map(spec => ({
			label: spec.label,
			description: spec.kind,
			botKind: spec.kind,
		})),
		{ placeHolder },
	);
	return picked?.botKind;
}
