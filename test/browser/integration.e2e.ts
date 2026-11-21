import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { appFixture } from '../app-helper.js';

test('GUI starts a real development server, previews it, and stops the process', { timeout: 60000 }, async t => {
  const { app } = appFixture(t); const workspace = [...app.hub.workspaces.values()][0]!;
  workspace.saveTask({ id: 'preview', label: 'Live preview server', command: process.execPath, args: ['-e', 'const h=require("node:http"); const s=h.createServer((q,r)=>{r.setHeader("Content-Type","text/html");r.end("<h1>Actual live preview</h1>")});s.listen(0,"127.0.0.1",()=>console.log("http://127.0.0.1:"+s.address().port));'], mode: 'server' });
  const url = await app.listen(0); const browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  try {
    await page.goto(url); await page.locator('[data-tab="tasks"]').click();
    await page.locator('[data-run-task="custom:preview"]').click();
    await page.locator('[data-server-preview]').waitFor({ timeout: 25000 });
    await page.locator('[data-server-preview]').click();
    await page.frameLocator('.preview-surface iframe').getByText('Actual live preview').waitFor();
    await page.locator('[data-tab="tasks"]').click(); await page.locator('[data-stop-server]').click();
    await page.locator('[data-stop-server]').waitFor({ state: 'hidden' });
    assert.equal((await workspace.processes.list())[0]?.status, 'stopped');
  } finally { await browser.close(); }
});

test('GUI connects to a real document adapter and edits its native resource through an operation', { timeout: 60000 }, async t => {
  const { root, app, write } = appFixture(t);
  write('canvas.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect id="accent" width="120" height="80" fill="#112233"/></svg>');
  const child = spawn(process.execPath, [resolve('integrations/svg-bridge.mjs'), '--file', join(root, 'canvas.svg'), '--port', '0'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
    const timer = setTimeout(() => reject(new Error('Document adapter did not start.')), 10000);
    child.once('error', reject); let output = '';
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolveEndpoint(match[0]); } });
  });
  const url = await app.listen(0); const browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  try {
    await page.goto(url); await page.locator('#open-workspace').click(); await page.locator('#connect-application').click();
    await page.locator('#connector-url').fill(endpoint); await page.locator('#connector-form button[type="submit"]').click();
    await page.locator('[data-file="document:canvas"]').waitFor({ timeout: 20000 });
    await page.locator('[data-file="document:canvas"]').click(); await page.locator('.preview-surface img').waitFor();
    await page.locator('[data-tab="editor"]').click(); assert.equal(await page.locator('#editor').getAttribute('readonly'), '');
    await page.locator('[data-tab="tasks"]').click(); await page.locator('[data-run-task="selection.setFill"]').click();
    await page.locator('[data-operation-param="nodeId"]').fill('accent'); await page.locator('[data-operation-param="fill"]').fill('#167a70');
    await page.locator('#operation-form button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent === 'Operation completed.', { timeout: 20000 });
    assert.match(readFileSync(join(root, 'canvas.svg'), 'utf8'), /#167a70/);
    await page.locator('[data-tab="memory"]').click(); await page.locator('#memory-statement').fill('Use green for the selected card'); await page.locator('#memory-form button').click();
    await page.locator('#panel').getByText('Use green for the selected card', { exact: true }).waitFor();
    assert.equal([...app.hub.workspaces.values()].filter(workspace => workspace.kind === 'remote').length, 1);
  } finally { await browser.close(); child.kill(); await new Promise<void>(resolveExit => child.once('close', () => resolveExit())); }
});

test('an external MCP client shares the running GUI memory without a second model or database writer', { timeout: 30000 }, async t => {
  const { app } = appFixture(t); const workspace = [...app.hub.workspaces.values()][0]!; await app.listen(0);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(app.origin + '/#token=' + app.token);
  await page.locator('#workspace-menu summary').click();
  await page.locator('#external-agent-button').click();
  await page.getByLabel('Client', { exact: true }).selectOption('opencode');
  await page.waitForFunction(() => document.querySelector('#integration-config')?.textContent?.includes('"servers"'));
  const { command, environment } = JSON.parse(await page.locator('#integration-config').innerText()).mcp.servers.vibekeep;
  assert.equal(environment.VIBEKEEP_WORKSPACE_ID, workspace.id);
  const transport = new StdioClientTransport({ command: command[0], args: command.slice(1), env: environment, stderr: 'pipe' });
  const client = new Client({ name: 'actual-external-host', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools(); assert.ok(!tools.tools.some(tool => tool.name === 'resource_write'));
    await client.callTool({ name: 'memory_propose', arguments: { statement: 'Keep typography consistent', area: 'design.type', sourceQuote: 'Keep typography consistent' } });
    assert.equal(workspace.store.decisions('workspace')[0]?.statement, 'Keep typography consistent');
    assert.equal(workspace.store.decisions('workspace')[0]?.status, 'proposed');
    const result = await client.callTool({ name: 'memory_query', arguments: { query: 'typography' } });
    assert.match(JSON.stringify(result), /Keep typography consistent/);
  } finally { await client.close(); }
});

test('agent task execution waits for an actual GUI authorization before invoking a local tool', { timeout: 60000 }, async t => {
  let calls = 0;
  const model = createOpenAICompatible({ name: 'test', baseURL: 'https://mock.invalid/v1', fetch: async () => {
    calls++; const invocation = calls === 1 ? { name: 'run_task', arguments: JSON.stringify({ taskId: 'custom:check' }) } : undefined;
    return Response.json({ id: String(calls), object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: invocation ? { role: 'assistant', content: null, tool_calls: [{ id: 'task-call', type: 'function', function: invocation }] } : { role: 'assistant', content: 'The authorized workspace check completed.' }, finish_reason: invocation ? 'tool_calls' : 'stop' }] });
  } })('test');
  const { app } = appFixture(t, () => model); const workspace = [...app.hub.workspaces.values()][0]!;
  workspace.saveTask({ id: 'check', label: 'Authorized workspace check', command: process.execPath, args: ['-e', 'console.log("authorized check")'] });
  const url = await app.listen(0); const browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  try {
    await page.goto(url); await page.locator('#prompt').fill('Run the workspace check'); await page.locator('#send-button').click();
    await page.locator('#approve-task').waitFor({ timeout: 20000 });
    assert.equal(workspace.store.db.prepare("SELECT COUNT(*) AS n FROM actions WHERE kind = 'task.run'").get()?.n, 0);
    await page.locator('#approve-task').click();
    await page.getByText('The authorized workspace check completed.', { exact: true }).waitFor({ timeout: 20000 });
    const row = workspace.store.db.prepare("SELECT status, result FROM actions WHERE kind = 'task.run'").get();
    assert.equal(row?.status, 'succeeded'); assert.match(String(row?.result), /authorized check/);
  } finally { await browser.close(); }
});
