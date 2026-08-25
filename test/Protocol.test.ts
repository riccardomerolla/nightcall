import { assert, describe, it } from "@effect/vitest"
import {
  Tags,
  branchFor,
  budgetOverrideUsd,
  claim,
  fail,
  isEpic,
  phaseOf,
  restart,
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
    // The tag still forces decomposition of any type.
    assert.isTrue(isEpic({ type: "Task", tags: [Tags.ready, Tags.epic] }))
    assert.isFalse(isEpic({ type: "Task", tags: [Tags.ready] }))
    // Azure DevOps says it in the type, so a human need not repeat it.
    assert.isTrue(isEpic({ type: "Epic", tags: [Tags.ready] }))
    assert.isTrue(isEpic({ type: "Feature", tags: [Tags.ready] }))
    // Process templates are localized and vary in casing.
    assert.isTrue(isEpic({ type: "epic", tags: [] }))
    assert.isFalse(isEpic({ type: "User Story", tags: [Tags.ready] }))
    // A board that calls its containers something else configures it.
    assert.isTrue(isEpic({ type: "Initiative", tags: [] }, ["Initiative"]))
    assert.isFalse(isEpic({ type: "Epic", tags: [] }, ["Initiative"]))
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

describe("factory:fresh", () => {
  it("clears every checkpoint so a stuck item starts from the front", () => {
    // Only the plan stage read this tag, so an item stuck at planned,
    // coded, or reviewed — the state an operator actually reaches for
    // factory:fresh in — was claimed by a later stage that never looked at
    // it. Restarting has to strip whichever checkpoint it stopped on, or
    // the next beat claims it for that same stage again.
    for (const checkpoint of [Tags.planned, Tags.coded, Tags.reviewed, Tags.review, Tags.failed]) {
      assert.include(restart.remove, checkpoint)
    }
    // The claim and the tag itself go too: the reset has been applied.
    assert.include(restart.remove, Tags.wip)
    assert.include(restart.remove, Tags.fresh)
    assert.deepStrictEqual([...restart.add], [Tags.ready])
  })
})
