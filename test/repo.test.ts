import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { adopt, readProjectFile } from '../src/repo.js';
import { projectPath } from '../src/paths.js';
import { fixture } from './helpers.js';

test('adoption detects packages and scripts without executing them or editing source', t => {
  const { root, store, write } = fixture(t);
  write('package.json', JSON.stringify({ name: 'existing', dependencies: { react: '*' }, scripts: { dev: 'never-run-this' } }));
  write('src/app.ts', 'export const original = 42;\n');
  const before = readFileSync(join(root, 'src/app.ts'));
  const inventory = adopt(store);
  assert.equal(inventory.packages[0]?.name, 'existing');
  assert.deepEqual(inventory.packages[0]?.technologies, ['react']);
  assert.equal(inventory.packages[0]?.scripts.dev, 'never-run-this');
  assert.deepEqual(readFileSync(join(root, 'src/app.ts')), before);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM actions').get()?.n, 0);
});

test('private files, generated directories, and ignored files are not indexed or readable', t => {
  const { root, store, write } = fixture(t);
  write('.env', 'API_KEY=fake-test-secret');
  write('node_modules/package/index.js', 'excluded');
  write('.gitignore', 'ignored.txt\n');
  write('ignored.txt', 'ignored');
  write('src/index.ts', 'safe');
  const inventory = adopt(store);
  assert.deepEqual(inventory.files.map(f => f.path).sort(), ['.gitignore', 'src/index.ts']);
  assert.throws(() => readProjectFile(root, '.env'), /excluded/);
  assert.throws(() => readProjectFile(root, 'ignored.txt'), /ignored/);
  assert.throws(() => projectPath(root, '../outside.txt'), /outside/);
  assert.throws(() => projectPath(root, 'C:\\outside.txt'), /relative/);
});

test('re-adoption identifies external edits and removed files', t => {
  const { root, store, write } = fixture(t);
  write('one.ts', 'old'); write('two.ts', 'remove me');
  const first = adopt(store);
  write('one.ts', 'external edit'); unlinkSync(join(root, 'two.ts'));
  const second = adopt(store);
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.deepEqual(second.changed, ['one.ts']);
  assert.deepEqual(second.removed, ['two.ts']);
});

test('Git enumeration respects nested gitignore and includes uncommitted files', t => {
  const { root, store, write } = fixture(t);
  try { execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' }); } catch { t.skip('Git unavailable'); return; }
  write('src/.gitignore', 'private.txt\n');
  write('src/private.txt', 'private'); write('src/new.ts', 'new');
  const inventory = adopt(store);
  assert.equal(inventory.branch, 'main');
  assert.ok(inventory.files.some(f => f.path === 'src/new.ts'));
  assert.ok(!inventory.files.some(f => f.path === 'src/private.txt'));
});

test('symlinked directories cannot escape project file tools', t => {
  const { root, write } = fixture(t);
  write('real/file.txt', 'content');
  try { symlinkSync(join(root, 'real'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { t.skip('Symlink creation unavailable'); return; }
  assert.throws(() => projectPath(root, 'linked/file.txt'), /Symlink/);
});

test('nested packages inherit a workspace package manager instead of silently choosing npm', t => {
  const { store, write } = fixture(t);
  write('package.json', JSON.stringify({ packageManager: 'pnpm@10.0.0', workspaces: ['packages/*'] }));
  write('packages/api/package.json', JSON.stringify({ scripts: { test: 'do-not-run' } }));
  const inventory = adopt(store);
  assert.equal(inventory.packages.find(p => p.path === 'packages/api/package.json')?.manager, 'pnpm');
});

test('non-Git inventories respect nested exclusions before reading files', t => {
  const { store, write } = fixture(t);
  write('nested/.gitignore', 'private.txt\n');
  write('nested/private.txt', 'should not be read');
  write('nested/keep.ts', 'safe');
  const inventory = adopt(store);
  assert.ok(!inventory.files.some(f => f.path === 'nested/private.txt'));
  assert.ok(inventory.files.some(f => f.path === 'nested/keep.ts'));
});
