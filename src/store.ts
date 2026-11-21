import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { decisionInput, type Decision, type Inventory } from './types.js';

const projectSchema = z.object({ schemaVersion: z.literal(1), id: z.string(), name: z.string(), createdAt: z.string() });
const exportedDecision = z.object({
  id: z.string().min(1), scope: z.string().min(1), area: z.string().min(1).max(200),
  statement: z.string().min(1).max(2000), status: z.enum(['proposed', 'accepted', 'superseded']),
  authority: z.enum(['agent_proposal', 'user_explicit']), source_id: z.string().nullable(), created_at: z.string(),
});

export class Store {
  readonly root: string;
  readonly local: string;
  readonly db: DatabaseSync;
  readonly project: z.infer<typeof projectSchema>;

  constructor(root: string) {
    this.root = resolve(root);
    const directory = join(this.root, '.vibe');
    this.local = join(directory, 'local');
    for (const path of [directory, this.local, join(directory, 'project.json'), join(directory, '.gitignore'), join(this.local, 'memory.sqlite'), join(this.local, 'memory.sqlite-wal'), join(this.local, 'memory.sqlite-shm')]) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`VibeKeep metadata cannot be a symlink: ${path}`);
    }
    mkdirSync(this.local, { recursive: true });
    const projectFile = join(directory, 'project.json');
    this.project = existsSync(projectFile)
      ? projectSchema.parse(JSON.parse(readFileSync(projectFile, 'utf8')))
      : { schemaVersion: 1, id: randomUUID(), name: this.root.split(/[\\/]/).at(-1) ?? 'project', createdAt: new Date().toISOString() };
    if (!existsSync(projectFile)) writeFileSync(projectFile, JSON.stringify(this.project, null, 2) + '\n', { flag: 'wx' });
    const ignoreFile = join(directory, '.gitignore');
    if (!existsSync(ignoreFile)) writeFileSync(ignoreFile, 'local/\n', { flag: 'wx' });
    else {
      const contents = readFileSync(ignoreFile, 'utf8');
      const last = contents.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).at(-1);
      if (!['local/', '/local/'].includes(last ?? '')) writeFileSync(ignoreFile, `${contents.trimEnd()}\n/local/\n`);
    }
    this.db = new DatabaseSync(join(this.local, 'memory.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=3000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, type TEXT NOT NULL, scope TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, scope TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, scope TEXT NOT NULL, area TEXT NOT NULL, statement TEXT NOT NULL, status TEXT NOT NULL, authority TEXT NOT NULL, source_id TEXT, created_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS decision_search USING fts5(id UNINDEXED, statement, area);
      CREATE TABLE IF NOT EXISTS inventories (scope TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL);
    `);
    const version = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    if (version && version.value !== '1') { this.db.close(); throw new Error('Unsupported memory schema version.'); }
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('schema_version', '1');
    const extensions = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('workspace_extensions');
    if (!extensions) {
      const hasHistory = Number(this.db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n ?? 0) > 0;
      if (hasHistory) {
        const backup = join(this.local, `before-workspaces-${Date.now()}.sqlite`);
        this.db.prepare('VACUUM INTO ?').run(backup);
      }
      this.transaction(() => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS experiments (id TEXT PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS experiment_actions (experiment_id TEXT NOT NULL, action_id TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS decision_resources (decision_id TEXT NOT NULL, workspace_id TEXT NOT NULL, resource_id TEXT NOT NULL, revision TEXT);
          CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
        this.db.prepare('INSERT INTO meta VALUES (?, ?)').run('workspace_extensions', '1');
      });
    }
  }

  close(): void { this.db.close(); }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  event(type: string, scope: string, payload: unknown): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)').run(id, type, scope, JSON.stringify(payload), new Date().toISOString());
    return id;
  }

  message(sessionId: string, scope: string, role: 'user' | 'assistant', content: string): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(id, sessionId, scope, role, content, new Date().toISOString());
    return id;
  }

  remember(input: z.input<typeof decisionInput>, scope: string, authority: Decision['authority'], sourceId: string | null = null): Decision {
    const value = decisionInput.parse(input);
    const decision: Decision = { id: randomUUID(), scope, ...value, status: authority === 'user_explicit' ? 'accepted' : 'proposed', authority, source_id: sourceId, created_at: new Date().toISOString() };
    return this.transaction(() => {
      this.insertDecision(decision);
      this.event('decision.recorded', scope, decision);
      return decision;
    });
  }

  private insertDecision(decision: Decision): void {
    this.db.prepare('INSERT INTO decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(decision.id, decision.scope, decision.area, decision.statement, decision.status, decision.authority, decision.source_id, decision.created_at);
    this.db.prepare('INSERT INTO decision_search VALUES (?, ?, ?)').run(decision.id, decision.statement, decision.area);
  }

  decisions(scope: string, query = ''): Decision[] {
    const words = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 16) ?? [];
    if (!words.length) return this.db.prepare("SELECT * FROM decisions WHERE scope = ? AND status != 'superseded' ORDER BY created_at DESC LIMIT 50").all(scope).map(row => ({ ...row })) as unknown as Decision[];
    const expression = words.map(w => `"${w}"`).join(' OR ');
    return this.db.prepare("SELECT d.* FROM decision_search s JOIN decisions d ON d.id = s.id WHERE decision_search MATCH ? AND d.scope = ? AND d.status != 'superseded' ORDER BY rank LIMIT 20").all(expression, scope).map(row => ({ ...row })) as unknown as Decision[];
  }

  accept(id: string, scope: string, supersedes?: string): Decision {
    return this.transaction(() => {
      const target = this.db.prepare("SELECT * FROM decisions WHERE id = ? AND scope = ? AND status = 'proposed'").get(id, scope) as unknown as Decision | undefined;
      if (!target) throw new Error('Proposed decision not found in this branch. Use its full ID.');
      if (supersedes) {
        const old = this.db.prepare("SELECT id FROM decisions WHERE id = ? AND scope = ? AND status = 'accepted'").get(supersedes, scope);
        if (!old) throw new Error('The decision being replaced is not accepted in this branch.');
        this.db.prepare("UPDATE decisions SET status = 'superseded' WHERE id = ?").run(supersedes);
      }
      this.db.prepare("UPDATE decisions SET status = 'accepted', authority = 'user_explicit' WHERE id = ?").run(id);
      this.event('decision.accepted', scope, { id, supersedes: supersedes ?? null });
      return { ...target, status: 'accepted', authority: 'user_explicit' };
    });
  }

  inventory(scope: string): Inventory | undefined {
    const row = this.db.prepare('SELECT payload FROM inventories WHERE scope = ?').get(scope);
    return row ? JSON.parse(String(row.payload)) as Inventory : undefined;
  }

  saveInventory(value: Inventory): void {
    const previous = this.inventory(value.branch);
    this.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO inventories VALUES (?, ?)').run(value.branch, JSON.stringify(value));
      if (previous?.fingerprint !== value.fingerprint) this.event('workspace.observed', value.branch, { fingerprint: value.fingerprint, files: value.files.length, changed: value.changed, removed: value.removed, truncated: value.truncated });
    });
  }

  action(scope: string, kind: string, payload: unknown): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO actions VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, scope, kind, 'running', JSON.stringify(payload), null, new Date().toISOString());
    const active = this.preference('active_experiment');
    if (active) {
      const experiment = this.db.prepare("SELECT id FROM experiments WHERE id = ? AND scope = ? AND status = 'active'").get(active, scope);
      if (experiment) this.db.prepare('INSERT INTO experiment_actions VALUES (?, ?)').run(active, id);
    }
    return id;
  }

  preference(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM preferences WHERE key = ?').get(key);
    return row ? String(row.value) : undefined;
  }

  setPreference(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO preferences VALUES (?, ?)').run(key, value);
  }

  messages(scope: string): Record<string, unknown>[] {
    return this.db.prepare('SELECT id, role, content, created_at FROM messages WHERE scope = ? ORDER BY rowid DESC LIMIT 100').all(scope).reverse().map(row => ({ ...row }));
  }

  timeline(): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM events ORDER BY rowid DESC LIMIT 100').all().map(row => ({ ...row, payload: JSON.parse(String(row.payload)) }));
  }

  experiments(scope: string): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM experiments WHERE scope = ? ORDER BY rowid DESC').all(scope).map(row => ({ ...row }));
  }

  beginExperiment(scope: string, name: string): string {
    if (!name.trim() || name.length > 200) throw new Error('An experiment name must contain 1–200 characters.');
    const active = this.preference('active_experiment');
    if (active && this.db.prepare("SELECT id FROM experiments WHERE id = ? AND status = 'active'").get(active)) throw new Error('Finish the active experiment first.');
    const id = randomUUID();
    this.transaction(() => {
      this.db.prepare('INSERT INTO experiments VALUES (?, ?, ?, ?, ?)').run(id, scope, name.trim(), 'active', new Date().toISOString());
      this.setPreference('active_experiment', id);
      this.event('experiment.started', scope, { id, name });
    });
    return id;
  }

  finishExperiment(id: string, scope: string, status: 'accepted' | 'discarded'): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT id FROM experiments WHERE id = ? AND scope = ? AND status = 'active'").get(id, scope);
      if (!row) throw new Error('Active experiment not found in this scope.');
      this.db.prepare('UPDATE experiments SET status = ? WHERE id = ?').run(status, id);
      this.setPreference('active_experiment', '');
      this.event(`experiment.${status}`, scope, { id });
    });
  }

  finish(id: string, status: string, result: unknown): void {
    this.db.prepare('UPDATE actions SET status = ?, result = ? WHERE id = ?').run(status, JSON.stringify(result), id);
  }

  pending(): Record<string, unknown>[] {
    return this.db.prepare("SELECT id, scope, kind, status, created_at FROM actions WHERE status IN ('running', 'unknown')").all();
  }

  export(): unknown {
    return { schemaVersion: 1, projectId: this.project.id, decisions: this.db.prepare('SELECT * FROM decisions ORDER BY created_at').all() };
  }

  import(value: unknown): number {
    const data = z.object({ schemaVersion: z.literal(1), projectId: z.string(), decisions: z.array(exportedDecision).max(10000) }).parse(value);
    if (data.projectId !== this.project.id) throw new Error('Export belongs to another project. Copy its .vibe/project.json only if this is a clone of that project.');
    return this.transaction(() => {
      let count = 0;
      for (const decision of data.decisions) {
        const existing = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(decision.id);
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(decision)) throw new Error(`Conflicting decision: ${decision.id}`);
          continue;
        }
        this.insertDecision(decision);
        count++;
      }
      this.event('memory.imported', 'project', { count });
      return count;
    });
  }
}
