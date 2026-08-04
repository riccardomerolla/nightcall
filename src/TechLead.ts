import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { makeChat } from "@llm4ts/flow/Chat"
import type { CostCell } from "@llm4ts/flow/CostLedger"
import { makeCostTracker } from "@llm4ts/flow/CostTracker"
import type { FlowContextShape } from "@llm4ts/flow/FlowContext"
import type { FlowError } from "@llm4ts/flow/FlowError"
import { Info, type FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import type { GitHubToolShape } from "@llm4ts/flow/GitHubTool"
import { coderFromEnv } from "@llm4ts/runner/Connectors"
import {
  makeFlowRunnerContext,
  nodeFlowRunnerDependencies,
  runWithBundle
} from "@llm4ts/runner/FlowRunner"
import { parseVerbosity } from "@llm4ts/runner/Terminal"
import { timestampedSurface } from "./Surface.ts"
import type { CompanyConfig } from "./Config.ts"
import { repoRefOf, type ClaimIntent, type WorkerReport } from "./Heartbeat.ts"
import {
  blockedByPrefix,
  epicChildMarker,
  epicDecompositionPrompt,
  maxEpicChildren,
  parseEpicChildren
} from "./Prompts.ts"
import { Labels, signature, signed } from "./Protocol.ts"

// Epic decomposition: the Tech Lead turns one CEO epic into ordered child
// issues. Issues-only — no worktree, no coder seat. The epic keeps
// factory:ready until decomposition succeeds, so a crashed run simply
// retries next beat (worst case: a partial crash duplicates a child,
// which the CEO can close — preferred over an epic stranded in wip).

const readHandbook = (cwd: string): Effect.Effect<string> =>
  Effect.tryPromise({
    try: () => import("node:fs/promises").then((fs) => fs.readFile(`${cwd}/COMPANY.md`, "utf8")),
    catch: () => "missing"
  }).pipe(Effect.catch(() => Effect.succeed("")))

const totalCost = (cells: ReadonlyArray<CostCell>): number =>
  cells.reduce((sum, cell) => sum + (cell.costUsd ?? 0), 0)

export const runEpic = (
  gh: GitHubToolShape,
  intent: ClaimIntent,
  config: CompanyConfig,
  environment: Readonly<Record<string, string | undefined>>,
  events: FlowEventsShape
): Effect.Effect<WorkerReport> =>
  Effect.gen(function* () {
    const ref = intent.issue.ref(repoRefOf(intent.target))
    const repo = repoRefOf(intent.target)
    const handbook = yield* readHandbook(process.cwd())
    // Iteration mode: the epic already shipped once (factory:validate) and
    // the CEO re-added ready — decompose from their feedback, not from the
    // original body alone.
    const iterating = intent.issue.labels.includes(Labels.validate)
    const iteration = iterating
      ? yield* Effect.gen(function* () {
          const comments = yield* gh.readIssueComments(ref).pipe(
            Effect.orElseSucceed(() => [])
          )
          const feedback = comments
            .filter((comment) => !comment.body.includes(signature))
            .map((comment) => ({ author: comment.author, body: comment.body }))
          const allIssues = yield* gh
            .listIssues(repo, { state: "all" })
            .pipe(Effect.orElseSucceed(() => []))
          const marker = epicChildMarker(intent.issue.number)
          const shipped = allIssues
            .filter((issue) => issue.body.includes(marker))
            .map((issue) => `#${issue.number} ${issue.title}`)
          return { shipped, feedback }
        })
      : undefined
    const startedAtMs = yield* Clock.currentTimeMillis
    const runId = `nightcall-epic-${intent.issue.number}-${startedAtMs}`
    const dependencies = nodeFlowRunnerDependencies()
    const coder = coderFromEnv(environment)
    const workDir = process.cwd()
    const options = {
      workDir,
      workspace: workDir,
      userPrompt: epicDecompositionPrompt(intent.issue, handbook, iteration),
      coder: CliConnectorConfig.make({ ...coder, workingDir: workDir }),
      runId,
      surface: timestampedSurface(),
      verbosity: parseVerbosity(environment["LLM4TS_VERBOSITY"] ?? "verbose")
    }

    const outcome = yield* Ref.make<WorkerReport["outcome"]>("Failed")
    const cellsRef = yield* Ref.make<ReadonlyArray<CostCell>>([])

    const body = (context: FlowContextShape): Effect.Effect<void, FlowError> =>
      Effect.gen(function* () {
        const techLead = yield* makeChat(context.reasoning, {
          system: handbook,
          events: context.events,
          agent: "techlead"
        })
        const reply = yield* techLead.ask(epicDecompositionPrompt(intent.issue, handbook, iteration))
        const children = parseEpicChildren(reply)
        if (children === undefined) {
          yield* gh.writeIssueComment(
            ref,
            signed(
              "The Tech Lead could not produce a parseable decomposition. " +
                `Raw reply:\n\n${reply.slice(0, 1500)}`
            )
          )
          yield* gh.editIssueLabels(ref, [Labels.needsInfo], [Labels.ready])
          yield* Ref.set(outcome, "Bounced")
          return
        }

        const capped = children.slice(0, maxEpicChildren)
        const created: Array<string> = []
        const numberOfOrdinal: Array<number> = []
        for (const child of capped) {
          // DEPENDS ordinals refer to earlier children in this reply;
          // creation order lets us resolve them to real issue numbers.
          const blockers = child.dependsOn
            .map((ordinal) => numberOfOrdinal[ordinal - 1])
            .filter((value): value is number => value !== undefined)
          const blockedLine =
            blockers.length === 0
              ? ""
              : `\n${blockedByPrefix} ${blockers.map((n) => `#${n}`).join(", ")}`
          const childRef = yield* gh.createIssue(
            repo,
            child.title,
            `${child.body}${blockedLine}\n\n${epicChildMarker(intent.issue.number)}`,
            [Labels.ready]
          )
          numberOfOrdinal.push(childRef.number)
          created.push(
            `- #${childRef.number} ${child.title}${
              blockers.length === 0 ? "" : ` (blocked by ${blockers.map((n) => `#${n}`).join(", ")})`
            }`
          )
          yield* events.publish(
            Info.make({ message: `epic #${intent.issue.number} → created #${childRef.number}` })
          )
        }
        yield* gh.writeIssueComment(
          ref,
          signed(
            [
              `Decomposed into ${created.length} child issue(s), in build order:`,
              "",
              ...created,
              ...(children.length > capped.length
                ? ["", `(${children.length - capped.length} proposed child(ren) beyond the cap of ${maxEpicChildren} were dropped.)`]
                : []),
              "",
              "This epic closes when all children are done."
            ].join("\n")
          )
        )
        // Only after every child exists does the epic leave the ready
        // queue — the transition is the last write, keeping retry safe.
        // An iteration also sheds validate; it returns when the new
        // children close.
        yield* gh.editIssueLabels(
          ref,
          [],
          iterating ? [Labels.ready, Labels.validate] : [Labels.ready]
        )
        yield* Ref.set(outcome, "Shipped")
      })

    yield* Effect.scoped(
      Effect.gen(function* () {
        const bundle = yield* makeFlowRunnerContext(options, dependencies)
        const tracker = yield* makeCostTracker()
        yield* tracker.consume(bundle.events)
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
      Effect.catch((error) =>
        Effect.ignore(
          gh.writeIssueComment(
            ref,
            signed(`Epic decomposition failed: ${error.message}. Will retry next beat.`)
          )
        )
      )
    )

    const cells = yield* Ref.get(cellsRef)
    return { outcome: yield* Ref.get(outcome), costUsd: totalCost(cells) }
  })
