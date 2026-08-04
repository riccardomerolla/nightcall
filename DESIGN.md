# Nightcall — founding design

Nightcall is a virtual AI software company: a single long-running Effect-TS
program that runs an org of LLM agents against GitHub repositories. GitHub
is the entire control plane — issues are the CEO↔company channel, labels
are the task state machine, pull requests are the deliverable, git is the
audit log. All LLM interaction goes through published `@llm4ts/*` packages;
Nightcall itself contains no model calls, only organization.

Inspired by [paperclipai/paperclip](https://github.com/paperclipai/paperclip)
(org chart, atomic task checkout, heartbeats, budgets, governance gates),
with one structural bet: GitHub replaces Paperclip's server, database, and
UI entirely.

Decision record from the founding grilling session, 2026-07-31.
Implementation status lives in [README.md](README.md); v1 deviations from
this record: the standup is a comment stream (not a regenerated Mermaid
body — GitHubTool has no issue-body edit), the ledger is a local JSONL
under the workspace (orphan-branch publication deferred), QA rejection
fails the attempt rather than looping findings back to the Engineer, and
epics are reported but not yet decomposed.
Amendment 2026-08-04: continuous delivery — with the staged pipeline's
mend stage keeping PRs current, the CEO ceded the merge click: green
checks auto-merge by default (NIGHTCALL_AUTO_MERGE=off restores the
gate). Merge authority is now exercised through issue scope, labels, and
revert — not the button.

## Constraints

- **Only llm4ts for intelligence.** Every model call, plan, review loop,
  and GitHub operation flows through published `@llm4ts/*` at a pinned
  release (stable-compiler rule; upgrading the pin is a deliberate act).
  Library gaps discovered here become specs in llm4ts `specs/pending/`,
  land there first, and arrive back via the next release. First such spec:
  `github-tool-work-queue.md` (issue list/label/assign/close ops).
- **Deterministic management.** Any decision that can be code is code.
  LLMs hold judgment roles only; the orchestrator, budgets, bookkeeping,
  label transitions, and reports are deterministic Effect programs.
- **Dark but legible.** The company runs unattended, but every action is
  attributable in GitHub: signed comments, invoice comments, a standup
  dashboard, and an append-only ledger.

## Runtime

A local long-running Effect daemon — the **Chief of Staff** — started by
the CEO, alive while the machine is awake.

- Heartbeat: `Effect.repeat(Schedule.spaced("2 minutes"))` polling the
  target repos' issues. Polling ≈ Paperclip heartbeats; no webhooks, no
  public endpoint in v1.
- **Idempotent heartbeat**: running it twice, or after any crash,
  converges to the same actions.
- **GitHub labels are the only org-level state.** No local database; any
  local mirror of GitHub state would drift. Local state is strictly
  per-issue execution state: the persisted llm4ts Plan and trace inside
  the issue's worktree.
- Restart reconciliation, before the first heartbeat, over `factory:wip`
  issues assigned to the bot: worktree + plan → resume via
  `recoverOrCreate`; branch pushed but worktree gone → recreate worktree
  from branch and resume or re-plan on top; nothing recoverable → comment,
  delete branch, treat as freshly claimed.
- Per-issue attempt counter; after **2** failed attempts the issue moves
  to `factory:failed` instead of looping.

## Org chart

```
CEO/CTO (human)      — scope & merge authority. Speaks via issues and PRs.
└─ Chief of Staff    — deterministic orchestrator. NOT an LLM.
   ├─ Tech Lead      — LLM, derived read-only coder. Triage authority.
   ├─ Engineers ×N   — LLM, coderFromEnv (default Claude CLI),
   │                   implementPlanFlow. Implementation authority.
   └─ QA Reviewer    — LLM, derived read-only coder, fresh context.
                       Ship authority.
```

- **Tech Lead**: reads a `factory:ready` issue and rules: under-specified
  → `factory:needs-info` + concrete questions as a comment (the upward
  channel); well-specified → acceptance criteria as a comment, hand to an
  Engineer; too big → decompose, **only** when the CEO marked the issue
  `factory:epic` (max 5 children, each `factory:ready` with a `parent #N`
  back-reference; the epic closes when all children do). Never writes code.
- **Engineer**: `implementPlanFlow` with the Tech Lead's acceptance
  criteria injected into plan context. Internal seats (reasoning / coder /
  reviewer + CI gate) per llm4ts. Specializations are registry rows, not
  code.
- **QA Reviewer**: fresh-context read-only review of the final diff
  (`LlmReview`/`PrSummary`) — deliberately distinct from the Engineer's
  internal reviewAndFixLoop, which shares the Engineer's blind spots. Only
  QA moves an issue to `factory:review`; rejection returns findings to the
  Engineer.
- **Org registry**: a config table `role → flow + connector + budget`.
  Adding a role (Docs, Triage, Release) is one row + one flow; the
  orchestrator does not change.
- **Downward context**: `COMPANY.md` (mission, quality bar, conventions)
  is injected into every agent's system prompt. The CEO edits strategy by
  editing the file.

## Issue protocol

Namespace `factory:*`; the factory never touches an issue without it
(explicit opt-in per issue — the label IS the management interface; no
backlog self-triage).

| Label                | Meaning                                | Set by       |
| -------------------- | -------------------------------------- | ------------ |
| `factory:ready`      | CEO says: pick this up                 | human only   |
| `factory:epic`       | CEO grants decomposition authority     | human only   |
| `factory:needs-info` | Tech Lead bounced with questions       | orchestrator |
| `factory:wip`        | claimed; first write wins              | orchestrator |
| `factory:review`     | PR open (`Closes #N`), QA approved     | orchestrator |
| `factory:failed`     | attempts/budget exhausted; see comment | orchestrator |
| `factory:budget-N`   | per-issue budget override ($N)         | human only   |
| `factory:fresh`      | one-shot: discard branch/worktree/plan, restart from origin/HEAD | human only (stripped after reset) |
| `factory:planned`    | staged pipeline: plan posted, ready for coder | orchestrator |
| `factory:coded`      | staged pipeline: implemented, ready for reviewer | orchestrator |
| `factory:reviewed`   | staged pipeline: reviewed, ready for QA | orchestrator |
| `factory:validate`   | epic's children all shipped; CEO review — comment feedback + re-add ready to iterate, or close | orchestrator |
| `factory:ship`       | CEO override: waive the QA verdict and ship (set with factory:reviewed) | human only (stripped when consumed) |

- Claim = remove `ready`, add `wip`, self-assign, comment the plan — the
  first write the orchestrator makes for an issue.
- Retry is human-driven: strip `failed`, re-add `ready`.
- On failure the branch is **pushed without a PR** — evidence for autopsy.
- Merged PRs auto-close issues via `Closes #N`.
- Atomicity: with exactly one daemon there is no claim race; multi-daemon
  checkout becomes a spec only if it ever exists.

## Workspaces

- Git **worktree per issue**: `.factory/worktrees/issue-<n>/`, branch
  `factory/issue-<n>`. The factory never touches the human checkout; a
  crashed run is a self-contained crime scene.
- Engineer parallelism via `Semaphore(n)`, **default 1** (semantic PR
  collisions arrive before git ones; there is no merge-conflict role).
  Going parallel is a config change, not a design change.
- Tech Lead needs no worktree (issues only); QA reviews the pushed
  branch's diff.
- CI gate runs per-worktree (per-worktree install; pnpm store keeps it
  cheap).

## Money

Enforced by the Chief of Staff — an LLM never reasons about its own budget.

- **Per-issue**: default **$5**, override via `factory:budget-N`. One
  `CostTracker` per issue fiber covers the whole chain (triage + engineer
  + QA). `BudgetExceeded` is the normal failure path: push branch,
  `factory:failed`, spend breakdown in the comment.
- **Per-day company cap**: default **$25**. When exhausted the Chief of
  Staff stops claiming (in-flight fibers finish their attempt) and notes
  it in the standup.
- No per-role monthly budgets in v1; per-seat attribution comes free from
  the llm4ts cost-events seam and shows in the standup.
- Suspected llm4ts gap: daily rolling aggregation across fibers/runs —
  check `CostLedger` first, spec the gap if real.

### Cost visibility (all in GitHub, all deterministic)

1. **Invoice comment** when an issue leaves `wip`: total, per-seat
   breakdown, review rounds, turns, model, budget remaining. Same line in
   the PR body.
2. **Standup issue** — one pinned issue whose body the Chief of Staff
   regenerates each heartbeat: today's spend vs cap, Mermaid pie of spend
   by role, table of in-flight issues with live spend (GitHub renders
   Mermaid natively — the dashboard costs zero infrastructure).
3. **Ledger** — append-only JSONL of cost events on orphan branch
   `factory/ledger`, one commit per heartbeat with spend. Queryable,
   diffable, survives issue archival; keeps bookkeeping out of `main`.

## Identity

- v1: CEO's personal PAT; **every** bot comment carries a signature line
  (`— Nightcall 🌙`). Token via env only — never argv, logs, or errors.
- Graduates with the trust bar to a dedicated machine account
  (fine-grained PAT, distinct actor, assignable, revocable). GitHub App
  only if Nightcall ever serves more than one company.

## Casting

- Engineer: `coderFromEnv` (`LLM4TS_CODER`, default Claude CLI).
- Tech Lead & QA: the derived read-only coder (dogfood-loop precedent).
  No cheaper model for triage in v1 — the Tech Lead makes the
  highest-judgment calls; cost-optimize later from invoice data.
- Overrides live in the org registry.

## Rollout

1. llm4ts: implement `specs/pending/github-tool-work-queue.md`
   (+ parity note + ADR), release, pin here.
2. Scaffold Nightcall: Chief of Staff daemon, org registry, label
   protocol, worktree manager, budgets, standup, ledger.
3. First target: a deliberately boring sandbox repo with real CI.
4. **Trust bar: three issues end-to-end unattended**
   (ready → triage → implement → QA → PR → human merge) before Nightcall
   may receive `factory:ready` on llm4ts issues.
5. Self-hosting (Nightcall working its own repo) only after the trust
   bar — never first: orchestrator bugs must not be edited by the buggy
   orchestrator.

## Non-goals (v1)

Webhooks/public endpoints, multi-daemon claim atomicity, PM agent with
backlog authority, blocking agent→human questions mid-run (agents fail
cleanly instead of waiting), per-role monthly budgets, auto-merge,
GitHub App identity, multi-company anything, Paperclip UI parity.
