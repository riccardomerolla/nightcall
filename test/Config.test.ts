import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { configFromEnv, parseTarget } from "../src/Config.ts"

describe("Config", () => {
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
      assert.include(malformed.message, "oops")
    })
  )
})
