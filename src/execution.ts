import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { accessiblePath, hash, projectPath } from './paths.js';
import { adopt, branch } from './repo.js';
import type { Store } from './store.js';
import type { CommandResult } from './types.js';

export class Executor {
  constructor(readonly store: Store) {}

  replace(path: string, oldText: string, newText: string, expectedHash: string): { actionId: string; hash: string } {
    if (!oldText) throw new Error('The text to replace cannot be empty.');
    const full = accessiblePath(this.store.root, path);
    const bytes = readFileSync(full);
    if (bytes.length > 256 * 1024 || bytes.includes(0)) throw new Error('Only bounded text files can be edited.');
    const content = bytes.toString('utf8');
    const first = content.indexOf(oldText);
    if (first < 0 || content.indexOf(oldText, first + 1) >= 0) throw new Error('The original text must occur exactly once. Read more context and retry.');
    return this.write(path, content.slice(0, first) + newText + content.slice(first + oldText.length), expectedHash);
  }

  checks(): { id: string; status: string; current: boolean; result: unknown }[] {
    const inventory = adopt(this.store);
    return this.store.db.prepare("SELECT * FROM actions WHERE scope = ? AND kind = 'script.run' ORDER BY rowid DESC LIMIT 10").all(inventory.branch).map(row => {
      const payload = JSON.parse(String(row.payload)) as { fingerprint: string };
      const result = row.result ? JSON.parse(String(row.result)) as { stale?: boolean } : null;
      return { id: String(row.id), status: String(row.status), current: payload.fingerprint === inventory.fingerprint && !result?.stale, result };
    });
  }

  write(path: string, content: string, expectedHash: string | null): { actionId: string; hash: string } {
    if (Buffer.byteLength(content) > 256 * 1024) throw new Error('Write exceeds the 256 KiB limit.');
    const full = accessiblePath(this.store.root, path);
    const before = existsSync(full) ? readFileSync(full) : null;
    if (before && before.length > 256 * 1024) throw new Error('Existing file exceeds the snapshot limit.');
    if (before?.includes(0)) throw new Error('Cannot overwrite a binary file.');
    const beforeHash = before === null ? null : hash(before);
    if (beforeHash !== expectedHash) throw new Error('File changed or already exists. Read it again and provide its exact hash; null is only for new files.');
    const afterHash = hash(content);
    const id = this.store.action(branch(this.store.root), 'file.write', { path, before: before?.toString('base64') ?? null, beforeHash, afterHash });
    try {
      mkdirSync(dirname(full), { recursive: true });
      // Re-check after the action has been recorded. Never deliberately replace concurrent edits.
      const actual = existsSync(full) ? hash(readFileSync(full)) : null;
      if (actual !== beforeHash) throw new Error('Concurrent edit detected; no write was applied.');
      writeFileSync(full, content, { flag: before === null ? 'wx' : 'w' });
      this.store.finish(id, 'succeeded', { afterHash });
      return { actionId: id, hash: afterHash };
    } catch (error) {
      this.store.finish(id, 'unknown', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  undo(): string {
    const scope = branch(this.store.root);
    const row = this.store.db.prepare("SELECT * FROM actions WHERE scope = ? AND kind = 'file.write' AND status = 'succeeded' ORDER BY rowid DESC LIMIT 1").get(scope);
    if (!row) throw new Error('No successful file change to undo on this branch.');
    const data = JSON.parse(String(row.payload)) as { path: string; before: string | null; beforeHash: string | null; afterHash: string };
    const full = projectPath(this.store.root, data.path);
    const actual = existsSync(full) ? hash(readFileSync(full)) : null;
    if (actual !== data.afterHash) throw new Error('The file changed after VibeKeep wrote it. Undo stopped to preserve your changes.');
    const undoId = this.store.action(scope, 'file.undo', { originalId: row.id, ...data });
    try {
      if (data.before === null) unlinkSync(full);
      else writeFileSync(full, Buffer.from(data.before, 'base64'));
      this.store.transaction(() => {
        this.store.finish(String(row.id), 'undone', { undoId });
        this.store.finish(undoId, 'succeeded', { path: data.path });
        this.store.event('file.reverted', scope, { actionId: row.id, path: data.path });
      });
      return data.path;
    } catch (error) {
      this.store.finish(undoId, 'unknown', { error: String(error) });
      throw error;
    }
  }

  changes(): { path: string; actionId: string; currentMatches: boolean; beforeHash: string | null; afterHash: string }[] {
    const rows = this.store.db.prepare("SELECT id, payload FROM actions WHERE scope = ? AND kind = 'file.write' AND status = 'succeeded' ORDER BY rowid DESC LIMIT 50").all(branch(this.store.root));
    return rows.map(row => {
      const data = JSON.parse(String(row.payload)) as { path: string; beforeHash: string | null; afterHash: string };
      let currentMatches = false;
      try { currentMatches = hash(readFileSync(projectPath(this.store.root, data.path))) === data.afterHash; } catch { /* absent */ }
      return { path: data.path, actionId: String(row.id), currentMatches, beforeHash: data.beforeHash, afterHash: data.afterHash };
    });
  }

  async runScript(script: string, manifest = 'package.json', timeoutMs = 60000, approve: (description: string) => Promise<boolean> = async () => false, signal?: AbortSignal): Promise<CommandResult> {
    const inventory = adopt(this.store);
    const pkg = inventory.packages.find(p => p.path === manifest);
    if (!pkg || !(script in pkg.scripts)) throw new Error(`Declared script not found: ${manifest} → ${script}`);
    if (pkg.manager !== 'npm') throw new Error(`This version detects ${pkg.manager} but only executes npm scripts. Run this command manually for now.`);
    if (!/^[\w:.-]+$/.test(script)) throw new Error('Unsupported script name.');
    const commands = [`pre${script}`, script, `post${script}`].filter(name => name in pkg.scripts).map(name => `${name}: ${pkg.scripts[name]}`).join('\n');
    const description = `${manifest}: npm run ${script}\n${commands}\nThis executes project code with your local user permissions.`;
    if (!await approve(description)) throw new Error('Script execution was not authorized.');
    // Approval can take time; verify that scripts did not change while waiting.
    const current = adopt(this.store);
    if (current.fingerprint !== inventory.fingerprint) throw new Error('Project changed while awaiting script approval. Request the script again.');
    const nodeDirectory = dirname(process.execPath);
    const candidates = [
      process.env.npm_execpath?.endsWith('npm-cli.js') ? process.env.npm_execpath : '',
      resolve(nodeDirectory, 'node_modules/npm/bin/npm-cli.js'),
      resolve(nodeDirectory, '../lib/node_modules/npm/bin/npm-cli.js'),
      resolve(nodeDirectory, '../share/nodejs/npm/bin/npm-cli.js'),
      resolve(nodeDirectory, '../share/npm/bin/npm-cli.js'),
    ];
    const npmCli = candidates.find(path => path && existsSync(path));
    if (!npmCli) throw new Error('Cannot locate npm. Run VibeKeep through npm start, use a standard Node.js distribution, or run the script manually.');
    const cwd = dirname(projectPath(this.store.root, manifest));
    const actionId = this.store.action(inventory.branch, 'script.run', { manifest, script, fingerprint: inventory.fingerprint });
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) if (/^(?:VIBEKEEP_.*|ANTHROPIC_API_KEY|OPENAI_API_KEY)$/i.test(key)) delete environment[key];
    try {
      const result = await runProcess(process.execPath, [npmCli, 'run', script], cwd, timeoutMs, environment, signal);
      const after = adopt(this.store);
      this.store.finish(actionId, result.exitCode === 0 && !result.timedOut ? 'succeeded' : 'failed', { ...result, fingerprint: inventory.fingerprint, stale: after.fingerprint !== inventory.fingerprint });
      return result;
    } catch (error) { this.store.finish(actionId, 'unknown', { error: String(error) }); throw error; }
  }
}

export async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<CommandResult> {
  if (signal?.aborted) throw new Error('Process cancelled.');
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    let cancelled = false;
    let truncated = false;
    const collect = (chunk: Buffer): void => {
      if (output.length < 32000) {
        const text = chunk.toString('utf8');
        if (text.length > 32000 - output.length) truncated = true;
        output += text.slice(0, 32000 - output.length);
      }
      else truncated = true;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const stop = (): void => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 1000 });
        child.kill('SIGKILL');
      }
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.min(Math.max(timeoutMs, 100), 120000));
    const cancel = (): void => { cancelled = true; stop(); };
    signal?.addEventListener('abort', cancel, { once: true });
    child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(error); });
    child.on('close', exitCode => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (cancelled) reject(new Error('Process cancelled. Inspect any effects before retrying.'));
      else resolveResult({ command, args, exitCode, output, timedOut, truncated });
    });
  });
}
