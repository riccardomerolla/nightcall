import { assert, describe, it } from "@effect/vitest"
import { ProcessError } from "@llm4ts/flow/FlowError"
import { describeError } from "../src/Surface.ts"

describe("Error reporting", () => {
  it("puts the cause next to the command that failed", () => {
    // A ProcessError's message is the command; the reason is in `detail`.
    // Reporting the message alone is what turned "az is not installed" into
    // an unexplained heartbeat failure with a 200-character `az` command
    // attached and nothing said about it.
    const failure = ProcessError.make({
      message: "az boards query --wiql SELECT ... [System.State] <> 'Closed'",
      detail: "az failed: command not found. Install 'az' and make sure it is on your PATH"
    })

    const described = describeError(failure)

    assert.include(described, "az boards query")
    assert.include(described, "command not found")
  })

  it("says only what it has when there is no detail", () => {
    assert.strictEqual(describeError({ message: "plain failure" }), "plain failure")
    assert.strictEqual(describeError(ProcessError.make({ message: "m", detail: "" })), "m")
    assert.strictEqual(describeError(ProcessError.make({ message: "m", detail: "   " })), "m")
  })
})
