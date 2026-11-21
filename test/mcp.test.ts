import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture } from './helpers.js';

test('an actual MCP host uses memory without model credentials and does not receive write tools by default', async t => {
  const { root, store, write } = fixture(t); write('brief.md', 'Design a calm reading experience.');
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--cwd', root], stderr: 'pipe' });
  const client = new Client({ name: 'vibekeep-test-host', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'memory_query'));
    assert.ok(!tools.tools.some(tool => tool.name === 'resource_write'));
    const source = await client.callTool({ name: 'resource_read', arguments: { path: 'brief.md' } });
    assert.match(JSON.stringify(source), /calm reading/);
    const remembered = await client.callTool({ name: 'memory_propose', arguments: { statement: 'Keep the reading experience calm', area: 'design.intent', sourceQuote: 'Design a calm reading experience.' } });
    assert.match(JSON.stringify(remembered), /proposed/);
    assert.equal(store.decisions('workspace')[0]?.authority, 'agent_proposal');
  } finally { await client.close(); }
});
