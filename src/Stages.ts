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
import { makePlanStore } from "@llm4ts/flow/Persistence"
import { Plan, Task } from "@llm4ts/flow/Plan"
import { planFrom } from "@llm4ts/flow/Planner"
import { lintCommand, minimalReviewers, reviewAndFixLoop } from "@llm4ts/flow/Review"
import { withTurnLimit } from "@llm4ts/runner/Connectors"
import {
  makeFlowRunnerContext,
  nodeFlowRunnerDependencies,
  runWithBundle
} from "@llm4ts/runner/FlowRunner"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { nodeProcessExecutor } from "@llm4ts/runner/NodeProcessExecutor"
import { parseVerbosity } from "@llm4ts/runner/Terminal"
import type { AzureConfig } from "./Azure.ts"
import type { HostingShape } from "./Hosting.ts"
import {
  companyCoder,
  ensureWorktree,
  workItemPaths,
  positiveIntOr,
  pruneNonCodingTasks,
  readHandbook,
  resetWorkItemState,
  run,
  tell,
  totalCost
} from "./Engineer.ts"
import type { ClaimIntent, Stage, WorkerReport } from "./Heartbeat.ts"
import { projectRefOf, type CompanyConfig } from "./Config.ts"
import { resolveWorkspace, unroutableNotice } from "./Workspace.ts"
import { loadCommentRef, makeChecklistEvents, renderChecklist, saveCommentRef } from "./Checklist.ts"
import { makeProgressEvents } from "./Progress.ts"
import {
  engineerBrief,
  guidanceSince,
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
  budgetOverrideUsd,
  doneCode,
  donePlan,
  doneQa,
  doneReview,
  fail,
  isFresh,
  restart,
  signature,
  signed
} from "./Protocol.ts"
import { describeError, timestampedSurface } from "./Surface.ts"

// The staged pipeline: each stage is a small, independently claimable and
// independently resumable unit that hands off through the tag state
// machine. The plan file plus the branch ARE the interface between
// stages — nothing in memory survives a handoff, which is what makes
// per-stage retry and cross-item concurrency safe.
//
//   ready ─plan▶ planned ─code▶ coded ─review▶ reviewed ─qa▶ review(PR)
//
// A stage failure removes only wip and adds failed, keeping the stage
// checkpoint so a human retry (strip failed) resumes at the same stage.

export const runStage = (
  stage: Exclude<Stage, "mend">,
  hosting: HostingShape,
  azure: AzureConfig,
  intent: ClaimIntent,
  config: CompanyConfig,
  environment: Readonly<Record<string, string | undefined>>,
  events: FlowEventsShape,
  gitLock: Semaphore.Semaphore
): Effect.Effect<WorkerReport> =>
  Effect.gen(function* () {
    const ref = intent.item.ref(projectRefOf(intent.target))
    const workspaceDir = resolve(environment["NIGHTCALL_WORKSPACE"] ?? ".factory")
    // A board spans repositories, so the Development links decide which one
    // this work item is worked in before any path is built.
    const routing = yield* resolveWorkspace(hosting, intent.target, ref, intent.item)
    if (routing._tag === "Undetermined") {
      // Not a routing decision — see Workspace.ts. Give the claim back and
      // leave the item's tags alone so the next beat retries it.
      yield* Effect.logWarning(
        `${intent.target.slug}#${intent.item.id}: cannot route — ${routing.detail}`
      )
      yield* Effect.ignore(hosting.editTags(ref, [], [Tags.wip]))
      return { outcome: "Failed" as const, costUsd: 0 }
    }
    if (routing._tag === "Unroutable") {
      yield* Effect.ignore(hosting.editTags(ref, bounce.add, bounce.remove))
      yield* tell(hosting, ref, unroutableNotice(intent.target, routing.links))
      return { outcome: "Bounced" as const, costUsd: 0 }
    }
    const workspace = routing.workspace
    const stateDir = join(
      workspaceDir,
      "state",
      `${intent.target.project}__${workspace.repository}`
    )
    yield* Effect.tryPromise({
      try: () => mkdir(stateDir, { recursive: true }),
      catch: (error) => ProcessError.make({ message: "mkdir state", detail: String(error) })
    })
    const planPath = join(stateDir, `item-${intent.item.id}-plan.md`)
    const planCommentPath = join(stateDir, `item-${intent.item.id}-plan-comment.json`)

    if (isFresh(intent.item.tags)) {
      yield* resetWorkItemState(workspaceDir, intent, workspace, planPath)
      if (stage === "plan") {
        yield* Effect.ignore(hosting.editTags(ref, [], [Tags.fresh]))
        yield* tell(
          hosting,
          ref,
          "Starting from scratch as requested (factory:fresh): prior branch, worktree, and plan discarded."
        )
      } else {
        // Only the plan stage was reading this tag, so an item stuck at
        // planned/coded/reviewed — the state an operator actually reaches
        // for factory:fresh in — was claimed by a later stage that never
        // looked at it, and the reset never ran. A later stage cannot
        // start over in place either: its input is the plan and branch the
        // reset just discarded. Send the item back to the front instead.
        yield* Effect.ignore(hosting.editTags(ref, restart.add, restart.remove))
        yield* tell(
          hosting,
          ref,
          "Starting from scratch as requested (factory:fresh): prior branch, worktree, and " +
            `plan discarded at the ${stage} stage. Back to \`factory:ready\` — the next beat ` +
            "plans this from nothing."
        )
        return { outcome: "Advanced" as const, costUsd: 0 }
      }
    }

    const worktree = yield* ensureWorktree(workspaceDir, azure, intent, workspace, gitLock)
    const handbook = yield* readHandbook(process.cwd())
    const budgetUsd = budgetOverrideUsd(intent.item.tags) ?? config.issueBudgetUsd
    const branch = workspace.branch
    const gate = environment["NIGHTCALL_GATE"]?.trim()
    const turnLimit = positiveIntOr(environment["NIGHTCALL_TURN_LIMIT"], 50)
    const maxRounds = positiveIntOr(environment["NIGHTCALL_MAX_ROUNDS"], 1)
    const timeoutMinutes = positiveIntOr(environment["NIGHTCALL_ISSUE_TIMEOUT_MINUTES"], 30)

    const startedAtMs = yield* Clock.currentTimeMillis
    const runId = `nightcall-${stage}-${intent.item.id}-${startedAtMs}`
    const store = makePlanStore(nodePlainFileStore)
    const dependencies = nodeFlowRunnerDependencies()
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
        if (!isEpicChild(intent.item.body)) {
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
        const brief = engineerBrief(intent.item, criteria, handbook)
        const plan = yield* store
          .recoverOrCreate(planPath, planFrom(context.reasoning, brief))
          .pipe(Effect.map(pruneNonCodingTasks))
        // The plan is posted as ONE task-list comment; its reference is
        // persisted so the code stage keeps checking items off by editing
        // the same comment.
        const commentRef = yield* hosting.writeComment(
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
        yield* hosting.editTags(ref, donePlan.add, donePlan.remove)
        yield* Ref.set(outcome, "Advanced")
      })

    const codeBody = (context: FlowContextShape): Effect.Effect<void, FlowError> =>
      Effect.gen(function* () {
        let persisted = yield* store.load(planPath)
        if (persisted === undefined) {
          return yield* Effect.fail(
            ProcessError.make({
              message: "code stage",
              detail: "no persisted plan for this item; run the plan stage first"
            })
          )
        }
        // A plan with nothing left to do means this round exists because
        // someone sent the item back. Two task sources, in priority order:
        // a red gate (deterministic — the machine knows what is broken),
        // then human guidance comments since Nightcall's last report.
        if (pruneNonCodingTasks(persisted).nextIncomplete === undefined) {
          const gateFailure =
            gate === undefined || gate.length === 0
              ? undefined
              : yield* run(["sh", "-lc", `cd '${worktree}' && ${gate}`], workspaceDir).pipe(
                  Effect.map((): string | undefined => undefined),
                  Effect.catch((error) =>
                    Effect.succeed<string | undefined>(
                      "detail" in error ? String(error.detail) : error.message
                    )
                  )
                )
          if (gateFailure !== undefined) {
            persisted = Plan.make({
              epicId: persisted.epicId,
              tasks: [
                ...persisted.tasks,
                Task.make({
                  title: "Make the gate green",
                  description:
                    "The gate currently fails on this branch. Fix the failures.\n" +
                    "Gate output (tail):\n" +
                    gateFailure.slice(-1500)
                })
              ],
              ...(persisted.brief === undefined ? {} : { brief: persisted.brief })
            })
            yield* store.save(planPath, persisted)
          }
        }
        // Human guidance becomes a task on EVERY round — a CEO steering a
        // mid-plan item must not be ignored until the plan completes.
        // Deduped: skip when the newest guidance already has its task.
        {
          const comments = yield* hosting
            .readComments(ref)
            .pipe(Effect.orElseSucceed(() => []))
          const guidance = guidanceSince(comments, signature)
          const guidanceText = guidance
            .map((entry) => `${entry.author}: ${entry.body}`)
            .join("\n\n")
          const alreadyTasked = persisted.tasks.some(
            (task) => task.description === guidanceText
          )
          if (guidance.length > 0 && !alreadyTasked) {
            persisted = Plan.make({
              epicId: persisted.epicId,
              tasks: [
                ...persisted.tasks,
                Task.make({
                  title: "Apply CEO guidance",
                  description: guidanceText
                })
              ],
              ...(persisted.brief === undefined ? {} : { brief: persisted.brief })
            })
            yield* store.save(planPath, persisted)
          }
        }
        // Prefer the living checklist (edit the plan comment as tasks
        // complete); fall back to per-task tick comments when the plan
        // stage could not capture a comment reference.
        const commentRef = yield* loadCommentRef(planCommentPath)
        const progress =
          commentRef === undefined
            ? yield* makeProgressEvents(context.events, hosting, ref)
            : yield* makeChecklistEvents(
                context.events,
                hosting,
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
        // The branch exists on the remote from this point on, so the board
        // can show it. A human-linked branch already has its link.
        if (!workspace.linked) {
          yield* Effect.ignore(hosting.linkBranch(ref, workspace.repository, branch))
        }
        yield* hosting.editTags(ref, doneCode.add, doneCode.remove)
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
          taskTitle: `#${intent.item.id} ${intent.item.title}`,
          currentDiff: context.git.diffVsBase(base, true),
          events: context.events,
          maxRounds,
          ...gateLint(context)
        })
        const dirty = yield* context.git.diffAll
        if (dirty.trim().length > 0) {
          yield* context.git.commitAll(`review fixes for #${intent.item.id}`)
        }
        yield* context.git.push("origin", branch)
        yield* hosting.editTags(ref, doneReview.add, doneReview.remove)
        yield* Ref.set(outcome, "Advanced")
      })

    const qaBody = (context: FlowContextShape): Effect.Effect<void, FlowError> =>
      Effect.gen(function* () {
        // CEO override: factory:ship skips the QA verdict entirely — the
        // human has judged the work done. Recorded in the PR body.
        if (intent.item.tags.includes(Tags.ship)) {
          yield* Ref.set(
            qaSummary,
            "Review: shipped by CEO override (factory:ship); the QA verdict was waived."
          )
          yield* Effect.ignore(hosting.editTags(ref, [], [Tags.ship]))
          yield* context.git.push("origin", branch)
          yield* Ref.set(outcome, "Shipped")
          return
        }
        const base = yield* context.git.defaultBase
        const diff = yield* context.git.diffVsBase(base, true)
        // The plan is the authorized scope: QA judges the diff against it,
        // not against a scope it re-derives (a QA once rejected the EUR 500
        // deferral rule the plan explicitly ordered).
        const planned = yield* Effect.orElseSucceed(store.load(planPath), () => undefined)
        const criteria =
          planned === undefined
            ? ""
            : [
                "The plan below was approved at the plan stage; everything in",
                "it is IN scope by definition.",
                "",
                ...planned.tasks.map((task) => `- ${task.title}: ${task.description}`)
              ].join("\n")
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
            : yield* qa.ask(qaPrompt(intent.item, criteria, diff, repoFiles))
        const verdict =
          reply === undefined
            ? ({ kind: "Reject", findings: "The change produced an empty diff." } as const)
            : parseQa(reply)
        if (verdict === undefined) {
          return yield* Effect.fail(
            ProcessError.make({
              message: "qa review",
              detail: `QA reply carried no parseable verdict. Raw reply:\n${(reply ?? "").slice(0, 1500)}`
            })
          )
        }
        if (verdict.kind === "Clarify") {
          // QA's upward channel: intent/scope questions go to the human,
          // the pipeline parks at needs-info instead of burning attempts.
          yield* hosting.writeComment(
            ref,
            signed(`QA needs clarification before shipping:\n\n${verdict.questions}`)
          )
          yield* hosting.editTags(
            ref,
            [Tags.needsInfo],
            [Tags.wip, Tags.reviewed]
          )
          yield* Ref.set(outcome, "Bounced")
          return
        }
        if (verdict.kind === "Reject") {
          const attempt = attemptOf(intent.item.tags) + 1
          if (attemptOf(intent.item.tags) >= config.maxAttempts) {
            // Ask for help instead of failing: the engineer's rounds are not
            // converging, so the item parks at needs-info with a full
            // account and the CEO's options. Guidance comments feed the next
            // round's plan (see the code stage).
            yield* hosting.writeComment(
              ref,
              signed(
                [
                  `This item is stuck: QA has rejected ${attempt} round(s) of fixes`,
                  "and the engineer is not converging. Latest findings:",
                  "",
                  verdict.findings,
                  "",
                  `The work so far is on branch \`${branch}\`.`,
                  "",
                  "How should we proceed? Your moves:",
                  "- Reply with guidance as a comment, then add `factory:planned`",
                  "  — the engineer runs another round applying your guidance.",
                  "- Take the branch over manually, or close this item."
                ].join("\n")
              )
            )
            yield* hosting.editTags(
              ref,
              [Tags.needsInfo],
              [Tags.wip, Tags.reviewed]
            )
            yield* Ref.set(outcome, "Bounced")
            return
          }
          // Findings become a plan task and the item loops back through
          // code → review → QA — the iteration the org chart promised.
          const planned = yield* store.load(planPath)
          if (planned !== undefined) {
            yield* store.save(
              planPath,
              Plan.make({
                epicId: planned.epicId,
                tasks: [
                  ...planned.tasks,
                  Task.make({
                    title: `Address QA findings (round ${attempt})`,
                    description: verdict.findings
                  })
                ],
                ...(planned.brief === undefined ? {} : { brief: planned.brief })
              })
            )
          }
          yield* hosting.writeComment(
            ref,
            signed(
              `QA requested changes (round ${attempt}) — sending back to the code stage:\n\n${verdict.findings}`
            )
          )
          yield* hosting.editTags(
            ref,
            [Tags.planned, attemptTag(attempt)],
            [Tags.wip, Tags.reviewed]
          )
          yield* Ref.set(outcome, "Iterated")
          return
        }
        yield* Ref.set(qaSummary, verdict.summary)
        yield* context.git.push("origin", branch)
        yield* Ref.set(outcome, "Shipped")
      })

    const bodies: Record<
      Exclude<Stage, "mend">,
      (context: FlowContextShape) => Effect.Effect<void, FlowError>
    > = {
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
          const cells = yield* Ref.get(cellsRef)
          if (error._tag === "BudgetExceeded") {
            // Running out of budget is a governance pause, not an
            // engineering failure: the committed work stands, no attempt
            // is burned. The CEO approves more spend with a budget tag.
            // Strip every queue tag too: the stage checkpoints outrank
            // needs-info in phase precedence, so leaving them would let
            // the next beat re-claim the paused item and keep spending.
            yield* Effect.ignore(
              hosting.editTags(
                ref,
                [Tags.needsInfo],
                [Tags.wip, Tags.ready, Tags.planned, Tags.coded, Tags.reviewed]
              )
            )
            yield* tell(
              hosting,
              ref,
              [
                `Budget exhausted during the ${stage} stage: this item's`,
                `budget is $${budgetUsd.toFixed(2)} and the run exceeded it.`,
                "Completed work is committed and pushed on the branch.",
                "",
                `To authorize more: add \`factory:budget-${Math.ceil(budgetUsd * 2)}\``,
                "(or any factory:budget-N) plus the stage's queue tag",
                `(\`factory:${stage === "plan" ? "ready" : stage === "code" ? "planned" : stage === "review" ? "coded" : "reviewed"}\`) and remove factory:needs-info.`,
                "Or close/reassign if the spend is not worth it.",
                "",
                renderInvoice(cells, budgetUsd)
              ].join("\n")
            )
            yield* Ref.set(outcome, "Bounced")
            return
          }
          const attempt = attemptOf(intent.item.tags) + 1
          yield* Effect.ignore(hosting.editTags(ref, fail.add, fail.remove))
          yield* Effect.ignore(hosting.editTags(ref, [attemptTag(attempt)], []))
          yield* tell(
            hosting,
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
      yield* Effect.ignore(
        Effect.gen(function* () {
          const pr = yield* hosting.createPr(
            projectRefOf(intent.target, workspace.repository),
            branch,
            intent.item.id,
            intent.item.title,
            prBody(intent.item, {
              qaSummary: summary,
              taskTitles,
              commits,
              gateCommand: gate,
              invoice
            }),
            workspace.base
          )
          // `az repos pr create --work-items` links a PR it creates; this
          // also covers a branch that already had one, and is a no-op when
          // the link is already there.
          yield* Effect.ignore(hosting.linkPullRequest(ref, workspace.repository, pr.id))
          yield* events.publish(Info.make({ message: `opened ${pr.url}` }))
        })
      )
      yield* Effect.ignore(hosting.editTags(ref, doneQa.add, doneQa.remove))
      yield* tell(hosting, ref, `Shipped to review on \`${branch}\`.\n\n${invoice}`)
    }
    return { outcome: final, costUsd: totalCost(cells) }
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed<WorkerReport>({ outcome: "Failed", costUsd: 0 }).pipe(
        Effect.tap(() =>
          events.publish(
            Info.make({
              message:
                `${stage} stage pipeline error for ${intent.target.slug}#${intent.item.id}: ` +
                describeError(error)
            })
          )
        )
      )
    )
  )

// Mend: keep open PRs mergeable as main moves. Cheap and LLM-free when the
// branch already contains origin/HEAD; otherwise rebase, and when the
// rebase conflicts, a coder agent resolves the markers file-by-file before
// the rebase continues. The branch is force-pushed (with lease) so the PR
// heals in place. Failure marks factory:failed but keeps factory:review,
// so a human can strip failed to retry after the queue settles.
export const runMend = (
  hosting: HostingShape,
  intent: ClaimIntent,
  config: CompanyConfig,
  environment: Readonly<Record<string, string | undefined>>,
  events: FlowEventsShape,
  gitLock: Semaphore.Semaphore
): Effect.Effect<WorkerReport> =>
  Effect.gen(function* () {
    const ref = intent.item.ref(projectRefOf(intent.target))
    const workspaceDir = resolve(environment["NIGHTCALL_WORKSPACE"] ?? ".factory")
    const routing = yield* resolveWorkspace(hosting, intent.target, ref, intent.item)
    if (routing._tag !== "Routed") {
      if (routing._tag === "Undetermined") {
        yield* Effect.logWarning(
          `${intent.target.slug}#${intent.item.id}: cannot route — ${routing.detail}`
        )
      }
      yield* Effect.ignore(hosting.editTags(ref, [], [Tags.wip]))
      return { outcome: "Failed" as const, costUsd: 0 }
    }
    const workspace = routing.workspace
    // An item at factory:review is claimed by mend, so this is the stage
    // that sees factory:fresh on anything with an open pull request. Same
    // answer as the other stages: reset and go back to the front. The pull
    // request is left alone — closing one is not this tag's job.
    if (isFresh(intent.item.tags)) {
      const planPath = join(
        workspaceDir,
        "state",
        `${intent.target.project}__${workspace.repository}`,
        `item-${intent.item.id}-plan.md`
      )
      yield* resetWorkItemState(workspaceDir, intent, workspace, planPath)
      yield* Effect.ignore(hosting.editTags(ref, restart.add, restart.remove))
      yield* tell(
        hosting,
        ref,
        "Starting from scratch as requested (factory:fresh): prior branch, worktree, and plan " +
          "discarded. Back to `factory:ready`. Any open pull request is left for you to close."
      )
      return { outcome: "Advanced" as const, costUsd: 0 }
    }
    const { repoDir, worktree } = workItemPaths(workspaceDir, intent, workspace.repository)
    const branch = workspace.branch
    const gate = environment["NIGHTCALL_GATE"]?.trim()
    const unclaim = Effect.ignore(hosting.editTags(ref, [], [Tags.wip]))
    const attempt = (effect: Effect.Effect<string, FlowError>): Effect.Effect<boolean> =>
      effect.pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false)
      )

    const prepared = yield* gitLock.withPermits(1)(
      Effect.gen(function* () {
        yield* run(["git", "-C", repoDir, "fetch", "origin", "--prune"], workspaceDir)
        const hasWorktree = yield* attempt(run(["git", "-C", worktree, "rev-parse", "HEAD"], workspaceDir))
        if (!hasWorktree) {
          // Recreate from the PUSHED branch — never from origin/HEAD, which
          // would silently discard the PR's commits. Prune first: a
          // registration whose directory is gone still holds the branch,
          // and `worktree add -B` refuses it — see ensureWorktree.
          yield* Effect.ignore(run(["git", "-C", repoDir, "worktree", "prune"], workspaceDir))
          return yield* attempt(
            run(
              ["git", "-C", repoDir, "worktree", "add", "-B", branch, worktree, `origin/${branch}`],
              workspaceDir
            )
          )
        }
        return true
      })
    ).pipe(Effect.orElseSucceed(() => false))
    if (!prepared) {
      yield* unclaim
      return { outcome: "Failed" as const, costUsd: 0 }
    }

    // REBASE_HEAD lingers after a finished rebase, so in-progress means
    // the rebase state directory exists — the only reliable signal.
    const rebaseInProgress = attempt(
      run(
        [
          "sh",
          "-lc",
          `test -d "$(git -C '${worktree}' rev-parse --git-path rebase-merge)" || test -d "$(git -C '${worktree}' rev-parse --git-path rebase-apply)"`
        ],
        workspaceDir
      )
    )
    const localSha = yield* run(["git", "-C", worktree, "rev-parse", "HEAD"], workspaceDir).pipe(
      Effect.orElseSucceed(() => "")
    )
    const remoteSha = yield* run(
      ["git", "-C", worktree, "rev-parse", `origin/${branch}`],
      workspaceDir
    ).pipe(Effect.orElseSucceed(() => ""))
    const ancestor = yield* attempt(
      run(["git", "-C", worktree, "merge-base", "--is-ancestor", "origin/HEAD", "HEAD"], workspaceDir)
    )
    // Continuous delivery: once the branch is confirmed current, merge the
    // PR automatically when its checks are green. NIGHTCALL_AUTO_MERGE=off
    // restores the human merge gate.
    const shipIfGreen: Effect.Effect<boolean> =
      environment["NIGHTCALL_AUTO_MERGE"] === "off"
        ? Effect.succeed(false)
        : Effect.gen(function* () {
            const pr = yield* hosting
              .openPr(projectRefOf(intent.target, workspace.repository), branch)
              .pipe(Effect.orElseSucceed(() => undefined))
            if (pr === undefined) {
              return false
            }
            // Branch policies are Azure DevOps' checks: a build policy that
            // has not reported is Pending, a rejected one is Failure.
            const checks = yield* hosting
              .prChecks(pr)
              .pipe(Effect.orElseSucceed(() => "Pending" as const))
            if (checks === "Failure") {
              // A red policy run is a real failure, not a waiting state:
              // park the work item as failed with instructions (the failed
              // phase also stops mend re-visiting, so this comments once).
              yield* Effect.ignore(hosting.editTags(ref, [Tags.failed], []))
              yield* tell(
                hosting,
                ref,
                [
                  `PR #${pr.id} CI is red (${checks}) — auto-merge is held.`,
                  `See the checks on ${pr.url}.`,
                  "Strip factory:failed and add factory:planned (with guidance",
                  "if useful) to run a fix round, or inspect the branch."
                ].join("\n")
              )
              return false
            }
            if (checks !== "Success") {
              yield* events.publish(
                Info.make({
                  message: `auto-merge: PR #${pr.id} checks ${checks}; waiting`
                })
              )
              return false
            }
            const merged = yield* hosting.mergePr(pr).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false)
            )
            if (merged) {
              yield* tell(
                hosting,
                ref,
                `Shipped: PR #${pr.id} merged automatically (checks green). 🚀`
              )
            }
            return merged
          })

    if (ancestor && localSha === remoteSha && localSha.length > 0) {
      const shipped = yield* shipIfGreen
      yield* unclaim
      return { outcome: shipped ? ("Shipped" as const) : ("Advanced" as const), costUsd: 0 }
    }
    // When ancestor holds but the shas differ, a previous mend already
    // rebased locally without pushing — skip the rebase, go gate-and-push.
    const rebasedClean = ancestor ? true : yield* attempt(
      run(["git", "-C", worktree, "-c", "core.editor=true", "rebase", "origin/HEAD"], workspaceDir)
    )
    const cellsRef = yield* Ref.make<ReadonlyArray<CostCell>>([])
    let resolvedRounds = 0

    if (!rebasedClean) {
      // Conflicted rebase: spin a runner so a coder agent can resolve the
      // markers, then continue the rebase — one round per conflicted commit.
      const startedAtMs = yield* Clock.currentTimeMillis
      const coder = withTurnLimit(
        companyCoder(environment),
        positiveIntOr(environment["NIGHTCALL_TURN_LIMIT"], 50)
      )
      const options = {
        workDir: worktree,
        workspace: worktree,
        userPrompt: `Resolve rebase conflicts for #${intent.item.id}`,
        coder: CliConnectorConfig.make({ ...coder, workingDir: worktree }),
        runId: `nightcall-mend-${intent.item.id}-${startedAtMs}`,
        surface: timestampedSurface(),
        verbosity: parseVerbosity(environment["LLM4TS_VERBOSITY"] ?? "verbose")
      }
      const dependencies = nodeFlowRunnerDependencies()
      const outcomeOk = yield* Effect.scoped(
        Effect.gen(function* () {
          const bundle = yield* makeFlowRunnerContext(options, dependencies)
          const tracker = yield* makeCostTracker()
          yield* tracker.consume(bundle.events)
          const body = (context: FlowContextShape): Effect.Effect<void, FlowError> =>
            Effect.gen(function* () {
              for (let round = 0; round < 10; round += 1) {
                const rebasing = yield* rebaseInProgress
                if (!rebasing) {
                  break
                }
                const conflicted = yield* run(
                  ["git", "-C", worktree, "diff", "--name-only", "--diff-filter=U"],
                  workspaceDir
                ).pipe(Effect.orElseSucceed(() => ""))
                if (conflicted.trim().length === 0) {
                  // Nothing conflicted but the rebase is paused: either the
                  // last resolution needs continuing, or the commit became
                  // empty because main already contains it — skip it then.
                  const continued = yield* attempt(
                    run(
                      ["git", "-C", worktree, "-c", "core.editor=true", "rebase", "--continue"],
                      workspaceDir
                    )
                  )
                  if (!continued) {
                    yield* Effect.ignore(
                      run(["git", "-C", worktree, "rebase", "--skip"], workspaceDir)
                    )
                  }
                  continue
                }
                resolvedRounds += 1
                const chat = yield* makeChat(context.coder, {
                  events: context.events,
                  agent: "coder",
                  system: noopRule
                })
                yield* chat.ask(
                  [
                    "A git rebase onto origin/HEAD is paused on conflicts in",
                    "this repository checkout. Conflicted files:",
                    conflicted,
                    "",
                    "Edit each conflicted file to resolve every <<<<<<< marker,",
                    "preserving BOTH intents: the changes already merged to",
                    "main and this branch's changes. Do not run any git",
                    "commands (no add, no commit, no rebase); only edit files.",
                    "Reply DONE when every marker is gone."
                  ].join("\n")
                )
                yield* run(["git", "-C", worktree, "add", "-A"], workspaceDir)
                yield* Effect.ignore(
                  run(
                    ["git", "-C", worktree, "-c", "core.editor=true", "rebase", "--continue"],
                    workspaceDir
                  )
                )
              }
              const stillRebasing = yield* rebaseInProgress
              if (stillRebasing) {
                return yield* Effect.fail(
                  ProcessError.make({
                    message: "mend rebase",
                    detail: "conflicts persisted after 5 resolution rounds; rebase aborted"
                  })
                )
              }
            })
          yield* runWithBundle(bundle, options, body, dependencies).pipe(
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
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      )
      if (!outcomeOk) {
        yield* Effect.ignore(
          run(["git", "-C", worktree, "rebase", "--abort"], workspaceDir)
        )
        const cells = yield* Ref.get(cellsRef)
        yield* Effect.ignore(hosting.editTags(ref, [Tags.failed], [Tags.wip]))
        yield* tell(
          hosting,
          ref,
          "Mend failed: the rebase onto main could not be resolved automatically. " +
            "The branch is unchanged; strip factory:failed to retry, or resolve manually.\n\n" +
            renderInvoice(cells, config.issueBudgetUsd)
        )
        return { outcome: "Failed" as const, costUsd: totalCost(cells) }
      }
    }

    // Rebase complete — PUSH FIRST, gate second. The rebase itself is
    // good; leaving it unpushed forked the worktree from the remote and
    // broke every later stage's plain push. A red gate then
    // means "don't auto-merge", with the PR honestly conflicted-free and
    // CI showing the truth.
    yield* run(
      ["git", "-C", worktree, "push", "--force-with-lease", "origin", branch],
      workspaceDir
    ).pipe(Effect.orElseSucceed(() => ""))
    if (gate !== undefined && gate.length > 0) {
      const gateFailure = yield* run(
        ["sh", "-lc", `cd '${worktree}' && ${gate}`],
        workspaceDir
      ).pipe(
        Effect.map((): string | undefined => undefined),
        Effect.catch((error) =>
          Effect.succeed("detail" in error ? String(error.detail) : error.message)
        )
      )
      if (gateFailure !== undefined) {
        yield* Effect.ignore(hosting.editTags(ref, [Tags.failed], [Tags.wip]))
        yield* tell(
          hosting,
          ref,
          [
            "Mend: the branch is rebased onto main and pushed, but the gate",
            "went red — auto-merge is held. Gate output (tail):",
            "",
            "```",
            gateFailure.slice(-1200),
            "```",
            "",
            "Strip factory:failed and add factory:planned (with guidance if",
            "needed) to run a fix round, or inspect the branch."
          ].join("\n")
        )
        return { outcome: "Failed" as const, costUsd: totalCost(yield* Ref.get(cellsRef)) }
      }
    }
    const cells = yield* Ref.get(cellsRef)
    yield* tell(
      hosting,
      ref,
      resolvedRounds === 0
        ? "Rebased onto main cleanly; the PR is mergeable again."
        : `Rebased onto main; the coder resolved conflicts across ${resolvedRounds} round(s). The PR is mergeable again.\n\n${renderInvoice(cells, config.issueBudgetUsd)}`
    )
    const shipped = yield* shipIfGreen
    yield* unclaim
    return {
      outcome: shipped ? ("Shipped" as const) : ("Advanced" as const),
      costUsd: totalCost(cells)
    }
  })
