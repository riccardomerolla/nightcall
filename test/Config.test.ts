import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { azureFromEnv, configFromEnv, parseTarget } from "../src/Config.ts"

describe("Config", () => {
  it("parses a board with or without a default repository", () => {
    assert.strictEqual(parseTarget("acme/widgets")?.slug, "acme/widgets")
    assert.strictEqual(parseTarget("acme/widgets")?.defaultRepository, "widgets")
    // A bare project is a board whose work routes itself by Development link.
    assert.strictEqual(parseTarget("acme")?.project, "acme")
    assert.strictEqual(parseTarget("acme")?.defaultRepository, "")
    assert.strictEqual(parseTarget("acme")?.slug, "acme")
    assert.isUndefined(parseTarget("a/b/c"))
    assert.isUndefined(parseTarget(""))
  })

  it.effect("refuses to poll one board twice", () =>
    Effect.gen(function* () {
      // Two entries for one project would claim every work item twice, in
      // two different repositories.
      const duplicate = yield* Effect.flip(
        configFromEnv({ NIGHTCALL_TARGETS: "acme/widgets, acme/gears" })
      )
      assert.include(duplicate.message, "twice")
      assert.include(duplicate.message, "Development")
    })
  )

  it.effect("applies DESIGN.md defaults and env overrides", () =>
    Effect.gen(function* () {
      const config = yield* configFromEnv({
        NIGHTCALL_TARGETS: "acme/widgets, gizmo/gears",
        NIGHTCALL_ISSUE_BUDGET_USD: "10"
      })
      assert.deepStrictEqual(
        config.targets.map((target) => target.slug),
        ["acme/widgets", "gizmo/gears"]
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
      // A bare project is a valid board now; three segments never are.
      const malformed = yield* Effect.flip(configFromEnv({ NIGHTCALL_TARGETS: "a/b/c" }))

      assert.strictEqual(config.heartbeatSeconds, 120)
      assert.strictEqual(missing._tag, "ConfigError")
      assert.include(malformed.message, "a/b/c")
    })
  )
})

describe("Epic types", () => {
  it.effect("decomposes the stock container types by default", () =>
    Effect.gen(function* () {
      const config = yield* configFromEnv({ NIGHTCALL_TARGETS: "acme/widgets" })

      assert.deepStrictEqual([...config.epicTypes], ["Epic", "Feature"])
    })
  )

  it.effect("takes the board's own container names", () =>
    Effect.gen(function* () {
      const config = yield* configFromEnv({
        NIGHTCALL_TARGETS: "acme/widgets",
        NIGHTCALL_ADO_EPIC_TYPES: "Initiative, Epica "
      })

      assert.deepStrictEqual([...config.epicTypes], ["Initiative", "Epica"])
    })
  )

  it.effect("never lets the child type be an epic type", () =>
    Effect.gen(function* () {
      // Children are created as NIGHTCALL_ADO_WORK_ITEM_TYPE. If that type
      // also counted as an epic, each child would be decomposed into more
      // children, forever, against a real board.
      const config = yield* configFromEnv({
        NIGHTCALL_TARGETS: "acme/widgets",
        NIGHTCALL_ADO_WORK_ITEM_TYPE: "Feature"
      })

      assert.deepStrictEqual([...config.epicTypes], ["Epic"])
    })
  )
})

describe("Coder", () => {
  it.effect("refuses a coder llm4ts does not know", () =>
    Effect.gen(function* () {
      // coderFromEnv falls back to claude, so an unrecognized name would
      // quietly hire a different CLI than the one asked for and only the
      // invoice would show it.
      const error = yield* Effect.flip(
        configFromEnv({ NIGHTCALL_TARGETS: "acme/widgets", LLM4TS_CODER: "gemni" })
      )

      assert.include(error.message, "gemni")
      // The message names what would have worked.
      assert.include(error.message, "gemini-cli")
    })
  )

  it.effect("accepts a connector id as readily as a short name", () =>
    Effect.gen(function* () {
      // `gemini-cli` is the name llm4ts prints for this connector, so it is
      // the one an operator is most likely to have written.
      yield* configFromEnv({ NIGHTCALL_TARGETS: "acme/widgets", LLM4TS_CODER: "gemini-cli" })
      yield* configFromEnv({ NIGHTCALL_TARGETS: "acme/widgets", LLM4TS_CODER: "gemini" })
      // Unset is the company default, not an error.
      yield* configFromEnv({ NIGHTCALL_TARGETS: "acme/widgets" })
    })
  )
})
