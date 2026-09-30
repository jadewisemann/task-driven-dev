# Changelog

## [0.1.0-alpha.1] - 2026-09-30

First alpha. Install and test guide: `docs/ALPHA.md`.

### Features
- **Board**: kanban of tasks with dependencies (DAG). A scheduler runs ready tasks by priority up to a concurrency limit, retries them, blocks dependents on failure and unblocks them on recovery, and supports a review/approval policy.
- **Agents**: each agent has a persona, harness (`claude-code`, `codex`, `kiro-cli`, `gemini`, `aider`, `shell`, `custom`, `mock`), model, effort level, tier, autonomy, context graph, retries, timeout and optional git worktree.
- **Worktrees**: each task gets its own branch/worktree. Dependency branches are merged in, results are committed, and conflicts are surfaced for review.
- **Orchestrator**: turns a natural-language goal into a dependency-ordered plan. Tasks are assigned to the cheapest capable agent, and plans can be reviewed and edited before running. Includes a built-in fallback planner.
- **Workflows**: n8n-style node graphs (Start, JSON, Transform, Agent, Router, Merge, Shell, Create task, Output) with JSON input, rule-based or agent-judged routing, and bounded loops.
- **Remote**: controls other machines over SSH (`todo-devs rpc` stdio bridge). Events from a remote server are relayed live.
- **Mobile app** (Expo / React Native): board, runs, orchestrator, agents, remote sessions and workflows. Pairs with the server via a one-time code.
- **Ops**: `todo-devs doctor`, `service install|uninstall|status` (launchd / systemd user), `backup` / `restore`, and a Settings view.

### Release assets
- `todo-devs-0.1.0-alpha.1.tgz`: npm package (`npm install -g ./todo-devs-0.1.0-alpha.1.tgz`), macOS / Linux, Node 22.13+
- `todo-devs-0.1.0-alpha.1.apk`: Android app (sideload; signed with a debug key)
- `todo-devs-0.1.0-alpha.1-ios-simulator.zip`: iOS simulator build
- `SHA256SUMS.txt`

### Known limitations
- Real LLM CLIs are not exercised in CI; harness flags may differ across CLI versions.
- No signed iOS device build (use Expo Go), and no push notifications.
- Windows is not supported natively.
