import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Semaphore from "effect/Semaphore"
import { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { makeChat } from "@llm4ts/flow/Chat"
import { CostBudget, type CostCell } from "@llm4ts/flow/CostLedger"
import { makeCostTracker } from "@llm4ts/flow/CostTracker"
import { flowReviewer, implementPlanFlow } from "@llm4ts/flow/Flow"
import type { FlowContextShape } from "@llm4ts/flow/FlowContext"
import { ProcessError, type FlowError } from "@llm4ts/flow/FlowError"
import { Info, type FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import { makeGitHubTool, type GitHubToolShape } from "@llm4ts/flow/GitHubTool"
import { makePlanStore } from "@llm4ts/flow/Persistence"
import { planFrom } from "@llm4ts/flow/Planner"
import { lintCommand, minimalReviewers, reviewAndFixLoop } from "@llm4ts/flow/Review"
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
import {
  ensureWorktree,
  positiveIntOr,
  pruneNonCodingTasks,
  readHandbook,
  resetIssueState,
  run,
  tell,
  totalCost
} from "./Engineer.ts"
import { repoRefOf, type ClaimIntent, type Stage, type WorkerReport } from "./Heartbeat.ts"
import { loadCommentRef, makeChecklistEvents, renderChecklist, saveCommentRef } from "./Checklist.ts"
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
  Labels,
  attemptLabel,
  attemptOf,
  bounce,
  branchFor,
  budgetOverrideUsd,
  doneCode,
  donePlan,
  doneQa,
  doneReview,
  fail,
  isFresh,
  signed
} from "./Protocol.ts"
import { timestampedSurface } from "./Surface.ts"

// The staged pipeline: each stage is a small, independently claimable and
// independently resumable unit that hands off through the label state
// machine. The plan file plus the branch ARE the interface between
// stages — nothing in memory survives a handoff, which is what makes
// per-stage retry and cross-issue concurrency safe.
//
//   ready ─plan▶ planned ─code▶ coded ─review▶ reviewed ─qa▶ review(PR)
//
// A stage failure removes only wip and adds failed, keeping the stage
// checkpoint so a human retry (strip failed) resumes at the same stage.

export const runStage = (
  stage: Stage,
  gh: GitHubToolShape,
  intent: ClaimIntent,
  config: CompanyConfig,
  environment: Readonly<Record<string, string | undefined>>,
  events: FlowEventsShape,
  gitLock: Semaphore.Semaphore
): Effect.Effect<WorkerReport> =>
  Effect.gen(function* () {
    const ref = intent.issue.ref(repoRefOf(intent.target))
    const workspaceDir = resolve(environment["NIGHTCALL_WORKSPACE"] ?? ".factory")
    const stateDir = join(workspaceDir, "state", `${intent.target.owner}__${intent.target.repo}`)
    yield* Effect.tryPromise({
      try: () => mkdir(stateDir, { recursive: true }),
      catch: (error) => ProcessError.make({ message: "mkdir state", detail: String(error) })
    })
    const planPath = join(stateDir, `issue-${intent.issue.number}-plan.md`)
    const planCommentPath = join(stateDir, `issue-${intent.issue.number}-plan-comment.json`)

    if (stage === "plan" && isFresh(intent.issue.labels)) {
      yield* resetIssueState(workspaceDir, intent, planPath)
      yield* Effect.ignore(gh.editIssueLabels(ref, [], [Labels.fresh]))
      yield* tell(
        gh,
        ref,
        "Starting from scratch as requested (factory:fresh): prior branch, worktree, and plan discarded."
      )
    }

    const worktree = yield* ensureWorktree(workspaceDir, intent, gitLock)
    const handbook = yield* readHandbook(process.cwd())
    const budgetUsd = budgetOverrideUsd(intent.issue.labels) ?? config.issueBudgetUsd
    const branch = branchFor(intent.issue.number)
    const gate = environment["NIGHTCALL_GATE"]?.trim()
    const turnLimit = positiveIntOr(environment["NIGHTCALL_TURN_LIMIT"], 50)
    const maxRounds = positiveIntOr(environment["NIGHTCALL_MAX_ROUNDS"], 1)
    const timeoutMinutes = positiveIntOr(environment["NIGHTCALL_ISSUE_TIMEOUT_MINUTES"], 30)

    const startedAtMs = yield* Clock.currentTimeMillis
    const runId = `nightcall-${stage}-${intent.issue.number}-${startedAtMs}`
    const store = makePlanStore(nodePlainFileStore)
    const dependencies = nodeFlowRunnerDependencies()
    const coder = withTurnLimit(coderFromEnv(environment), turnLimit)
    const options = {
      workDir: worktree,
      workspace: worktree,
      userPrompt: engineerBrief(intent.issue, "", handbook),
      coder: CliConnectorConfig.make({ ...coder, workingDir: worktree }),
      tracePath: join(stateDir, `trace-${runId}.jsonl`),
      runId,
      surface: timestampedSurface(),
      verbosity: parseVerbosity(environment["LLM4TS_VERBOSITY"] ?? "verbose"),
      budget: CostBudget.make({ maximumCostUsd: budgetUsd })
    }

    const outcome = yield* Ref.make<WorkerReport["outcome"]>("Failed")
    const qaSummary = yield* Ref.make("")
    const cellsRef = yield* Ref.make<ReadonlyArray<CostCell>>([])
    const gateLint = (context: FlowContextShape) =>
      gate === undefined || gate.length === 0
        ? {}
        : { lint: lintCommand(nodeProcessExecutor, context.events, ["sh", "-lc", gate], worktree) }
    const system = [noopRule, handbook.trim()].filter((part) => part.length > 0).join("\n\n")

    const planBody = (context: FlowContextShape): Effect.Effect<void, FlowError> =>
      Effect.gen(function* () {
        let criteria = ""
        if (!isEpicChild(intent.issue.body)) {
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
        const brief = engineerBrief(intent.issue, criteria, handbook)
        const plan = yield* store
          .recoverOrCreate(planPath, planFrom(context.reasoning, brief))
          .pipe(Effect.map(pruneNonCodingTasks))
        // The plan is posted as ONE task-list comment; its reference is
        // persisted so the code stage keeps checking items off by editing
        // the same comment.
        const commentRef = yield* context.hosting.writeIssueComment(
          ref,
          renderChecklist(
            plan.epicId,
            plan.tasks.map((task) => ({
              title: task.title,
              progress: task.completed ? ("done" as const) : ("pending" as const)
            }))
          )
        )
        if (commentRef !== undefined) {
          yield* saveCommentRef(planCommentPath, commentRef)
        }
        yield* context.hosting.editIssueLabels(ref, donePlan.add, donePlan.remove)
        yield* Ref.set(outcome, "Advanced")
      })

    const codeBody = (context: FlowContextShape): Effect.Effect<void, FlowError> =>
      Effect.gen(function* () {
        const persisted = yield* store.load(planPath)
        if (persisted === undefined) {
          return yield* Effect.fail(
            ProcessError.make({
              message: "code stage",
              detail: "no persisted plan for this issue; run the plan stage first"
            })
          )
        }
        // Prefer the living checklist (edit the plan comment as tasks
        // complete); fall back to per-task tick comments when the plan
        // stage could not capture a comment reference.
        const commentRef = yield* loadCommentRef(planCommentPath)
        const progress =
          commentRef === undefined
            ? yield* makeProgressEvents(context.events, context.hosting, ref)
            : yield* makeChecklistEvents(
                context.events,
                context.hosting,
                commentRef,
                persisted.epicId,
                persisted.tasks.map((task) => ({ title: task.title, completed: task.completed }))
              )
        yield* implementPlanFlow(
          { ...context, events: progress },
          {
            store,
            planPath,
            plan: Effect.succeed(pruneNonCodingTasks(persisted)),
            chatPerTask: true,
            checkoutBranch: false,
            system,
            noopTaskPolicy: "complete",
            reviewers: [],
            maxRounds: 1,
            ...gateLint(context)
          }
        )
        yield* context.git.push("origin", branch)
        yield* context.hosting.editIssueLabels(ref, doneCode.add, doneCode.remove)
        yield* Ref.set(outcome, "Advanced")
      })

    const reviewBody = (context: FlowContextShape): Effect.Effect<void, FlowError> =>
      Effect.gen(function* () {
        const base = yield* context.git.defaultBase
        const coderChat = yield* makeChat(context.coder, {
          system,
          events: context.events,
          agent: "coder",
          manageGit: true
        })
        yield* reviewAndFixLoop({
          reviewers: minimalReviewers,
          reviewerService: flowReviewer(context),
          coder: coderChat,
          taskTitle: `#${intent.issue.number} ${intent.issue.title}`,
          currentDiff: context.git.diffVsBase(base, true),
          events: context.events,
          maxRounds,
          ...gateLint(context)
        })
        const dirty = yield* context.git.diffAll
        if (dirty.trim().length > 0) {
          yield* context.git.commitAll(`review fixes for #${intent.issue.number}`)
        }
        yield* context.git.push("origin", branch)
        yield* context.hosting.editIssueLabels(ref, doneReview.add, doneReview.remove)
        yield* Ref.set(outcome, "Advanced")
      })

    const qaBody = (context: FlowContextShape): Effect.Effect<void, FlowError> =>
      Effect.gen(function* () {
        const base = yield* context.git.defaultBase
        const diff = yield* context.git.diffVsBase(base, true)
        const qa = yield* makeChat(context.reasoning, { events: context.events, agent: "qa" })
        const repoFiles = yield* Effect.orElseSucceed(
          run(["git", "-C", worktree, "ls-files"], workspaceDir).pipe(
            Effect.map((listing) => listing.split("\n").slice(0, 400).join("\n"))
          ),
          () => ""
        )
        const reply =
          diff.trim().length === 0
            ? undefined
            : yield* qa.ask(qaPrompt(intent.issue, "", diff, repoFiles))
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

    const bodies: Record<Stage, (context: FlowContextShape) => Effect.Effect<void, FlowError>> = {
      plan: planBody,
      code: codeBody,
      review: reviewBody,
      qa: qaBody
    }

    yield* Effect.scoped(
      Effect.gen(function* () {
        const bundle = yield* makeFlowRunnerContext(options, dependencies)
        const tracker = yield* makeCostTracker()
        yield* tracker.consume(bundle.events)
        yield* runWithBundle(bundle, options, bodies[stage], dependencies).pipe(
          Effect.timeoutOrElse({
            duration: `${timeoutMinutes} minutes`,
            orElse: () =>
              Effect.fail(
                ProcessError.make({
                  message: `${stage} stage wall clock`,
                  detail: `exceeded ${timeoutMinutes} minutes; the stage checkpoint is intact and a retry resumes here`
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
          yield* Effect.ignore(
            run(["git", "-C", worktree, "push", "-u", "origin", branch], workspaceDir)
          )
          const attempt = attemptOf(intent.issue.labels) + 1
          yield* Effect.ignore(gh.editIssueLabels(ref, fail.add, fail.remove))
          yield* Effect.ignore(gh.editIssueLabels(ref, [attemptLabel(attempt)], []))
          const cells = yield* Ref.get(cellsRef)
          yield* tell(
            gh,
            ref,
            [
              `${stage} stage, attempt ${attempt} failed: ${error.message}`,
              "detail" in error ? String(error.detail) : "",
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
    if (stage === "qa" && final === "Shipped") {
      const invoice = renderInvoice(cells, budgetUsd)
      const summary = yield* Ref.get(qaSummary)
      const persisted = yield* Effect.orElseSucceed(store.load(planPath), () => undefined)
      const taskTitles =
        persisted === undefined
          ? []
          : persisted.tasks.filter((task) => task.completed).map((task) => task.title)
      const commits = yield* Effect.orElseSucceed(
        run(["git", "-C", worktree, "log", "--oneline", "origin/HEAD..HEAD"], workspaceDir),
        () => ""
      )
      const filesChanged = yield* Effect.orElseSucceed(
        run(["git", "-C", worktree, "diff", "--stat", "origin/HEAD...HEAD"], workspaceDir),
        () => ""
      )
      const worktreeGh = makeGitHubTool(nodeProcessExecutor, worktree, events)
      yield* Effect.ignore(
        Effect.gen(function* () {
          const pr = yield* worktreeGh.createPr(
            intent.issue.title,
            prBody(intent.issue, {
              qaSummary: summary,
              taskTitles,
              commits,
              filesChanged,
              gateCommand: gate,
              invoice
            })
          )
          yield* events.publish(Info.make({ message: `opened ${pr.url}` }))
        })
      )
      yield* Effect.ignore(gh.editIssueLabels(ref, doneQa.add, doneQa.remove))
      yield* tell(gh, ref, `Shipped to review on \`${branch}\`.\n\n${invoice}`)
    }
    return { outcome: final, costUsd: totalCost(cells) }
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed<WorkerReport>({ outcome: "Failed", costUsd: 0 }).pipe(
        Effect.tap(() =>
          events.publish(
            Info.make({
              message: `${stage} stage pipeline error for ${intent.target.slug}#${intent.issue.number}: ${error.message}`
            })
          )
        )
      )
    )
  )
