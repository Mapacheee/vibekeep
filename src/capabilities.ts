import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { hash, projectPath } from './paths.js';
import type { Inventory } from './types.js';

export const taskSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/), label: z.string().min(1).max(200),
  command: z.string().min(1).max(1000), args: z.array(z.string().max(4000)).max(300).default([]),
  cwd: z.string().max(1000).default('.'), mode: z.enum(['check', 'action', 'server']).default('check'),
  previewUrl: z.string().url().optional(),
});
export type TaskDefinition = z.infer<typeof taskSchema>;
export type CapabilityTask = TaskDefinition & { provider: string; available: boolean; reason?: string; signature: string; details?: string; inputSchema?: Record<string, unknown>; description?: string; recovery?: string };

export function executableAvailable(command: string): boolean {
  if (isAbsolute(command)) return existsSync(command);
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.com'] : [''];
  return (process.env.PATH ?? '').split(delimiter).some(directory => extensions.some(extension => existsSync(join(directory, command + extension))));
}

export function npmCommand(): { command: string; prefix: string[] } {
  const directory = dirname(process.execPath);
  const candidates = [process.env.npm_execpath?.endsWith('npm-cli.js') ? process.env.npm_execpath : '',
    resolve(directory, 'node_modules/npm/bin/npm-cli.js'), resolve(directory, '../lib/node_modules/npm/bin/npm-cli.js'),
    resolve(directory, '../share/nodejs/npm/bin/npm-cli.js'), resolve(directory, '../share/npm/bin/npm-cli.js')];
  const cli = candidates.find(path => path && existsSync(path));
  return cli ? { command: process.execPath, prefix: [cli] } : { command: 'npm', prefix: [] };
}

export function localTaskDirectory(root: string, cwd: string): string {
  if (cwd === '.') return realpathSync(root);
  // Resolve a child without granting access to a different workspace.
  return realpathSync(projectPath(root, cwd));
}

export function discoverTasks(inventory: Inventory): CapabilityTask[] {
  const tasks: CapabilityTask[] = [];
  const add = (value: TaskDefinition, provider: string, reason?: string, definitionRevision = '', details?: string): void => {
    const task = taskSchema.parse(value);
    const available = !reason && executableAvailable(task.command);
    tasks.push({ ...task, provider, available, details, reason: reason ?? (available ? undefined : `Executable not found: ${task.command}`), signature: hash(JSON.stringify(task) + definitionRevision) });
  };
  for (const pkg of inventory.packages) {
    const cwd = dirname(pkg.path).replaceAll('\\', '/');
    const npm = npmCommand();
    for (const script of Object.keys(pkg.scripts).filter(name => /^[\w:.-]+$/.test(name))) {
      const command = pkg.manager === 'npm' ? npm.command : pkg.manager;
      const args = pkg.manager === 'npm' ? [...npm.prefix, 'run', script] : ['run', script];
      const mode = /^(dev|start|serve)(:|$)/.test(script) ? 'server' : /test|check|lint|build|verify/.test(script) ? 'check' : 'action';
      const details = [`pre${script}`, script, `post${script}`].filter(name => name in pkg.scripts).map(name => `${name}: ${pkg.scripts[name]}`).join('\n');
      add({ id: `package:${pkg.path}:${script}`, label: `${pkg.name}: ${script}`, command, args, cwd, mode }, pkg.manager, undefined, inventory.files.find(file => file.path === pkg.path)?.hash, details);
    }
  }
  const paths = new Set(inventory.files.map(file => file.path));
  for (const file of inventory.files) {
    const name = basename(file.path);
    const cwd = dirname(file.path).replaceAll('\\', '/');
    const at = (path: string): string => cwd === '.' ? path : `${cwd}/${path}`;
    if (name === 'pom.xml') {
      const wrapper = at(process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
      const command = paths.has(wrapper) ? resolve(inventory.root, wrapper) : 'mvn';
      for (const goal of ['test', 'verify', 'package']) add({ id: `maven:${file.path}:${goal}`, label: `Maven: ${goal}`, command, args: [goal], cwd, mode: 'check' }, 'maven', !executableAvailable('java') ? 'A JDK is required.' : undefined);
    }
    if (name === 'build.gradle' || name === 'build.gradle.kts') {
      const wrapper = at(process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
      const command = paths.has(wrapper) ? resolve(inventory.root, wrapper) : 'gradle';
      for (const goal of ['test', 'build']) add({ id: `gradle:${file.path}:${goal}`, label: `Gradle: ${goal}`, command, args: [goal, '--console=plain'], cwd, mode: 'check' }, 'gradle', !executableAvailable('java') ? 'A JDK is required.' : undefined);
    }
    if (name === 'Cargo.toml') for (const goal of ['check', 'test', 'build']) add({ id: `cargo:${file.path}:${goal}`, label: `Cargo: ${goal}`, command: 'cargo', args: [goal], cwd, mode: 'check' }, 'cargo');
    if (name === 'go.mod') add({ id: `go:${file.path}:test`, label: 'Go: test', command: 'go', args: ['test', './...'], cwd, mode: 'check' }, 'go');
    if (name === 'pyproject.toml' || name === 'pytest.ini') add({ id: `python:${file.path}:test`, label: 'Python: pytest', command: process.platform === 'win32' ? 'python' : 'python3', args: ['-m', 'pytest'], cwd, mode: 'check' }, 'python');
  }
  const java = inventory.files.filter(file => file.path.endsWith('.java'));
  if (java.length && java.length <= 200 && !tasks.some(task => ['maven', 'gradle'].includes(task.provider))) {
    add({ id: 'java:compile', label: 'Java: compile sources', command: 'javac', args: ['-d', '.vibe/local/java-classes', ...java.map(file => file.path)], cwd: '.', mode: 'check' }, 'java');
    for (const file of java) {
      try {
        const content = readFileSync(projectPath(inventory.root, file.path), 'utf8');
        if (!/static\s+void\s+main\s*\(/.test(content)) continue;
        const pkg = content.match(/\bpackage\s+([\w.]+)\s*;/)?.[1];
        const name = `${pkg ? `${pkg}.` : ''}${basename(file.path, '.java')}`;
        add({ id: `java:run:${name}`, label: `Java: run ${name} (compile first)`, command: 'java', args: ['-cp', '.vibe/local/java-classes', name], cwd: '.', mode: 'action' }, 'java');
      } catch { /* unavailable source */ }
    }
  }
  const config = join(inventory.root, '.vibe', 'tasks.json');
  if (existsSync(config)) {
    if (lstatSync(config).isSymbolicLink()) throw new Error('Task configuration cannot be a symlink.');
    const data = z.object({ version: z.literal(1), tasks: z.array(taskSchema).max(100) }).parse(JSON.parse(readFileSync(config, 'utf8')));
    for (const task of data.tasks) {
      localTaskDirectory(inventory.root, task.cwd);
      add({ ...task, id: `custom:${task.id}` }, 'custom');
    }
  }
  return tasks;
}
