import * as vscode from 'vscode';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

let channel: vscode.OutputChannel | undefined;
let currentLevel: LogLevel = 'info';

export function initLogger(): vscode.OutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel('GenericAgent');
	}
	currentLevel = (vscode.workspace.getConfiguration('genericAgent').get<LogLevel>('logLevel')) || 'info';
	vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('genericAgent.logLevel')) {
			currentLevel = (vscode.workspace.getConfiguration('genericAgent').get<LogLevel>('logLevel')) || 'info';
		}
	});
	return channel;
}

function log(level: LogLevel, msg: string, ...args: unknown[]) {
	if (!channel) { return; }
	if (ORDER[level] > ORDER[currentLevel]) { return; }
	const stamp = new Date().toISOString().slice(11, 23);
	const extras = args.length ? ' ' + args.map(a => {
		try { return typeof a === 'string' ? a : JSON.stringify(a); }
		catch { return String(a); }
	}).join(' ') : '';
	channel.appendLine(`[${stamp}] [${level}] ${msg}${extras}`);
}

export const logger = {
	error: (m: string, ...a: unknown[]) => log('error', m, ...a),
	warn:  (m: string, ...a: unknown[]) => log('warn',  m, ...a),
	info:  (m: string, ...a: unknown[]) => log('info',  m, ...a),
	debug: (m: string, ...a: unknown[]) => log('debug', m, ...a),
	show:  () => channel?.show(),
};
