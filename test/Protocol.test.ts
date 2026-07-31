import { assert, describe, it } from "@effect/vitest"
import {
  Labels,
  branchFor,
  budgetOverrideUsd,
  claim,
  fail,
  isEpic,
  phaseOf,
  signed
} from "../src/Protocol.ts"

describe("Protocol", () => {
  it("derives the phase from labels with terminal-first precedence", () => {
    assert.strictEqual(phaseOf([]), "Unmanaged")
    assert.strictEqual(phaseOf(["bug"]), "Unmanaged")
    assert.strictEqual(phaseOf([Labels.ready]), "Ready")
    assert.strictEqual(phaseOf([Labels.needsInfo]), "NeedsInfo")
    assert.strictEqual(phaseOf([Labels.wip]), "InProgress")
    assert.strictEqual(phaseOf([Labels.review]), "InReview")
    assert.strictEqual(phaseOf([Labels.failed]), "Failed")
    // Contradictory leftovers from a partial write: in-flight and terminal
    // markers outrank readiness, failure outranks everything.
    assert.strictEqual(phaseOf([Labels.ready, Labels.wip]), "InProgress")
    assert.strictEqual(phaseOf([Labels.wip, Labels.review]), "InReview")
    assert.strictEqual(phaseOf([Labels.review, Labels.failed]), "Failed")
  })

  it("reads epic and budget-override labels", () => {
    assert.isTrue(isEpic([Labels.ready, Labels.epic]))
    assert.isFalse(isEpic([Labels.ready]))
    assert.strictEqual(budgetOverrideUsd([Labels.ready]), undefined)
    assert.strictEqual(budgetOverrideUsd(["factory:budget-20"]), 20)
    assert.strictEqual(budgetOverrideUsd(["factory:budget-20", "factory:budget-5"]), 20)
    assert.strictEqual(budgetOverrideUsd(["factory:budget-0"]), undefined)
    assert.strictEqual(budgetOverrideUsd(["factory:budget-x"]), undefined)
  })

  it("names transitions, branches, and the signature", () => {
    assert.deepStrictEqual([...claim.add], [Labels.wip])
    assert.deepStrictEqual([...claim.remove], [Labels.ready])
    assert.deepStrictEqual([...fail.remove], [Labels.wip, Labels.review])
    assert.strictEqual(branchFor(42), "factory/issue-42")
    assert.strictEqual(signed("Done.\n"), "Done.\n\n— Nightcall 🌙")
  })
})
