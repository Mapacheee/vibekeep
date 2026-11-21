import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './helpers.js';
import { RemoteWorkspace, remoteManifestSchema } from '../src/remote-workspace.js';
import { hash } from '../src/paths.js';

test('an application connector observes opaque resources and dispatches schema-validated operations with revisions', async t => {
  const { store } = fixture(t);
  let content = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="red"/></svg>';
  let connected = true; let calls = 0;
  const manifest = remoteManifestSchema.parse({ protocolVersion: 1, name: 'Design application', operations: [{ id: 'color.update', label: 'Update color', recovery: 'none', inputSchema: { type: 'object', properties: { resourceId: { type: 'string' }, color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } }, required: ['resourceId', 'color'], additionalProperties: false } }] });
  const transport: typeof fetch = async (request, init) => {
    if (!connected) throw new Error('Disconnected');
    const url = new URL(String(request));
    if (url.pathname === '/resources') return Response.json({ resources: [{ id: 'node:1:2', name: 'Selected card', revision: hash(content), bytes: content.length, mediaType: 'image/svg+xml', representation: 'structure', kind: 'design' }] });
    if (url.pathname === '/resource') return Response.json({ revision: hash(content), structure: { name: 'Selected card', fill: content.includes('red') ? 'red' : '#167a70' } });
    if (url.pathname === '/preview') return new Response(content, { headers: { 'Content-Type': 'image/svg+xml' } });
    if (url.pathname === '/invoke') {
      calls++; const body = JSON.parse(String(init?.body));
      assert.equal(body.expectedRevisions[0].revision, hash(content));
      assert.equal(body.inputs.resourceId, 'node:1:2');
      content = `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="${body.inputs.color}"/></svg>`;
      return Response.json({ revision: hash(content), applied: true });
    }
    return new Response('', { status: 404 });
  };
  const workspace = new RemoteWorkspace(store, 'http://application.invalid', undefined, manifest, transport);
  await workspace.refresh();
  assert.equal(workspace.inspect().files[0]?.path, 'node:1:2');
  assert.equal((await workspace.read('node:1:2')).editable, false);
  assert.equal((await workspace.binary('node:1:2')).mediaType, 'image/svg+xml');
  await assert.rejects(workspace.runTask('color.update', async () => true, { inputs: { resourceId: 'node:1:2', color: 'invalid' } }), /schema/);
  await assert.rejects(workspace.runTask('color.update', async () => false, { inputs: { resourceId: 'node:1:2', color: '#167a70' } }), /not authorized/);
  assert.equal(calls, 0);
  await workspace.runTask('color.update', async () => true, { inputs: { resourceId: 'node:1:2', color: '#167a70' } });
  assert.equal(calls, 1); assert.match(content, /#167a70/);
  assert.equal(workspace.inspect().files[0]?.hash, hash(content));
  connected = false; await workspace.refresh();
  assert.equal(workspace.connection().connected, false);
  assert.equal(workspace.tasks()[0]?.available, false);
  await assert.rejects(workspace.runTask('color.update', async () => true), /Disconnected/);
});
