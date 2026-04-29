import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { logger } from './logger';

export type BotKind = 'tg' | 'qq' | 'feishu' | 'wecom' | 'dingtalk' | 'wechat';

type BotProc = cp.ChildProcessByStdio<null, Readable, Readable>;

type BotSpec = {
	kind: BotKind;
	label: string;
	script: string;
	requiredKeys: string[];
};

const BOT_SPECS: Record<BotKind, BotSpec> = {
	tg: { kind: 'tg', label: 'Telegram', script: 'tgapp.py', requiredKeys: ['tg_bot_token'] },
	qq: { kind: 'qq', label: 'QQ', script: 'qqapp.py', requiredKeys: ['qq_app_id', 'qq_app_secret'] },
	feishu: { kind: 'feishu', label: '飞书', script: 'fsapp.py', requiredKeys: ['fs_app_id', 'fs_app_secret'] },
	wecom: { kind: 'wecom', label: '企业微信', script: 'wecomapp.py', requiredKeys: ['wecom_bot_id', 'wecom_secret'] },
	dingtalk: { kind: 'dingtalk', label: '钉钉', script: 'dingtalkapp.py', requiredKeys: ['dingtalk_client_id', 'dingtalk_client_secret'] },
	wechat: { kind: 'wechat', label: '微信', script: 'wechatapp.py', requiredKeys: [] },
};

export class BotProcessManager implements vscode.Disposable {
	private readonly procs = new Map<BotKind, BotProc>();

	constructor(private readonly ctx: vscode.ExtensionContext) {}

	static specs(): BotSpec[] {
		return Object.values(BOT_SPECS);
	}

	async startEnabled(): Promise<void> {
		const cfg = vscode.workspace.getConfiguration('genericAgent');
		const enabled = cfg.get<string[]>('enabledBots') || [];
		for (const kind of enabled) {
			if (this.isBotKind(kind)) {
				await this.start(kind, false);
			}
		}
	}

	async start(kind: BotKind, notify = true): Promise<void> {
		if (this.procs.has(kind)) {
			if (notify) { vscode.window.showInformationMessage(`GenericAgent ${BOT_SPECS[kind].label} 机器人已经在运行。`); }
			return;
		}
		const cfg = vscode.workspace.getConfiguration('genericAgent');
		const py = this.resolvePython(cfg.get<string>('pythonPath') || '');
		const core = this.resolveAgentCore(cfg.get<string>('agentCorePath') || '');
		const spec = BOT_SPECS[kind];
		const script = path.join(core, 'frontends', spec.script);
		if (!fs.existsSync(script)) {
			throw new Error(`${spec.label} 机器人入口不存在: ${script}`);
		}
		const missing = this.missingKeys(core, spec.requiredKeys);
		if (missing.length) {
			throw new Error(`${spec.label} 机器人缺少配置: ${missing.join(', ')}。请在 mykey.json 中补齐。`);
		}
		logger.info('spawning bot process', { kind, py, script });
		const child = cp.spawn(py, ['-u', script], {
			cwd: path.join(core, 'frontends'),
			env: {
				...process.env,
				GA_IDE_MODE: '1',
				PYTHONIOENCODING: 'utf-8',
				PYTHONUNBUFFERED: '1',
				...(this.resolveMykey(core) ? { GA_MYKEY_PATH: this.resolveMykey(core) } : {}),
			},
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});
		this.procs.set(kind, child);
		this.wireStdio(kind, child);
		child.on('exit', (code, signal) => {
			logger.warn('bot process exited', { kind, code, signal });
			this.procs.delete(kind);
		});
		child.on('error', err => {
			logger.error('bot spawn error', { kind, error: err.message });
			this.procs.delete(kind);
		});
		if (notify) { vscode.window.showInformationMessage(`GenericAgent ${spec.label} 机器人已启动。`); }
	}

	stop(kind: BotKind, notify = true): void {
		const child = this.procs.get(kind);
		if (!child) {
			if (notify) { vscode.window.showInformationMessage(`GenericAgent ${BOT_SPECS[kind].label} 机器人未运行。`); }
			return;
		}
		logger.info('stopping bot process', { kind, pid: child.pid });
		this.procs.delete(kind);
		try { child.kill('SIGTERM'); } catch {}
		setTimeout(() => {
			if (!child.killed) {
				try { child.kill('SIGKILL'); } catch {}
			}
		}, 2000);
		if (notify) { vscode.window.showInformationMessage(`GenericAgent ${BOT_SPECS[kind].label} 机器人已停止。`); }
	}

	statusText(): string {
		return BotProcessManager.specs().map(spec => {
			const child = this.procs.get(spec.kind);
			return `${child ? '●' : '○'} ${spec.label}${child ? ` pid=${child.pid}` : ''}`;
		}).join('\n');
	}

	dispose(): void {
		for (const kind of Array.from(this.procs.keys())) {
			this.stop(kind, false);
		}
	}

	private wireStdio(kind: BotKind, child: BotProc): void {
		const onLine = (line: string) => {
			if (line.trim()) { logger.info(`[bot:${kind}] ${line}`); }
		};
		const splitter = (buf: Buffer, carry: { tail: string }) => {
			const lines = (carry.tail + buf.toString('utf8')).split(/\r?\n/);
			carry.tail = lines.pop() || '';
			lines.forEach(onLine);
		};
		const outCarry = { tail: '' }, errCarry = { tail: '' };
		child.stdout.on('data', b => splitter(b, outCarry));
		child.stderr.on('data', b => splitter(b, errCarry));
	}

	private isBotKind(v: string): v is BotKind {
		return Object.prototype.hasOwnProperty.call(BOT_SPECS, v);
	}

	private resolvePython(override: string): string {
		if (override && fs.existsSync(override)) { return override; }
		const bundled = path.join(this.ctx.extensionPath, '..', '..', 'python-embed', 'python.exe');
		if (fs.existsSync(bundled)) { return bundled; }
		return process.platform === 'win32' ? 'python.exe' : 'python3';
	}

	private resolveAgentCore(override: string): string {
		if (override && fs.existsSync(override)) { return override; }
		for (const folder of vscode.workspace.workspaceFolders || []) {
			const root = folder.uri.fsPath;
			if (fs.existsSync(path.join(root, 'frontends', 'webapp.py'))) { return root; }
			const genericAgentSibling = path.join(path.dirname(root), 'GenericAgent');
			if (fs.existsSync(path.join(genericAgentSibling, 'frontends', 'webapp.py'))) { return genericAgentSibling; }
			const sibling = path.join(root, 'agent-core');
			if (fs.existsSync(path.join(sibling, 'frontends', 'webapp.py'))) { return sibling; }
		}
		const bundled = path.join(this.ctx.extensionPath, '..', '..', 'agent-core');
		if (fs.existsSync(bundled)) { return bundled; }
		const dev = path.join(this.ctx.extensionPath, '..', '..', '..', 'agent-core');
		if (fs.existsSync(dev)) { return dev; }
		return path.join(this.ctx.extensionPath, '..', '..', 'agent-core');
	}

	private resolveMykey(core: string): string | undefined {
		const p = path.join(core, 'mykey.json');
		if (fs.existsSync(p)) { return p; }
		for (const folder of vscode.workspace.workspaceFolders || []) {
			const workspaceKey = path.join(folder.uri.fsPath, 'mykey.json');
			if (fs.existsSync(workspaceKey)) { return workspaceKey; }
		}
		return undefined;
	}

	private missingKeys(core: string, keys: string[]): string[] {
		if (!keys.length) { return []; }
		const mykey = this.resolveMykey(core);
		if (!mykey) { return keys; }
		try {
			const raw = fs.readFileSync(mykey, 'utf8');
			const obj = JSON.parse(raw) as Record<string, unknown>;
			return keys.filter(k => !obj[k]);
		} catch {
			return [];
		}
	}
}
