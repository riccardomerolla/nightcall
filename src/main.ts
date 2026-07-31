import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import type { FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import { makeGitHubTool } from "@llm4ts/flow/GitHubTool"
import { nodeProcessExecutor } from "@llm4ts/runner/NodeProcessExecutor"
import { configFromEnv } from "./Config.ts"
import { heartbeat } from "./Heartbeat.ts"

// The Chief of Staff daemon: decode config, then run the idempotent
// heartbeat on a fixed schedule. Observe mode is the default — the daemon
// reports what it would claim; NIGHTCALL_CLAIM=1 arms real claiming once
// an Engineer pipeline exists to work what gets claimed.

const loggingEvents: FlowEventsShape = {
  publish: (event) =>
    event._tag === "Info" ? Effect.log(event.message) : Effect.logDebug(event._tag)
}

const program = Effect.gen(function* () {
  const config = yield* configFromEnv(process.env)
  const claimMode = process.env["NIGHTCALL_CLAIM"] === "1"
  const gh = makeGitHubTool(nodeProcessExecutor, process.cwd(), loggingEvents)
  yield* Effect.log(
    `Nightcall up: ${config.targets.map((target) => target.slug).join(", ")} ` +
      `(heartbeat ${config.heartbeatSeconds}s, ` +
      `$${config.issueBudgetUsd}/issue, $${config.dailyBudgetUsd}/day, ` +
      `${claimMode ? "CLAIM" : "observe"} mode)`
  )
  const beat = heartbeat(gh, config, loggingEvents, { claimMode }).pipe(
    // A failed beat (gh missing, network down, rate limit) is reported and
    // the daemon stays up: the next beat re-derives everything from labels.
    Effect.catch((error) => Effect.logWarning(`heartbeat failed: ${error.message}`))
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
