import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import ignore from 'ignore';

const excludedDirectories = new Set([
  '.git', '.vibe', 'node_modules', 'dist', 'build', 'coverage', '.next',
  '.venv', 'venv', '__pycache__', 'vendor', 'target', '.cache',
]);
const privateNames = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\..*)?|id_(?:rsa|ed25519)(?:\..*)?)$/i;
const privateExtensions = /\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|log)$/i;

export function excluded(path: string): boolean {
  const parts = path.replaceAll('\\', '/').split('/');
  return parts.some(p => excludedDirectories.has(p.toLowerCase())) || parts.some(p => privateNames.test(p)) || privateExtensions.test(path);
}

export function hash(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Reject lexical escapes and existing symlinks, including symlinked parent directories. */
export function projectPath(root: string, input: string): string {
  if (!input || input.includes('\0') || input.includes(':') || isAbsolute(input)) {
    throw new Error('Use a relative project path.');
  }
  const absoluteRoot = realpathSync(root);
  const target = resolve(absoluteRoot, input);
  const rel = relative(absoluteRoot, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || excluded(rel)) {
    throw new Error(`Path is outside the editable project or is excluded: ${input}`);
  }
  let cursor = target;
  while (cursor !== absoluteRoot) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`Symlink access is excluded: ${input}`);
    cursor = dirname(cursor);
  }
  return target;
}

/** File tools also honor Git exclusions, even for paths suggested directly by the model. */
export function accessiblePath(root: string, input: string): string {
  const target = projectPath(root, input);
  const check = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--', input], { timeout: 5000, windowsHide: true, stdio: 'ignore' });
  if (check.status === 0) throw new Error(`File is ignored by this project: ${input}`);
  if (check.status !== 1) {
    const parts = relative(realpathSync(root), target).replaceAll('\\', '/').split('/');
    for (let depth = 0; depth < parts.length; depth++) {
      const ignoreFile = resolve(root, ...parts.slice(0, depth), '.gitignore');
      if (existsSync(ignoreFile) && !lstatSync(ignoreFile).isSymbolicLink()) {
        const rules = ignore().add(readFileSync(ignoreFile, 'utf8'));
        if (rules.ignores(parts.slice(depth).join('/'))) throw new Error(`File is ignored by this project: ${input}`);
      }
    }
  }
  return target;
}
