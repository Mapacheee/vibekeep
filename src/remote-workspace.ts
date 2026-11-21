import { z } from 'zod';
import { LocalWorkspace, type OperationRequest } from './workspace.js';
import { hash } from './paths.js';
import type { Store } from './store.js';
import type { Inventory } from './types.js';
import type { CapabilityTask } from './capabilities.js';

const operationSchema = z.object({ id: z.string().regex(/^[\w.:-]{1,100}$/), label: z.string().min(1).max(200), description: z.string().max(2000).default(''), inputSchema: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }), readOnly: z.boolean().default(false), recovery: z.enum(['restore', 'compensate', 'manual', 'none']).default('none') });
export const remoteManifestSchema = z.object({ protocolVersion: z.literal(1), name: z.string().min(1).max(100), operations: z.array(operationSchema).max(100) });
const resourcesSchema = z.object({ resources: z.array(z.object({ id: z.string().min(1).max(2000), name: z.string().max(300), revision: z.string().min(1).max(1000), bytes: z.number().int().nonnegative().default(0), mediaType: z.string().max(100).default('application/json'), representation: z.enum(['text', 'binary', 'structure']), kind: z.enum(['text', 'image', 'design', 'document', 'binary']).default('document') })).max(5000) });

/** HTTP is a versioned adapter boundary, not a requirement imposed on the authoring app's language. */
export class RemoteWorkspace extends LocalWorkspace {
  override readonly kind = 'remote';
  override readonly name: string;
  private snapshot?: Inventory;
  private disconnected?: string;
  constructor(store: Store, readonly endpoint: string, private apiKey: string | undefined, readonly manifest: z.infer<typeof remoteManifestSchema>, private transport: typeof fetch = fetch, private enabled = true) { super(store); this.name = manifest.name; this.snapshot = store.inventory('workspace'); this.disconnected = 'Reconnect the application to use live operations.'; }

  static endpoint(value: string): string {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Connector URL must be HTTP(S), without credentials, query, or fragment.');
    return url.toString().replace(/\/$/, '');
  }
  static async probe(endpoint: string, apiKey?: string, transport: typeof fetch = fetch) {
    const response = await transport(`${RemoteWorkspace.endpoint(endpoint)}/manifest`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!response.ok) throw new Error(`Connector rejected the manifest request (${response.status}).`);
    return remoteManifestSchema.parse(await response.json());
  }
  private async request(path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const response = await this.transport(`${this.endpoint}/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ?? AbortSignal.timeout(20000), redirect: 'error' });
    if (!response.ok) throw new Error(`Connector request failed (${response.status}).`);
    return response;
  }
  override location(): string { return this.endpoint; }
  override connection(): { connected: boolean; reason?: string } { return { connected: !this.disconnected, reason: this.disconnected }; }
  override scope(): string { return 'workspace'; }
  override inspect(): Inventory { if (!this.snapshot) throw new Error('The remote workspace has not been observed yet.'); return this.snapshot; }
  override async refresh(): Promise<void> {
    if (!this.enabled) { if (!this.snapshot) throw new Error('Reconnect this application to observe its resources.'); return; }
    try {
      const data = resourcesSchema.parse(await (await this.request('resources')).json());
      const files = data.resources.map(resource => ({ path: resource.id, label: resource.name, hash: resource.revision, bytes: resource.bytes, mediaType: resource.mediaType, representation: resource.representation === 'binary' ? 'binary' as const : 'text' as const, kind: resource.kind }));
      const before = this.snapshot?.files ?? [];
      this.snapshot = { root: this.endpoint, branch: 'workspace', head: null, files, packages: [], markers: [], instructions: [], fingerprint: hash(JSON.stringify(files)), changed: files.filter(file => before.find(old => old.path === file.path)?.hash !== file.hash).map(file => file.path), removed: before.filter(file => !files.some(current => current.path === file.path)).map(file => file.path), truncated: false, scannedAt: new Date().toISOString() };
      this.store.saveInventory(this.snapshot); this.disconnected = undefined;
    } catch (error) { this.disconnected = error instanceof Error ? error.message : String(error); if (!this.snapshot) throw error; }
  }
  override tasks(): CapabilityTask[] {
    return this.manifest.operations.map(operation => ({ id: operation.id, label: operation.label, command: `${this.endpoint}/invoke`, args: [], cwd: '.', mode: 'action', provider: 'remote', available: !this.disconnected, reason: this.disconnected, signature: hash(JSON.stringify(operation)), inputSchema: operation.inputSchema, description: operation.description, recovery: operation.recovery }));
  }
  override capabilities(): unknown[] { return this.manifest.operations.map(operation => ({ ...operation, available: !this.disconnected, reason: this.disconnected })); }
  override async read(id: string): Promise<{ content: string; hash: string; truncated: boolean; editable: boolean }> {
    const resource = this.inspect().files.find(file => file.path === id); if (!resource) throw new Error('Resource not found in the connected document.');
    const response = await this.request(`resource?id=${encodeURIComponent(id)}`);
    const data = z.object({ revision: z.string(), content: z.string().max(256 * 1024).optional(), structure: z.unknown().optional() }).parse(await response.json());
    return { content: data.content ?? JSON.stringify(data.structure ?? {}, null, 2), hash: data.revision, truncated: false, editable: data.content !== undefined && this.manifest.operations.some(operation => operation.id === 'resource.write') };
  }
  override async binary(id: string): Promise<{ data: Uint8Array; mediaType: string }> {
    if (!this.inspect().files.some(file => file.path === id)) throw new Error('Resource not found.');
    const response = await this.request(`preview?id=${encodeURIComponent(id)}`);
    const data = new Uint8Array(await response.arrayBuffer());
    const mediaType = response.headers.get('Content-Type')?.split(';')[0] ?? 'application/octet-stream';
    if (data.byteLength > 16 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'application/pdf'].includes(mediaType)) throw new Error('Connector returned an unsupported preview.');
    return { data, mediaType };
  }
  override async write(id: string, content: string, expectedHash: string | null): Promise<unknown> { return this.runTask('resource.write', async () => true, { inputs: { resourceId: id, content, expectedRevision: expectedHash } }); }
  override async replace(id: string, oldText: string, newText: string, expectedHash: string): Promise<unknown> {
    const resource = await this.read(id);
    if (!resource.editable || resource.hash !== expectedHash) throw new Error('Resource is read-only or its revision changed.');
    const first = resource.content.indexOf(oldText);
    if (first < 0 || resource.content.indexOf(oldText, first + 1) >= 0) throw new Error('Original text must occur exactly once.');
    return this.write(id, resource.content.slice(0, first) + newText + resource.content.slice(first + oldText.length), expectedHash);
  }
  override saveTask(): never { throw new Error('Remote operations are declared by the connector. Add local tasks to a local workspace.'); }
  override svg(): never { throw new Error('Use the connected application’s registered visual operations.'); }
  override updateSvg(): never { throw new Error('Use the connected application’s registered visual operations.'); }
  override async runTask(id: string, approve: (request: OperationRequest) => Promise<boolean>, options: { signal?: AbortSignal; timeoutMs?: number; inputs?: Record<string, unknown> } = {}): Promise<unknown> {
    const task = this.tasks().find(task => task.id === id);
    if (!task || !task.available) throw new Error(task?.reason ?? 'Remote operation not found.');
    const inputs = options.inputs ?? {};
    const { Ajv } = await import('ajv');
    const validator = new Ajv({ strict: false, ownProperties: true }).compile(this.manifest.operations.find(operation => operation.id === id)!.inputSchema);
    if (!validator(inputs)) throw new Error(`Operation inputs do not match its schema: ${JSON.stringify(validator.errors)}`);
    if (!await approve({ task, description: `${task.label}\nConnector: ${this.endpoint}\nInputs: ${JSON.stringify(inputs)}\nRecovery: ${this.manifest.operations.find(operation => operation.id === id)!.recovery}` })) throw new Error('Remote operation was not authorized.');
    const requestId = this.store.action('workspace', 'connector.invoke', { operation: id, resources: this.inspect().files.map(file => ({ id: file.path, revision: file.hash })) });
    try {
      const result = await (await this.request('invoke', { requestId, operation: id, inputs, expectedRevisions: this.inspect().files.map(resource => ({ id: resource.path, revision: resource.hash })) }, options.signal)).json();
      this.store.finish(requestId, 'succeeded', result);
      this.store.event('connector.operation', 'workspace', { operation: id, actionId: requestId, recovery: this.manifest.operations.find(operation => operation.id === id)!.recovery });
      await this.refresh(); return result;
    } catch (error) { this.store.finish(requestId, 'unknown', { error: String(error) }); throw error; }
  }
}
