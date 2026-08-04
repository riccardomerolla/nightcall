import { resolve } from "node:path"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as Semaphore from "effect/Semaphore"
import type { FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import { makeGitHubTool, parseIssueRef } from "@llm4ts/flow/GitHubTool"
import { nodeProcessExecutor } from "@llm4ts/runner/NodeProcessExecutor"
import { configFromEnv } from "./Config.ts"
import { runIssue } from "./Engineer.ts"
import { heartbeat, type ClaimIntent, type Stage, type WorkerReport } from "./Heartbeat.ts"
import { runMend, runStage } from "./Stages.ts"
import { runEpic } from "./TechLead.ts"

// The Chief of Staff daemon: decode config, then run the idempotent
// heartbeat on a fixed schedule. Observe mode is the default — the daemon
// reports what it would claim; NIGHTCALL_CLAIM=1 arms the full pipeline
// (claim → Tech Lead triage → Engineer → QA → PR).

const loggingEvents: FlowEventsShape = {
  publish: (event) =>
    event._tag === "Info" ? Effect.log(event.message) : Effect.logDebug(event._tag)
}

const program = Effect.gen(function* () {
  const config = yield* configFromEnv(process.env)
  const claimMode = process.env["NIGHTCALL_CLAIM"] === "1"
  const staged = process.env["NIGHTCALL_PIPELINE"] === "staged"
  // Serializes clone/fetch/worktree-add on the shared per-target clone
  // while concurrent stage workers run their long LLM phases in parallel.
  const gitLock = yield* Semaphore.make(1)
  const workspaceDir = resolve(process.env["NIGHTCALL_WORKSPACE"] ?? ".factory")
  const standupIssue = parseIssueRef(process.env["NIGHTCALL_STANDUP_ISSUE"] ?? "")
  const gh = makeGitHubTool(nodeProcessExecutor, process.cwd(), loggingEvents)
  yield* Effect.log(
    `Nightcall up: ${config.targets.map((target) => target.slug).join(", ")} ` +
      `(heartbeat ${config.heartbeatSeconds}s, ` +
      `$${config.issueBudgetUsd}/issue, $${config.dailyBudgetUsd}/day, ` +
      `${claimMode ? "CLAIM" : "observe"} mode, ${staged ? "staged" : "mono"} pipeline)`
  )
  const stageWorker =
    (stage: Stage) =>
    (intent: ClaimIntent): Effect.Effect<WorkerReport> =>
      runStage(stage, gh, intent, config, process.env, loggingEvents, gitLock)
  const beat = heartbeat(gh, config, loggingEvents, {
    claimMode,
    worker: (intent) => runIssue(gh, intent, config, process.env, loggingEvents),
    epicWorker: (intent) => runEpic(gh, intent, config, process.env, loggingEvents),
    ...(staged
      ? {
          stageWorkers: {
            plan: stageWorker("plan"),
            code: stageWorker("code"),
            review: stageWorker("review"),
            qa: stageWorker("qa"),
            mend: (intent: ClaimIntent) =>
              runMend(gh, intent, config, process.env, loggingEvents, gitLock)
          }
        }
      : {}),
    workspaceDir,
    ...(standupIssue === undefined ? {} : { standupIssue })
  }).pipe(
    // A failed beat (gh missing, network down, rate limit) is reported and
    // the daemon stays up: the next beat re-derives everything from labels.
    Effect.catch((error) => Effect.logWarning(`heartbeat failed: ${error.message}`)),
    Effect.asVoid
  )
  yield* beat.pipe(
    Effect.andThen(Effect.sleep(`${config.heartbeatSeconds} seconds`)),
    Effect.repeat(Schedule.forever)
  )
})

program.pipe(
  Effect.catchTag("ConfigError", (error) =>
    Effect.sync(() => {
      console.error(`nightcall: ${error.message}`)
      process.exitCode = 1
    })
  ),
  Effect.runPromise
)
