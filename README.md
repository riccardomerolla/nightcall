# Nightcall 🌙 — Azure DevOps

A dark software house: a single Effect-TS daemon that runs a virtual AI
company against Azure DevOps repositories, built entirely on published
[`@llm4ts/*`](https://github.com/riccardomerolla/llm4ts) packages.

Azure DevOps is the whole control plane — a **project board** carries the
work items that are the channel between the human CEO/CTO and the company,
**tags** are the task state machine, **Development links** say which
repository and branch a work item belongs to, **pull requests** are the
deliverable, git is the audit log. Every call is the `az` CLI; every coding
seat is the **Gemini CLI**.

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
Azure DevOps PAT and git's credential helper authenticates the clone.
Nightcall adds no variables of its own to any process it launches — they
inherit its environment, which is how `az` finds its credential — so a
token stays in the environment and never reaches argv, a log line, a
trace, or a persisted plan. Make sure
`git clone https://dev.azure.com/<org>/<project>/_git/<repo>` works
non-interactively before arming the daemon.

## Running

```bash
cp .env.example .env     # edit the two required values
pnpm start
```

`pnpm start` loads `.env` if it is present (Node's own `--env-file-if-exists`;
no dependency, no parser of ours) and starts without one if it is not, so
plain environment variables still work exactly as before:

```bash
NIGHTCALL_ADO_ORG=https://dev.azure.com/acme \
NIGHTCALL_TARGETS=project/repository \
pnpm start
```

`.env` is gitignored, and `.env.example` is the tracked template that
documents every variable. Anything in `.env` is inherited by the processes
Nightcall launches (`az`, `git`, `gemini`) — that is how `az` picks up
`AZURE_DEVOPS_EXT_PAT` if you keep it there rather than running
`az devops login`, and it is also why nothing belongs in `.env` that you
would not hand to those three programs.

A target is a **board**, not a repository. `project/repository` names a
board plus the repository to use for work items that do not say otherwise;
a bare `project` names a board whose every work item must route itself
through a Development link. Listing one project twice is a startup error —
a board is polled once, and its work items choose their own repositories.

Observe mode is the default: the daemon polls `factory:ready` /
`factory:wip` and logs what it would claim, writing nothing. Arm the full
pipeline (claim → Tech Lead triage → Engineer → QA → PR) with
`NIGHTCALL_CLAIM=1`.

Every variable below can live in `.env` or in the environment; the two
are the same thing by the time the daemon reads them.

| Variable                        | Default              | Meaning                                                                                       |
| ------------------------------- | -------------------- | --------------------------------------------------------------------------------------------- |
| `NIGHTCALL_ADO_ORG`             | (required)           | organization URL, e.g. `https://dev.azure.com/acme`                                             |
| `NIGHTCALL_TARGETS`             | (required)           | comma-separated boards: `project/default-repository`, or bare `project`                         |
| `NIGHTCALL_AZ_BIN`              | `az` / `az.cmd`      | the `az` executable to launch; defaults per platform                                            |
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

## Windows

Two things differ, and both come from the same fact: **Nightcall never runs
`az` through a shell.** The executor spawns an argv array directly, so every
argument reaches `az` exactly as built.

- **The executable is `az.cmd`, not `az`.** A shell-less spawn resolves a
  command against `PATH` but never appends a `PATHEXT` extension, and the
  Azure CLI installs on Windows as `az.cmd`. That is the default here;
  `NIGHTCALL_AZ_BIN` overrides it (a full path, for instance).
- **The `az` command in an error message is a description, not a snippet.**
  A WIQL query contains `<>`, and pasting one into PowerShell asks a shell
  to parse text that was deliberately never given to one — PowerShell reads
  `<>` as redirection and reports *"Missing file specification after
  redirection operator"*. That error is produced by the paste, not by the
  daemon. To run the same query by hand, quote the `--wiql` value:

  ```powershell
  az boards query --wiql "SELECT [System.Id] FROM WorkItems WHERE [System.State] <> 'Closed'" --project P --org https://dev.azure.com/acme --detect false --output json
  ```

Failures now report their cause beside the command (`↳ …`), so the reason a
heartbeat failed is in the log rather than something to reconstruct.

The coding seat has the same executable shape: a `gemini` installed through
npm is `gemini.cmd` on Windows. That one is resolved by `@llm4ts/runner`,
not here, so if the coder cannot start, `LLM4TS_CODER` accepts an
alternative and a full path works.

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

## Where a work item's code lives

On GitHub the question does not arise: an issue belongs to a repository.
An Azure DevOps work item belongs to a **project board**, and a project
holds many repositories — so before doing anything, the factory asks the
work item where its code is:

1. **A Branch development link** — that repository, that branch. A human
   who created a branch from the work item has already decided where this
   work goes; the factory commits on that branch and opens the PR from it.
   It is never deleted or force-reset by `factory:fresh`, because the
   factory did not create it.
2. **The board's default repository** — a fresh `factory/item-<n>` off
   `origin/HEAD`, which is then **linked back** to the work item so the
   board's Development section shows the work.
3. **Neither** — the work item is not actionable. It goes to
   `factory:needs-info` with a comment explaining the two ways to fix it.

Nightcall links back at the moments the flow produces something linkable:
the **branch** the first time it reaches the remote (code stage, or QA in
the mono pipeline), and the **pull request** when it is opened. Both are
no-ops when the link already exists, so a resumed stage does not duplicate
them.

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
  remote, authenticated by git's credential helper. Clones and worktrees
  are keyed by the *resolved* repository, so one board can drive work in
  several repositories at once.
- **Artifact links address GUIDs.** A Development link names its project
  and repository by id, so reading one back costs an `az repos show` to
  recover the name.

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

Development-link handling — the `vstfs:` URI encoding, relation decoding,
and GUID resolution — comes from `@llm4ts/flow/AzureDevOpsTool` (0.13.0).
The remaining `az` argv builders and JSON parsers in `src/Azure.ts` are
the ones whose shape differs from that tool's single-project config: the
board queries, the HTML round trip, and the comment operations that need
real comment ids. They are deliberately shaped like llm4ts's own so the
rest can follow later — the port in `src/Hosting.ts` is what keeps that a
local swap.
