import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { azureFromEnv, configFromEnv, parseTarget } from "../src/Config.ts"

describe("Config", () => {
  it("parses project/repository slugs", () => {
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

  it.effect("requires an organization URL and normalizes its trailing slash", () =>
    Effect.gen(function* () {
      const azure = yield* azureFromEnv({ NIGHTCALL_ADO_ORG: "https://dev.azure.com/acme/" })
      const missing = yield* Effect.flip(azureFromEnv({}))

      assert.strictEqual(azure.orgUrl, "https://dev.azure.com/acme")
      // Azure DevOps knobs have defaults; the organization never does,
      // because guessing it would point the company at another board.
      assert.strictEqual(azure.workItemType, "Task")
      assert.strictEqual(azure.targetBranch, "main")
      assert.strictEqual(missing._tag, "ConfigError")
      assert.include(missing.message, "NIGHTCALL_ADO_ORG")

      const overridden = yield* azureFromEnv({
        NIGHTCALL_ADO_ORG: "https://dev.azure.com/acme",
        NIGHTCALL_ADO_WORK_ITEM_TYPE: "User Story",
        NIGHTCALL_ADO_TARGET_BRANCH: "develop"
      })
      assert.strictEqual(overridden.workItemType, "User Story")
      assert.strictEqual(overridden.targetBranch, "develop")
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
