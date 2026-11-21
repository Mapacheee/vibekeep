#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Agent, configuredModel } from './agent.js';
import { Executor } from './execution.js';
import { acquireLock } from './lock.js';
import { adopt, branch, inventorySummary } from './repo.js';
import { Store } from './store.js';
import type { Decision } from './types.js';

const HELP = `VibeKeep 0.2.0 — Build freely. Keep the context.

Usage: vibekeep [command] [text] [--cwd <project>] [--json]

  (no command), ui [path]    Open the local graphical workspace (--port <number>)
  chat [path]                Open the terminal chat; initialize automatically
  mcp [path]                 Start an MCP memory/resource server for an external host
  open <client>              Open claude, opencode, antigravity or codex in this project
  config <client>            Print the client's workspace MCP settings
  team [help]                Coordinate separate chats and working copies
  tasks                      List actual workspace tasks and availability
  task <id>                  Run a registered task (--allow-tasks for MCP execution)
  init [path], adopt [path] Inspect an existing or empty project; never run code
  status                    Rescan files and show detected stack and changes
  remember <text>            Save an explicit accepted decision (--area <name>)
  memory [query]            Search current decisions on this branch
  accept <id>               Accept a proposed decision (--supersedes <id>)
  ask <prompt>              Run one agent turn (requires configured model)
  changes                   List VibeKeep file changes and their current state
  checks                    Show script results and whether the code still matches
  undo                      Undo the most recent own write if unchanged
  run <script>              Run a declared npm script (--package <manifest>)
  export                    Print portable decision memory as JSON
  import <file>             Import same-project memory, rejecting conflicts

Options: --cwd <path>, --json, --allow-scripts, --allow-tasks, --allow-writes,
         --port <number>, --help, --version
Chat: /help /status /memory [query] /remember <text> /accept <id>
      /changes /checks /undo /run <script> /exit

Model configuration (environment variables):
  VIBEKEEP_PROVIDER=compatible|anthropic
  VIBEKEEP_MODEL=<tool-capable model id>
  VIBEKEEP_BASE_URL=<compatible endpoint>  (compatible provider)
  VIBEKEEP_API_KEY=<private key>           (required for Anthropic)

No model is needed to adopt projects, inspect files, or manage memory.
--allow-scripts authorizes declared npm scripts to execute local project code.
`;

function memoryText(decisions: Decision[]): string {
  return decisions.length ? decisions.map(d => `[${d.status}] ${d.statement}\n  ${d.id} · ${d.area}`).join('\n') : 'No decisions recorded on this branch.';
}

async function main(): Promise<void> {
  const args = parseArgs({ allowPositionals: true, options: {
    cwd: { type: 'string' }, json: { type: 'boolean' }, area: { type: 'string' },
    supersedes: { type: 'string' }, package: { type: 'string' },
    'allow-scripts': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    'allow-tasks': { type: 'boolean' }, 'allow-writes': { type: 'boolean' }, port: { type: 'string' },
    connect: { type: 'string' },
  } });
  if (args.values.help) { console.log(HELP); return; }
  if (args.values.version) { console.log('0.2.0'); return; }
  const command = args.positionals[0] ?? 'ui';
  const known = ['ui', 'mcp', 'open', 'config', 'team', 'tasks', 'task', 'chat', 'init', 'adopt', 'status', 'remember', 'memory', 'accept', 'ask', 'changes', 'checks', 'undo', 'run', 'export', 'import'];
  if (!known.includes(command)) throw new Error(`Unknown command: ${command}. Run vibekeep --help.`);
  const positionalPath = ['ui', 'mcp', 'chat', 'init', 'adopt'].includes(command) ? args.positionals[1] : undefined;
  const root = realpathSync(resolve(args.values.cwd ?? positionalPath ?? process.cwd()));
  if (command === 'open' || command === 'config') {
    const { configFormat, formatConfig, openClient, workspaceServer } = await import('./clients.js');
    const client = args.positionals[1];
    if (command === 'open') process.exitCode = await openClient(client, root);
    else console.log(formatConfig(configFormat(client), workspaceServer(root)));
    return;
  }
  if (command === 'team') {
    const { teamCommand } = await import('./team-cli.js');
    return teamCommand(root, args.positionals.slice(1), args.values.port);
  }
  if (command === 'ui') {
    const { WebApplication } = await import('./server.js');
    const port = args.values.port === undefined ? 4317 : Number(args.values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535.');
    const application = new WebApplication(root);
    const url = await application.listen(port);
    console.log(`\nVibeKeep is running locally.\n\n  ${url}\n\nOpen this URL in your browser. Press Ctrl+C to stop the application and its servers.\n`);
    let stopping = false;
    const stop = async (): Promise<void> => { if (stopping) return; stopping = true; await application.close(); };
    process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
    return;
  }
  if (command === 'mcp') {
    if (args.values.connect) { const { startMcpProxy } = await import('./mcp-proxy.js'); await startMcpProxy(args.values.connect, process.env.VIBEKEEP_SERVICE_TOKEN ?? '', process.env.VIBEKEEP_WORKSPACE_ID ?? '', { writes: args.values['allow-writes'], tasks: args.values['allow-tasks'] }); }
    else { const { startMcp } = await import('./mcp.js'); await startMcp(root, { writes: args.values['allow-writes'], tasks: args.values['allow-tasks'] }); }
    return;
  }
  const store = new Store(root);
  let release: (() => void) | undefined;
  let readline: ReturnType<typeof createInterface> | undefined;
  try {
    release = acquireLock(store.local);
    const executor = new Executor(store);
    const tail = args.positionals.slice(1).join(' ').trim();
    const print = (data: unknown, human?: string): void => console.log(args.values.json ? JSON.stringify(data, null, 2) : human ?? (typeof data === 'string' ? data : JSON.stringify(data, null, 2)));
    const requireText = (): string => { if (!tail) throw new Error(`${command} requires an argument.`); return tail; };
    const getReadline = (): ReturnType<typeof createInterface> => readline ??= createInterface({ input: stdin, output: stdout });
    const approve = async (description: string): Promise<boolean> => {
      if (args.values['allow-scripts'] || command === 'run') return true;
      if (!stdin.isTTY) return false;
      const answer = await getReadline().question(`\n${description}\nRun this script? [y/N] `);
      return /^(?:y|yes)$/i.test(answer.trim());
    };
    if (command === 'tasks' || command === 'task') {
      const { LocalWorkspace } = await import('./workspace.js'); const workspace = new LocalWorkspace(store);
      try { if (command === 'tasks') print(workspace.tasks()); else print(await workspace.runTask(requireText(), async () => true)); }
      finally { await workspace.close(); }
    } else if (['init', 'adopt', 'status'].includes(command)) {
      const value = adopt(store);
      print(value, inventorySummary(value));
    } else if (command === 'remember') {
      const id = store.message('cli', branch(root), 'user', requireText());
      const value = store.remember({ statement: tail, area: args.values.area }, branch(root), 'user_explicit', id);
      print(value, `Remembered: ${value.statement}\n${value.id}`);
    } else if (command === 'memory') print(store.decisions(branch(root), tail), memoryText(store.decisions(branch(root), tail)));
    else if (command === 'accept') print(store.accept(requireText(), branch(root), args.values.supersedes));
    else if (command === 'changes') print(executor.changes());
    else if (command === 'checks') print(executor.checks());
    else if (command === 'undo') print({ path: executor.undo() });
    else if (command === 'export') console.log(JSON.stringify(store.export(), null, 2));
    else if (command === 'import') print({ imported: store.import(JSON.parse(readFileSync(resolve(requireText()), 'utf8'))) });
    else if (command === 'run') {
      const result = await executor.runScript(requireText(), args.values.package, 60000, approve);
      print(result, result.output + `\nExit: ${result.exitCode ?? 'unknown'}${result.timedOut ? ' (timeout)' : ''}`);
      if (result.exitCode !== 0 || result.timedOut) process.exitCode = 1;
    } else {
      const value = adopt(store);
      if (command === 'ask') {
        const agent = new Agent(store, configuredModel(), approve, message => { if (!args.values.json) console.error(message); });
        try { const result = await agent.turn(requireText()); print(result, result.text); }
        finally { await agent.workspace.close(); }
        return;
      }
      if (!stdin.isTTY) throw new Error('Interactive chat requires a terminal. Use vibekeep ask "..." or memory commands for non-interactive use.');
      console.log(`\nVibeKeep — ${store.project.name}\n${inventorySummary(value)}\n\nType normally to build, or /help for commands. /exit to leave.\n`);
      if (store.pending().length) console.log('Some previous actions have uncertain results. Inspect `status` and `changes`; they will not replay automatically.\n');
      let agent: Agent | undefined;
      try { agent = new Agent(store, configuredModel(), approve, message => console.log(message)); }
      catch (error) { console.log(`${(error as Error).message}\n`); }
      const rl = getReadline();
      let interrupted = false;
      let active: AbortController | undefined;
      rl.on('SIGINT', () => { if (active) active.abort(); else { interrupted = true; rl.close(); } });
      while (!interrupted) {
        let line: string;
        try { line = (await rl.question('You › ')).trim(); } catch { break; }
        if (!line) continue;
        if (line === '/exit' || line === '/quit') break;
        try {
          const argument = line.slice(line.indexOf(' ') + 1).trim();
          if (line === '/help') console.log(HELP);
          else if (line === '/status') console.log(inventorySummary(adopt(store)));
          else if (line === '/memory' || line.startsWith('/memory ')) console.log(memoryText(store.decisions(branch(root), line === '/memory' ? '' : argument)));
          else if (line.startsWith('/remember ')) {
            const sourceId = store.message('cli', branch(root), 'user', argument);
            console.log(memoryText([store.remember({ statement: argument }, branch(root), 'user_explicit', sourceId)]));
          } else if (line.startsWith('/accept ')) console.log(memoryText([store.accept(argument, branch(root))]));
          else if (line === '/changes') console.log(JSON.stringify(executor.changes(), null, 2));
          else if (line === '/checks') console.log(JSON.stringify(executor.checks(), null, 2));
          else if (line === '/undo') console.log(`Restored: ${executor.undo()}`);
          else if (line.startsWith('/run ')) console.log(await executor.runScript(argument, 'package.json', 60000, async () => true));
          else if (line.startsWith('/')) console.log('Unknown command. Type /help.');
          else if (!agent) console.log('Configure a model and restart to chat. You can still use /remember, /memory, and /status.');
          else {
            active = new AbortController();
            const result = await agent.turn(line, active.signal);
            console.log(`\nVibeKeep › ${result.text}\n`);
          }
        } catch (error) { console.error(`VibeKeep: ${(error as Error).message}`); }
        finally { active = undefined; }
      }
      await agent?.workspace.close();
    }
  } finally { readline?.close(); release?.(); store.close(); }
}

main().catch(error => { console.error(`VibeKeep: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
