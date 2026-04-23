import * as vscode from 'vscode';
import { initLogger, logger } from './logger';
import { PythonProcessManager } from './processManager';
import { AgentClient } from './agentClient';
import { ChatViewProvider } from './chatView';
import { IdeActions } from './ideActions';
import { ContextProvider } from './contextProvider';

let processMgr: PythonProcessManager | undefined;
let agentClient: AgentClient | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
	initLogger();
	logger.info('GenericAgent extension activating', { version: ctx.extension.packageJSON?.version });

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
		vscode.commands.registerCommand('genericAgent.showLogs', () => logger.show()),
		vscode.commands.registerCommand('genericAgent.restartBackend', async () => {
			logger.info('restart requested by user');
			processMgr?.dispose();
			agentClient?.dispose();
			await bootstrapBackend(ctx, chat);
		}),
	);

	// 3. Kick off the backend
	try {
		await bootstrapBackend(ctx, chat);
	} catch (e) {
		const msg = (e as Error).message;
		logger.error('backend bootstrap failed', msg);
		vscode.window.showErrorMessage(`GenericAgent: backend failed to start — ${msg}`);
	}
}

async function bootstrapBackend(ctx: vscode.ExtensionContext, chat: ChatViewProvider): Promise<void> {
	processMgr = new PythonProcessManager(ctx);
	ctx.subscriptions.push(processMgr);

	const ports = await processMgr.start();
	chat.setBackendPorts(ports);

	const version: string = ctx.extension.packageJSON?.version || '0.0.0';
	agentClient = new AgentClient(`ws://127.0.0.1:${ports.ws}`, version);
	ctx.subscriptions.push(agentClient);

	agentClient.onHelloAck(ack => {
		logger.info('negotiated features', ack.features);
		vscode.window.setStatusBarMessage(
			`$(robot) GenericAgent ${ack.llm ?? ''}`.trim(),
			5000,
		);
	});

	// M2: wire IDE actions (edit_file / open_file / run_terminal / show_diff)
	// and begin pushing editor context once the handshake succeeds.
	const actions = new IdeActions(agentClient);
	ctx.subscriptions.push(actions.register());
	ctx.subscriptions.push({ dispose: () => actions.dispose() });

	const ctxProvider = new ContextProvider(agentClient);
	ctxProvider.start();
	ctx.subscriptions.push(ctxProvider);

	agentClient.connect();
}

export function deactivate(): void {
	logger.info('deactivating');
	agentClient?.dispose();
	processMgr?.dispose();
}
