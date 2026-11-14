import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fixture } from './helpers.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
test('CLI adoption, persistent memory, and search work in separate processes without a model', t => {
  const { root } = fixture(t);
  const run = (...args: string[]): string => execFileSync(process.execPath, [cli, ...args, '--cwd', root, '--json'], { encoding: 'utf8', timeout: 15000 });
  const adopted = JSON.parse(run('adopt'));
  assert.equal(adopted.files.length, 0);
  const remembered = JSON.parse(run('remember', 'Keep the navigation menu', '--area', 'ui.navigation'));
  assert.equal(remembered.status, 'accepted');
  assert.equal(JSON.parse(run('memory', 'menu'))[0].statement, 'Keep the navigation menu');
});

test('CLI help is usable without initialization and invalid commands fail', () => {
  const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.match(help, /Build freely/);
  const invalid = spawnSync(process.execPath, [cli, 'missing-command'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unknown command/);
});
