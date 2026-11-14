# VibeKeep

**Build freely. Keep the context.**

A vibe coding framework with a terminal chat and local project memory. Talk, change your mind, and keep building; VibeKeep preserves decisions and records its changes.

This is the first working release, **0.1.0**. It can adopt an existing repository, chat with a model, read and edit files, run authorized npm scripts, and restore memory in another session. You do not need to write a specification to get started.

## Getting started

Requirements: **Node.js 24.13 or later**, npm, and Git for repository features. The stack has been tested locally with Node 24.19 on Windows, with CI on Windows and Linux. Use a compatible LTS release.

```bash
git clone https://github.com/Mapacheee/vibekeep.git
cd vibekeep
npm ci
npm run build
```

Inspect another project without configuring a model or making network requests:

```bash
node dist/src/cli.js adopt /path/to/your/project
node dist/src/cli.js remember "Keep the current navigation" --cwd /path/to/your/project --area ui.navigation
node dist/src/cli.js memory navigation --cwd /path/to/your/project
```

On Windows, quote paths when needed, for example `"C:\projects\my-app"`.

To make the command available from any directory, optionally run `npm link` inside this repository. Then enter your project directory and run:

```bash
vibekeep
```

Without a global installation, open the same chat with:

```bash
node dist/src/cli.js --cwd /path/to/your/project
```

## Model configuration

The chat uses the provider you configure. It needs a model with **tool calling** to edit files and use tools. Memory, repository adoption, and local commands work without a model.

### Compatible endpoint, including a local server

PowerShell:

```powershell
$env:VIBEKEEP_PROVIDER = "compatible"
$env:VIBEKEEP_BASE_URL = "http://localhost:1234/v1"
$env:VIBEKEEP_MODEL = "your-tool-capable-model-id"
# Only if your provider requires authentication:
$env:VIBEKEEP_API_KEY = "your-key"
node dist/src/cli.js --cwd "C:\projects\my-app"
```

macOS/Linux:

```bash
export VIBEKEEP_PROVIDER=compatible
export VIBEKEEP_BASE_URL=http://localhost:1234/v1
export VIBEKEEP_MODEL=your-tool-capable-model-id
# export VIBEKEEP_API_KEY=your-key
node dist/src/cli.js --cwd /path/to/your/project
```

This endpoint is a configuration example: VibeKeep does not install or start that model server. For a remote provider, use its endpoint and credentials.

### Anthropic

Set `VIBEKEEP_PROVIDER=anthropic`, `VIBEKEEP_MODEL` to the model ID, and `VIBEKEEP_API_KEY` to your key. `VIBEKEEP_BASE_URL` is not used in this mode.

You can also load a private environment file through Node:

```bash
node --env-file=/private/path/vibekeep.env dist/src/cli.js --cwd /path/to/project
```

VibeKeep does not automatically load the application's `.env` file or store provider keys in memory. Selected project context is sent to your configured provider. Agent responses, generated documentation, and decision summaries use English.

## Example session

```text
You › Review this application and add a favorites button.
→ list_files
→ read_file
→ edit_file
VibeKeep › I added the button. I can run the verification script…

You › I like the light theme; keep it for mobile.
→ propose_decision

You › /memory
[proposed] Keep the light theme for mobile
  <full-id> · ui.mobile

You › /accept <full-id>
You › /changes
You › /undo
You › /exit
```

This dialogue is illustrative; tool selection depends on the model. When you return, VibeKeep rebuilds context from decisions and recent messages on the same branch, then inspects the code again.

The agent can propose memories automatically with a quote from the current message. In this version, **accepting** a decision is an explicit action through `/accept` or `/remember`; the model cannot claim your confirmation. Proposals remain available as provisional context without requiring you to resolve them before continuing.

## Commands

| Command | Purpose |
|---|---|
| `vibekeep` or `vibekeep chat [path]` | Initialize if needed and open the chat. |
| `vibekeep init [path]` / `vibekeep adopt [path]` | Inspect and save an inventory without installing or running the project. |
| `vibekeep status` | Detect the stack and changes since the previous inspection. |
| `vibekeep remember "text" --area ui.theme` | Record an explicitly accepted decision. |
| `vibekeep memory [query]` | Search current decisions on this branch. |
| `vibekeep accept <id> --supersedes <previous-id>` | Accept a proposal and optionally replace another decision. |
| `vibekeep ask "request"` | Run one turn without opening an interactive chat. |
| `vibekeep changes` | List recorded file writes and whether their contents still match. |
| `vibekeep undo` | Revert the most recent own write if the file still matches. |
| `vibekeep run test` | Explicitly run the npm `test` script. |
| `vibekeep checks` | Show script results and whether they still match the current code. |
| `vibekeep export` | Print decision memory as JSON, without the conversation. |
| `vibekeep import memory.json` | Import same-project memory without duplicating IDs. |

All commands accept `--cwd <path>`. `--json` produces structured output for non-interactive commands. `--help` lists all options.

Inside the chat: `/status`, `/memory [query]`, `/remember <text>`, `/accept <id>`, `/changes`, `/checks`, `/undo`, `/run <script>`, `/help`, and `/exit`. The chat and CLI use the same data.

## Execution and files

- Adoption reads project files and writes metadata only inside `.vibe/`.
- Exclusions cover `.git`, `.vibe`, dependencies, generated output, `.env` files, recognized key extensions, databases, and logs. This is not a universal secret detector: review project contents before using a remote provider.
- Git repositories respect Git exclusions, including direct file reads. Without Git, root and nested `.gitignore` files are applied conservatively: nested rules cannot override an ancestor's exclusion.
- Symlinks are skipped. Inventory limits are 5,000 text files, 256 KiB per file, and 32 MiB in total. Partial scans are identified.
- Model file reads are paginated. Edits require the current file hash and save previous contents; partial replacements require a unique match.
- `/undo` reverts one write at a time and stops if later edits are detected. It does not reverse script effects, databases, or external services. Preconditions reduce conflicts but do not lock other editors at the filesystem level.
- Scripts run with local user permissions. VibeKeep is not a sandbox. The agent requests authorization before running scripts; `--allow-scripts` authorizes them for the session. `vibekeep run` and `/run` are explicit execution requests.
- Scripts have time and output limits. **The process is stopped when its time limit expires**: this version does not manage persistent development servers. Start the server in another terminal to preview changes while chatting.
- Other package managers are detected, but automatic execution initially supports npm. VibeKeep does not replace lockfiles or automatically install dependencies.

## Memory and privacy

```text
your-project/
  .vibe/
    project.json          # Project identity
    .gitignore            # Excludes local/ from Git
    local/
      memory.sqlite       # Conversation, decisions, inventory, and action journal
      session.lock        # Prevents simultaneous CLI writers
```

The database uses SQLite with WAL and FTS5. Decisions are scoped by branch, with explicit provenance and authority. Superseded decisions retain their history and are omitted from current retrieval. Script results are linked to the inventory fingerprint; `checks` marks them out of date when that fingerprint changes.

Local data is **not encrypted**. Excluding `local/` prevents its normal inclusion in Git; preserve those exclusion rules. Do not copy an active SQLite database as an isolated file. To share decisions, use `export`, review its contents, and save the result outside `local/`. Imports require the same project identity and do not resolve semantic divergence between shared decisions.

After an interruption, uncertain actions remain visible and are not replayed automatically. This version does not yet reconcile all their effects automatically. Independent worktrees have separate local stores; coordination between them is planned.

## Development and verification

```bash
npm ci
npm run check
npm test
npm start -- --help
```

Tests use temporary repositories and files, real SQLite memory, and a simulated provider transport to exercise the tool loop without keys, API usage, or external connections. Coverage includes persistence, branch isolation, import, decision replacement, script failures, stale evidence, and preserving later edits during undo. The symlink test is skipped when the environment cannot create symlinks.

A real-provider chat needs a manual test with your credentials; simulated tests do not evaluate model quality.

See [the architecture](docs/architecture.md) and [the roadmap](docs/roadmap.md) for implemented features and upcoming work. No npm package has been published.
