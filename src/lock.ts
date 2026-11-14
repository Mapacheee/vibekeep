import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** One CLI writer per local project; leave uncertain actions in the journal after a crash. */
export function acquireLock(local: string): () => void {
  const path = join(local, 'session.lock');
  const token = randomUUID();
  if (existsSync(path)) {
    let pid: number;
    try { pid = Number(JSON.parse(readFileSync(path, 'utf8')).pid); }
    catch { throw new Error('Unreadable session lock. Inspect .vibe/local/session.lock before removing it.'); }
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid session lock; inspect it before removing it.');
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
    if (alive) throw new Error(`Another VibeKeep session is active (PID ${pid}).`);
    unlinkSync(path);
  }
  const fd = openSync(path, 'wx');
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); } finally { closeSync(fd); }
  return () => {
    try {
      const current = JSON.parse(readFileSync(path, 'utf8')) as { token?: string };
      if (current.token === token) unlinkSync(path);
    } catch { /* Already released. */ }
  };
}
