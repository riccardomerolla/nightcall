import { resolve } from "node:path"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as Semaphore from "effect/Semaphore"
import type { FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import { nodeProcessExecutor } from "@llm4ts/runner/NodeProcessExecutor"
import { nodeTemporaryFiles } from "@llm4ts/runner/NodeTemporaryFiles"
import { makeAzureHosting } from "./Azure.ts"
import { azureFromEnv, configFromEnv, projectRefOf } from "./Config.ts"
import { runWorkItem } from "./Engineer.ts"
import { heartbeat, type ClaimIntent, type Stage, type WorkerReport } from "./Heartbeat.ts"
import { parseWorkItemRef } from "./Hosting.ts"
import { runMend, runStage } from "./Stages.ts"
import { runEpic } from "./TechLead.ts"
import { Tags } from "./Protocol.ts"

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
  const azure = yield* azureFromEnv(process.env)
  const claimMode = process.env["NIGHTCALL_CLAIM"] === "1"
  const staged = process.env["NIGHTCALL_PIPELINE"] === "staged"
  // Serializes clone/fetch/worktree-add on the shared per-target clone
  // while concurrent stage workers run their long LLM phases in parallel.
  const gitLock = yield* Semaphore.make(1)
  const workspaceDir = resolve(process.env["NIGHTCALL_WORKSPACE"] ?? ".factory")
  const standupItem = parseWorkItemRef(process.env["NIGHTCALL_STANDUP_ITEM"] ?? "")
  const hosting = makeAzureHosting(
    azure,
    nodeProcessExecutor,
    nodeTemporaryFiles,
    process.cwd(),
    loggingEvents
  )
  yield* Effect.log(
    `Nightcall up: ${azure.orgUrl} — ${config.targets.map((target) => target.slug).join(", ")} ` +
      `(heartbeat ${config.heartbeatSeconds}s, ` +
      `$${config.issueBudgetUsd}/item, $${config.dailyBudgetUsd}/day, ` +
      `${claimMode ? "CLAIM" : "observe"} mode, ${staged ? "staged" : "mono"} pipeline)`
  )
  const stageWorker =
    (stage: Exclude<Stage, "mend">) =>
    (intent: ClaimIntent): Effect.Effect<WorkerReport> =>
      runStage(stage, hosting, azure, intent, config, process.env, loggingEvents, gitLock)
  // Restart reconciliation (DESIGN.md): a fresh daemon has no work in
  // flight, so any factory:wip at boot is a stale claim from a killed
  // process. Strip it — the stage checkpoint tags remain, so each work item
  // is re-claimed at the stage it was interrupted in and resumes from its
  // persisted plan and branch.
  yield* Effect.forEach(config.targets, (target) =>
    Effect.gen(function* () {
      const project = projectRefOf(target)
      const stale = yield* hosting
        .listWorkItems(project, { tags: [Tags.wip] })
        .pipe(Effect.orElseSucceed(() => []))
      yield* Effect.forEach(stale, (item) =>
        Effect.gen(function* () {
          yield* Effect.ignore(hosting.editTags(item.ref(project), [], [Tags.wip]))
          yield* Effect.log(
            `reconciled stale factory:wip on ${target.slug}#${item.id}; it resumes at its checkpoint`
          )
        })
      )
    })
  )
  const beat = heartbeat(hosting, config, loggingEvents, {
    claimMode,
    worker: (intent) =>
      runWorkItem(hosting, azure, intent, config, process.env, loggingEvents),
    epicWorker: (intent) => runEpic(hosting, intent, config, process.env, loggingEvents),
    ...(staged
      ? {
          stageWorkers: {
            plan: stageWorker("plan"),
            code: stageWorker("code"),
            review: stageWorker("review"),
            qa: stageWorker("qa"),
            mend: (intent: ClaimIntent) =>
              runMend(hosting, intent, config, process.env, loggingEvents, gitLock)
          }
        }
      : {}),
    workspaceDir,
    ...(standupItem === undefined ? {} : { standupItem })
  }).pipe(
    // A failed beat (az missing, network down, throttling) is reported and
    // the daemon stays up: the next beat re-derives everything from tags.
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
