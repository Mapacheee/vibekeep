import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import type { LanguageModel } from 'ai';
import { WebApplication } from '../src/server.js';

export function appFixture(t: TestContext, model?: () => LanguageModel) {
  const root = mkdtempSync(join(tmpdir(), 'vibekeep-app-'));
  const app = new WebApplication(root, model);
  t.after(async () => {
    await app.close();
    const rel = relative(resolve(tmpdir()), root);
    if (!isAbsolute(rel) && !rel.includes('..') && rel.startsWith('vibekeep-app-')) rmSync(root, { recursive: true, force: true });
  });
  return { app, root, write(path: string, content: string) { const full = join(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, content); },
    async request(path: string, body?: unknown, authenticated = true) {
      return app.fetch(new Request(`${app.origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(authenticated ? { Authorization: `Bearer ${app.token}` } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
    },
  };
}
