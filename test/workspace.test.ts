import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from './helpers.js';
import { LocalWorkspace } from '../src/workspace.js';
import { hash } from '../src/paths.js';
import { executableAvailable } from '../src/capabilities.js';
import { inspectSvg } from '../src/artifacts.js';

test('a design-only workspace has artifacts and reversible SVG operations without npm or Git', t => {
  const { root, store, write } = fixture(t);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="card" width="40" height="20" fill="red"/></svg>';
  write('build/source.svg', svg);
  write('image.png', String.fromCharCode(0, 1, 2, 3));
  const workspace = new LocalWorkspace(store);
  const inventory = workspace.inspect();
  assert.ok(inventory.files.some(file => file.path === 'build/source.svg'), 'design source directories must not inherit npm build exclusions');
  assert.equal(inventory.files.find(file => file.path === 'image.png')?.representation, 'binary');
  assert.equal(workspace.tasks().length, 0);
  assert.equal(workspace.svg('build/source.svg').nodes[0]?.id, 'card');
  workspace.updateSvg('build/source.svg', 'card', { fill: '#167a70' }, hash(svg));
  assert.match(readFileSync(join(root, 'build/source.svg'), 'utf8'), /#167a70/);
  workspace.executor.undo();
  assert.equal(readFileSync(join(root, 'build/source.svg'), 'utf8'), svg);
  assert.throws(() => inspectSvg('<!DOCTYPE svg><svg/>'), /declarations/);
});

test('custom tasks work without package.json and authorization cannot be bypassed', async t => {
  const { store } = fixture(t); const workspace = new LocalWorkspace(store);
  workspace.saveTask({ id: 'inspect', label: 'Inspect environment', command: process.execPath, args: ['-e', 'console.log("custom task works")'] });
  await assert.rejects(workspace.runTask('custom:inspect', async () => false), /not authorized/);
  const result = await workspace.runTask('custom:inspect', async () => true) as { exitCode: number; output: string };
  assert.equal(result.exitCode, 0); assert.match(result.output, /custom task works/);
  assert.equal(workspace.executor.checks()[0]?.current, true);
});

test('Java sources compile and execute through the Java provider without an npm project', async t => {
  if (!executableAvailable('javac') || !executableAvailable('java')) { t.skip('A compatible JDK is not installed.'); return; }
  const { root, store, write } = fixture(t);
  write('Main.java', 'public class Main { public static void main(String[] args) { System.out.println("Java integration works"); } }');
  const workspace = new LocalWorkspace(store);
  const compile = await workspace.runTask('java:compile', async () => true) as { exitCode: number; output: string };
  assert.equal(compile.exitCode, 0, compile.output); assert.equal(existsSync(join(root, '.vibe/local/java-classes/Main.class')), true);
  const run = await workspace.runTask('java:run:Main', async () => true) as { exitCode: number; output: string };
  assert.equal(run.exitCode, 0); assert.match(run.output, /Java integration works/);
});

test('experiments discard all their own writes and preserve the original bytes', t => {
  const { root, store, write } = fixture(t); const workspace = new LocalWorkspace(store);
  write('one.txt', 'original\r\n');
  const id = store.beginExperiment('workspace', 'Try a different direction');
  workspace.executor.write('one.txt', 'first', hash('original\r\n'));
  workspace.executor.write('one.txt', 'second', hash('first'));
  workspace.executor.write('new.txt', 'new', null);
  workspace.executor.discardExperiment(id);
  assert.equal(readFileSync(join(root, 'one.txt'), 'utf8'), 'original\r\n');
  assert.equal(existsSync(join(root, 'new.txt')), false);
  assert.equal(store.experiments('workspace')[0]?.status, 'discarded');
});

test('experiment conflict preflight does not partially revert other files', t => {
  const { root, store, write } = fixture(t); const workspace = new LocalWorkspace(store);
  write('one.txt', 'one'); write('two.txt', 'two');
  const id = store.beginExperiment('workspace', 'Conflicting experiment');
  workspace.executor.write('one.txt', 'agent one', hash('one'));
  workspace.executor.write('two.txt', 'agent two', hash('two'));
  write('one.txt', 'external edit');
  assert.throws(() => workspace.executor.discardExperiment(id), /No changes were reverted/);
  assert.equal(readFileSync(join(root, 'two.txt'), 'utf8'), 'agent two');
});
