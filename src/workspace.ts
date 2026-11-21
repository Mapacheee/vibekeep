import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverTasks, localTaskDirectory, taskSchema, type CapabilityTask, type TaskDefinition } from './capabilities.js';
import { hash, accessiblePath } from './paths.js';
import { adopt, branch, readProjectFile } from './repo.js';
import { Executor, runProcess } from './execution.js';
import { inspectSvg, updateSvg } from './artifacts.js';
import { ProcessManager, taskEnvironment } from './processes.js';
import type { Store } from './store.js';
import type { Inventory } from './types.js';
import { PreviewManager } from './previews.js';

export type OperationRequest = { task: CapabilityTask; description: string };
export interface WorkspaceConnector {
  id: string;
  kind: string;
  name: string;
  store: Store;
  inspect(): Inventory;
  capabilities(): unknown[];
  close(): Promise<void>;
}

export class LocalWorkspace implements WorkspaceConnector {
  readonly id: string;
  readonly kind: string = 'local';
  readonly name: string;
  readonly executor: Executor;
  readonly processes: ProcessManager;
  readonly previews: PreviewManager;
  constructor(readonly store: Store, notify: (event: unknown) => void = () => {}) {
    this.id = hash(store.root).slice(0, 20); this.name = store.project.name;
    this.executor = new Executor(store); this.processes = new ProcessManager(store, notify);
    this.previews = new PreviewManager(store.root);
  }
  inspect(): Inventory { return adopt(this.store); }
  scope(): string { return branch(this.store.root); }
  location(): string { return this.store.root; }
  connection(): { connected: boolean; reason?: string } { return { connected: true }; }
  async refresh(): Promise<void> { this.inspect(); }
  async read(path: string, startLine = 1, full = false): Promise<{ content: string; hash: string; truncated: boolean; editable: boolean }> {
    if (full) {
      const file = accessiblePath(this.store.root, path);
      if (statSync(file).size > 256 * 1024) throw new Error('The browser editor supports text resources up to 256 KiB.');
      const data = readFileSync(file);
      if (data.length > 256 * 1024 || data.includes(0)) throw new Error('The browser editor supports text resources up to 256 KiB.');
      return { content: data.toString('utf8'), hash: hash(data), truncated: false, editable: true };
    }
    return { ...readProjectFile(this.store.root, path, startLine, 200), editable: true };
  }
  async write(path: string, content: string, expectedHash: string | null): Promise<unknown> { return this.executor.write(path, content, expectedHash); }
  async replace(path: string, oldText: string, newText: string, expectedHash: string): Promise<unknown> { return this.executor.replace(path, oldText, newText, expectedHash); }
  async binary(path: string): Promise<{ data: Uint8Array; mediaType: string }> {
    const full = accessiblePath(this.store.root, path);
    if (statSync(full).size > 16 * 1024 * 1024) throw new Error('Preview limit is 16 MiB.');
    const data = readFileSync(full);
    return { data, mediaType: this.inspect().files.find(file => file.path === path)?.mediaType ?? 'application/octet-stream' };
  }
  tasks(): CapabilityTask[] { return discoverTasks(this.inspect()); }
  capabilities(): unknown[] {
    return [
      { id: 'files.read', available: true, representation: 'text', recovery: 'none' },
      { id: 'files.edit', available: true, representation: 'text', recovery: 'restore' },
      { id: 'artifacts.preview', available: true, formats: ['svg', 'png', 'jpeg', 'webp', 'gif', 'pdf', 'html', 'markdown', 'text'], recovery: 'none' },
      { id: 'svg.inspect', available: true, recovery: 'none' }, { id: 'svg.update', available: true, recovery: 'restore' },
      ...this.tasks().map(task => ({ id: task.id, available: task.available, reason: task.reason, mode: task.mode, provider: task.provider, recovery: 'manual' })),
    ];
  }

  saveTask(value: unknown): TaskDefinition {
    const task = taskSchema.parse(value);
    localTaskDirectory(this.store.root, task.cwd);
    const file = join(this.store.root, '.vibe', 'tasks.json');
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('Task configuration cannot be a symlink.');
    const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as { version: number; tasks: TaskDefinition[] } : { version: 1, tasks: [] };
    const validated = existing.tasks.map(item => taskSchema.parse(item)).filter(item => item.id !== task.id);
    writeFileSync(file, JSON.stringify({ version: 1, tasks: [...validated, task] }, null, 2) + '\n');
    this.store.event('task.configured', branch(this.store.root), { id: task.id });
    return task;
  }

  async runTask(id: string, approve: (request: OperationRequest) => Promise<boolean>, options: { signal?: AbortSignal; timeoutMs?: number; inputs?: Record<string, unknown> } = {}): Promise<unknown> {
    if (options.inputs && Object.keys(options.inputs).length) throw new Error('Local tasks use registered arguments, not dynamic shell inputs.');
    const inventory = this.inspect();
    const task = discoverTasks(inventory).find(item => item.id === id);
    if (!task) throw new Error('Registered task not found.');
    if (!task.available) throw new Error(task.reason ?? 'Task unavailable.');
    const description = `${task.label}\n${task.command} ${task.args.join(' ')}\n${task.details ?? ''}\nDirectory: ${task.cwd}\nExecutes project code with your local user permissions.`;
    if (!await approve({ task, description })) throw new Error('Task execution was not authorized.');
    const current = this.inspect();
    const latest = discoverTasks(current).find(item => item.id === id);
    if (!latest || latest.signature !== task.signature || current.fingerprint !== inventory.fingerprint) throw new Error('Workspace or task changed during authorization. Request it again.');
    if (task.mode === 'server') return this.processes.start(task);
    if (task.provider === 'java' && task.id === 'java:compile') mkdirSync(join(this.store.local, 'java-classes'), { recursive: true });
    const action = this.store.action(inventory.branch, 'task.run', { taskId: id, provider: task.provider, signature: task.signature, fingerprint: inventory.fingerprint });
    try {
      const result = await runProcess(task.command, task.args, localTaskDirectory(this.store.root, task.cwd), options.timeoutMs ?? 60000, taskEnvironment(), options.signal);
      const after = this.inspect();
      this.store.finish(action, result.exitCode === 0 && !result.timedOut ? 'succeeded' : 'failed', { ...result, stale: after.fingerprint !== inventory.fingerprint });
      return result;
    } catch (error) { this.store.finish(action, 'unknown', { error: String(error) }); throw error; }
  }

  svg(path: string): ReturnType<typeof inspectSvg> {
    const content = readProjectFile(this.store.root, path, 1, 500);
    if (content.truncated) throw new Error('SVG exceeds the structured editing limit. Use text tools or a native adapter.');
    return inspectSvg(content.content);
  }

  updateSvg(path: string, nodeId: string, attributes: Record<string, string>, expectedHash: string): unknown {
    const full = accessiblePath(this.store.root, path);
    const content = readFileSync(full, 'utf8');
    if (Buffer.byteLength(content) > 256 * 1024) throw new Error('SVG exceeds the editing limit.');
    return this.executor.write(path, updateSvg(content, nodeId, attributes), expectedHash);
  }

  async close(): Promise<void> { await this.processes.close(); await this.previews.close(); }
}
