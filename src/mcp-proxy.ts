import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/** Share the running GUI's workspace session instead of opening a second database writer. */
export async function startMcpProxy(service: string, token: string, workspaceId: string, options: { writes?: boolean; tasks?: boolean } = {}): Promise<void> {
  const url = new URL(service);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) service URL without embedded credentials.');
  if (!token || !workspaceId) throw new Error('Service mode requires VIBEKEEP_SERVICE_TOKEN and VIBEKEEP_WORKSPACE_ID. Copy the connection configuration from the GUI.');
  const call = async (endpoint: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${url.origin}/api/${endpoint}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify({ workspaceId, ...(body as object) }), signal: AbortSignal.timeout(125000) });
    const value = await response.json() as { error?: string };
    if (!response.ok) throw new Error(value.error ?? `Service request failed (${response.status}).`);
    return value;
  };
  const query = (path: string, values: Record<string, string> = {}): string => `${path}?${new URLSearchParams({ workspace: workspaceId, ...values })}`;
  const server = new McpServer({ name: 'vibekeep', version: '0.2.0' });
  const register = (name: string, description: string, schema: z.ZodRawShape, operation: (args: Record<string, unknown>) => Promise<unknown>, readOnly = true): void => {
    server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly } }, async args => {
      try { return { content: [{ type: 'text', text: JSON.stringify(await operation(args), null, 2) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }; }
    });
  };
  register('workspace_inspect', 'Inspect the connected workspace and actual capabilities. Uses the GUI session, with no separate model.', {}, () => call(query('workspace')));
  register('memory_query', 'Search current decisions in the active scope.', { query: z.string().default('') }, args => call(query('memory', { query: String(args.query) })));
  register('memory_propose', 'Save a provisional decision attributed to the external host; it is not explicit user acceptance.', { statement: z.string().min(1).max(2000), area: z.string().default('project'), sourceQuote: z.string().min(1).max(2000) }, args => call('propose', args), false);
  register('memory_observe', 'Record an external application resource observation, attributed to the host and not independently verified.', { resourceId: z.string().min(1), revision: z.string().nullable(), observation: z.string().min(1).max(8000) }, args => call('observe', args), false);
  register('resource_read', 'Read a bounded text representation and its revision.', { path: z.string(), startLine: z.number().min(1).default(1) }, args => call(query('file', { path: String(args.path), start: String(args.startLine) })));
  if (options.writes) {
    register('resource_write', 'Write a resource with revision checking and an undo snapshot.', { path: z.string(), content: z.string().max(256 * 1024), expectedHash: z.string().nullable() }, args => call('file', args), false);
    register('resource_edit', 'Replace one exact text fragment with revision checking.', { path: z.string(), oldText: z.string().min(1), newText: z.string(), expectedHash: z.string() }, args => call('edit', args), false);
    register('resource_undo', 'Restore the last own resource write when there are no conflicting later edits.', {}, () => call('undo', {}), false);
  }
  if (options.tasks) register('task_run', 'Run an explicitly enabled registered task. Host-side approval is recommended.', { id: z.string() }, async args => {
    const started = await call('run', { taskId: args.id }) as { jobId: string };
    const until = Date.now() + 122000;
    while (Date.now() < until) {
      const job = await call(`jobs?id=${encodeURIComponent(started.jobId)}`) as { status: string; result?: unknown; error?: string };
      if (job.status !== 'running') { if (job.error) throw new Error(job.error); return job; }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    return { jobId: started.jobId, status: 'running', message: 'Inspect the task in the GUI.' };
  }, false);
  await server.connect(new StdioServerTransport());
}
