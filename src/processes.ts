import crossSpawn from 'cross-spawn';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { localTaskDirectory, type CapabilityTask } from './capabilities.js';
import type { Store } from './store.js';
import { branch } from './repo.js';

export type ServerInfo = { id: string; taskId: string; label: string; status: 'starting' | 'running' | 'stopped' | 'exited' | 'failed'; pid?: number; url?: string; ready: boolean; logs: string; exitCode: number | null };
type Managed = { info: ServerInfo; child: ChildProcess; closed: Promise<void>; stopRequested: boolean; actionId: string };

export function taskEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  for (const key of Object.keys(env)) if (/^(?:VIBEKEEP_.*|ANTHROPIC_API_KEY|OPENAI_API_KEY)$/i.test(key)) delete env[key];
  return env;
}

export function localPreviewUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || !url.port) throw new Error('A preview must use a local HTTP address with an explicit port.');
  return url.toString();
}

export class ProcessManager {
  private servers = new Map<string, Managed>();
  constructor(readonly store: Store, readonly notify: (event: unknown) => void = () => {}) {}

  start(task: CapabilityTask): ServerInfo {
    if (!task.available) throw new Error(task.reason ?? 'Task is unavailable.');
    if (task.mode !== 'server') throw new Error('This task is not a server.');
    const existing = [...this.servers.values()].find(s => s.info.taskId === task.id && ['starting', 'running'].includes(s.info.status));
    if (existing) return { ...existing.info };
    if ([...this.servers.values()].filter(s => ['starting', 'running'].includes(s.info.status)).length >= 8) throw new Error('Stop a server before starting another (limit: 8).');
    const url = task.previewUrl ? localPreviewUrl(task.previewUrl) : undefined;
    const child = crossSpawn(task.command, task.args, { cwd: localTaskDirectory(this.store.root, task.cwd), env: taskEnvironment(), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const info: ServerInfo = { id: randomUUID(), taskId: task.id, label: task.label, status: 'starting', pid: child.pid, url, ready: false, logs: '', exitCode: null };
    const actionId = this.store.action(branch(this.store.root), 'server.start', { taskId: task.id, signature: task.signature, pid: child.pid });
    let complete!: () => void;
    const managed: Managed = { info, child, closed: new Promise<void>(resolve => { complete = resolve; }), stopRequested: false, actionId };
    this.servers.set(info.id, managed);
    const output = (chunk: Buffer): void => {
      info.logs = (info.logs + chunk.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '')).slice(-64000);
      const found = info.logs.match(/http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+(?:\/[^\s\x1b]*)?/);
      if (!info.url && found) { try { info.url = localPreviewUrl(found[0]); } catch { /* not a usable URL */ } }
      this.notify({ type: 'server.output', id: info.id });
    };
    child.stdout?.on('data', output); child.stderr?.on('data', output);
    child.on('spawn', () => { info.status = 'running'; this.notify({ type: 'server.started', id: info.id }); });
    child.on('error', error => { info.status = 'failed'; info.logs += `\n${error.message}`; });
    child.on('close', code => {
      info.exitCode = code; info.ready = false;
      info.status = managed.stopRequested ? 'stopped' : info.status === 'failed' || (code !== 0 && code !== null) ? 'failed' : 'exited';
      this.store.finish(actionId, info.status === 'failed' ? 'failed' : 'succeeded', { ...info });
      this.notify({ type: 'server.stopped', id: info.id }); complete();
    });
    return { ...info };
  }

  async list(): Promise<ServerInfo[]> {
    await Promise.all([...this.servers.values()].map(async ({ info }) => {
      if (info.url && info.status === 'running') {
        try { const response = await fetch(info.url, { signal: AbortSignal.timeout(600), redirect: 'manual' }); info.ready = response.status < 500; await response.body?.cancel(); }
        catch { info.ready = false; }
      }
    }));
    return [...this.servers.values()].map(server => ({ ...server.info }));
  }

  async stop(id: string): Promise<void> {
    const server = this.servers.get(id);
    if (!server) throw new Error('Server not found.');
    if (!['starting', 'running'].includes(server.info.status)) return;
    server.stopRequested = true;
    if (server.child.pid) {
      if (process.platform === 'win32') { spawnSync('taskkill', ['/pid', String(server.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 2000 }); server.child.kill('SIGKILL'); }
      else { try { process.kill(-server.child.pid, 'SIGKILL'); } catch { server.child.kill('SIGKILL'); } }
    }
    await server.closed;
  }

  async close(): Promise<void> { await Promise.all([...this.servers.keys()].map(id => this.stop(id))); }
}
