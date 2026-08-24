# Nightcall 🌙 — Azure DevOps

A dark software house: a single Effect-TS daemon that runs a virtual AI
company against Azure DevOps repositories, built entirely on published
[`@llm4ts/*`](https://github.com/riccardomerolla/llm4ts) packages.

Azure DevOps is the whole control plane — **work items** are the channel
between the human CEO/CTO and the company, **tags** are the task state
machine, **pull requests** are the deliverable, git is the audit log. Every
call is the `az` CLI; every coding seat is the **Gemini CLI**.

This is the Azure DevOps + Gemini branch of Nightcall. The GitHub + Claude
original is on `main`; the two differ only in their backend, because the
control plane sits behind a port (`src/Hosting.ts`) with one adapter
(`src/Azure.ts`).

- [DESIGN.md](DESIGN.md) — the founding decision record plus the amendment
  that maps it onto Azure DevOps.
- [COMPANY.md](COMPANY.md) — the handbook injected into every agent's
  prompt; the CEO edits strategy by editing this file.

## Prerequisites

```bash
az extension add --name azure-devops     # the boards/repos commands
az devops login                          # or export AZURE_DEVOPS_EXT_PAT
gemini --version                         # the coding seat
```

Nightcall never reads, stores, or forwards a credential: `az` owns the
Azure DevOps PAT and git's credential helper authenticates the clone, so
no token can reach argv, a log line, a trace, or a persisted plan. Make
sure `git clone https://dev.azure.com/<org>/<project>/_git/<repo>` works
non-interactively before arming the daemon.

## Running

```bash
NIGHTCALL_ADO_ORG=https://dev.azure.com/acme \
NIGHTCALL_TARGETS=project/repository \
pnpm start
```

Observe mode is the default: the daemon polls `factory:ready` /
`factory:wip` and logs what it would claim, writing nothing. Arm the full
pipeline (claim → Tech Lead triage → Engineer → QA → PR) with
`NIGHTCALL_CLAIM=1`.

| Variable                        | Default              | Meaning                                                                                       |
| ------------------------------- | -------------------- | --------------------------------------------------------------------------------------------- |
| `NIGHTCALL_ADO_ORG`             | (required)           | organization URL, e.g. `https://dev.azure.com/acme`                                             |
| `NIGHTCALL_TARGETS`             | (required)           | comma-separated `project/repository` list                                                       |
| `NIGHTCALL_ADO_WORK_ITEM_TYPE`  | `Task`               | type created for epic children (`User Story`, `Product Backlog Item`, …)                        |
| `NIGHTCALL_ADO_TARGET_BRANCH`   | `main`               | pull-request target branch                                                                      |
| `NIGHTCALL_ADO_API_VERSION`     | `7.1-preview.3`      | API version for the work-item comments resource                                                 |
| `NIGHTCALL_CLAIM`               | off                  | `1` arms claiming and the engineer pipeline                                                     |
| `NIGHTCALL_HEARTBEAT_SECONDS`   | `120`                | poll interval                                                                                   |
| `NIGHTCALL_ISSUE_BUDGET_USD`    | `5`                  | per-work-item budget (`factory:budget-N` overrides)                                             |
| `NIGHTCALL_DAILY_BUDGET_USD`    | `25`                 | company-wide daily claim throttle                                                               |
| `NIGHTCALL_MAX_ATTEMPTS`        | `2`                  | attempts before a work item stays failed                                                        |
| `NIGHTCALL_ENGINEER_PARALLELISM`| `1`                  | concurrent engineer seats                                                                       |
| `NIGHTCALL_WORKSPACE`           | `.factory`           | clones, worktrees, and the ledger                                                               |
| `NIGHTCALL_GATE`                | (unset)              | CI gate command run in the worktree                                                             |
| `NIGHTCALL_STANDUP_ITEM`        | (unset)              | `project/repository#N` — standup comments land here                                             |
| `NIGHTCALL_PIPELINE`            | `mono`               | `staged` splits work into plan → code → review → QA stage workers running concurrently across work items (one item per stage per beat); each stage is independently retryable and hands off via `factory:planned` / `factory:coded` / `factory:reviewed` |
| `NIGHTCALL_MAX_ROUNDS`          | `1`                  | internal review rounds per task                                                                 |
| `NIGHTCALL_INTERNAL_REVIEW`     | on                   | `off` skips internal reviewer seats (gate stays)                                                |
| `NIGHTCALL_TURN_LIMIT`          | `50`                 | coder turns per task                                                                            |
| `NIGHTCALL_ISSUE_TIMEOUT_MINUTES` | `30`               | wall clock per work item (mono) or per stage (staged)                                           |
| `NIGHTCALL_AUTO_MERGE`          | on                   | `off` restores the human merge gate; otherwise the mend stage squash-completes a `factory:review` PR the moment its branch policies pass |
| `NIGHTCALL_CODER_MODEL`         | (connector default)  | model for every seat, e.g. `gemini-2.5-pro`                                                     |
| `LLM4TS_CODER`                  | `gemini`             | override the coding CLI (`claude`, `codex`, `opencode`, …)                                      |

## Tag protocol

The `factory:*` tags are Azure DevOps tags on the work item, and the
company never touches a work item without one. They are stored in the
single `System.Tags` field, so every transition is a read-merge-write
rather than an atomic label add — safe because exactly one stage worker
holds a work item at a time.

`factory:ready` → `factory:wip` → (`factory:planned` → `factory:coded` →
`factory:reviewed` in the staged pipeline) → `factory:review`, with
`factory:needs-info` and `factory:failed` as the exits. Full table in
[DESIGN.md](DESIGN.md).

## Differences that come from the backend

- **Bodies and comments are HTML.** Work item descriptions and discussion
  comments are stored as HTML; the adapter converts both ways so the
  protocol's line-oriented markers (`Blocked-by: #12`,
  `Parent: #7 (epic)`, the report signature) survive a round trip.
- **PRs link, they do not close.** `Closes #N` means nothing here, so the
  PR is created with `--work-items N` — a real board link — and the
  description carries a human-readable `Work item #N` line.
- **Checks are branch policies.** `prChecks` reads policy evaluations:
  queued/running is Pending, rejected/broken is Failure, and no configured
  policy is Success (there is nothing to fail).
- **No `az repos clone`.** The clone is a plain `git clone` of the HTTPS
  remote, authenticated by git's credential helper.

## Development

```bash
pnpm typecheck
pnpm test
```

Tests never invoke `az`, `git`, or a model: the control plane runs through
llm4ts's process and temporary-file fakes with checked-in `--output json`
fixtures, so the suite needs no network, no credentials, and no installed
CLI.

## Status

Implemented: heartbeat (poll → pure decide → claim), Tech Lead triage
(accept / bounce with questions), Engineer (`implementPlanFlow` in a git
worktree per work item), QA review of the final diff, branch push + PR
linked to the work item with a per-seat invoice, `factory:failed` with
attempt tags and pushed evidence branches, a JSONL ledger driving the
daily budget throttle, and optional standup comments.

Deferred until the trust bar (three work items end-to-end unattended on a
sandbox project): ledger publication on an orphan branch, Mermaid standup
dashboard, machine-account identity.

The `az` argv builders and JSON parsers in `src/Azure.ts` are deliberately
shaped like llm4ts's own forge tools. Once llm4ts publishes its CLI-backed
`@llm4ts/flow/AzureDevOpsTool` ([llm4ts PR #11](https://github.com/riccardomerolla/llm4ts/pull/11)),
they can be deleted in favour of it — the port in `src/Hosting.ts` is what
keeps that a local swap.
