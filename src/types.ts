import { z } from 'zod';

export const decisionInput = z.object({
  statement: z.string().trim().min(1).max(2000),
  area: z.string().trim().min(1).max(200).default('project'),
});

export type Decision = {
  id: string;
  scope: string;
  area: string;
  statement: string;
  status: 'proposed' | 'accepted' | 'superseded';
  authority: 'agent_proposal' | 'user_explicit';
  source_id: string | null;
  created_at: string;
};

export type FileFact = { path: string; hash: string; bytes: number };
export type PackageFact = {
  path: string;
  name: string;
  technologies: string[];
  scripts: Record<string, string>;
  manager: 'npm' | 'pnpm' | 'yarn' | 'bun';
};
export type Inventory = {
  root: string;
  branch: string;
  head: string | null;
  fingerprint: string;
  files: FileFact[];
  packages: PackageFact[];
  markers: string[];
  instructions: { path: string; text: string }[];
  changed: string[];
  removed: string[];
  truncated: boolean;
  scannedAt: string;
};

export type CommandResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  truncated: boolean;
};
