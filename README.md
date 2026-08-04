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

## Running

```bash
NIGHTCALL_TARGETS=owner/repo pnpm start
```

Observe mode is the default: the daemon polls `factory:ready` /
`factory:wip` and logs what it would claim, writing nothing. Arm the full
pipeline (claim → Tech Lead triage → Engineer → QA → PR) with
`NIGHTCALL_CLAIM=1` once a coding agent CLI is available (`LLM4TS_CODER`,
default `claude`) and `gh` is authenticated.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NIGHTCALL_TARGETS` | (required) | comma-separated `owner/repo` list |
| `NIGHTCALL_CLAIM` | off | `1` arms claiming and the engineer pipeline |
| `NIGHTCALL_HEARTBEAT_SECONDS` | `120` | poll interval |
| `NIGHTCALL_ISSUE_BUDGET_USD` | `5` | per-issue budget (`factory:budget-N` overrides) |
| `NIGHTCALL_DAILY_BUDGET_USD` | `25` | company-wide daily claim throttle |
| `NIGHTCALL_MAX_ATTEMPTS` | `2` | attempts before an issue stays failed |
| `NIGHTCALL_ENGINEER_PARALLELISM` | `1` | concurrent engineer seats |
| `NIGHTCALL_WORKSPACE` | `.factory` | clones, worktrees, and the ledger |
| `NIGHTCALL_GATE` | (unset) | CI gate command run in the worktree |
| `NIGHTCALL_STANDUP_ISSUE` | (unset) | `owner/repo#N` — standup comments land here |
| `NIGHTCALL_PIPELINE` | `mono` | `staged` splits work into plan → code → review → QA stage workers that run concurrently across issues (one issue per stage per beat); each stage is independently retryable and hands off via `factory:planned` / `factory:coded` / `factory:reviewed` |
| `NIGHTCALL_MAX_ROUNDS` | `1` | internal review rounds per task |
| `NIGHTCALL_INTERNAL_REVIEW` | on | `off` skips internal reviewer seats (gate stays) |
| `NIGHTCALL_TURN_LIMIT` | `50` | coder turns per task |
| `NIGHTCALL_ISSUE_TIMEOUT_MINUTES` | `30` | wall clock per issue (mono) or per stage (staged) |
| `NIGHTCALL_AUTO_MERGE` | on | `off` restores the human merge gate; otherwise the mend stage squash-merges a factory:review PR the moment its checks are green (continuous delivery) |

## Status

Implemented: heartbeat (poll → pure decide → claim), Tech Lead triage
(accept / bounce with questions), Engineer (`implementPlanFlow` in a git
worktree per issue), QA review of the final diff, branch push + PR with
`Closes #N` and a per-seat invoice, `factory:failed` with attempt labels
and pushed evidence branches, a JSONL ledger driving the daily budget
throttle, and optional standup comments. Deferred until the trust bar
(three issues end-to-end unattended on a sandbox repo): ledger
publication on an orphan branch, Mermaid standup dashboard, epic
decomposition, machine-account identity.
