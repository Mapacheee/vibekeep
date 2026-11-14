# Roadmap

## 0.1 — First working loop

- [x] CLI with automatic initialization and terminal chat.
- [x] Adoption of empty and existing projects without executing scripts.
- [x] Inventory of packages, commands, instructions, and changes using hashes.
- [x] SQLite, FTS5, branch-scoped decisions, and explicit provenance.
- [x] Chat with Anthropic or a configurable compatible provider.
- [x] Paginated reads, partial replacements, and writes with preconditions.
- [x] Per-write snapshots and undo that detects later edits.
- [x] Authorized npm scripts, timeouts, bounded output, and results.
- [x] Results marked out of date when indexed code changes.
- [x] Cross-process persistence and export/import with conflict rejection.
- [x] Deterministic tests without a paid API dependency.

## Next increment — See the project running

- Development-server management: start, check readiness, display logs, and stop.
- Authorization by project profile without repeated prompts for an already granted scope.
- Content diffs in the conversation and grouping writes into experiments.
- Conversational decision acceptance with evidence and ambiguity evaluation.
- Guided recovery of uncertain actions and coordinated process cancellation.

## Later — Understand and extend

- Tree-sitter and language adapters; LSP for specific semantic queries.
- Worktrees for complete variants and memory with explicit branch inheritance and conflicts.
- React/Vite, API, CLI, and Python profiles with verified commands.
- Official-documentation research tied to repository versions.
- Better multilingual retrieval; evaluate embeddings against the text-search baseline.
- An MCP server for external agents, with integration limits declared per client.
- An optional panel with conversation, preview, and timeline.

## Prioritization

Every increment should improve this journey: open a real repository, change something through conversation, verify it, close the session, and resume with accurate memory. The interaction should not require turning every idea into documents or completing planning phases.
