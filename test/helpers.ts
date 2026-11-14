import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { Store } from '../src/store.js';

export function fixture(t: TestContext): { root: string; store: Store; write: (path: string, value: string) => void } {
  const root = mkdtempSync(join(tmpdir(), 'vibekeep-test-'));
  const store = new Store(root);
  t.after(() => {
    store.close();
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (!isAbsolute(rel) && !rel.includes('..') && rel.startsWith('vibekeep-test-')) rmSync(root, { recursive: true, force: true });
  });
  const write = (path: string, value: string): void => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, value);
  };
  return { root, store, write };
}
