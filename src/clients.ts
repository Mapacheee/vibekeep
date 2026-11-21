import spawn from 'cross-spawn';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { acquireLock } from './lock.js';

export const chatClients = ['codex', 'claude', 'opencode', 'antigravity'] as const;
export type ChatClient = typeof chatClients[number];
export type ConfigFormat = ChatClient | 'opencode-v1';
type StdioServer = { command: string; args: string[]; env?: Record<string, string> };
const cli = fileURLToPath(new URL('./cli.js', import.meta.url));

export function configFormat(name: unknown): ConfigFormat {
  if (name === 'opencode-v1') return name;
  const client = chatClients.find(item => item === name);
  if (!client) throw new Error('Choose a client: ' + chatClients.join(', ') + '.');
  return client;
}

export function workspaceServer(root: string): StdioServer {
  return { command: process.execPath, args: [cli, 'mcp', '--cwd', root] };
}

function configEntry(format: ConfigFormat, server: StdioServer) {
  if (format === 'opencode' || format === 'opencode-v1') {
    return { path: format === 'opencode' ? ['mcp', 'servers', 'vibekeep'] : ['mcp', 'vibekeep'],
      value: { type: 'local', command: [server.command, ...server.args], ...(server.env && { environment: server.env }) } };
  }
  return { path: ['mcpServers', 'vibekeep'], value: server };
}

export function formatConfig(format: ConfigFormat, server: StdioServer): string {
  if (format === 'codex') {
    const lines = ['[mcp_servers.vibekeep]', 'command = ' + JSON.stringify(server.command), 'args = ' + JSON.stringify(server.args)];
    if (server.env) lines.push('', '[mcp_servers.vibekeep.env]', ...Object.entries(server.env).map(([key, value]) => key + ' = ' + JSON.stringify(value)));
    return lines.join('\n');
  }
  const { path, value } = configEntry(format, server);
  const content = path.reduceRight<object>((child, key) => ({ [key]: child }), value);
  return JSON.stringify(content, null, 2);
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function regularPath(path: string, directory = false) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && !(directory ? stat.isDirectory() : stat.isFile())) throw new Error('Expected a regular ' + (directory ? 'directory' : 'file') + ' at ' + path);
  return stat;
}

/** Preserve the rest of the host config, including JSONC comments and per-server preferences. */
export function installWorkspaceConfig(root: string, format: 'antigravity' | 'opencode' | 'opencode-v1') {
  const candidates = ['.opencode/opencode.jsonc', '.opencode/opencode.json', 'opencode.jsonc', 'opencode.json'];
  const file = format === 'antigravity' ? join(root, '.agents', 'mcp_config.json') :
    join(root, candidates.find(name => existsSync(join(root, name))) ?? 'opencode.jsonc');
  const parent = dirname(file);
  regularPath(parent, true);
  mkdirSync(parent, { recursive: true });
  const release = acquireLock(parent, basename(file) + '.vibekeep-lock');
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    const stat = regularPath(file);
    const original = stat ? readFileSync(file, 'utf8') : '{}\n';
    const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
    const raw = original.slice(bom.length);
    const errors: ParseError[] = [];
    const allowComments = format !== 'antigravity';
    const config: unknown = parse(raw, errors, { disallowComments: !allowComments, allowTrailingComma: allowComments });
    if (errors.length || !object(config)) throw new Error('Invalid configuration in ' + file);
    const entry = configEntry(format, workspaceServer(root));
    let current: unknown = config;
    for (const key of entry.path) {
      if (current === undefined) break;
      if (!object(current)) throw new Error('Invalid MCP configuration in ' + file);
      current = current[key];
    }
    if (current !== undefined) {
      if (object(current) && Object.entries(entry.value).every(([key, value]) => isDeepStrictEqual(current[key], value))) return file;
      throw new Error('The vibekeep entry in ' + file + ' already has different settings. Review it with vibekeep config ' + format + '.');
    }
    const edits = modify(raw, entry.path, entry.value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: raw.includes('\r\n') ? '\r\n' : '\n' } });
    writeFileSync(temp, bom + applyEdits(raw, edits), { flag: 'wx', mode: stat ? stat.mode & 0o777 : 0o600 });
    if (stat ? readFileSync(file, 'utf8') !== original : existsSync(file)) throw new Error('Configuration changed during setup. Retry.');
    renameSync(temp, file);
    return file;
  } finally {
    try { if (existsSync(temp)) unlinkSync(temp); } finally { release(); }
  }
}

export async function openClient(name: string | undefined, root: string): Promise<number> {
  const client = chatClients.find(item => item === name);
  if (!client) throw new Error('Choose a client: ' + chatClients.join(', ') + '.');
  const binary = client === 'antigravity' ? 'agy' : client;
  const server = workspaceServer(root);
  let args: string[] = [];
  if (client === 'codex') {
    args = ['-c', 'mcp_servers.vibekeep.command=' + JSON.stringify(server.command), '-c', 'mcp_servers.vibekeep.args=' + JSON.stringify(server.args)];
  } else if (client === 'claude') {
    args = ['--mcp-config', JSON.stringify({ mcpServers: { vibekeep: server } })];
  } else {
    const probe = spawn.sync(binary, client === 'opencode' ? ['--version'] : ['mcp', '--help'], { cwd: root, encoding: 'utf8', timeout: 15000 });
    if (probe.error) throw launchError(binary, probe.error);
    if (probe.status !== 0) throw new Error('Could not start ' + binary + '. ' + probe.stderr.trim());
    const format = client === 'opencode' && /(?:^|\s)v?1\./.test(probe.stdout) ? 'opencode-v1' : client;
    installWorkspaceConfig(root, format);
  }
  const child = spawn(binary, args, { cwd: root, stdio: 'inherit' });
  return new Promise((done, fail) => {
    child.once('error', error => fail(launchError(binary, error)));
    child.once('exit', code => done(code ?? 1));
  });
}

function launchError(binary: string, error: NodeJS.ErrnoException) {
  return error.code === 'ENOENT' ? new Error('Install ' + binary + ' and make it available on PATH before launching this client.') : error;
}
