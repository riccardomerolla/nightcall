import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { ConfigError, configFromEnv, parseTarget } from "../src/Config.ts"

describe("Config", () => {
  it.effect("recovers from invalid targets and defaults non-numeric heartbeat values", () =>
    Effect.gen(function* () {
      const config = yield* configFromEnv({ NIGHTCALL_TARGETS: "invalid" }).pipe(
        Effect.catchTag("ConfigError", () =>
          configFromEnv({
            NIGHTCALL_TARGETS: "acme/widgets",
            NIGHTCALL_HEARTBEAT_SECONDS: "not-a-number"
          })
        )
      )

      assert.deepStrictEqual(config.targets.map((target) => target.slug), ["acme/widgets"])
      assert.strictEqual(config.heartbeatSeconds, 120)
    })
  )

  it.effect("yields ConfigError and recovers by tag", () =>
    Effect.gen(function* () {
      const error = new ConfigError({ message: "invalid config" })
      const recovered = yield* Effect.gen(function* () {
        return yield* error
      }).pipe(Effect.catchTag("ConfigError", (failure) => Effect.succeed(failure)))

      assert.instanceOf(recovered, ConfigError)
      assert.strictEqual(recovered._tag, "ConfigError")
      assert.strictEqual(recovered.message, "invalid config")
    })
  )

  it("parses owner/repo slugs", () => {
    assert.strictEqual(parseTarget("acme/widgets")?.slug, "acme/widgets")
    assert.isUndefined(parseTarget("not-a-slug"))
    assert.isUndefined(parseTarget("a/b/c"))
  })

  it.effect("applies DESIGN.md defaults and env overrides", () =>
    Effect.gen(function* () {
      const config = yield* configFromEnv({
        NIGHTCALL_TARGETS: "acme/widgets, acme/gears",
        NIGHTCALL_ISSUE_BUDGET_USD: "10"
      })
      assert.deepStrictEqual(
        config.targets.map((target) => target.slug),
        ["acme/widgets", "acme/gears"]
      )
      assert.strictEqual(config.heartbeatSeconds, 120)
      assert.strictEqual(config.issueBudgetUsd, 10)
      assert.strictEqual(config.dailyBudgetUsd, 25)
      assert.strictEqual(config.maxAttempts, 2)
      assert.strictEqual(config.engineerParallelism, 1)
    })
  )

  it.effect("falls back on malformed numbers and fails on bad targets", () =>
    Effect.gen(function* () {
      const config = yield* configFromEnv({
        NIGHTCALL_TARGETS: "acme/widgets",
        NIGHTCALL_HEARTBEAT_SECONDS: "-5"
      })
      const missing = yield* Effect.flip(configFromEnv({}))
      const malformed = yield* Effect.flip(configFromEnv({ NIGHTCALL_TARGETS: "oops" }))

      assert.strictEqual(config.heartbeatSeconds, 120)
      assert.strictEqual(missing._tag, "ConfigError")
      assert.instanceOf(missing, ConfigError)
      assert.strictEqual(missing.message, "NIGHTCALL_TARGETS must list at least one owner/repo")
      assert.instanceOf(malformed, ConfigError)
      assert.strictEqual(malformed._tag, "ConfigError")
      assert.include(malformed.message, "oops")
    })
  )
})
