import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Agent } from '../src/agent.js';
import { TeamBoard } from '../src/team-board.js';
import { serveTeam } from '../src/team-service.js';
import { TeamClient, type TeamContext } from '../src/team-client.js';
import { Store } from '../src/store.js';
import { fixture } from './helpers.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('operator CLI serves a project, admits a named member and honors credential revocation', { timeout: 30000 }, async t => {
  const { root } = fixture(t);
  const copy = join(root, 'member-copy');
  mkdirSync(copy);
  const run = promisify(execFile);
  const token = (await run(process.execPath, [cli, 'team', 'invite', 'Sam', '--cwd', root])).stdout.trim();
  const host = spawn(process.execPath, [cli, 'team', 'serve', '--port', '0', '--cwd', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(host, 'close');
  const lines = createInterface({ input: host.stdout });
  try {
    const line = await Promise.race([once(lines, 'line'), closed.then(() => { throw new Error('Coordinator exited at startup.'); })]);
    const url = /http:\/\/127\.0\.0\.1:\d+/.exec(String(line[0]))![0];
    await run(process.execPath, [cli, 'team', 'join', url, '--cwd', copy], { env: { ...process.env, VIBEKEEP_TEAM_TOKEN: token } });
    const status = JSON.parse((await run(process.execPath, [cli, 'team', 'status', '--cwd', copy])).stdout);
    assert.equal(status.member, 'Sam');
    await run(process.execPath, [cli, 'team', 'revoke', 'Sam', '--cwd', root]);
    await assert.rejects(run(process.execPath, [cli, 'team', 'status', '--cwd', copy]), /Invalid team credential/);
  } finally {
    lines.close(); host.kill(); await closed;
  }
});

test('team updates are atomic, scoped, replayable and release claims on completion', t => {
  const { store } = fixture(t);
  const board = new TeamBoard(store);
  const a = randomUUID(), b = randomUUID(), key = randomUUID();
  const goal = { title: 'Report design', resources: ['design/reports/'], branch: 'workspace' };
  const start = board.execute('Ana', a, 'start', goal, key);
  const id = start.selected!.id;
  assert.equal(board.execute('Ana', a, 'start', goal, key).selected?.id, id);
  assert.throws(() => board.execute('Ana', a, 'start', { ...goal, title: 'Changed' }, key), /another operation/);
  assert.throws(() => board.execute('Ana', a, 'start', goal, randomUUID()), /open task/);
  const other = board.execute('Bo', b, 'start', { ...goal, resources: ['Design/Reports/menu', 'other'] }, randomUUID());
  assert.equal(other.conflicts[0]?.taskId, id);
  assert.equal(board.execute('Ana', a, 'context', {}).conflicts[0]?.owner, 'Bo');
  const update = { taskId: id, summary: 'Ready', version: 1 };
  assert.throws(() => board.execute('Bo', b, 'update', update, randomUUID()), /owning member/);
  assert.throws(() => board.execute('Ana', b, 'update', update, randomUUID()), /working copy/);
  board.execute('Ana', a, 'update', { ...update, resources: ['design/reports-old'] }, randomUUID());
  assert.throws(() => board.execute('Ana', a, 'update', update, randomUUID()), /Refresh/);
  assert.equal(board.execute('Bo', b, 'context', {}).conflicts.length, 0);
  const proposal = board.execute('Ana', a, 'propose', { taskId: id, statement: 'Use PDF/A' }, randomUUID()).decisions[0]!;
  assert.equal(proposal.accepted_by, null);
  assert.throws(() => board.execute('Bo', b, 'accept', { id: proposal.id }, randomUUID()), /Unknown team operation/);
  board.accept(String(proposal.id));
  assert.equal(board.execute('Bo', b, 'context', {}).decisions[0]?.accepted_by, 'project owner');
  board.execute('Ana', a, 'update', { ...update, version: 2, status: 'done' }, randomUUID());
  const history = board.execute('Bo', b, 'context', { taskId: id });
  assert.equal(history.selected?.status, 'done');
  assert.equal(history.events.at(-1)?.body, 'Ready');
  assert.equal(board.execute('Ana', a, 'start', goal, randomUUID()).active.length, 2);
});

test('two MCP chats coordinate across isolated copies and recover handoffs after reconnect and coordinator restart', { timeout: 90000 }, async t => {
  const { root, store } = fixture(t);
  const folder = (name: string) => { const path = join(root, name); mkdirSync(path); return path; };
  const base = folder('source'), design = folder('design'), worktree = join(root, 'export');
  execFileSync('git', ['init', '-q', base]);
  writeFileSync(join(base, 'menu.txt'), 'Original');
  execFileSync('git', ['-C', base, 'add', 'menu.txt']);
  execFileSync('git', ['-C', base, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture']);
  let coordinatorStore = new Store(store.root);
  let board = new TeamBoard(coordinatorStore);
  const tokenA = board.invite('Ana'), tokenB = board.invite('Bo');
  assert.throws(() => board.invite('Ana'), /already/);
  let service = await serveTeam(board, 0);
  const clients = new Set<Client>();
  const connect = async (path: string, coordinationOnly = false) => {
    const client = new Client({ name: 'team-test', version: '1' });
    clients.add(client);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [cli, ...(coordinationOnly ? ['team', 'mcp'] : ['mcp']), '--cwd', path], stderr: 'pipe' }));
    const { tools } = await client.listTools();
    assert.ok(tools.some(tool => tool.name === 'team_context'));
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result.content));
    return JSON.parse((result.content as {text: string}[])[0]!.text) as TeamContext;
  };

  // The HTTP coordinator runs in this process, so child requests must be asynchronous.
  const run = async (args: string[], env = process.env) => {
    return (await promisify(execFile)(process.execPath, [cli, ...args], { env })).stdout;
  };
  try {
    await assert.rejects(run(['team', 'join', service.url, '--cwd', design], { ...process.env, VIBEKEEP_TEAM_TOKEN: '0'.repeat(64) }), /Invalid team credential/);
    await Promise.all([
      run(['team', 'join', service.url, '--cwd', base], { ...process.env, VIBEKEEP_TEAM_TOKEN: tokenA }),
      run(['team', 'join', service.url, '--cwd', design], { ...process.env, VIBEKEEP_TEAM_TOKEN: tokenB }),
    ]);
    await run(['team', 'worktree', 'export-pdf', worktree, '--cwd', base]);
    assert.match(await run(['team', 'config', '--cwd', worktree]), /mcpServers/);
    const [ana, bo] = await Promise.all([connect(worktree), connect(design, true)]);
    const starts = await Promise.all([
      call(ana, 'team_start', { title: 'Export PDF', resources: ['export'] }),
      call(bo, 'team_start', { title: 'Report layout', resources: ['menu.txt'] }),
    ]);
    const id = starts[0].selected!.id;
    writeFileSync(join(worktree, 'menu.txt'), 'Export item');
    assert.equal(readFileSync(join(base, 'menu.txt'), 'utf8'), 'Original');
    const report = await call(ana, 'team_context');
    assert.equal(report.conflicts[0]?.owner, 'Bo');
    assert.equal((await call(bo, 'team_context')).conflicts[0]?.owner, 'Ana');
    const uri = 'vibekeep://team/context';
    const notifications: string[] = [];
    ana.setNotificationHandler(ResourceUpdatedNotificationSchema, event => { notifications.push(event.params.uri); });
    await ana.subscribeResource({ uri });
    await call(bo, 'team_message', { taskId: id, message: 'Use the footer for the export action.' });
    const deadline = Date.now() + 10000;
    while (!notifications.length && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
    assert.ok(notifications.includes(uri));
    assert.match(JSON.stringify(await ana.readResource({ uri })), /Use the footer/);
    await ana.unsubscribeResource({ uri });
    await call(ana, 'team_update', { taskId: id, version: 1, summary: 'Renderer ready. Footer integration pending.', status: 'blocked' });
    await ana.close(); clients.delete(ana);
    const port = Number(new URL(service.url).port);
    await service.close();
    coordinatorStore.close();
    coordinatorStore = new Store(store.root);
    board = new TeamBoard(coordinatorStore);
    service = await serveTeam(board, port);
    const resumed = await connect(worktree);
    const context = await call(resumed, 'team_context');
    assert.equal(context.currentTaskId, id);
    assert.match(context.selected!.summary, /Footer integration pending/);
    assert.ok(context.events.some(event => event.actor === 'Bo' && event.kind === 'message'));
    const otherStore = new Store(design);
    try {
      const profile = TeamClient.load(otherStore)!;
      await assert.rejects(profile.call('update', { taskId: id, version: 2, summary: 'Overwrite' }), /owning member/);
    } finally { otherStore.close(); }
    await call(resumed, 'team_update', { taskId: id, version: 2, summary: 'Footer ready for review', status: 'done' });
    assert.equal((await call(bo, 'team_context')).conflicts.length, 0);
  } finally {
    await Promise.all([...clients].map(client => client.close()));
    await service.close();
    coordinatorStore.close();
  }
});

test('the built-in chat receives handoffs and team tools without including member credentials', async t => {
  const { store } = fixture(t);
  const board = new TeamBoard(store);
  const token = board.invite('Sam');
  const service = await serveTeam(board, 0);
  let request = '';
  const model = createOpenAICompatible({ name: 'test', baseURL: 'https://mock.invalid/v1', fetch: async (_url, init) => {
    request = String(init?.body);
    return Response.json({ id: 'mock', object: 'chat.completion', created: 1, model: 'test',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Ready to resume.' }, finish_reason: 'stop' }] });
  } })('test');
  const agent = new Agent(store, model, async () => false);
  try {
    await TeamClient.join(store, service.url, token);
    const client = TeamClient.load(store)!;
    const task = await client.call('start', { title: 'Print layout', resources: ['page'], branch: 'workspace' });
    board.execute('Taylor', randomUUID(), 'message', { taskId: task.selected!.id, message: 'Keep the fold at 20 mm.' }, randomUUID());
    await agent.turn('Resume my task.');
    assert.match(request, /Keep the fold at 20 mm/);
    assert.match(request, /team_update/);
    assert.ok(!request.includes(token));
  } finally { await agent.workspace.close(); await service.close(); }
});
