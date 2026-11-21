# VibeKeep

VibeKeep gives AI chats a persistent memory for each project. Open your usual coding assistant in a project folder, record a decision, and pick it up in the next chat. Teammates using different assistants can share decisions, see overlapping work, and leave each other handoffs.

VibeKeep works with source code, design assets, documents, and mixed workspaces. Git adds branch-specific memory and isolated worktrees. A folder of files is enough to get started.

## Install from source

Install Node.js **24.13 or later** and the chat client you want to use. From a terminal:

```sh
git clone https://github.com/Mapacheee/vibekeep.git
cd vibekeep
npm ci
npm run build
npm link
```

## Start in your project

Run these commands in the folder containing your work. This example uses Claude Code.

```sh
cd /path/to/your/project
vibekeep init
vibekeep remember "Deliver print assets as PDF/A." --area export
vibekeep open claude
```

In the chat, ask **“Check VibeKeep for our export decision, then inspect the project for files that need updating.”** A new chat connected to the same working copy can retrieve the same decision. The external client supplies the model and applies its own account and usage limits. VibeKeep's memory service runs locally without a model key.

### Choose your client

| Client | Launch from the project folder | Connection |
| --- | --- | --- |
| Claude Code | `vibekeep open claude` | Adds VibeKeep to this Claude session with `--mcp-config`. |
| OpenCode | `vibekeep open opencode` | Adds a local MCP server to the project's OpenCode configuration. The launcher detects the installed major version. |
| Google Antigravity CLI | `vibekeep open antigravity` | Adds the server to `.agents/mcp_config.json` and starts `agy`. |
| Codex CLI | `vibekeep open codex` | Supplies the MCP configuration for this invocation. |

To configure a client manually, run `vibekeep config <client>` in the working copy. For Antigravity CLI, open the project and check the connection from `/mcp`. In Antigravity IDE, use **MCP Servers → Manage MCP Servers → View raw config** to merge the generated `vibekeep` entry, then refresh the server list. For OpenCode 1.x, use `vibekeep config opencode-v1`. Generated entries include absolute paths for this machine and working copy. Review them before sharing client configuration. [Claude Code MCP](https://code.claude.com/docs/en/mcp) · [OpenCode MCP](https://opencode.ai/docs/mcp-servers) · [Antigravity MCP](https://antigravity.google/docs/mcp?app=cli) · [Codex MCP](https://developers.openai.com/codex/mcp)

## Work with a team

**Host the project.** In a persistent directory on one machine, run `vibekeep team serve`. In another terminal in that same directory, run `vibekeep team invite Ana` for each member, using their name. Send each person their own credential privately. The coordinator keeps its state across restarts in that directory.

**Join from a working copy.** Set `VIBEKEEP_TEAM_TOKEN` to your credential and run the following commands in your checkout. For two machines, forward port 4318 with `ssh -N -L 4318:127.0.0.1:4318 user@team-host`, or use the HTTPS address of your coordinator.

```sh
vibekeep team join http://127.0.0.1:4318
vibekeep team opencode
```

You can unset the environment variable after joining. Each member can choose any client in the table. For another task on the same machine, `vibekeep team worktree export-pdf ../project-export` creates a Git branch and a joined working copy from committed HEAD. For a design project outside Git, join from separate working folders and declare the resources each person intends to edit.

**Coordinate in the chat.** Ask your assistant to claim a task and list the files or design resources it plans to change. If someone claims the same resource or a parent folder, both chats can retrieve an overlap warning. Leave a message on the other task or record a handoff before closing your chat. Open a new chat in the same copy to recover the assignment, recent messages, and shared decisions. The coordinator shares task records and resource names. Chat transcripts stay with their respective clients.

Use `vibekeep team status` to inspect the board. The coordinator operator can confirm a proposed team decision with `vibekeep team accept <decision-id>` or revoke a credential with `vibekeep team revoke <name>`. Overlap warnings are advisory. Review and integrate edits through your usual Git or design workflow.

## Local workspace

Run `vibekeep ui` and open the local URL printed in the terminal. Browse files, preview assets, inspect memory, run registered tasks, or review changes. To connect an external client while the GUI owns the same working copy, choose **Workspace actions → Connect external agent**, select your client, and use the generated session configuration.

The built-in chat supports Anthropic and OpenAI-compatible endpoints, including local models with tool calling. Configure the model in the GUI or set the variables shown in [.env.example](.env.example) for `vibekeep chat`. Store your credentials outside version control.

| Command | Use |
| --- | --- |
| `vibekeep status` | Inspect the current files and detected changes. |
| `vibekeep memory [query]` | Find decisions for this branch or working folder. |
| `vibekeep accept <id>` | Confirm a local decision proposed by an agent. |
| `vibekeep changes` / `vibekeep undo` | Review VibeKeep's own edits or restore its latest edit if the file still matches. |
| `vibekeep tasks` / `vibekeep checks` | List available tasks or inspect recorded verification results. |
| `vibekeep export` / `vibekeep import <file>` | Transfer decision memory between copies of the same project. |

Use `--cwd <directory>` to target another folder. Run `vibekeep --help` or `vibekeep team help` for the full command list. Project identity and local state are stored under `.vibe/`. The private database and team credentials live in its ignored `local/` directory.

## Development

Run `npm run check` for type checking and `npm test` for automated tests. For the browser suite, install Chromium with `npx playwright install chromium` and run `npm run test:browser`. The [design](examples/design) and [Java](examples/java) projects are small workspaces for trying VibeKeep.
