import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { chatClients, configFormat, formatConfig, openClient, workspaceServer } from './clients.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Store } from './store.js';
import { TeamBoard } from './team-board.js';
import { TeamClient } from './team-client.js';
import { registerTeamTools, teamInstructions, teamTools } from './team-tools.js';
import { serveTeam } from './team-service.js';

const help = `Team coordination
  team serve [--port 4318]      Run the coordinator for this project on loopback
  team invite <name>            Issue a named member credential on the coordinator machine
  team revoke <name>            Disable a member credential on the coordinator machine
  team accept <decision-id>     Confirm a shared decision on the coordinator machine
  team join <origin>            Join from this working copy using VIBEKEEP_TEAM_TOKEN
  team worktree <branch> <dir>  Create a separate Git working copy from HEAD and carry membership
  team <client>                 Open codex, claude, opencode or antigravity in this working copy
  team config [client]          Print the client's MCP configuration (default: standard JSON)
  team mcp                      Serve coordination tools only, including alongside the GUI
  team status                   Show shared work and messages for this working copy
Pass --cwd <directory> to select the project.`;

export async function teamCommand(root: string, args: string[], portValue?: string) {
  const [action, value, destination] = args;
  if (!action || action === 'help') { console.log(help); return; }
  const store = new Store(root);
  const required = () => { if (!value?.trim()) throw new Error(help); return value; };
  try {
    if (['serve', 'invite', 'revoke', 'accept'].includes(action)) {
      const board = new TeamBoard(store);
      if (action === 'invite') { console.log(board.invite(required())); return; }
      if (action === 'revoke') {
        const removed = store.db.prepare('DELETE FROM team_members WHERE name=?').run(required());
        if (!removed.changes) throw new Error('Unknown member.');
        console.log('Member credential revoked.'); return;
      }
      if (action === 'accept') { board.accept(required()); console.log('Team decision accepted.'); return; }
      const port = Number(portValue ?? 4318);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid team port.');
      const service = await serveTeam(board, port);
      console.log(`Team coordinator for ${store.project.name} at ${service.url}`);
      await new Promise<void>(done => {
        const stop = () => { process.off('SIGTERM', stop); process.off('SIGINT', stop); done(); };
        process.once('SIGTERM', stop); process.once('SIGINT', stop);
      });
      await service.close(); return;
    }
    if (action === 'join') {
      if (!process.env.VIBEKEEP_TEAM_TOKEN) throw new Error('Set VIBEKEEP_TEAM_TOKEN to your personal team credential.');
      const result = await TeamClient.join(store, required(), process.env.VIBEKEEP_TEAM_TOKEN);
      console.log(`Joined ${result.project} as ${result.member}.`); return;
    }
    const client = TeamClient.load(store);
    if (!client) throw new Error('Join this working copy first with vibekeep team join <origin>.');
    if (action === 'status') {
      console.log(JSON.stringify(await teamTools(client, root).team_context.execute({}), null, 2)); return;
    }
    if (action === 'config') {
      console.log(formatConfig(configFormat(value ?? 'claude'), workspaceServer(root))); return;
    }
    if (action === 'mcp') {
      const server = new McpServer({ name: 'vibekeep-team', version: '0.2.0' }, { instructions: teamInstructions });
      registerTeamTools(server, client, root);
      const transport = new StdioServerTransport();
      process.stdin.once('end', () => { void server.close(); });
      await server.connect(transport);
      await new Promise<void>(done => { server.server.onclose = done; });
      return;
    }
    if (chatClients.some(client => client === action)) {
      process.exitCode = await openClient(action, root);
      return;
    }
    if (action === 'worktree') {
      if (!destination) throw new Error(help);
      const branchName = required();
      execFileSync('git', ['check-ref-format', '--branch', branchName], { stdio: 'pipe' });
      const resolved = resolve(root, destination);
      const path = join(realpathSync.native(dirname(resolved)), basename(resolved));
      const prefix = execFileSync('git', ['-C', root, 'rev-parse', '--show-prefix'], { encoding: 'utf8' }).trim();
      if (prefix) throw new Error('Run team worktree from the repository root.');
      const top = realpathSync.native(root);
      const rel = relative(top, path);
      if (existsSync(path) || !(isAbsolute(rel) || rel.startsWith('..' + sep))) throw new Error('Choose a new directory outside the source checkout.');
      execFileSync('git', ['-C', root, 'worktree', 'add', '-b', branchName, '--', path, 'HEAD'], { stdio: 'pipe' });
      try {
        const copy = new Store(path);
        try { await client.attachWorktree(copy); } finally { copy.close(); }
      } catch (error) {
        throw new Error(`Worktree created at ${path}. Run team join there to finish setup. ${error instanceof Error ? error.message : error}`);
      }
      console.log(`Created ${path} on ${branchName} from committed HEAD. Launch your chat in that directory.`);
      return;
    }
    throw new Error(help);
  } finally { store.close(); }
}
