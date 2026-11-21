import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'jsonc-parser';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { formatConfig, installWorkspaceConfig, workspaceServer } from '../src/clients.js';
import { fixture } from './helpers.js';

test('client configs launch the local memory server and preserve proxy credentials in the host-specific field', async t => {
  const { root } = fixture(t);
  const local = workspaceServer(root);
  for (const format of ['opencode', 'opencode-v1', 'claude', 'antigravity'] as const) {
    const config = JSON.parse(formatConfig(format, local));
    const entry = config.mcpServers?.vibekeep ?? config.mcp.servers?.vibekeep ?? config.mcp.vibekeep;
    const command = Array.isArray(entry.command) ? entry.command : [entry.command, ...entry.args];
    assert.deepEqual(command, [local.command, ...local.args]);
    const client = new Client({ name: format, version: '1' });
    try {
      await client.connect(new StdioClientTransport({ command: command[0]!, args: command.slice(1), stderr: 'pipe' }));
      const tools = await client.listTools();
      assert.ok(tools.tools.some(tool => tool.name === 'memory_query'));
    } finally { await client.close(); }
    const secret = { VIBEKEEP_SERVICE_TOKEN: 'session-token', VIBEKEEP_WORKSPACE_ID: 'workspace' };
    const proxy = JSON.parse(formatConfig(format, { ...local, env: secret }));
    const env = proxy.mcpServers?.vibekeep.env ?? proxy.mcp.servers?.vibekeep.environment ?? proxy.mcp.vibekeep.environment;
    assert.deepEqual(env, secret);
  }
  assert.match(formatConfig('codex', { ...local, env: { VIBEKEEP_WORKSPACE_ID: 'id' } }), /\[mcp_servers\.vibekeep\.env\]/);
});

test('workspace setup preserves other servers, comments, invalid files and user-owned settings', t => {
  const { root, write } = fixture(t);
  const path = join(root, 'opencode.jsonc');
  write('opencode.jsonc', '{\n  // Existing settings\n  "mcp": { "servers": { "review": {"disabled": true} } },\n}\n');
  assert.equal(installWorkspaceConfig(root, 'opencode'), path);
  const installed = readFileSync(path, 'utf8');
  assert.ok(installed.includes('// Existing settings'));
  assert.deepEqual(parse(installed).mcp.servers.review, { disabled: true });
  installWorkspaceConfig(root, 'opencode');
  assert.equal(readFileSync(path, 'utf8'), installed);
  const custom = '{"mcp":{"servers":{"vibekeep":{"type":"remote","url":"https://example.invalid"}}}}';
  writeFileSync(path, custom);
  assert.throws(() => installWorkspaceConfig(root, 'opencode'), /different settings/);
  assert.equal(readFileSync(path, 'utf8'), custom);
  writeFileSync(path, '{');
  assert.throws(() => installWorkspaceConfig(root, 'opencode'), /Invalid configuration/);
  assert.equal(readFileSync(path, 'utf8'), '{');
  const agy = installWorkspaceConfig(root, 'antigravity');
  assert.equal(agy, join(root, '.agents', 'mcp_config.json'));
  assert.deepEqual(JSON.parse(readFileSync(agy, 'utf8')).mcpServers.vibekeep, workspaceServer(root));
});
