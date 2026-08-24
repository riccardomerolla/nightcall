import { mkdir, readFile, rm, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Semaphore from "effect/Semaphore"
import { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { makeChat } from "@llm4ts/flow/Chat"
import { CostBudget, type CostCell } from "@llm4ts/flow/CostLedger"
import { makeCostTracker } from "@llm4ts/flow/CostTracker"
import { implementPlanFlow } from "@llm4ts/flow/Flow"
import type { FlowContextShape } from "@llm4ts/flow/FlowContext"
import { ProcessError, type FlowError } from "@llm4ts/flow/FlowError"
import { Info, type FlowEventsShape } from "@llm4ts/flow/FlowEvents"
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
import { timestampedSurface } from "./Surface.ts"
import { cloneUrl, type AzureConfig } from "./Azure.ts"
import type { HostingShape, WorkItemRef } from "./Hosting.ts"
import { projectRefOf, type CompanyConfig } from "./Config.ts"
import type { ClaimIntent } from "./Heartbeat.ts"
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
  Tags,
  attemptTag,
  attemptOf,
  bounce,
  branchFor,
  budgetOverrideUsd,
  fail,
  isFresh,
  sendToReview,
  signed
} from "./Protocol.ts"

// One claimed work item, end to end: Tech Lead triage → Engineer
// (implementPlanFlow in a worktree) → QA over the final diff → push, PR,
// factory:review — or the bounce/failure paths. Never fails the daemon:
// every outcome, including errors, resolves to an WorkOutcome and is
// reported on the work item itself.

export type WorkOutcome = "Shipped" | "Bounced" | "Failed"

export const run = (
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

// The company's coder casting in one place. Every seat on this branch is
// the Gemini CLI: llm4ts's coderFromEnv defaults to claude, so the default
// is overridden here rather than left to the operator's environment — a
// company whose coder silently changes with an unset variable is not a
// company. LLM4TS_CODER still wins when the operator sets it explicitly,
// and NIGHTCALL_CODER_MODEL overrides the model (e.g. gemini-2.5-pro).
export const defaultCoder = "gemini"

export const companyCoder = (
  environment: Readonly<Record<string, string | undefined>>
): CliConnectorConfig => {
  const base = coderFromEnv({
    ...environment,
    LLM4TS_CODER:
      environment["LLM4TS_CODER"]?.trim() ||
      environment["LLM4ZIO_CODER"]?.trim() ||
      defaultCoder
  })
  const model = environment["NIGHTCALL_CODER_MODEL"]?.trim()
  return model === undefined || model.length === 0
    ? base
    : CliConnectorConfig.make({ ...base, model })
}

export const positiveIntOr = (raw: string | undefined, fallback: number): number => {
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const exists = (path: string): Effect.Effect<boolean> =>
  Effect.tryPromise({ try: () => stat(path), catch: () => "missing" }).pipe(
    Effect.map(() => true),
    Effect.catch(() => Effect.succeed(false))
  )

export const workItemPaths = (
  workspaceDir: string,
  intent: ClaimIntent
): { readonly repoDir: string; readonly worktree: string } => {
  const slugDir = `${intent.target.project}__${intent.target.repository}`
  return {
    repoDir: join(workspaceDir, "repos", slugDir),
    worktree: join(workspaceDir, "worktrees", slugDir, `item-${intent.item.id}`)
  }
}

// factory:fresh — discard every trace of prior attempts so the run starts
// from a brand-new branch off origin/HEAD: worktree, persisted plan, and
// the branch locally and on the remote. All best-effort: a partially
// applied reset still proceeds (worktree add -B re-points the branch).
export const resetWorkItemState = (
  workspaceDir: string,
  intent: ClaimIntent,
  planPath: string
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { repoDir, worktree } = workItemPaths(workspaceDir, intent)
    const branch = branchFor(intent.item.id)
    yield* Effect.ignore(
      Effect.tryPromise({
        try: () => rm(worktree, { recursive: true, force: true }),
        catch: (error) => String(error)
      })
    )
    yield* Effect.ignore(run(["git", "-C", repoDir, "worktree", "prune"], workspaceDir))
    yield* Effect.ignore(run(["git", "-C", repoDir, "branch", "-D", branch], workspaceDir))
    yield* Effect.ignore(
      run(["git", "-C", repoDir, "push", "origin", "--delete", branch], workspaceDir)
    )
    yield* Effect.ignore(
      Effect.tryPromise({ try: () => rm(planPath, { force: true }), catch: (error) => String(error) })
    )
  })

// Clone-on-first-use per target, then a worktree per work item. An
// existing worktree is reused as-is: the persisted plan inside it makes a
// re-run resume instead of restart (DESIGN.md reconciliation).
//
// Azure DevOps has no `az repos clone`, so the remote is the plain HTTPS
// git URL and git's own credential helper authenticates it. That is
// deliberate: putting a PAT in the URL would write a secret into argv and
// into .git/config on disk.
export const ensureWorktree = (
  workspaceDir: string,
  azure: AzureConfig,
  intent: ClaimIntent,
  lock?: Semaphore.Semaphore
): Effect.Effect<string, FlowError> => {
  const setup = Effect.gen(function* () {
    const { repoDir, worktree } = workItemPaths(workspaceDir, intent)
    yield* Effect.tryPromise({
      try: () => mkdir(join(workspaceDir, "repos"), { recursive: true }),
      catch: (error) => ProcessError.make({ message: "mkdir", detail: String(error) })
    })
    if (!(yield* exists(repoDir))) {
      yield* run(
        ["git", "clone", cloneUrl(azure, projectRefOf(intent.target)), repoDir],
        workspaceDir
      )
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
          branchFor(intent.item.id),
          worktree,
          "origin/HEAD"
        ],
        workspaceDir
      )
    }
    return worktree
  })
  // Clone/fetch/worktree-add touch the shared per-target clone; concurrent
  // stage workers serialize just this setup, then run free.
  return lock === undefined ? setup : lock.withPermits(1)(setup)
}

export const readHandbook = (cwd: string): Effect.Effect<string> =>
  Effect.tryPromise({
    try: () => readFile(join(cwd, "COMPANY.md"), "utf8"),
    catch: () => "missing"
  }).pipe(Effect.catch(() => Effect.succeed("")))

export interface EngineerReport {
  readonly outcome: WorkOutcome
  readonly costUsd: number
}

export const totalCost = (cells: ReadonlyArray<CostCell>): number =>
  cells.reduce((sum, cell) => sum + (cell.costUsd ?? 0), 0)

// Post-run bookkeeping helpers are best-effort: a failed comment must not
// turn a shipped work item into a crashed daemon.
export const tell = (
  hosting: HostingShape,
  ref: WorkItemRef,
  body: string
): Effect.Effect<void> => Effect.ignore(hosting.writeComment(ref, signed(body)))

export const runWorkItem = (
  hosting: HostingShape,
  azure: AzureConfig,
  intent: ClaimIntent,
  config: CompanyConfig,
  environment: Readonly<Record<string, string | undefined>>,
  events: FlowEventsShape
): Effect.Effect<EngineerReport> =>
  Effect.gen(function* () {
    const ref = intent.item.ref(projectRefOf(intent.target))
    const workspaceDir = resolve(environment["NIGHTCALL_WORKSPACE"] ?? ".factory")
    // Plans and traces live OUTSIDE the worktree: commitAll sweeps the
    // whole tree, and run-state (prompts, tool output) must never land in
    // the target repo's history. State survives worktree deletion, which
    // also makes resume more robust.
    const stateDir = join(
      workspaceDir,
      "state",
      `${intent.target.project}__${intent.target.repository}`
    )
    yield* Effect.tryPromise({
      try: () => mkdir(stateDir, { recursive: true }),
      catch: (error) => ProcessError.make({ message: "mkdir state", detail: String(error) })
    })
    const planPath = join(stateDir, `item-${intent.item.id}-plan.md`)

    if (isFresh(intent.item.tags)) {
      yield* resetWorkItemState(workspaceDir, intent, planPath)
      yield* Effect.ignore(hosting.editTags(ref, [], [Tags.fresh]))
      yield* tell(hosting, ref, "Starting from scratch as requested (factory:fresh): prior branch, worktree, and plan discarded.")
    }

    const worktree = yield* ensureWorktree(workspaceDir, azure, intent)
    const handbook = yield* readHandbook(process.cwd())
    const budgetUsd = budgetOverrideUsd(intent.item.tags) ?? config.issueBudgetUsd
    const branch = branchFor(intent.item.id)
    const gate = environment["NIGHTCALL_GATE"]?.trim()

    const startedAtMs = yield* Clock.currentTimeMillis
    const runId = `nightcall-${intent.item.id}-${startedAtMs}`
    const store = makePlanStore(nodePlainFileStore)
    const dependencies = nodeFlowRunnerDependencies()
    // Bounded darkness: a per-task turn limit and a per-item wall clock.
    // Trust-bar run 3 spent 84 minutes and 90k tokens on one importer task
    // before the CLI died — without bounds, one degenerate task holds the
    // company's only seat for hours.
    const turnLimit = positiveIntOr(environment["NIGHTCALL_TURN_LIMIT"], 50)
    // Internal review is triple-checked downstream (fresh-context QA, PR
    // CI), so default to a single round; NIGHTCALL_INTERNAL_REVIEW=off
    // skips the reviewer seats entirely and leaves the lint gate.
    const maxRounds = positiveIntOr(environment["NIGHTCALL_MAX_ROUNDS"], 1)
    const internalReview = environment["NIGHTCALL_INTERNAL_REVIEW"] !== "off"
    const timeoutMinutes = positiveIntOr(environment["NIGHTCALL_ISSUE_TIMEOUT_MINUTES"], 30)
    const coder = withTurnLimit(companyCoder(environment), turnLimit)
    const options = {
      workDir: worktree,
      workspace: worktree,
      userPrompt: engineerBrief(intent.item, "", handbook),
      coder: CliConnectorConfig.make({ ...coder, workingDir: worktree }),
      tracePath: join(stateDir, `trace-${runId}.jsonl`),
      runId,
      surface: timestampedSurface(),
      verbosity: parseVerbosity(environment["LLM4TS_VERBOSITY"] ?? "verbose"),
      budget: CostBudget.make({ maximumCostUsd: budgetUsd })
    }

    const outcome = yield* Ref.make<WorkOutcome>("Failed")
    const qaSummary = yield* Ref.make("")
    const cellsRef = yield* Ref.make<ReadonlyArray<CostCell>>([])

    const body = (context: FlowContextShape): Effect.Effect<void, FlowError> =>
      Effect.gen(function* () {
        // Epic children were specified by the Tech Lead's own
        // decomposition — re-triaging them in fresh context invites
        // self-second-guessing (trust-bar run: the triager bounced a
        // child its decomposition wrote). Their body IS the criteria.
        let criteria = ""
        if (!isEpicChild(intent.item.body)) {
          // Tech Lead: fresh chat on the read-only reasoning seat. An
          // unparseable verdict bounces — a confused triager must never
          // green-light work.
          const techLead = yield* makeChat(context.reasoning, {
            system: handbook,
            events: context.events,
            agent: "techlead"
          })
          const triage = parseTriage(yield* techLead.ask(triagePrompt(intent.item)))
          if (triage === undefined || triage.kind === "Bounce") {
            const questions =
              triage === undefined
                ? "Triage could not reach a verdict; please tighten the item description."
                : triage.questions
            yield* hosting.writeComment(
              ref,
              signed(`Bounced by the Tech Lead:\n\n${questions}`)
            )
            yield* hosting.editTags(ref, bounce.add, bounce.remove)
            yield* Ref.set(outcome, "Bounced")
            return
          }
          criteria = triage.criteria
        }

        // Engineer: plan once (resumable), then the proven per-task
        // machinery from implementPlanFlow. Stage events are mirrored to
        // the work item as ▶/✔/✖ progress comments.
        const brief = engineerBrief(intent.item, criteria, handbook)
        const plan = store
          .recoverOrCreate(planPath, planFrom(context.reasoning, brief))
          .pipe(Effect.map(pruneNonCodingTasks))
        const progress = yield* makeProgressEvents(context.events, hosting, ref)
        yield* implementPlanFlow({ ...context, events: progress }, {
          store,
          planPath,
          plan,
          chatPerTask: true,
          checkoutBranch: false,
          system: [noopRule, handbook.trim()].filter((part) => part.length > 0).join("\n\n"),
          // QA and the CI gate re-judge the final state, so an unconfirmed
          // no-op task completes with a notice instead of sinking the run
          // (this exact failure burned three attempts on one work item).
          noopTaskPolicy: "complete",
          ...(internalReview ? {} : { reviewers: [] }),
          maxRounds,
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
        // QA sees the tracked-file listing so it never rejects for assets
        // that already exist outside the diff (trust-bar false positive on
        // the fixtures the seed committed).
        const repoFiles = yield* Effect.orElseSucceed(
          run(["git", "-C", worktree, "ls-files"], workspaceDir).pipe(
            Effect.map((listing) => listing.split("\n").slice(0, 400).join("\n"))
          ),
          () => ""
        )
        const reply =
          diff.trim().length === 0
            ? undefined
            : yield* qa.ask(qaPrompt(intent.item, criteria, diff, repoFiles))
        const verdict =
          reply === undefined
            ? ({ kind: "Reject", findings: "The change produced an empty diff." } as const)
            : parseQa(reply)
        if (verdict === undefined || verdict.kind === "Reject") {
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
        if (verdict.kind === "Clarify") {
          yield* hosting.writeComment(
            ref,
            signed(`QA needs clarification before shipping:\n\n${verdict.questions}`)
          )
          yield* hosting.editTags(ref, bounce.add, bounce.remove)
          yield* Ref.set(outcome, "Bounced")
          return
        }
        yield* Ref.set(qaSummary, verdict.summary)
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
                  message: "item wall clock",
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
          // The critical transition first, alone: a partial tag edit that
          // removed wip without adding failed strands the work item
          // invisibly (trust-bar run 1). The attempt tag is a separate
          // best-effort add.
          const attempt = attemptOf(intent.item.tags) + 1
          yield* Effect.ignore(hosting.editTags(ref, fail.add, fail.remove))
          yield* Effect.ignore(hosting.editTags(ref, [attemptTag(attempt)], []))
          const cells = yield* Ref.get(cellsRef)
          yield* tell(
            hosting,
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
      // PR context is assembled deterministically: completed plan tasks,
      // the branch's commits and file stat vs origin/HEAD, and the gate.
      const persisted = yield* Effect.orElseSucceed(store.load(planPath), () => undefined)
      const taskTitles =
        persisted === undefined
          ? []
          : persisted.tasks.filter((task) => task.completed).map((task) => task.title)
      const commits = yield* Effect.orElseSucceed(
        run(["git", "-C", worktree, "log", "--oneline", "origin/HEAD..HEAD"], workspaceDir),
        () => ""
      )
      // The branch is named explicitly rather than inferred from a working
      // directory: `az repos pr create` targets a repository, not a cwd, so
      // one hosting instance opens PRs for every work item.
      yield* Effect.ignore(
        Effect.gen(function* () {
          const pr = yield* hosting.createPr(
            projectRefOf(intent.target),
            branch,
            intent.item.id,
            intent.item.title,
            prBody(intent.item, {
              qaSummary: summary,
              taskTitles,
              commits,
              gateCommand: gate,
              invoice
            })
          )
          yield* events.publish(Info.make({ message: `opened ${pr.url}` }))
        })
      )
      yield* Effect.ignore(hosting.editTags(ref, sendToReview.add, sendToReview.remove))
      yield* tell(hosting, ref, `Shipped to review on \`${branch}\`.\n\n${invoice}`)
    }
    return { outcome: final, costUsd: totalCost(cells) }
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed<EngineerReport>({ outcome: "Failed", costUsd: 0 }).pipe(
        Effect.tap(() =>
          events.publish(
            Info.make({
              message: `engineer pipeline error for ${intent.target.slug}#${intent.item.id}: ${error.message}`
            })
          )
        )
      )
    )
  )
