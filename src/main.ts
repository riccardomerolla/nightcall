import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import { configFromEnv } from "./Config.ts"

// The Chief of Staff daemon. v0 skeleton: decode config, then run the
// idempotent heartbeat on a fixed schedule. The heartbeat body becomes the
// real poll → claim → spawn pipeline once Nightcall pins @llm4ts/* 0.4.0
// (GitHubTool work-queue operations); until then it only reports liveness.

const program = Effect.gen(function* () {
  const config = yield* configFromEnv(process.env)
  yield* Effect.log(
    `Nightcall up: ${config.targets.map((target) => target.slug).join(", ")} ` +
      `(heartbeat ${config.heartbeatSeconds}s, ` +
      `$${config.issueBudgetUsd}/issue, $${config.dailyBudgetUsd}/day)`
  )
  const heartbeat = Effect.log("heartbeat: work-queue poll not wired yet (awaiting @llm4ts 0.4.0)")
  yield* heartbeat.pipe(Effect.repeat(Schedule.spaced(`${config.heartbeatSeconds} seconds`)))
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
