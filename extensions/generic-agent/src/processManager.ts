import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { Readable } from 'stream';
import { logger } from './logger';

export interface BackendPorts {
	http: number;
	ws: number;
}

/**
 * Manages the lifecycle of the Python agent-core process.
 *
 * Bootstrap:
 *   1. Resolve python executable (setting → bundled python-embed → system python).
 *   2. Resolve agent-core path (setting → bundled copy → sibling of extension).
 *   3. Spawn `python.exe agent-core/frontends/webapp.py --http-port 0 --ws-port 0`
 *      with `windowsHide: true` (no console window, but pipes still flow).
 *      Note: launch.pyw is *not* used here — it wraps webapp.py in a pywebview
 *      window which we don't want inside the IDE.
 *   4. Parse stdout for `[webapp] HTTP on http://127.0.0.1:<n>` and the matching WS line.
 *   5. Resolve `ready` promise with those ports.
 *
 * On dispose: SIGTERM → wait 2 s → force kill.
 */
type SpawnedProc = cp.ChildProcessByStdio<null, Readable, Readable>;

export class PythonProcessManager implements vscode.Disposable {
	private child?: SpawnedProc;
	private readyResolver?: (p: BackendPorts) => void;
	private readyRejecter?: (err: Error) => void;
	private restartCount = 0;
	private lastRestartAt = 0;

	readonly ready: Promise<BackendPorts>;

	constructor(private readonly ctx: vscode.ExtensionContext) {
		this.ready = new Promise<BackendPorts>((resolve, reject) => {
			this.readyResolver = resolve;
			this.readyRejecter = reject;
		});
	}

	async start(): Promise<BackendPorts> {
		const cfg = vscode.workspace.getConfiguration('genericAgent');
		const py = this.resolvePython(cfg.get<string>('pythonPath') || '');
		const core = this.resolveAgentCore(cfg.get<string>('agentCorePath') || '');
		const webappPy = path.join(core, 'frontends', 'webapp.py');
		const workspaceMykey = this.resolveWorkspaceMykey();

		// Only check existence for absolute/relative paths. A bare name like
		// 'python.exe' or 'python3' relies on PATH resolution inside cp.spawn,
		// so the existsSync check on a bare name is wrong — skip it.
		const pyIsPath = path.isAbsolute(py) || py.includes(path.sep) || py.includes('/');
		if (pyIsPath && !fs.existsSync(py)) {
			throw new Error(`Python interpreter not found: ${py}`);
		}
		if (!fs.existsSync(webappPy)) {
			throw new Error(`webapp.py not found: ${webappPy}`);
		}

		logger.info('spawning python backend', { py, webappPy });

		const child = cp.spawn(py, ['-u', webappPy, '--http-port', '0', '--ws-port', '0'], {
			cwd: path.join(core, 'frontends'),
			env: {
				...process.env,
				GA_IDE_MODE: '1',
				PYTHONIOENCODING: 'utf-8',
				// Critical: when stdout is a pipe (not a tty), CPython switches to
				// block-buffered output. The extension relies on parsing the
				// "[webapp] HTTP on …" line from stdout to learn the port, so we
				// MUST force unbuffered. `-u` above covers most cases, but setting
				// PYTHONUNBUFFERED belts-and-braces against sitecustomize etc.
				PYTHONUNBUFFERED: '1',
				...(workspaceMykey ? { GA_MYKEY_PATH: workspaceMykey } : {}),
			},
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});
		this.child = child;
		this.wireStdio(child);

		child.on('exit', (code, signal) => {
			logger.warn('python backend exited', { code, signal });
			this.maybeRestart();
		});
		child.on('error', err => {
			logger.error('python spawn error', err.message);
			this.readyRejecter?.(err);
		});

		return this.ready;
	}

	private wireStdio(child: SpawnedProc) {
		let http = 0, ws = 0;
		const onLine = (line: string) => {
			logger.debug(`[py] ${line}`);
			const m1 = /\[webapp\] HTTP on http:\/\/127\.0\.0\.1:(\d+)/.exec(line);
			const m2 = /\[webapp\] WS on ws:\/\/127\.0\.0\.1:(\d+)/.exec(line);
			if (m1) { http = parseInt(m1[1], 10); }
			if (m2) { ws = parseInt(m2[1], 10); }
			if (http && ws && this.readyResolver) {
				logger.info('backend ready', { http, ws });
				this.readyResolver({ http, ws });
				this.readyResolver = undefined;
			}
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

	private maybeRestart() {
		const now = Date.now();
		if (now - this.lastRestartAt > 5 * 60_000) {
			this.restartCount = 0;
		}
		if (this.restartCount >= 3) {
			this.readyRejecter?.(new Error('Python backend exited before becoming ready. Check GenericAgent logs for the Python traceback.'));
			this.readyRejecter = undefined;
			vscode.window.showErrorMessage(
				'GenericAgent backend has crashed 3 times in 5 minutes. Auto-restart disabled. Use "GenericAgent: Restart Backend" to retry.'
			);
			return;
		}
		this.restartCount++;
		this.lastRestartAt = now;
		logger.warn(`auto-restarting python backend (attempt ${this.restartCount}/3)`);
		setTimeout(() => {
			this.start().catch(err => logger.error('restart failed', err.message));
		}, 1500);
	}

	private resolvePython(override: string): string {
		if (override && fs.existsSync(override)) { return override; }
		// bundled python-embed lives at ../../python-embed/python.exe relative to
		// the compiled extension (resources/app/python-embed/…).
		// We use python.exe (not pythonw.exe) so that the child's stdout pipe is
		// reliable for port parsing; the console window is suppressed via
		// `windowsHide: true` in spawn options.
		const bundled = path.join(this.ctx.extensionPath, '..', '..', 'python-embed', 'python.exe');
		if (fs.existsSync(bundled)) { return bundled; }
		// Dev fallback: system python
		return process.platform === 'win32' ? 'python.exe' : 'python3';
	}

	private resolveAgentCore(override: string): string {
		if (override && fs.existsSync(override)) { return override; }
		// Highest priority: user's workspace root IS an agent-core layout
		// (i.e. a folder containing frontends/webapp.py).  This makes the
		// extension follow the user's data — sessions, mykey, skills —
		// instead of the bundled copy that ships with the extension.
		for (const folder of vscode.workspace.workspaceFolders || []) {
			const root = folder.uri.fsPath;
			if (fs.existsSync(path.join(root, 'frontends', 'webapp.py'))) {
				return root;
			}
			const sibling = path.join(root, 'agent-core');
			if (fs.existsSync(path.join(sibling, 'frontends', 'webapp.py'))) {
				return sibling;
			}
		}
		// Built-in layout: <extensionPath>/../../agent-core/
		const bundled = path.join(this.ctx.extensionPath, '..', '..', 'agent-core');
		if (fs.existsSync(bundled)) { return bundled; }
		// Dev layout: monorepo sibling
		const dev = path.join(this.ctx.extensionPath, '..', '..', '..', 'agent-core');
		if (fs.existsSync(dev)) { return dev; }
		// Last resort: user's workspace sibling
		const workspace = path.join(this.ctx.extensionPath, '..', '..');
		return path.join(workspace, 'agent-core');
	}

	private resolveWorkspaceMykey(): string | undefined {
		for (const folder of vscode.workspace.workspaceFolders || []) {
			const p = path.join(folder.uri.fsPath, 'mykey.json');
			if (fs.existsSync(p)) { return p; }
		}
		return undefined;
	}

	dispose(): void {
		const c = this.child;
		if (!c || c.killed) { return; }
		logger.info('disposing backend process', { pid: c.pid });
		try { c.kill('SIGTERM'); } catch { /* noop */ }
		setTimeout(() => {
			if (!c.killed) {
				try { c.kill('SIGKILL'); } catch { /* noop */ }
			}
		}, 2000);
	}
}
