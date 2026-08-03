import { assert, describe, it } from "@effect/vitest"
import { Plan, Task } from "@llm4ts/flow/Plan"
import { pruneNonCodingTasks } from "../src/Engineer.ts"

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
