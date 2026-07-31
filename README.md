# Nightcall 🌙

A dark software house: a single Effect-TS daemon that runs a virtual AI
company against GitHub repositories, built entirely on published
[`@llm4ts/*`](https://github.com/riccardomerolla/llm4ts) packages.

GitHub is the whole control plane — issues are the channel between the
human CEO/CTO and the company, labels are the task state machine, pull
requests are the deliverable, git is the audit log.

- [DESIGN.md](DESIGN.md) — the founding decision record: runtime, org
  chart, issue protocol, workspaces, budgets, identity, rollout.
- [COMPANY.md](COMPANY.md) — the handbook injected into every agent's
  prompt; the CEO edits strategy by editing this file.

Status: founding documents only. First code arrives after llm4ts ships
the `GitHubTool` work-queue operations
(`specs/pending/github-tool-work-queue.md` in the llm4ts repo).
