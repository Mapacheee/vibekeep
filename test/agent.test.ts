import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent, configuredModel } from '../src/agent.js';
import { fixture } from './helpers.js';

test('model configuration fails clearly without credentials or endpoint', () => {
  assert.throws(() => configuredModel({}), /VIBEKEEP_MODEL/);
  assert.throws(() => configuredModel({ VIBEKEEP_MODEL: 'test' }), /BASE_URL/);
  assert.throws(() => configuredModel({ VIBEKEEP_MODEL: 'test', VIBEKEEP_PROVIDER: 'anthropic' }), /API_KEY/);
});

test('actual compatible-provider tool loop writes code and preserves provisional memory across turns', async t => {
  const { root, store } = fixture(t);
  const requests: Record<string, unknown>[] = [];
  const model = createOpenAICompatible({ name: 'test', baseURL: 'https://mock.invalid/v1', fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const number = requests.length;
    const call = number === 1
      ? { name: 'write_file', arguments: JSON.stringify({ path: 'hello.ts', content: 'export const greeting = "hello";\n', expectedHash: null }) }
      : number === 2 ? { name: 'propose_decision', arguments: JSON.stringify({ statement: 'Use a light theme', area: 'ui.theme', evidenceQuote: 'light theme' }) } : undefined;
    return new Response(JSON.stringify({
      id: `mock-${number}`, object: 'chat.completion', created: 1, model: 'test-model',
      choices: [{ index: 0, message: call ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${number}`, type: 'function', function: call }] } : { role: 'assistant', content: 'I created the file and saved the preference as a proposal. I did not run tests.' }, finish_reason: call ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } })('test-model');
  const agent = new Agent(store, model, async () => false);
  const result = await agent.turn('Create a greeting and use a light theme');
  assert.equal(result.steps, 3);
  assert.match(readFileSync(join(root, 'hello.ts'), 'utf8'), /hello/);
  assert.equal(store.decisions('workspace')[0]?.status, 'proposed');
  assert.equal(store.decisions('workspace')[0]?.authority, 'agent_proposal');
  assert.equal(store.pending().length, 0);
  const restored = new Agent(store, model, async () => false);
  await restored.turn('What did we choose?');
  const serialized = JSON.stringify(requests.at(-1));
  assert.match(serialized, /Use a light theme/);
  assert.match(serialized, /Create a greeting/);
  assert.match(serialized, /Always respond in English/);
});
