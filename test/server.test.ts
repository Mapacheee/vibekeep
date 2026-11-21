import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appFixture } from './app-helper.js';

test('local control API rejects missing authentication and cross-origin requests', async t => {
  const { app, request } = appFixture(t);
  assert.equal((await request('state', undefined, false)).status, 401);
  assert.equal((await app.fetch(new Request(`${app.origin}/api/state`, { headers: { Authorization: `Bearer ${app.token}`, Origin: 'https://unrelated.invalid' } }))).status, 403);
  const response = await request('state'); assert.equal(response.status, 200);
  const value = await response.json() as { workspaces: unknown[]; model: { configured: boolean } };
  assert.equal(value.workspaces.length, 1); assert.equal(value.model.configured, false);
});

test('GUI API edits resources with revision checking and keeps memory without a model', async t => {
  const { app, root, write, request } = appFixture(t); write('notes.md', 'Original notes');
  const workspaceId = [...app.hub.workspaces.keys()][0]!;
  const before = await (await request(`file?workspace=${workspaceId}&path=notes.md&full=1`)).json() as { hash: string };
  assert.equal((await request('file', { workspaceId, path: 'notes.md', content: 'Changed notes', expectedHash: 'wrong' })).status, 400);
  assert.equal((await request('file', { workspaceId, path: 'notes.md', content: 'Changed notes', expectedHash: before.hash })).status, 200);
  assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), 'Changed notes');
  const decision = await (await request('memory', { workspaceId, statement: 'Preserve the narrative voice' })).json() as { status: string };
  assert.equal(decision.status, 'accepted');
  assert.equal((await request('undo', { workspaceId })).status, 200);
  assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), 'Original notes');
});

test('model keys are not returned in API state or written to project memory', async t => {
  const { app, request } = appFixture(t);
  const response = await request('settings', { provider: 'compatible', model: 'test', baseUrl: 'http://localhost:1234/v1', apiKey: 'fake-private-test-key' });
  assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /fake-private-test-key/);
  assert.doesNotMatch(await (await request('state')).text(), /fake-private-test-key/);
  const store = [...app.hub.workspaces.values()][0]!.store;
  assert.doesNotMatch(JSON.stringify(store.export()), /fake-private-test-key/);
});

test('private and ignored paths cannot be retrieved through API resource endpoints', async t => {
  const { app, request, write } = appFixture(t); write('.env', 'SECRET=fake'); write('.gitignore', 'private.txt\n'); write('private.txt', 'private');
  const id = [...app.hub.workspaces.keys()][0]!;
  for (const path of ['.env', 'private.txt', '../outside']) {
    const response = await request(`file?workspace=${id}&path=${encodeURIComponent(path)}`);
    assert.equal(response.status, 400);
  }
});

test('external agent tokens are workspace-scoped and cannot accept decisions, change settings, or write without permission', async t => {
  const { app, request, write } = appFixture(t); write('brief.md', 'Keep this private to the selected workspace.');
  const workspaceId = [...app.hub.workspaces.keys()][0]!;
  const issued = await (await request('integration', { workspaceId })).json() as { serviceToken: string };
  const call = (path: string, body?: unknown) => app.fetch(new Request(`${app.origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${issued.serviceToken}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
  assert.equal((await call(`file?workspace=${workspaceId}&path=brief.md`)).status, 200);
  assert.equal((await call('settings', { provider: 'compatible', model: 'other', baseUrl: 'http://localhost:9999' })).status, 403);
  assert.equal((await call('memory', { workspaceId, statement: 'Fake accepted intent' })).status, 403);
  assert.equal((await call('file', { workspaceId, path: 'brief.md', content: 'overwrite', expectedHash: null })).status, 403);
  assert.equal((await call(`workspace?workspace=another-workspace`)).status, 403);
  assert.equal((await call('propose', { workspaceId, statement: 'A proposed idea', area: 'project', sourceQuote: 'A proposed idea' })).status, 200);
});

test('switching provider destinations never forwards an existing model key implicitly', async t => {
  const { app, request } = appFixture(t);
  await request('settings', { provider: 'compatible', model: 'first', baseUrl: 'https://first.invalid/v1', apiKey: 'private-first-provider' });
  await request('settings', { provider: 'compatible', model: 'second', baseUrl: 'https://second.invalid/v1' });
  assert.equal(app.hub.settings.apiKey, undefined);
});
