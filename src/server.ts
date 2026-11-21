import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import { WorkspaceHub, type ModelSettings } from './hub.js';
import { readProjectFile, branch } from './repo.js';
import { accessiblePath, hash } from './paths.js';
import { artifactType } from './artifacts.js';
import { configFormat, formatConfig } from './clients.js';

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const settingsSchema = z.object({ provider: z.enum(['compatible', 'anthropic']), model: z.string().max(300), baseUrl: z.string().max(2000), apiKey: z.string().max(4000).optional(), clearKey: z.boolean().optional() });
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-src blob: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export class WebApplication {
  readonly token = randomBytes(32).toString('hex');
  readonly hub: WorkspaceHub;
  origin = 'http://127.0.0.1:4317';
  private server?: Server;
  private clients = new Map<string, { workspaceId: string; writes: boolean; tasks: boolean }>();
  private readonly assets = resolve(dirname(fileURLToPath(import.meta.url)), '../../ui');

  constructor(root: string, modelFactory?: (settings: ModelSettings) => LanguageModel) { this.hub = new WorkspaceHub(root, modelFactory); }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const origin = request.headers.get('Origin');
      if (url.origin !== this.origin || origin && origin !== this.origin) return json({ error: 'Origin is not allowed.' }, 403);
      const pathname = url.pathname;
      if (!pathname.startsWith('/api/')) {
        if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
        const asset = pathname === '/' ? 'index.html' : pathname === '/app.js' ? 'app.js' : pathname === '/styles.css' ? 'styles.css' : undefined;
        if (!asset) return new Response('Not found', { status: 404 });
        return new Response(readFileSync(join(this.assets, asset)), { headers: { 'Content-Type': asset.endsWith('.js') ? 'text/javascript' : asset.endsWith('.css') ? 'text/css' : 'text/html', 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
      }
      const candidate = (request.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
      const master = candidate.length === this.token.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(this.token));
      const client = this.clients.get(candidate);
      if (!master && !client) return json({ error: 'Authentication required. Open the local launch URL printed in your terminal.' }, 401);
      let body: Record<string, unknown> = {};
      if (request.method !== 'GET') {
        const raw = await request.text();
        if (Buffer.byteLength(raw) > 2 * 1024 * 1024) return json({ error: 'Request too large.' }, 413);
        body = raw ? z.record(z.string(), z.unknown()).parse(JSON.parse(raw)) : {};
      }
      const workspaceId = url.searchParams.get('workspace') ?? (typeof body.workspaceId === 'string' ? body.workspaceId : '');
      if (client) {
        const read = request.method === 'GET' && ['/api/workspace', '/api/memory', '/api/file'].includes(pathname);
        const memory = request.method === 'POST' && ['/api/propose', '/api/observe'].includes(pathname);
        const write = client.writes && request.method === 'POST' && ['/api/file', '/api/edit', '/api/undo'].includes(pathname);
        const run = client.tasks && request.method === 'POST' && pathname === '/api/run';
        if (pathname === '/api/jobs' && request.method === 'GET' && client.tasks) {
          const job = this.hub.job(url.searchParams.get('id') ?? '') as { workspaceId: string };
          if (job.workspaceId !== client.workspaceId) return json({ error: 'Client token does not cover this workspace.' }, 403);
        } else if (!(read || memory || write || run) || workspaceId !== client.workspaceId) return json({ error: 'Client token does not grant this operation or workspace.' }, 403);
      }
      const workspace = (): ReturnType<WorkspaceHub['get']> => this.hub.get(workspaceId);
      const text = (key: string): string => z.string().min(1).parse(body[key]);
      const get = request.method === 'GET'; const post = request.method === 'POST';
      if (pathname === '/api/state' && get) return json({ workspaces: this.hub.list(), recentWorkspaces: this.hub.recentRoots, model: this.hub.modelStatus(), approvals: this.hub.pendingApprovals(), events: this.hub.events(Number(url.searchParams.get('after') ?? 0)) });
      if (pathname === '/api/integration' && post) {
        workspace();
        const format = configFormat(body.client ?? 'claude');
        const serviceToken = randomBytes(32).toString('hex');
        this.clients.set(serviceToken, { workspaceId, writes: body.writes === true, tasks: body.tasks === true });
        if (this.clients.size > 100) this.clients.delete(this.clients.keys().next().value!);
        const cli = resolve(dirname(fileURLToPath(import.meta.url)), 'cli.js');
        const args = [cli, 'mcp', '--connect', this.origin];
        if (body.writes === true) args.push('--allow-writes');
        if (body.tasks === true) args.push('--allow-tasks');
        const config = formatConfig(format, { command: process.execPath, args, env: { VIBEKEEP_SERVICE_TOKEN: serviceToken, VIBEKEEP_WORKSPACE_ID: workspaceId } });
        return json({ command: process.execPath, cli, serviceUrl: this.origin, workspaceId, serviceToken, config });
      }
      if (pathname === '/api/workspaces' && post) { const opened = this.hub.open(text('path')); return json({ id: opened.id, name: opened.name }); }
      if (pathname === '/api/connectors' && post) {
        const value = z.object({ endpoint: z.string().url(), apiKey: z.string().max(4000).optional() }).parse(body);
        const opened = await this.hub.connectRemote(value.endpoint, value.apiKey); return json({ id: opened.id, name: opened.name });
      }
      if (pathname === '/api/browse' && get) {
        const root = realpathSync(resolve(url.searchParams.get('path') || this.hub.baseDirectory));
        const directories = readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory() && !item.isSymbolicLink() && !item.name.startsWith('.')).slice(0, 200).map(item => ({ name: item.name, path: join(root, item.name) }));
        return json({ path: root, parent: dirname(root), directories });
      }
      if (pathname === '/api/workspace' && get) {
        const item = workspace(); await item.refresh(); const inventory = item.inspect();
        return json({ id: item.id, kind: item.kind, connection: item.connection(), name: item.name, root: item.location(), inventory, tasks: item.tasks(), capabilities: item.capabilities(), messages: item.store.messages(inventory.branch), decisions: item.store.decisions(inventory.branch), changes: item.kind === 'local' ? item.executor.changes() : [], experiments: item.store.experiments(inventory.branch), pending: item.store.pending(), timeline: item.store.timeline(), servers: await item.processes.list() });
      }
      if (pathname === '/api/settings' && post) {
        const value = settingsSchema.parse(body);
        const sameDestination = value.provider === this.hub.settings.provider && (value.provider !== 'compatible' || value.baseUrl === this.hub.settings.baseUrl);
        this.hub.settings = { provider: value.provider, model: value.model, baseUrl: value.baseUrl, apiKey: value.clearKey ? undefined : value.apiKey || (sameDestination ? this.hub.settings.apiKey : undefined) };
        return json(this.hub.modelStatus());
      }
      if (pathname === '/api/chat' && post) {
        const value = z.object({ workspaceId: z.string(), message: z.string().trim().min(1).max(16000), images: z.array(z.string()).max(2).default([]) }).parse(body);
        return json({ jobId: this.hub.ask(value.workspaceId, value.message, value.images) }, 202);
      }
      if (pathname === '/api/jobs' && get) return json(this.hub.job(url.searchParams.get('id') ?? ''));
      if (pathname === '/api/cancel' && post) { this.hub.cancel(text('id')); return json({ cancelled: true }); }
      if (pathname === '/api/approval' && post) { this.hub.resolveApproval(text('id'), body.approved === true, body.remember === true); return json({ resolved: true }); }
      if (pathname === '/api/file' && get) {
        const path = url.searchParams.get('path') ?? '';
        return json(await workspace().read(path, Number(url.searchParams.get('start') || 1), url.searchParams.get('full') === '1'));
      }
      if (pathname === '/api/file' && post) {
        const value = z.object({ path: z.string(), content: z.string().max(256 * 1024), expectedHash: z.string().nullable() }).parse(body);
        return json(await workspace().write(value.path, value.content, value.expectedHash));
      }
      if (pathname === '/api/edit' && post) {
        const value = z.object({ path: z.string(), oldText: z.string().min(1).max(20000), newText: z.string().max(20000), expectedHash: z.string() }).parse(body);
        return json(await workspace().replace(value.path, value.oldText, value.newText, value.expectedHash));
      }
      if (pathname === '/api/artifact' && get) {
        const path = url.searchParams.get('path') ?? '';
        const resource = await workspace().binary(path);
        return new Response(resource.data as BodyInit, { headers: { 'Content-Type': resource.mediaType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
      }
      if (pathname === '/api/preview' && get) return json({ url: await workspace().previews.url(url.searchParams.get('path') ?? '') });
      if (pathname === '/api/svg' && get) return json(workspace().svg(url.searchParams.get('path') ?? ''));
      if (pathname === '/api/svg' && post) {
        const value = z.object({ path: z.string(), nodeId: z.string(), attributes: z.record(z.string(), z.string()), expectedHash: z.string() }).parse(body);
        return json(workspace().updateSvg(value.path, value.nodeId, value.attributes, value.expectedHash));
      }
      if (pathname === '/api/memory' && post) {
        const item = workspace(); const statement = z.string().min(1).max(2000).parse(body.statement);
        const source = item.store.message('web-ui', item.scope(), 'user', statement);
        return json(item.store.remember({ statement, area: z.string().max(200).optional().parse(body.area) }, item.scope(), 'user_explicit', source));
      }
      if (pathname === '/api/memory' && get) { const item = workspace(); return json(item.store.decisions(item.scope(), url.searchParams.get('query') ?? '')); }
      if (pathname === '/api/propose' && post) {
        const value = z.object({ statement: z.string().min(1).max(2000), area: z.string().default('project'), sourceQuote: z.string().min(1).max(2000) }).parse(body);
        const item = workspace();
        const source = item.store.message('external-host', item.scope(), 'user', `External host reported this quote (not independently verified): ${value.sourceQuote}`);
        return json(item.store.remember(value, item.scope(), 'agent_proposal', source));
      }
      if (pathname === '/api/observe' && post) {
        const value = z.object({ resourceId: z.string().min(1).max(2000), revision: z.string().nullable(), observation: z.string().min(1).max(8000) }).parse(body);
        const item = workspace(); return json({ id: item.store.event('external.observed', item.scope(), { ...value, source: 'external_host', independentlyVerified: false }) });
      }
      if (pathname === '/api/accept' && post) { const item = workspace(); return json(item.store.accept(text('id'), item.scope(), typeof body.supersedes === 'string' ? body.supersedes : undefined)); }
      if (pathname === '/api/export' && get) return json(workspace().store.export());
      if (pathname === '/api/import' && post) return json({ imported: workspace().store.import(body.memory) });
      if (pathname === '/api/undo' && post) return json({ path: workspace().executor.undo(typeof body.actionId === 'string' ? body.actionId : undefined) });
      if (pathname === '/api/diff' && get) return json(workspace().executor.diff(url.searchParams.get('id') ?? ''));
      if (pathname === '/api/experiment' && post) {
        const item = workspace(); const action = text('action');
        if (item.kind !== 'local') throw new Error('Remote recovery is defined by the connector. Use its advertised checkpoint or restore operations.');
        if (action === 'create') return json({ id: item.store.beginExperiment(item.scope(), text('name')) });
        if (action === 'accept') item.store.finishExperiment(text('id'), item.scope(), 'accepted');
        else if (action === 'discard') item.executor.discardExperiment(text('id'));
        else throw new Error('Unknown experiment action.');
        return json({ completed: true });
      }
      if (pathname === '/api/tasks' && post) return json(workspace().saveTask(body.task));
      if (pathname === '/api/run' && post) return json({ jobId: this.hub.task(workspaceId, text('taskId'), z.record(z.string(), z.unknown()).optional().parse(body.inputs)) }, 202);
      if (pathname === '/api/stop' && post) { await workspace().processes.stop(text('id')); return json({ stopped: true }); }
      if (pathname === '/api/checks' && get) return json(workspace().kind === 'local' ? workspace().executor.checks() : []);
      return json({ error: 'Endpoint not found.' }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: this.hub.settings.apiKey ? message.replaceAll(this.hub.settings.apiKey, '[redacted]') : message }, 400);
    }
  }

  async listen(port = 4317): Promise<string> {
    if (this.server) return `${this.origin}/#token=${this.token}`;
    this.server = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of incoming) { size += chunk.length; if (size > 2 * 1024 * 1024) { outgoing.writeHead(413).end(); incoming.destroy(); return; } chunks.push(chunk); }
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        const request = new Request(`${this.origin}${incoming.url ?? '/'}`, { method: incoming.method, headers, body: ['GET', 'HEAD'].includes(incoming.method ?? 'GET') ? undefined : Buffer.concat(chunks) });
        // Do not trust a Host header pointing at an unrelated hostname (DNS rebinding).
        const response = headers.get('host') !== new URL(this.origin).host ? json({ error: 'Invalid host.' }, 403) : await this.fetch(request);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch { if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end('Request failed.'); }
    });
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(port, '127.0.0.1', resolve); });
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('Local server did not start.');
    this.origin = `http://127.0.0.1:${address.port}`;
    return `${this.origin}/#token=${this.token}`;
  }

  async close(): Promise<void> {
    await this.hub.close();
    if (this.server) await new Promise<void>(resolve => { this.server!.closeAllConnections(); this.server!.close(() => resolve()); });
  }
}
