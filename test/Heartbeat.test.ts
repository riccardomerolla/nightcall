import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  ProcessResult,
  makeFakeProcessExecutor,
  processCommandKey
} from "@llm4ts/core/ProcessExecutor"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import {
  IssueSummary,
  issueCommentArgs,
  issueEditLabelsArgs,
  issueListArgs,
  makeGitHubTool
} from "@llm4ts/flow/GitHubTool"
import { CompanyConfig, TargetRepo } from "../src/Config.ts"
import { claimComment, decide, heartbeat, repoRefOf } from "../src/Heartbeat.ts"
import { Labels } from "../src/Protocol.ts"

const target = TargetRepo.make({ owner: "acme", repo: "widgets" })

const config = CompanyConfig.make({
  targets: [target],
  heartbeatSeconds: 120,
  issueBudgetUsd: 5,
  dailyBudgetUsd: 25,
  maxAttempts: 2,
  engineerParallelism: 1
})

const summary = (number: number, labels: ReadonlyArray<string>): IssueSummary =>
  IssueSummary.make({
    number,
    title: `Issue ${number}`,
    body: "",
    author: "ceo",
    labels,
    updatedAt: "2026-07-31T00:00:00Z"
  })

describe("Heartbeat", () => {
  it("decide claims oldest first, caps by free seats, and reports epics", () => {
    const ready = [
      summary(9, [Labels.ready]),
      summary(3, [Labels.ready]),
      summary(5, [Labels.ready, Labels.epic])
    ]
    const idle = decide([{ target, ready, wip: [] }], config)
    assert.deepStrictEqual(
      idle.claims.map((intent) => intent.issue.number),
      [3]
    )
    assert.deepStrictEqual(
      idle.skippedEpics.map((intent) => intent.issue.number),
      [5]
    )

    const busy = decide([{ target, ready, wip: [summary(1, [Labels.wip])] }], config)
    assert.deepStrictEqual(busy.claims, [])
    assert.strictEqual(busy.inFlight, 1)
  })

  it.effect("claims via gh in claim mode and stays read-only in observe mode", () =>
    Effect.gen(function* () {
      const repo = repoRefOf(target)
      const listJson = (issues: string): ProcessResult =>
        ProcessResult.make({ stdout: [issues], exitCode: 0 })
      const readyRow =
        '[{"number":3,"title":"T","body":"B","author":{"login":"ceo"},' +
        `"labels":[{"name":"${Labels.ready}"}],"updatedAt":"2026-07-31T00:00:00Z"}]`
      const ok = ProcessResult.make({ stdout: [], exitCode: 0 })
      const issueRef = summary(3, [Labels.ready]).ref(repo)
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(["gh", ...issueListArgs(repo, { labels: [Labels.ready] })]),
            listJson(readyRow)
          ],
          [
            processCommandKey(["gh", ...issueListArgs(repo, { labels: [Labels.wip] })]),
            listJson("[]")
          ],
          [
            processCommandKey([
              "gh",
              ...issueEditLabelsArgs(issueRef, [Labels.wip], [Labels.ready])
            ]),
            ok
          ],
          [processCommandKey(["gh", ...issueCommentArgs(issueRef, claimComment)]), ok]
        ])
      })
      const events = yield* makeCollectingFlowEvents
      const gh = makeGitHubTool(fake.executor, "/anywhere", events)

      const observed = yield* heartbeat(gh, config, events, { claimMode: false })
      const readOnlyCalls = (yield* fake.recorded).length
      const claimed = yield* heartbeat(gh, config, events, { claimMode: true })
      const allCalls = yield* fake.recorded

      assert.strictEqual(observed.claims.length, 1)
      assert.strictEqual(readOnlyCalls, 2)
      assert.strictEqual(claimed.claims.length, 1)
      const issue = summary(3, [Labels.ready]).ref(repo)
      const editKey = processCommandKey([
        "gh",
        ...issueEditLabelsArgs(issue, [Labels.wip], [Labels.ready])
      ])
      assert.isTrue(allCalls.map((call) => processCommandKey(call.argv)).includes(editKey))
      const commentCall = allCalls.find((call) => call.argv.includes("comment"))
      assert.include(commentCall?.argv.at(-1), "— Nightcall 🌙")
    })
  )
})
