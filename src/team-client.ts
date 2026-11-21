import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store.js';
import type { TeamBoard } from './team-board.js';

export type TeamContext = ReturnType<TeamBoard['execute']>;
const connection = z.object({ url: z.string(), token: z.string().regex(/^[0-9a-f]{64}$/), workspace: z.string().uuid() });
type Connection = z.infer<typeof connection>;

function endpoint(value: string) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use the HTTPS origin of your team coordinator, or a loopback HTTP address.');
  }
  return url.origin;
}

export class TeamClient {
  constructor(private readonly profile: Connection) {}

  static load(store: Store) {
    const saved = store.preference('team_connection');
    return saved ? new TeamClient(connection.parse(JSON.parse(saved))) : undefined;
  }

  static async join(store: Store, url: string, token: string) {
    const previous = TeamClient.load(store);
    const origin = endpoint(url);
    const profile = connection.parse({ url: origin, token, workspace: previous?.profile.workspace ?? randomUUID() });
    const client = new TeamClient(profile);
    const context = await client.call('context');
    const identity = JSON.stringify([context.projectId, context.member]);
    store.transaction(() => {
      const existing = store.preference('team_identity');
      if (existing && existing !== identity) throw new Error('This working copy is assigned to another project or member. Join from a separate copy.');
      const current = TeamClient.load(store);
      if (current && current.profile.workspace !== profile.workspace) throw new Error('Another join completed in this working copy. Retry to use the existing membership.');
      store.setPreference('team_connection', JSON.stringify(profile));
      store.setPreference('team_identity', identity);
    });
    return context;
  }

  async attachWorktree(store: Store) {
    return TeamClient.join(store, this.profile.url, this.profile.token);
  }

  async call(action: string, input: Record<string, unknown> = {}, requestId = randomUUID()): Promise<TeamContext> {
    const url = endpoint(this.profile.url) + '/team';
    const body = JSON.stringify({ action, input, workspace: this.profile.workspace, requestId });
    // A lost response is safe to retry with the same operation ID.
    const send = () => fetch(url, { method: 'POST', redirect: 'error', headers: {
      Authorization: 'Bearer ' + this.profile.token, 'Content-Type': 'application/json',
    }, body, signal: AbortSignal.timeout(6000) });
    const response = await send().catch(() => send());
    const result = await response.json();
    if (!response.ok) throw new Error(String(result.error ?? 'Team coordinator rejected the request.'));
    z.object({ projectId: z.string().uuid(), member: z.string().min(1), active: z.array(z.unknown()), events: z.array(z.unknown()), decisions: z.array(z.unknown()) }).parse(result);
    return result as TeamContext;
  }
}
