import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { StageCompleted, StageFailed, StageStarted, makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import { IssueCommentRef, type GitHubToolShape } from "@llm4ts/flow/GitHubTool"
import {
  loadCommentRef,
  makeChecklistEvents,
  renderChecklist,
  saveCommentRef
} from "../src/Checklist.ts"

const comment = IssueCommentRef.make({ owner: "acme", repo: "widgets", id: 42 })

const editCollector = (edits: Ref.Ref<ReadonlyArray<string>>): GitHubToolShape => ({
  createPr: () => Effect.die("unused"),
  readIssue: () => Effect.die("unused"),
  writeIssueComment: () => Effect.die("unused"),
  editIssueComment: (_comment, body) => Ref.update(edits, (existing) => [...existing, body]),
  writePrComment: () => Effect.die("unused"),
  updatePr: () => Effect.die("unused"),
  prChecks: () => Effect.die("unused"),
  listIssues: () => Effect.die("unused"),
  createIssue: () => Effect.die("unused"),
  editIssueLabels: () => Effect.die("unused"),
  assignIssue: () => Effect.die("unused"),
  closeIssue: () => Effect.die("unused")
})

describe("Checklist", () => {
  it("renders GitHub task-list syntax for every progress state", () => {
    const body = renderChecklist("deterministic-rebalancing", [
      { title: "Expose violations", progress: "done", note: "5m44s" },
      { title: "Propose trades", progress: "running" },
      { title: "Apply constraints", progress: "failed", note: "gate failed" },
      { title: "Defer adjustments", progress: "pending" }
    ])
    assert.include(body, "### Plan: deterministic-rebalancing")
    assert.include(body, "- [x] Expose violations (5m44s)")
    assert.include(body, "- [ ] ⏳ **Propose trades**")
    assert.include(body, "- [ ] ❌ Apply constraints — gate failed")
    assert.include(body, "- [ ] Defer adjustments")
    assert.include(body, "— Nightcall 🌙")
  })

  it.effect("round-trips the comment reference through the state file", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "nightcall-checklist-")))
      const path = join(dir, "plan-comment.json")
      assert.isUndefined(yield* loadCommentRef(path))
      yield* saveCommentRef(path, comment)
      const loaded = yield* loadCommentRef(path)
      assert.strictEqual(loaded?.id, 42)
      assert.strictEqual(loaded?.owner, "acme")
    })
  )

  it.effect("edits the checklist comment as task stage events arrive", () =>
    Effect.gen(function* () {
      const edits = yield* Ref.make<ReadonlyArray<string>>([])
      const inner = yield* makeCollectingFlowEvents
      const events = yield* makeChecklistEvents(inner, editCollector(edits), comment, "epic-x", [
        { title: "First task", completed: true },
        { title: "Second task", completed: false }
      ])

      yield* events.publish(StageStarted.make({ stage: "branch" }))
      yield* events.publish(StageStarted.make({ stage: "Second task" }))
      yield* events.publish(StageCompleted.make({ stage: "Second task" }))
      yield* events.publish(StageFailed.make({ stage: "Second task", message: "boom" }))

      const bodies = yield* Ref.get(edits)
      // Plumbing stage ("branch") produced no edit; the three task events did.
      assert.strictEqual(bodies.length, 3)
      assert.include(bodies[0], "- [x] First task")
      assert.include(bodies[0], "- [ ] ⏳ **Second task**")
      assert.match(bodies[1] ?? "", /- \[x\] Second task \(\d+s\)/)
      assert.include(bodies[2], "- [ ] ❌ Second task — boom")
      assert.strictEqual((yield* inner.recorded).length, 4)
    })
  )
})
