import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { excluded, hash } from './paths.js';
import type { Store } from './store.js';

const text = z.string().trim().min(1).max(2000);
const name = z.string().trim().min(1).max(80);
const resource = z.string().trim().min(1).max(350)
  .transform(value => value.normalize('NFC').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, ''))
  .refine(value => value.length > 0 && !value.split('/').some(part => !part || part === '..' || part === '.') &&
    !/^[a-z]:/i.test(value) && !/[\x00-\x1f*?]/.test(value) && !excluded(value), 'Use project-relative file, folder or design resource names.');
const resources = z.array(resource).max(80).transform(items => [...new Set(items)]);
const taskId = z.string().uuid();
export const operations = {
  context: z.object({ taskId: taskId.optional(), before: z.number().int().positive().optional(), observed: resources.optional() }),
  start: z.object({ title: text, resources, branch: z.string().max(512) }),
  update: z.object({ taskId, version: z.number().int().positive(), summary: text, resources: resources.optional(), status: z.enum(['active', 'blocked', 'done']).optional() }),
  message: z.object({ taskId, message: text }),
  propose: z.object({ taskId, statement: text }),
};
type Task = { id: string; owner: string; workspace: string; title: string; branch: string; resources: string[]; observed: string[]; status: string; summary: string; version: number };
const parseTask = (row: Record<string, unknown>) => ({ ...row, resources: JSON.parse(String(row.resources)), observed: JSON.parse(String(row.observed)) }) as Task;

function overlap(a: string, b: string): boolean {
  const left = a.toLowerCase(), right = b.toLowerCase();
  return left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
}

export class TeamBoard {
  constructor(readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS team_members (name TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS team_tasks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace TEXT NOT NULL, title TEXT NOT NULL,
        branch TEXT NOT NULL, resources TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, version INTEGER NOT NULL, observed TEXT NOT NULL DEFAULT '[]');
      CREATE UNIQUE INDEX IF NOT EXISTS team_active_workspace ON team_tasks(workspace) WHERE status != 'done';
      CREATE TABLE IF NOT EXISTS team_events (seq INTEGER PRIMARY KEY, task TEXT NOT NULL REFERENCES team_tasks(id),
        actor TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_task_events ON team_events(task, seq);
      CREATE TABLE IF NOT EXISTS team_decisions (id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES team_tasks(id),
        author TEXT NOT NULL, statement TEXT NOT NULL, accepted_by TEXT);
      CREATE TABLE IF NOT EXISTS team_receipts (actor TEXT NOT NULL, request TEXT NOT NULL, fingerprint TEXT NOT NULL, task TEXT NOT NULL,
        PRIMARY KEY(actor,request));
    `);
  }

  invite(member: string): string {
    const actor = name.parse(member);
    const token = randomBytes(32).toString('hex');
    if (!this.store.db.prepare('INSERT OR IGNORE INTO team_members VALUES (?,?)').run(actor, hash(token)).changes) {
      throw new Error('This member already has a credential. Revoke it before issuing a replacement.');
    }
    return token;
  }

  authenticate(token: string): string | undefined {
    const row = this.store.db.prepare('SELECT name FROM team_members WHERE token_hash=?').get(hash(token));
    return row ? String(row.name) : undefined;
  }

  private event(task: string, actor: string, kind: string, body: string) {
    this.store.db.prepare('INSERT INTO team_events(task,actor,kind,body,created) VALUES (?,?,?,?,?)')
      .run(task, actor, kind, body, new Date().toISOString());
  }

  private task(id: string): Task {
    const row = this.store.db.prepare('SELECT * FROM team_tasks WHERE id=?').get(id);
    if (!row) throw new Error('Unknown team task.');
    return parseTask(row);
  }

  private context(actor: string, workspace: string, input: unknown) {
    const { taskId, before, observed } = operations.context.parse(input);
    const db = this.store.db;
    if (observed) db.prepare("UPDATE team_tasks SET observed=? WHERE owner=? AND workspace=? AND status!='done'").run(JSON.stringify(observed), actor, workspace);
    const active = db.prepare("SELECT * FROM team_tasks WHERE status != 'done' ORDER BY rowid").all().map(parseTask);
    const current = active.find(task => task.workspace === workspace && task.owner === actor);
    const selected = taskId ? this.task(taskId) : current;
    const conflicts = selected && selected.status !== 'done' ? active.filter(task => task.id !== selected.id)
      .map(task => ({ taskId: task.id, owner: task.owner, title: task.title,
        resources: [...new Set([...selected.resources, ...selected.observed])].filter(item => [...task.resources, ...task.observed].some(other => overlap(item, other))) }))
      .filter(item => item.resources.length) : [];
    const history = db.prepare('SELECT * FROM team_events WHERE (? IS NULL OR task=?) AND seq < ? ORDER BY seq DESC LIMIT 51')
      .all(selected?.id ?? null, selected?.id ?? null, before ?? Number.MAX_SAFE_INTEGER);
    const events = history.slice(0, 50).reverse();
    return { project: this.store.project.name, projectId: this.store.project.id, member: actor, currentTaskId: current?.id ?? null,
      selected: selected ?? null, active, conflicts, events, nextBefore: history.length > 50 ? events[0]?.seq : null,
      decisions: db.prepare('SELECT * FROM team_decisions ORDER BY rowid').all() };
  }

  execute(actor: string, workspace: string, action: string, input: unknown, requestId?: string) {
    z.string().uuid().parse(workspace);
    return this.store.transaction(() => {
      if (action === 'context') return this.context(actor, workspace, input);
      const key = z.string().uuid().parse(requestId);
      const db = this.store.db;
      const fingerprint = hash(JSON.stringify([workspace, action, input]));
      const previous = db.prepare('SELECT * FROM team_receipts WHERE actor=? AND request=?').get(actor, key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('Request ID already belongs to another operation.');
        return this.context(actor, workspace, { taskId: previous.task });
      }
      let id: string;
      if (action === 'start') {
        const args = operations.start.parse(input);
        if (db.prepare("SELECT id FROM team_tasks WHERE workspace=? AND status != 'done'").get(workspace)) throw new Error('This working copy already has an open task. Read its context or use a separate working copy.');
        id = randomUUID();
        db.prepare("INSERT INTO team_tasks(id,owner,workspace,title,branch,resources,status,summary,version) VALUES (?,?,?,?,?,?,'active','',1)").run(id, actor, workspace, args.title, args.branch, JSON.stringify(args.resources));
        this.event(id, actor, 'started', args.title);
      } else if (action === 'update') {
        const args = operations.update.parse(input);
        const task = this.task(args.taskId);
        if (task.owner !== actor || task.workspace !== workspace) throw new Error('Only the owning member in the assigned working copy can update this task.');
        if (task.version !== args.version || task.status === 'done') throw new Error('Task changed or finished. Refresh team context.');
        id = task.id;
        db.prepare('UPDATE team_tasks SET resources=?, status=?, summary=?, version=version+1 WHERE id=?')
          .run(JSON.stringify(args.resources ?? task.resources), args.status ?? task.status, args.summary, id);
        this.event(id, actor, args.status ?? task.status, args.summary);
      } else if (action === 'message') {
        const args = operations.message.parse(input);
        id = this.task(args.taskId).id;
        this.event(id, actor, 'message', args.message);
      } else if (action === 'propose') {
        const args = operations.propose.parse(input);
        id = this.task(args.taskId).id;
        db.prepare('INSERT INTO team_decisions VALUES (?,?,?,?,NULL)').run(randomUUID(), id, actor, args.statement);
        this.event(id, actor, 'proposed', args.statement);
      } else {
        throw new Error('Unknown team operation.');
      }
      db.prepare('INSERT INTO team_receipts VALUES (?,?,?,?)').run(actor, key, fingerprint, id);
      return this.context(actor, workspace, { taskId: id });
    });
  }

  accept(id: string) {
    return this.store.transaction(() => {
      const decision = this.store.db.prepare('SELECT * FROM team_decisions WHERE id=?').get(id);
      if (!decision) throw new Error('Unknown team decision.');
      if (!decision.accepted_by) {
        this.store.db.prepare("UPDATE team_decisions SET accepted_by='project owner' WHERE id=?").run(id);
        this.event(String(decision.task), 'project owner', 'accepted', String(decision.statement));
      }
    });
  }
}
