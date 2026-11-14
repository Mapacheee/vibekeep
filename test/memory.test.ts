import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { fixture } from './helpers.js';

test('decisions survive a new database connection, with authority and provenance', t => {
  const { root, store } = fixture(t);
  const source = store.message('session', 'main', 'user', 'Use a light theme');
  const decision = store.remember({ statement: 'Use a light theme', area: 'ui.theme' }, 'main', 'user_explicit', source);
  const restored = new Store(root);
  try { assert.deepEqual(restored.decisions('main'), [decision]); assert.equal(decision.status, 'accepted'); assert.equal(decision.source_id, source); }
  finally { restored.close(); }
});

test('agent proposals cannot silently become explicit accepted choices', t => {
  const { store } = fixture(t);
  const decision = store.remember({ statement: 'Try bottom navigation' }, 'main', 'agent_proposal');
  assert.equal(decision.status, 'proposed');
  assert.equal(store.accept(decision.id, 'main').authority, 'user_explicit');
});

test('branch memory is isolated and FTS search handles Unicode and punctuation', t => {
  const { store } = fixture(t);
  store.remember({ statement: 'Use a light theme for the caf\u00e9 menu', area: 'ui.menu' }, 'main', 'user_explicit');
  store.remember({ statement: 'Dark layout' }, 'experiment', 'user_explicit');
  assert.equal(store.decisions('main', 'caf\u00e9 OR "').length, 1);
  assert.equal(store.decisions('experiment', 'caf\u00e9').length, 0);
  assert.equal(store.decisions('main').length, 1);
});

test('superseding a decision removes it from current retrieval and preserves history', t => {
  const { store } = fixture(t);
  const old = store.remember({ statement: 'Dark mode' }, 'main', 'user_explicit');
  const next = store.remember({ statement: 'Light mode' }, 'main', 'agent_proposal');
  store.accept(next.id, 'main', old.id);
  assert.deepEqual(store.decisions('main').map(d => d.statement), ['Light mode']);
  assert.equal(store.db.prepare('SELECT status FROM decisions WHERE id = ?').get(old.id)?.status, 'superseded');
});

test('failed acceptance rolls back all changes', t => {
  const { store } = fixture(t);
  const next = store.remember({ statement: 'Use tabs' }, 'main', 'agent_proposal');
  assert.throws(() => store.accept(next.id, 'main', 'missing'));
  assert.equal(store.decisions('main')[0]?.status, 'proposed');
  assert.throws(() => store.accept(next.id, 'other'));
});

test('portable memory import is idempotent and rejects conflicts atomically', t => {
  const { store } = fixture(t);
  store.remember({ statement: 'Keep the sidebar' }, 'main', 'user_explicit');
  const data = store.export();
  assert.equal(store.import(data), 0);
  const altered = JSON.parse(JSON.stringify(data));
  altered.decisions[0].statement = 'A conflicting edit';
  assert.throws(() => store.import(altered), /Conflicting/);
  assert.equal(store.decisions('main')[0]?.statement, 'Keep the sidebar');
  assert.throws(() => store.import({ ...altered, projectId: 'another-project' }), /another project/);
});

test('uncertain actions remain visible after reconnecting and never execute on load', t => {
  const { root, store } = fixture(t);
  const id = store.action('main', 'script.run', { script: 'test' });
  const restored = new Store(root);
  try { assert.equal(restored.pending()[0]?.id, id); }
  finally { restored.close(); }
});
