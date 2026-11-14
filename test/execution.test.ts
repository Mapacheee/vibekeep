import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Executor, runProcess } from '../src/execution.js';
import { acquireLock } from '../src/lock.js';
import { hash } from '../src/paths.js';
import { fixture } from './helpers.js';

test('file writes require exact preconditions and preserve original user content on undo', t => {
  const { root, store, write } = fixture(t);
  write('app.ts', 'original user work\r\n');
  const executor = new Executor(store);
  assert.throws(() => executor.write('app.ts', 'replacement', null), /changed/);
  executor.write('app.ts', 'replacement', hash('original user work\r\n'));
  assert.equal(readFileSync(join(root, 'app.ts'), 'utf8'), 'replacement');
  assert.equal(executor.undo(), 'app.ts');
  assert.equal(readFileSync(join(root, 'app.ts'), 'utf8'), 'original user work\r\n');
});

test('undo refuses to overwrite later external changes', t => {
  const { root, store, write } = fixture(t);
  const executor = new Executor(store);
  executor.write('new.ts', 'agent work', null);
  write('new.ts', 'later user work');
  assert.throws(() => executor.undo(), /preserve/);
  assert.equal(readFileSync(join(root, 'new.ts'), 'utf8'), 'later user work');
});

test('undo of newly created files removes only that file', t => {
  const { root, store, write } = fixture(t);
  write('keep.txt', 'unrelated');
  const executor = new Executor(store);
  executor.write('new.ts', 'agent work', null);
  executor.undo();
  assert.equal(existsSync(join(root, 'new.ts')), false);
  assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'unrelated');
});

test('partial edits require unique text and preserve all surrounding content', t => {
  const { root, store, write } = fixture(t);
  write('app.ts', 'before\nconst theme = "dark";\nafter\n');
  const executor = new Executor(store);
  executor.replace('app.ts', '"dark"', '"light"', hash('before\nconst theme = "dark";\nafter\n'));
  assert.equal(readFileSync(join(root, 'app.ts'), 'utf8'), 'before\nconst theme = "light";\nafter\n');
  write('repeated.txt', 'same same');
  assert.throws(() => executor.replace('repeated.txt', 'same', 'new', hash('same same')), /exactly once/);
});

test('successful script evidence becomes stale after an external code change', async t => {
  const { store, write } = fixture(t);
  write('package.json', JSON.stringify({ scripts: { check: 'node check.cjs' } }));
  write('check.cjs', 'process.exit(0)');
  const executor = new Executor(store);
  await executor.runScript('check', 'package.json', 10000, async () => true);
  assert.equal(executor.checks()[0]?.current, true);
  write('app.ts', 'new unverified code');
  assert.equal(executor.checks()[0]?.current, false);
});

test('script execution requires authorization, reports actual failures, and journals results', async t => {
  const { store, write } = fixture(t);
  write('package.json', JSON.stringify({ scripts: { check: 'node check.cjs' } }));
  write('check.cjs', 'console.log("baseline failure"); process.exit(3);');
  const executor = new Executor(store);
  await assert.rejects(executor.runScript('check'), /not authorized/);
  const result = await executor.runScript('check', 'package.json', 10000, async () => true);
  assert.equal(result.exitCode, 3);
  assert.match(result.output, /baseline failure/);
  assert.equal(store.db.prepare("SELECT status FROM actions WHERE kind = 'script.run'").get()?.status, 'failed');
});

test('script approval is invalidated by a concurrent project change', async t => {
  const { store, write } = fixture(t);
  write('package.json', JSON.stringify({ scripts: { check: 'node -e "process.exit(0)"' } }));
  await assert.rejects(new Executor(store).runScript('check', 'package.json', 10000, async () => {
    write('changed.ts', 'concurrent work'); return true;
  }), /changed while/);
});

test('bounded processes time out and retain output', async () => {
  const started = Date.now();
  const result = await runProcess(process.execPath, ['-e', 'console.log("started"); setTimeout(()=>{}, 10000)'], process.cwd(), 400);
  assert.equal(result.timedOut, true);
  assert.match(result.output, /started/);
  assert.ok(Date.now() - started < 5000, 'timed out process must actually terminate');
});

test('one local writer lock prevents another concurrent session', t => {
  const { store } = fixture(t);
  const release = acquireLock(store.local);
  try { assert.throws(() => acquireLock(store.local), /Another VibeKeep/); }
  finally { release(); }
  acquireLock(store.local)();
});

test('cancelling a process stops it without recording a successful result', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  try {
    await assert.rejects(runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], process.cwd(), 10000, process.env, controller.signal), /cancelled/);
  } finally { clearTimeout(timer); }
});
