import { assert, describe, it } from "@effect/vitest"
import {
  Tags,
  branchFor,
  budgetOverrideUsd,
  claim,
  fail,
  isEpic,
  phaseOf,
  signed
} from "../src/Protocol.ts"

describe("Protocol", () => {
  it("derives the phase from tags with terminal-first precedence", () => {
    assert.strictEqual(phaseOf([]), "Unmanaged")
    assert.strictEqual(phaseOf(["bug"]), "Unmanaged")
    assert.strictEqual(phaseOf([Tags.ready]), "Ready")
    assert.strictEqual(phaseOf([Tags.needsInfo]), "NeedsInfo")
    assert.strictEqual(phaseOf([Tags.wip]), "InProgress")
    assert.strictEqual(phaseOf([Tags.review]), "InReview")
    assert.strictEqual(phaseOf([Tags.failed]), "Failed")
    // Contradictory leftovers from a partial write: in-flight and terminal
    // markers outrank readiness, failure outranks everything.
    assert.strictEqual(phaseOf([Tags.ready, Tags.wip]), "InProgress")
    assert.strictEqual(phaseOf([Tags.wip, Tags.review]), "InReview")
    assert.strictEqual(phaseOf([Tags.review, Tags.failed]), "Failed")
  })

  it("reads epic and budget-override tags", () => {
    assert.isTrue(isEpic([Tags.ready, Tags.epic]))
    assert.isFalse(isEpic([Tags.ready]))
    assert.strictEqual(budgetOverrideUsd([Tags.ready]), undefined)
    assert.strictEqual(budgetOverrideUsd(["factory:budget-20"]), 20)
    assert.strictEqual(budgetOverrideUsd(["factory:budget-20", "factory:budget-5"]), 20)
    assert.strictEqual(budgetOverrideUsd(["factory:budget-0"]), undefined)
    assert.strictEqual(budgetOverrideUsd(["factory:budget-x"]), undefined)
  })

  it("names transitions, branches, and the signature", () => {
    assert.deepStrictEqual([...claim.add], [Tags.wip])
    assert.deepStrictEqual([...claim.remove], [Tags.ready])
    assert.deepStrictEqual([...fail.remove], [Tags.wip, Tags.review])
    assert.strictEqual(branchFor(42), "factory/item-42")
    assert.strictEqual(signed("Done.\n"), "Done.\n\n— Nightcall 🌙")
  })
})
