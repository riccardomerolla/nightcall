import { assert, describe, it } from "@effect/vitest"
import { Plan, Task } from "@llm4ts/flow/Plan"
import { pruneNonCodingTasks, worktreeHoldingBranch } from "../src/Engineer.ts"

const task = (title: string, completed = false): Task =>
  Task.make({ title, description: title, completed })

describe("Engineer plan pruning", () => {
  it("drops incomplete verification-shaped tasks, keeps real and completed work", () => {
    const plan = Plan.make({
      epicId: "issue-13",
      tasks: [
        task("Typed row-error schemas for imports", true),
        task("MiFID JSON importer decodes the sample fixture"),
        task("Verify importer integration quality"),
        task("Gate verification for import module"),
        task("Run the tests and confirm green"),
        task("Check malformed rows raise CsvParseError", true),
        task("Add tests for unknown asset classes")
      ]
    })
    const pruned = pruneNonCodingTasks(plan)
    assert.deepStrictEqual(
      pruned.tasks.map((item) => item.title),
      [
        "Typed row-error schemas for imports",
        "MiFID JSON importer decodes the sample fixture",
        "Check malformed rows raise CsvParseError",
        "Add tests for unknown asset classes"
      ]
    )
  })

  it("returns the same plan when nothing matches", () => {
    const plan = Plan.make({
      epicId: "issue-14",
      tasks: [task("Model target allocations"), task("Allocation analytics")]
    })
    assert.strictEqual(pruneNonCodingTasks(plan), plan)
  })
})

describe("Worktree registration", () => {
  // `git worktree list --porcelain` prints a block per worktree.
  const listing = [
    "worktree /w/repos/acme__gears",
    "HEAD 1111111111111111111111111111111111111111",
    "branch refs/heads/main",
    "",
    "worktree /w/worktrees/acme__gears/item-7",
    "HEAD 2222222222222222222222222222222222222222",
    "branch refs/heads/factory/item-7",
    "",
    "worktree /w/worktrees/acme__gears/detached",
    "HEAD 3333333333333333333333333333333333333333",
    "detached",
    ""
  ].join("\n")

  it("finds which worktree holds a branch", () => {
    // A registration outlives its directory, so a retry of a work item
    // whose folder was deleted hits "'factory/item-7' is already used by
    // worktree at ..." and fails the same way for ever. Knowing the path
    // is what lets the stale claim be released.
    assert.strictEqual(
      worktreeHoldingBranch(listing, "factory/item-7"),
      "/w/worktrees/acme__gears/item-7"
    )
    assert.strictEqual(worktreeHoldingBranch(listing, "main"), "/w/repos/acme__gears")
  })

  it("does not confuse a detached worktree or a near-miss name", () => {
    // `branch refs/heads/factory/item-7` must not answer for `item-70`,
    // and a detached HEAD holds no branch at all.
    assert.isUndefined(worktreeHoldingBranch(listing, "factory/item-70"))
    assert.isUndefined(worktreeHoldingBranch(listing, "factory/item-1"))
    assert.isUndefined(worktreeHoldingBranch("", "main"))
    assert.isUndefined(worktreeHoldingBranch("worktree /w/x\nHEAD abc\ndetached\n", "main"))
  })
})
