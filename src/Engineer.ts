import { mkdir, readFile, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { makeChat } from "@llm4ts/flow/Chat"
import { CostBudget, type CostCell } from "@llm4ts/flow/CostLedger"
import { makeCostTracker } from "@llm4ts/flow/CostTracker"
import { implementPlanFlow } from "@llm4ts/flow/Flow"
import type { FlowContextShape } from "@llm4ts/flow/FlowContext"
import { ProcessError, type FlowError } from "@llm4ts/flow/FlowError"
import { Info, type FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import { makeGitHubTool, type GitHubToolShape, type IssueRef } from "@llm4ts/flow/GitHubTool"
import { makePlanStore } from "@llm4ts/flow/Persistence"
import { Plan } from "@llm4ts/flow/Plan"
import { planFrom } from "@llm4ts/flow/Planner"
import { lintCommand } from "@llm4ts/flow/Review"
import { coderFromEnv, withTurnLimit } from "@llm4ts/runner/Connectors"
import {
  makeFlowRunnerContext,
  nodeFlowRunnerDependencies,
  runWithBundle
} from "@llm4ts/runner/FlowRunner"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { nodeProcessExecutor } from "@llm4ts/runner/NodeProcessExecutor"
import { parseVerbosity } from "@llm4ts/runner/Terminal"
import type { CompanyConfig } from "./Config.ts"
import { repoRefOf, type ClaimIntent } from "./Heartbeat.ts"
import { makeProgressEvents } from "./Progress.ts"
import {
  engineerBrief,
  isEpicChild,
  noopRule,
  parseQa,
  parseTriage,
  prBody,
  qaPrompt,
  renderInvoice,
  triagePrompt
} from "./Prompts.ts"
import {
  attemptLabel,
  attemptOf,
  bounce,
  branchFor,
  budgetOverrideUsd,
  fail,
  sendToReview,
  signed
} from "./Protocol.ts"

// One claimed issue, end to end: Tech Lead triage → Engineer
// (implementPlanFlow in a worktree) → QA over the final diff → push, PR,
// factory:review — or the bounce/failure paths. Never fails the daemon:
// every outcome, including errors, resolves to an IssueOutcome and is
// reported on the issue itself.

export type IssueOutcome = "Shipped" | "Bounced" | "Failed"

const run = (
  argv: ReadonlyArray<string>,
  cwd: string
): Effect.Effect<string, FlowError> =>
  nodeProcessExecutor.run(argv, cwd, {}).pipe(
    Effect.mapError((error) =>
      ProcessError.make({ message: argv.join(" "), detail: error.message })
    ),
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout.join("\n").trim())
        : Effect.fail(
            ProcessError.make({
              message: argv.join(" "),
              detail:
                [...result.stdout, ...result.stderr].join("\n").trim() ||
                `exit code ${result.exitCode}`
            })
          )
    )
  )

// Deterministic guard against planner-invented non-coding tasks: a task
// like "Verify importer integration quality" can never produce a diff, so
// the no-op protocol fails the whole run when the model forgets the
// TASK_ALREADY_SATISFIED confirmation. Prompt guidance failed twice
// (trust-bar runs 4 and 5); policy that can be code is code. Completed
// tasks are kept for checkbox integrity.
const verificationTaskPattern = /^(verify|verification|validate|confirm|ensure|check|gate|run (the )?(tests?|gate|build))\b/i

export const pruneNonCodingTasks = (plan: Plan): Plan => {
  const tasks = plan.tasks.filter(
    (task) => task.completed || !verificationTaskPattern.test(task.title.trim())
  )
  return tasks.length === plan.tasks.length
    ? plan
    : Plan.make({
        epicId: plan.epicId,
        tasks,
        ...(plan.brief === undefined ? {} : { brief: plan.brief })
      })
}

const positiveIntOr = (raw: string | undefined, fallback: number): number => {
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const exists = (path: string): Effect.Effect<boolean> =>
  Effect.tryPromise({ try: () => stat(path), catch: () => "missing" }).pipe(
    Effect.map(() => true),
    Effect.catch(() => Effect.succeed(false))
  )

// Clone-on-first-use per target, then a worktree per issue. An existing
// worktree is reused as-is: the persisted plan inside it makes a re-run
// resume instead of restart (DESIGN.md reconciliation).
export const ensureWorktree = (
  workspaceDir: string,
  intent: ClaimIntent
): Effect.Effect<string, FlowError> =>
  Effect.gen(function* () {
    const slugDir = `${intent.target.owner}__${intent.target.repo}`
    const repoDir = join(workspaceDir, "repos", slugDir)
    const worktree = join(workspaceDir, "worktrees", slugDir, `issue-${intent.issue.number}`)
    yield* Effect.tryPromise({
      try: () => mkdir(join(workspaceDir, "repos"), { recursive: true }),
      catch: (error) =>
        ProcessError.make({ message: "mkdir", detail: String(error) })
    })
    if (!(yield* exists(repoDir))) {
      yield* run(["gh", "repo", "clone", intent.target.slug, repoDir], workspaceDir)
    }
    yield* run(["git", "-C", repoDir, "fetch", "origin", "--prune"], workspaceDir)
    if (!(yield* exists(worktree))) {
      // Branch from origin/HEAD, not the clone's local HEAD: fetch never
      // moves local main, so an implicit start point would base new work
      // on however stale the clone happens to be.
      yield* run(
        [
          "git",
          "-C",
          repoDir,
          "worktree",
          "add",
          "-B",
          branchFor(intent.issue.number),
          worktree,
          "origin/HEAD"
        ],
        workspaceDir
      )
    }
    return worktree
  })

const readHandbook = (cwd: string): Effect.Effect<string> =>
  Effect.tryPromise({
    try: () => readFile(join(cwd, "COMPANY.md"), "utf8"),
    catch: () => "missing"
  }).pipe(Effect.catch(() => Effect.succeed("")))

export interface EngineerReport {
  readonly outcome: IssueOutcome
  readonly costUsd: number
}

const totalCost = (cells: ReadonlyArray<CostCell>): number =>
  cells.reduce((sum, cell) => sum + (cell.costUsd ?? 0), 0)

// Post-run bookkeeping helpers are best-effort: a failed comment must not
// turn a shipped issue into a crashed daemon.
const tell = (
  gh: GitHubToolShape,
  ref: IssueRef,
  body: string
): Effect.Effect<void> => Effect.ignore(gh.writeIssueComment(ref, signed(body)))

export const runIssue = (
  gh: GitHubToolShape,
  intent: ClaimIntent,
  config: CompanyConfig,
  environment: Readonly<Record<string, string | undefined>>,
  events: FlowEventsShape
): Effect.Effect<EngineerReport> =>
  Effect.gen(function* () {
    const ref = intent.issue.ref(repoRefOf(intent.target))
    const workspaceDir = resolve(environment["NIGHTCALL_WORKSPACE"] ?? ".factory")
    const worktree = yield* ensureWorktree(workspaceDir, intent)
    const handbook = yield* readHandbook(process.cwd())
    const budgetUsd = budgetOverrideUsd(intent.issue.labels) ?? config.issueBudgetUsd
    const branch = branchFor(intent.issue.number)
    const gate = environment["NIGHTCALL_GATE"]?.trim()

    const startedAtMs = yield* Clock.currentTimeMillis
    const runId = `nightcall-${intent.issue.number}-${startedAtMs}`
    const store = makePlanStore(nodePlainFileStore)
    // Plans and traces live OUTSIDE the worktree: commitAll sweeps the
    // whole tree, and run-state (prompts, tool output) must never land in
    // the target repo's history. State survives worktree deletion, which
    // also makes resume more robust.
    const stateDir = join(
      workspaceDir,
      "state",
      `${intent.target.owner}__${intent.target.repo}`
    )
    yield* Effect.tryPromise({
      try: () => mkdir(stateDir, { recursive: true }),
      catch: (error) => ProcessError.make({ message: "mkdir state", detail: String(error) })
    })
    const planPath = join(stateDir, `issue-${intent.issue.number}-plan.md`)
    const dependencies = nodeFlowRunnerDependencies()
    // Bounded darkness: a per-task turn limit and a per-issue wall clock.
    // Trust-bar run 3 spent 84 minutes and 90k tokens on one importer task
    // before the CLI died — without bounds, one degenerate task holds the
    // company's only seat for hours.
    const turnLimit = positiveIntOr(environment["NIGHTCALL_TURN_LIMIT"], 50)
    const timeoutMinutes = positiveIntOr(environment["NIGHTCALL_ISSUE_TIMEOUT_MINUTES"], 30)
    const coder = withTurnLimit(coderFromEnv(environment), turnLimit)
    const options = {
      workDir: worktree,
      workspace: worktree,
      userPrompt: engineerBrief(intent.issue, "", handbook),
      coder: CliConnectorConfig.make({ ...coder, workingDir: worktree }),
      tracePath: join(stateDir, `trace-${runId}.jsonl`),
      runId,
      verbosity: parseVerbosity(environment["LLM4TS_VERBOSITY"]),
      budget: CostBudget.make({ maximumCostUsd: budgetUsd })
    }

    const outcome = yield* Ref.make<IssueOutcome>("Failed")
    const qaSummary = yield* Ref.make("")
    const cellsRef = yield* Ref.make<ReadonlyArray<CostCell>>([])

    const body = (context: FlowContextShape): Effect.Effect<void, FlowError> =>
      Effect.gen(function* () {
        // Epic children were specified by the Tech Lead's own
        // decomposition — re-triaging them in fresh context invites
        // self-second-guessing (trust-bar run: the triager bounced a
        // child its decomposition wrote). Their body IS the criteria.
        let criteria = ""
        if (!isEpicChild(intent.issue.body)) {
          // Tech Lead: fresh chat on the read-only reasoning seat. An
          // unparseable verdict bounces — a confused triager must never
          // green-light work.
          const techLead = yield* makeChat(context.reasoning, {
            system: handbook,
            events: context.events,
            agent: "techlead"
          })
          const triage = parseTriage(yield* techLead.ask(triagePrompt(intent.issue)))
          if (triage === undefined || triage.kind === "Bounce") {
            const questions =
              triage === undefined
                ? "Triage could not reach a verdict; please tighten the issue description."
                : triage.questions
            yield* context.hosting.writeIssueComment(
              ref,
              signed(`Bounced by the Tech Lead:\n\n${questions}`)
            )
            yield* context.hosting.editIssueLabels(ref, bounce.add, bounce.remove)
            yield* Ref.set(outcome, "Bounced")
            return
          }
          criteria = triage.criteria
        }

        // Engineer: plan once (resumable), then the proven per-task
        // machinery from implementPlanFlow. Stage events are mirrored to
        // the issue as ▶/✔/✖ progress comments.
        const brief = engineerBrief(intent.issue, criteria, handbook)
        const plan = store
          .recoverOrCreate(planPath, planFrom(context.reasoning, brief))
          .pipe(Effect.map(pruneNonCodingTasks))
        const progress = yield* makeProgressEvents(context.events, context.hosting, ref)
        yield* implementPlanFlow({ ...context, events: progress }, {
          store,
          planPath,
          plan,
          chatPerTask: true,
          checkoutBranch: false,
          system: [noopRule, handbook.trim()].filter((part) => part.length > 0).join("\n\n"),
          maxRounds: 3,
          ...(gate === undefined || gate.length === 0
            ? {}
            : {
                lint: lintCommand(
                  nodeProcessExecutor,
                  context.events,
                  ["sh", "-lc", gate],
                  worktree
                )
              })
        })

        // QA: fresh chat, final diff vs the default base. Empty diff or an
        // unparseable verdict rejects — shipping nothing is failure.
        const base = yield* context.git.defaultBase
        const diff = yield* context.git.diffVsBase(base, true)
        const qa = yield* makeChat(context.reasoning, { events: context.events, agent: "qa" })
        const reply =
          diff.trim().length === 0
            ? undefined
            : yield* qa.ask(qaPrompt(intent.issue, criteria, diff))
        const verdict =
          reply === undefined
            ? { approved: false, findings: "The change produced an empty diff." }
            : parseQa(reply)
        if (verdict === undefined || !verdict.approved) {
          return yield* Effect.fail(
            ProcessError.make({
              message: "qa review",
              detail:
                verdict === undefined
                  ? `QA reply carried no parseable verdict. Raw reply:\n${(reply ?? "").slice(0, 1500)}`
                  : `QA rejected the change:\n${verdict.findings}`
            })
          )
        }
        yield* Ref.set(qaSummary, verdict.findings)
        yield* context.git.push("origin", branch)
        yield* Ref.set(outcome, "Shipped")
      })

    yield* Effect.scoped(
      Effect.gen(function* () {
        const bundle = yield* makeFlowRunnerContext(options, dependencies)
        const tracker = yield* makeCostTracker()
        yield* tracker.consume(bundle.events)
        yield* runWithBundle(bundle, options, body, dependencies).pipe(
          Effect.timeoutOrElse({
            duration: `${timeoutMinutes} minutes`,
            orElse: () =>
              Effect.fail(
                ProcessError.make({
                  message: "issue wall clock",
                  detail:
                    `exceeded ${timeoutMinutes} minutes; completed tasks are ` +
                    "committed and the persisted plan resumes on retry"
                })
              )
          }),
          Effect.ensuring(
            tracker
              .awaitDrained(bundle.events)
              .pipe(
                Effect.andThen(tracker.cells),
                Effect.flatMap((cells) => Ref.set(cellsRef, cells)),
                Effect.ignore
              )
          )
        )
      })
    ).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          // Failure path: push the branch as evidence (best-effort), record
          // the attempt, move to factory:failed with the reason.
          yield* Effect.ignore(
            run(["git", "-C", worktree, "push", "-u", "origin", branch], workspaceDir)
          )
          // The critical transition first, alone: gh issue edit dies wholesale
          // on a label the repo doesn't have, and a partial edit that removed
          // wip without adding failed strands the issue invisibly (trust-bar
          // run 1, issue #1). The attempt label is a separate best-effort add.
          const attempt = attemptOf(intent.issue.labels) + 1
          yield* Effect.ignore(gh.editIssueLabels(ref, fail.add, fail.remove))
          yield* Effect.ignore(gh.editIssueLabels(ref, [attemptLabel(attempt)], []))
          const cells = yield* Ref.get(cellsRef)
          yield* tell(
            gh,
            ref,
            [
              `Attempt ${attempt} failed: ${error.message}`,
              "detail" in error ? String(error.detail) : "",
              `Branch \`${branch}\` was pushed for autopsy.`,
              "",
              renderInvoice(cells, budgetUsd)
            ].join("\n")
          )
          yield* Ref.set(outcome, "Failed")
        })
      )
    )

    const final = yield* Ref.get(outcome)
    const cells = yield* Ref.get(cellsRef)
    if (final === "Shipped") {
      const invoice = renderInvoice(cells, budgetUsd)
      const summary = yield* Ref.get(qaSummary)
      // PR creation runs gh in the worktree so the head branch is inferred
      // from the issue's own checkout, not the daemon's.
      const worktreeGh = makeGitHubTool(nodeProcessExecutor, worktree, events)
      yield* Effect.ignore(
        Effect.gen(function* () {
          const pr = yield* worktreeGh.createPr(
            intent.issue.title,
            prBody(intent.issue, summary, invoice)
          )
          yield* events.publish(Info.make({ message: `opened ${pr.url}` }))
        })
      )
      yield* Effect.ignore(gh.editIssueLabels(ref, sendToReview.add, sendToReview.remove))
      yield* tell(gh, ref, `Shipped to review on \`${branch}\`.\n\n${invoice}`)
    }
    return { outcome: final, costUsd: totalCost(cells) }
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed<EngineerReport>({ outcome: "Failed", costUsd: 0 }).pipe(
        Effect.tap(() =>
          events.publish(
            Info.make({
              message: `engineer pipeline error for ${intent.target.slug}#${intent.issue.number}: ${error.message}`
            })
          )
        )
      )
    )
  )
