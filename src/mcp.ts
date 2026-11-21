import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TeamClient } from './team-client.js';
import { registerTeamTools, teamInstructions } from './team-tools.js';
import { Store } from './store.js';
import { LocalWorkspace } from './workspace.js';
import { branch, readProjectFile } from './repo.js';
import { acquireLock } from './lock.js';

const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

/** A host can use project memory and resources without a VibeKeep model or a second chat. */
export async function startMcp(root: string, options: { writes?: boolean; tasks?: boolean } = {}): Promise<void> {
  const store = new Store(root); const release = acquireLock(store.local); const workspace = new LocalWorkspace(store);
  const team = TeamClient.load(store);
  const server = new McpServer({ name: 'vibekeep', version: '0.2.0' }, team ? { instructions: teamInstructions } : {});
  if (team) registerTeamTools(server, team, root);
  const registered = (name: string, description: string, inputSchema: z.ZodRawShape, execute: (args: Record<string, unknown>) => Promise<unknown> | unknown, readOnly = true) => {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false } }, async args => {
      try { return result(await execute(args)); }
      catch (error) { return { ...result({ error: error instanceof Error ? error.message : String(error) }), isError: true }; }
    });
  };
  registered('workspace_inspect', 'Inspect any local workspace and its actual capabilities. Does not require npm, Git, or a configured model.', {}, () => ({ inventory: workspace.inspect(), capabilities: workspace.capabilities(), tasks: workspace.tasks() }));
  registered('memory_query', 'Retrieve current workspace decisions. Proposed decisions are not confirmed user intent.', { query: z.string().default('') }, args => store.decisions(branch(root), String(args.query)));
  registered('memory_propose', 'Record a provisional decision from the external agent. Only the operator can explicitly accept it through the CLI or GUI.', { statement: z.string().min(1).max(2000), area: z.string().default('project'), sourceQuote: z.string().min(1).max(2000) }, args => {
    const source = store.message('mcp-host', branch(root), 'user', `External host reported this source quote (not independently verified): ${args.sourceQuote}`);
    return store.remember({ statement: String(args.statement), area: String(args.area) }, branch(root), 'agent_proposal', source);
  }, false);
  registered('memory_observe', 'Record an external application observation with a resource identity and revision. Observation is attributed to the external host, not independently verified by VibeKeep.', { resourceId: z.string().min(1).max(2000), revision: z.string().nullable(), observation: z.string().min(1).max(8000) }, args => ({ eventId: store.event('external.observed', branch(root), { ...args, source: 'external_host', independentlyVerified: false }) }), false);
  registered('resource_read', 'Read a bounded text representation with its revision hash.', { path: z.string(), startLine: z.number().int().min(1).default(1) }, args => readProjectFile(root, String(args.path), Number(args.startLine), 200));
  registered('svg_inspect', 'Inspect SVG nodes and dimensions.', { path: z.string() }, args => workspace.svg(String(args.path)));
  if (options.writes) {
    registered('resource_write', 'Write a text resource with an exact revision precondition and an undo snapshot.', { path: z.string(), content: z.string().max(256 * 1024), expectedHash: z.string().nullable() }, args => workspace.executor.write(String(args.path), String(args.content), args.expectedHash as string | null), false);
    registered('resource_edit', 'Replace a unique text fragment with exact revision checking.', { path: z.string(), oldText: z.string().min(1), newText: z.string(), expectedHash: z.string() }, args => workspace.executor.replace(String(args.path), String(args.oldText), String(args.newText), String(args.expectedHash)), false);
    registered('resource_undo', 'Restore the last own write only when no later edit conflicts.', {}, () => ({ restored: workspace.executor.undo() }), false);
  }
  if (options.tasks) registered('task_run', 'Execute a registered workspace task. The operator enabled task execution when configuring this server; the host should apply its own approval policy.', { id: z.string() }, args => workspace.runTask(String(args.id), async () => true), false);
  let closing = false;
  const close = async (): Promise<void> => { if (closing) return; closing = true; await workspace.close(); release(); store.close(); await server.close(); };
  process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
  process.stdin.once('end', () => { void close(); });
  await server.connect(new StdioServerTransport());
}
