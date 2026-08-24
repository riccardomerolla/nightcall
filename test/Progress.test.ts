import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { makeCollectingFlowEvents, StageCompleted, StageFailed, StageStarted } from "@llm4ts/flow/FlowEvents"
import { WorkItemRef } from "../src/Hosting.ts"
import { stubHosting } from "./FakeHosting.ts"
import { formatDuration, makeProgressEvents } from "../src/Progress.ts"

const ref = WorkItemRef.make({ project: "acme", repository: "widgets", id: 7 })

const commentCollector = (comments: Ref.Ref<ReadonlyArray<string>>) =>
  stubHosting({
    writeComment: (_ref, body) =>
      Ref.update(comments, (existing) => [...existing, body]).pipe(Effect.as(undefined))
  })

describe("Progress", () => {
  it("formats durations", () => {
    assert.strictEqual(formatDuration(0), "0s")
    assert.strictEqual(formatDuration(45_000), "45s")
    assert.strictEqual(formatDuration(186_000), "3m06s")
    assert.strictEqual(formatDuration(3_600_000), "60m00s")
  })

  it.effect("mirrors stage events as ▶/✔/✖ comments and filters plumbing", () =>
    Effect.gen(function* () {
      const comments = yield* Ref.make<ReadonlyArray<string>>([])
      const inner = yield* makeCollectingFlowEvents
      const events = yield* makeProgressEvents(inner, commentCollector(comments), ref)

      yield* events.publish(StageStarted.make({ stage: "branch" }))
      yield* events.publish(StageStarted.make({ stage: "Implement kebabCase" }))
      yield* events.publish(StageCompleted.make({ stage: "Implement kebabCase" }))
      yield* events.publish(StageStarted.make({ stage: "Add tests" }))
      yield* events.publish(StageFailed.make({ stage: "Add tests", message: "gate failed" }))

      const posted = yield* Ref.get(comments)
      assert.strictEqual(posted.length, 4)
      assert.strictEqual(posted[0], "▶ Implement kebabCase")
      assert.match(posted[1] ?? "", /^✔ Implement kebabCase \(\d+s\)$/)
      assert.strictEqual(posted[2], "▶ Add tests")
      assert.match(posted[3] ?? "", /^✖ Add tests \(\d+s\): gate failed$/)
      // Inner sink still received everything, including the filtered stage.
      assert.strictEqual((yield* inner.recorded).length, 5)
    })
  )
})
