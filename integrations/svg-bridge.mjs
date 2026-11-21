#!/usr/bin/env node
// A real document adapter example. Replace its document API with your authoring application's API.
import { createServer } from 'node:http';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { inspectSvg, updateSvg } from '../dist/src/artifacts.js';
import { hash } from '../dist/src/paths.js';
import { z } from 'zod';

const { values } = parseArgs({ options: { file: { type: 'string' }, port: { type: 'string' } } });
if (!values.file) throw new Error('Usage: node integrations/svg-bridge.mjs --file /path/to/scene.svg [--port 4450]');
const file = realpathSync(resolve(values.file));
const port = Number(values.port ?? 4450);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
const key = process.env.VIBEKEEP_CONNECTOR_KEY;
const snapshots = new Map(); const completed = new Map();
const resourceId = 'document:canvas';
const current = () => { const content = readFileSync(file, 'utf8'); if (Buffer.byteLength(content) > 256 * 1024) throw new Error('Document exceeds the adapter limit.'); inspectSvg(content); return { content, revision: hash(content) }; };
current();
const operations = [
  { id: 'selection.setFill', label: 'Change a visual element’s fill', description: 'Update one SVG element in the connected document. Use $root for the root.', readOnly: false, recovery: 'manual', inputSchema: { type: 'object', properties: { nodeId: { type: 'string', description: 'SVG element ID or $root' }, fill: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Hex color, for example #167a70' } }, required: ['nodeId', 'fill'], additionalProperties: false } },
  { id: 'checkpoint.create', label: 'Create a document checkpoint', description: 'Keep a snapshot in this adapter process until it stops.', readOnly: true, recovery: 'restore', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { id: 'checkpoint.restore', label: 'Restore a document checkpoint', description: 'Restore a checkpoint created in this running adapter, with revision checking.', readOnly: false, recovery: 'restore', inputSchema: { type: 'object', properties: { checkpointId: { type: 'string' } }, required: ['checkpointId'], additionalProperties: false } },
];
const server = createServer(async (request, response) => {
  const json = (value, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
  try {
    if (request.headers.origin) return json({ error: 'Connect through the VibeKeep service, not a cross-origin web page.' }, 403);
    if (key && request.headers.authorization !== `Bearer ${key}`) return json({ error: 'Authentication required.' }, 401);
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/manifest' && request.method === 'GET') return json({ protocolVersion: 1, name: 'SVG Studio', operations });
    const document = current();
    if (url.pathname === '/resources' && request.method === 'GET') return json({ resources: [{ id: resourceId, name: 'Scene canvas', revision: document.revision, bytes: Buffer.byteLength(document.content), mediaType: 'image/svg+xml', representation: 'structure', kind: 'design' }] });
    if (['/resource', '/preview'].includes(url.pathname) && url.searchParams.get('id') !== resourceId) return json({ error: 'Resource not found.' }, 404);
    if (url.pathname === '/resource' && request.method === 'GET') return json({ revision: document.revision, structure: inspectSvg(document.content) });
    if (url.pathname === '/preview' && request.method === 'GET') return response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }).end(document.content);
    if (url.pathname !== '/invoke' || request.method !== 'POST') return json({ error: 'Endpoint not found.' }, 404);
    if (!request.headers['content-type']?.startsWith('application/json')) return json({ error: 'JSON input required.' }, 415);
    let text = ''; for await (const chunk of request) { text += chunk; if (text.length > 64000) throw new Error('Request too large.'); }
    const body = z.object({ requestId: z.string().min(1).max(100), operation: z.string(), inputs: z.record(z.string(), z.unknown()), expectedRevisions: z.array(z.object({ id: z.string(), revision: z.string() })) }).parse(JSON.parse(text));
    if (completed.has(body.requestId)) return json(completed.get(body.requestId));
    if (body.expectedRevisions.find(item => item.id === resourceId)?.revision !== document.revision) return json({ error: 'Document revision changed. Re-observe before editing.' }, 409);
    let result;
    if (body.operation === 'checkpoint.create') { const checkpointId = randomUUID(); snapshots.set(checkpointId, document.content); result = { checkpointId, revision: document.revision }; }
    else if (body.operation === 'checkpoint.restore') {
      const { checkpointId } = z.object({ checkpointId: z.string() }).strict().parse(body.inputs);
      const saved = snapshots.get(checkpointId); if (!saved) throw new Error('Checkpoint not found in this adapter session.');
      writeFileSync(file, saved); result = { applied: true, revision: hash(saved) };
    } else if (body.operation === 'selection.setFill') {
      const { nodeId, fill } = z.object({ nodeId: z.string().min(1).max(100), fill: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).strict().parse(body.inputs);
      const content = updateSvg(document.content, nodeId, { fill }); writeFileSync(file, content); result = { applied: true, revision: hash(content) };
    } else return json({ error: 'Operation not registered.' }, 404);
    completed.set(body.requestId, result); if (completed.size > 500) completed.delete(completed.keys().next().value);
    return json(result);
  } catch (error) { return json({ error: error.message }, 400); }
});
server.listen(port, '127.0.0.1', () => { console.log(`SVG Studio adapter: http://127.0.0.1:${server.address().port}\nDocument: ${file}\nAccess key: ${key ? 'configured through VIBEKEEP_CONNECTOR_KEY' : 'not configured (local development only)'}`); });
process.once('SIGINT', () => server.close()); process.once('SIGTERM', () => server.close());
