import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import ignore from 'ignore';
import { accessiblePath, excluded, hash, projectPath } from './paths.js';
import type { Inventory, PackageFact } from './types.js';
import type { Store } from './store.js';
import { artifactType } from './artifacts.js';

export function git(root: string, args: string[]): string | null {
  try {
    const output = execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return args.includes('-z') ? output : output.trim();
  }
  catch { return null; }
}

export function branch(root: string): string {
  return git(root, ['symbolic-ref', '--short', 'HEAD']) ?? (git(root, ['rev-parse', '--short', 'HEAD']) ? `detached:${git(root, ['rev-parse', '--short', 'HEAD'])}` : 'workspace');
}

function filesIn(root: string, limit: number): { paths: string[]; truncated: boolean } {
  const generated = new Set<string>();
  if (existsSync(join(root, 'package.json'))) { generated.add('dist'); generated.add('build'); }
  if (existsSync(join(root, 'pom.xml')) || existsSync(join(root, 'Cargo.toml'))) generated.add('target');
  if (existsSync(join(root, 'build.gradle')) || existsSync(join(root, 'build.gradle.kts'))) generated.add('build');
  const omitted = (path: string): boolean => excluded(path) || generated.has(path.replaceAll('\\', '/').split('/')[0]!);
  const listed = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  if (listed !== null) {
    const paths = [...new Set(listed.split('\0').filter(p => p && !omitted(p)))].sort();
    return { paths: paths.slice(0, limit), truncated: paths.length > limit };
  }
  const rules = ignore();
  if (existsSync(join(root, '.gitignore'))) rules.add(readFileSync(join(root, '.gitignore'), 'utf8'));
  const paths: string[] = [];
  let truncated = false;
  function walk(directory: string, inherited: { base: string; matcher: ReturnType<typeof ignore> }[]): void {
    const nestedIgnore = join(directory, '.gitignore');
    const active = directory !== root && existsSync(nestedIgnore) && !lstatSync(nestedIgnore).isSymbolicLink()
      ? [...inherited, { base: directory, matcher: ignore().add(readFileSync(nestedIgnore, 'utf8')) }] : inherited;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(directory, entry.name);
      const path = relative(root, full).replaceAll('\\', '/');
      if (omitted(path) || entry.isSymbolicLink() || active.some(rule => rule.matcher.ignores(relative(rule.base, full).replaceAll('\\', '/') + (entry.isDirectory() ? '/' : '')))) continue;
      if (paths.length >= limit) { truncated = true; return; }
      if (entry.isDirectory()) walk(full, active);
      else if (entry.isFile()) paths.push(path);
      if (truncated) return;
    }
  }
  walk(root, [{ base: root, matcher: rules }]);
  return { paths, truncated };
}

function packageFact(root: string, path: string): PackageFact | null {
  try {
    const manifest = JSON.parse(readFileSync(projectPath(root, path), 'utf8')) as Record<string, unknown>;
    const strings = (value: unknown): Record<string, string> => value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
    const dependencies = { ...strings(manifest.dependencies), ...strings(manifest.devDependencies) };
    const known = ['react', 'vue', 'svelte', 'next', 'vite', 'typescript', 'fastify', 'express', 'astro', 'phaser'];
    const directory = join(root, path, '..');
    const declared = typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : undefined;
    let manager: PackageFact['manager'] = 'npm';
    let cursor = directory;
    while (true) {
      let hint = cursor === directory ? declared : undefined;
      if (cursor !== directory && existsSync(join(cursor, 'package.json'))) {
        try { hint = String(JSON.parse(readFileSync(join(cursor, 'package.json'), 'utf8')).packageManager ?? '').split('@')[0]; } catch { /* malformed ancestor manifest */ }
      }
      if (['npm', 'pnpm', 'yarn', 'bun'].includes(hint ?? '')) { manager = hint as PackageFact['manager']; break; }
      if (existsSync(join(cursor, 'pnpm-lock.yaml'))) { manager = 'pnpm'; break; }
      if (existsSync(join(cursor, 'yarn.lock'))) { manager = 'yarn'; break; }
      if (existsSync(join(cursor, 'bun.lock')) || existsSync(join(cursor, 'bun.lockb'))) { manager = 'bun'; break; }
      if (existsSync(join(cursor, 'package-lock.json')) || cursor === root) break;
      cursor = dirname(cursor);
    }
    return { path, name: typeof manifest.name === 'string' ? manifest.name : basename(directory), technologies: known.filter(name => name in dependencies), scripts: strings(manifest.scripts), manager };
  } catch { return null; }
}

export function inspect(root: string, previous?: Inventory): Inventory {
  root = realpathSync(root);
  const listing = filesIn(root, 5000);
  const files: Inventory['files'] = [];
  const packages: PackageFact[] = [];
  const instructions: Inventory['instructions'] = [];
  let truncated = listing.truncated;
  let totalBytes = 0;
  for (const path of listing.paths) {
    try {
      const full = projectPath(root, path);
      const stat = lstatSync(full);
      if (!stat.isFile()) continue;
      if (stat.size > 16 * 1024 * 1024 || totalBytes + stat.size > 64 * 1024 * 1024) {
        truncated = true;
        files.push({ path, hash: `metadata:${stat.size}:${stat.mtimeMs}`, bytes: stat.size, ...artifactType(path, true) });
        continue;
      }
      const content = readFileSync(full);
      totalBytes += content.length;
      const binary = content.includes(0) || /\.(png|jpe?g|webp|gif|pdf|fig|sketch|psd|blend|ai|zip|woff2?)$/i.test(path);
      files.push({ path, hash: hash(content), bytes: content.length, ...artifactType(path, binary) });
      if (binary) continue;
      if (basename(path) === 'package.json') {
        const fact = packageFact(root, path);
        if (fact) packages.push(fact);
      }
      if (basename(path) === 'AGENTS.md' && instructions.length < 12) instructions.push({ path, text: content.toString('utf8').slice(0, 12000) });
    } catch { /* Deleted, unreadable, or excluded files are not evidence. */ }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const old = new Map(previous?.files.map(f => [f.path, f.hash]) ?? []);
  const current = new Set(files.map(f => f.path));
  const markers = files.filter(f => /(?:^|\/)(?:pyproject\.toml|requirements\.txt|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|Makefile|Dockerfile|compose\.ya?ml)$/.test(f.path)).map(f => f.path);
  return {
    root, branch: branch(root), head: git(root, ['rev-parse', 'HEAD']),
    fingerprint: hash(files.map(f => `${f.path}\0${f.hash}`).join('\n')),
    files, packages, markers, instructions,
    changed: files.filter(f => old.get(f.path) !== f.hash).map(f => f.path),
    removed: previous && !truncated ? previous.files.filter(f => !current.has(f.path)).map(f => f.path) : [],
    truncated, scannedAt: new Date().toISOString(),
  };
}

export function adopt(store: Store): Inventory {
  const scope = branch(store.root);
  const value = inspect(store.root, store.inventory(scope));
  store.saveInventory(value);
  return value;
}

export function inventorySummary(value: Inventory): string {
  const packages = value.packages.map(p => `- ${p.path}: ${p.technologies.join(', ') || 'JavaScript/Node'}; ${p.manager}; scripts: ${Object.keys(p.scripts).join(', ') || 'none'}`);
  return [
    `Workspace: ${value.root}`, `Scope: ${value.branch}`, `Indexed: ${value.files.length} artifacts${value.truncated ? ' (partial content scan)' : ''}`,
    ...packages, ...value.markers.map(m => `- Detected manifest: ${m}`),
    `Changes since previous scan: ${value.changed.length}; removed: ${value.removed.length}`,
    'Script detection is not proof of a successful run. Existing implementation does not imply historical user approval.',
  ].join('\n');
}

export function readProjectFile(root: string, path: string, startLine = 1, maxLines = 200): { content: string; hash: string; totalLines: number; truncated: boolean; startLine: number } {
  const full = accessiblePath(root, path);
  if (statSync(full).size > 256 * 1024) throw new Error('File exceeds the 256 KiB read limit.');
  const bytes = readFileSync(full);
  if (bytes.includes(0)) throw new Error('Binary files are not supported.');
  const lines = bytes.toString('utf8').split('\n');
  const start = Math.max(1, Math.floor(startLine));
  const count = Math.min(500, Math.max(1, Math.floor(maxLines)));
  const selected = lines.slice(start - 1, start - 1 + count).join('\n');
  return { content: selected.slice(0, 20000), hash: hash(bytes), totalLines: lines.length, startLine: start, truncated: start > 1 || start - 1 + count < lines.length || selected.length > 20000 };
}
