import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LanguageModel } from 'ai';
import { Agent, configuredModel } from './agent.js';
import { Store } from './store.js';
import { acquireLock } from './lock.js';
import { LocalWorkspace, type OperationRequest } from './workspace.js';
import { branch } from './repo.js';
import { RemoteWorkspace, remoteManifestSchema } from './remote-workspace.js';
import { hash } from './paths.js';

type Job = { id: string; workspaceId: string; kind: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; result?: unknown; error?: string; controller: AbortController };
type Approval = { id: string; workspaceId: string; description: string; signature: string; resolve: (approved: boolean) => void };
export type ModelSettings = { provider: 'compatible' | 'anthropic'; model: string; baseUrl: string; apiKey?: string };

export class WorkspaceHub {
  readonly workspaces = new Map<string, LocalWorkspace>();
  private releases = new Map<string, () => void>();
  readonly jobs = new Map<string, Job>();
  readonly recentRoots: string[] = [];
  private approvals = new Map<string, Approval>();
  private grants = new Set<string>();
  private activities: { seq: number; workspaceId: string; message: string; time: string }[] = [];
  private seq = 0;
  settings: ModelSettings;
  private readonly registry: string;
  private readonly connectorRegistry: string;
  private readonly connectorDirectory: string;

  constructor(readonly baseDirectory: string, readonly modelFactory?: (settings: ModelSettings) => LanguageModel) {
    this.settings = { provider: process.env.VIBEKEEP_PROVIDER === 'anthropic' ? 'anthropic' : 'compatible', model: process.env.VIBEKEEP_MODEL ?? '', baseUrl: process.env.VIBEKEEP_BASE_URL ?? '', apiKey: process.env.VIBEKEEP_API_KEY };
    const first = this.open(baseDirectory);
    this.registry = join(first.store.local, 'workspaces.json');
    this.connectorRegistry = join(first.store.local, 'connectors.json');
    this.connectorDirectory = join(first.store.local, 'connectors');
    if (existsSync(this.registry)) {
      try {
        const roots = JSON.parse(readFileSync(this.registry, 'utf8')) as string[];
        // Saved project metadata is not authority to open another filesystem root.
        for (const root of roots.slice(0, 20)) if (typeof root === 'string') this.recentRoots.push(root);
      } catch { /* malformed registry does not block startup */ }
    }
    if (existsSync(this.connectorRegistry)) {
      try {
        const saved = JSON.parse(readFileSync(this.connectorRegistry, 'utf8')) as { endpoint: string; manifest: unknown }[];
        for (const entry of saved.slice(0, 20)) {
          try {
            const endpoint = RemoteWorkspace.endpoint(entry.endpoint); const folder = join(this.connectorDirectory, hash(endpoint).slice(0, 20));
            mkdirSync(folder, { recursive: true }); const store = new Store(folder); const release = acquireLock(store.local);
            const workspace = new RemoteWorkspace(store, endpoint, undefined, remoteManifestSchema.parse(entry.manifest), fetch, false);
            this.workspaces.set(workspace.id, workspace); this.releases.set(workspace.id, release);
          } catch { /* a saved connector can be reattached manually */ }
        }
      } catch { /* invalid connector registry */ }
    }
  }

  open(path: string): LocalWorkspace {
    const root = realpathSync(resolve(path));
    if (!statSync(root).isDirectory()) throw new Error('Select an existing directory.');
    for (const workspace of this.workspaces.values()) if (workspace.store.root === root) return workspace;
    if (this.workspaces.size >= 20) throw new Error('Workspace limit reached (20).');
    const store = new Store(root);
    let release: () => void;
    try { release = acquireLock(store.local); } catch (error) { store.close(); throw error; }
    const workspace = new LocalWorkspace(store, event => this.activity(workspace.id, JSON.stringify(event)));
    this.workspaces.set(workspace.id, workspace); this.releases.set(workspace.id, release);
    workspace.inspect();
    if (this.registry) writeFileSync(this.registry, JSON.stringify([...this.workspaces.values()].filter(item => item.kind === 'local').map(item => item.store.root), null, 2));
    return workspace;
  }

  get(id: string): LocalWorkspace { const workspace = this.workspaces.get(id); if (!workspace) throw new Error('Workspace not found.'); return workspace; }
  list(): unknown[] { return [...this.workspaces.values()].map(workspace => ({ id: workspace.id, name: workspace.name, kind: workspace.kind, root: workspace.location(), scope: workspace.scope() })); }
  async connectRemote(endpointValue: string, apiKey?: string): Promise<RemoteWorkspace> {
    const endpoint = RemoteWorkspace.endpoint(endpointValue);
    const manifest = await RemoteWorkspace.probe(endpoint, apiKey);
    const existing = [...this.workspaces.values()].find(item => item.kind === 'remote' && item.location() === endpoint);
    if (existing) {
      if ([...this.jobs.values()].some(job => job.workspaceId === existing.id && job.status === 'running')) throw new Error('Wait for the current connector operation before reconnecting.');
      this.releases.get(existing.id)?.(); existing.store.close(); this.workspaces.delete(existing.id);
    }
    const folder = join(this.connectorDirectory, hash(endpoint).slice(0, 20)); mkdirSync(folder, { recursive: true });
    const store = new Store(folder); const release = acquireLock(store.local);
    const workspace = new RemoteWorkspace(store, endpoint, apiKey, manifest);
    try { await workspace.refresh(); workspace.inspect(); }
    catch (error) { release(); store.close(); throw error; }
    this.workspaces.set(workspace.id, workspace); this.releases.set(workspace.id, release);
    writeFileSync(this.connectorRegistry, JSON.stringify([...this.workspaces.values()].filter(item => item instanceof RemoteWorkspace).map(item => ({ endpoint: (item as RemoteWorkspace).endpoint, manifest: (item as RemoteWorkspace).manifest })), null, 2));
    return workspace;
  }
  activity(workspaceId: string, message: string): void {
    this.activities.push({ seq: ++this.seq, workspaceId, message, time: new Date().toISOString() });
    this.activities = this.activities.slice(-300);
  }
  events(after: number): unknown[] { return this.activities.filter(event => event.seq > after); }
  pendingApprovals(): unknown[] { return [...this.approvals.values()].map(({ resolve, ...approval }) => approval); }
  modelStatus(): unknown { return { provider: this.settings.provider, model: this.settings.model, baseUrl: this.settings.baseUrl, hasKey: Boolean(this.settings.apiKey), configured: Boolean(this.modelFactory || this.settings.model && (this.settings.provider === 'anthropic' ? this.settings.apiKey : this.settings.baseUrl)) }; }
  model(): LanguageModel {
    if (this.modelFactory) return this.modelFactory(this.settings);
    return configuredModel({ VIBEKEEP_PROVIDER: this.settings.provider, VIBEKEEP_MODEL: this.settings.model, VIBEKEEP_BASE_URL: this.settings.baseUrl, VIBEKEEP_API_KEY: this.settings.apiKey });
  }

  private async requestApproval(workspaceId: string, description: string, signature: string, signal: AbortSignal): Promise<boolean> {
    const key = `${workspaceId}:${signature}`;
    if (this.grants.has(key)) return true;
    if (signal.aborted) return false;
    return new Promise<boolean>(resolve => {
      const id = randomUUID();
      const timeout = setTimeout(() => finish(false), 115000);
      const cancel = (): void => finish(false);
      const finish = (approved: boolean): void => { clearTimeout(timeout); signal.removeEventListener('abort', cancel); this.approvals.delete(id); resolve(approved); };
      this.approvals.set(id, { id, workspaceId, description, signature, resolve: finish });
      signal.addEventListener('abort', cancel, { once: true });
      this.activity(workspaceId, 'Task authorization requested.');
    });
  }

  resolveApproval(id: string, approved: boolean, remember = false): void {
    const approval = this.approvals.get(id);
    if (!approval) throw new Error('Approval request expired.');
    if (approved && remember) this.grants.add(`${approval.workspaceId}:${approval.signature}`);
    approval.resolve(approved);
  }

  startJob(workspaceId: string, kind: string, operation: (signal: AbortSignal) => Promise<unknown>): string {
    this.get(workspaceId);
    if ([...this.jobs.values()].some(job => job.workspaceId === workspaceId && job.status === 'running')) throw new Error('This workspace already has a running operation. Stop it or wait for it to finish.');
    const id = randomUUID(); const controller = new AbortController();
    const job: Job = { id, workspaceId, kind, status: 'running', controller };
    this.jobs.set(id, job);
    this.activity(workspaceId, `${kind} started.`);
    void Promise.resolve().then(() => operation(controller.signal)).then(result => { job.result = result; job.status = controller.signal.aborted ? 'cancelled' : 'completed'; }, error => {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed';
      const message = error instanceof Error ? error.message : String(error);
      job.error = this.settings.apiKey ? message.replaceAll(this.settings.apiKey, '[redacted]') : message;
    }).finally(() => this.activity(workspaceId, `${kind} ${job.status}.`));
    for (const [key, value] of this.jobs) if (this.jobs.size > 100 && value.status !== 'running') this.jobs.delete(key);
    return id;
  }

  ask(workspaceId: string, message: string, images: string[] = []): string {
    const workspace = this.get(workspaceId); const model = this.model();
    return this.startJob(workspaceId, 'Conversation', async signal => {
      const approve = (request: OperationRequest): Promise<boolean> => this.requestApproval(workspaceId, request.description, request.task.signature, signal);
      const agent = new Agent(workspace.store, model, description => this.requestApproval(workspaceId, description, description, signal), message => this.activity(workspaceId, message), workspace, approve);
      return agent.turn(message, signal, images);
    });
  }

  task(workspaceId: string, taskId: string, inputs?: Record<string, unknown>): string {
    const workspace = this.get(workspaceId);
    return this.startJob(workspaceId, 'Task', signal => workspace.runTask(taskId, async () => true, { signal, inputs }));
  }
  job(id: string): unknown { const job = this.jobs.get(id); if (!job) throw new Error('Job not found.'); const { controller, ...value } = job; return value; }
  cancel(id: string): void { const job = this.jobs.get(id); if (!job) throw new Error('Job not found.'); job.controller.abort(); }

  async close(): Promise<void> {
    for (const job of this.jobs.values()) job.controller.abort();
    for (const approval of this.approvals.values()) approval.resolve(false);
    const deadline = Date.now() + 5000;
    while ([...this.jobs.values()].some(job => job.status === 'running') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    for (const workspace of this.workspaces.values()) { await workspace.close(); this.releases.get(workspace.id)?.(); workspace.store.close(); }
  }
}
