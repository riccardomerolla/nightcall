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

const empty = { planned: [], coded: [], reviewed: [], inReview: [], openNumbers: new Set<number>() }

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
    const idle = decide([{ target, ready, wip: [], ...empty }], config)
    assert.deepStrictEqual(
      idle.claims.map((intent) => intent.issue.number),
      [3]
    )
    assert.deepStrictEqual(
      idle.epics.map((intent) => intent.issue.number),
      [5]
    )

    const busy = decide([{ target, ready, wip: [summary(1, [Labels.wip])], ...empty }], config)
    assert.deepStrictEqual(busy.claims, [])
    assert.strictEqual(busy.inFlight, 1)
  })

  it("decide blocks plan and code claims until Blocked-by prerequisites close", () => {
    const blockedIssue = IssueSummary.make({
      number: 52,
      title: "Apply shell design",
      body: "Work.\nBlocked-by: #51\n\nParent: #50 (epic)",
      author: "bot",
      labels: [Labels.planned],
      updatedAt: "2026-08-04T00:00:00Z"
    })
    const withOpenBlocker = decide(
      [{ target, ready: [], wip: [], planned: [blockedIssue], coded: [], reviewed: [], inReview: [], openNumbers: new Set([51]) }],
      config
    )
    assert.deepStrictEqual(withOpenBlocker.stages.code, [])
    const blockerClosed = decide(
      [{ target, ready: [], wip: [], planned: [blockedIssue], coded: [], reviewed: [], inReview: [], openNumbers: new Set<number>() }],
      config
    )
    assert.strictEqual(blockerClosed.stages.code.length, 1)
  })

  it("decide stops claiming when today's spend exhausts the daily budget", () => {
    const ready = [summary(3, [Labels.ready])]
    const throttled = decide([{ target, ready, wip: [], ...empty }], config, 25)
    assert.isTrue(throttled.throttled)
    assert.deepStrictEqual(throttled.claims, [])
    assert.deepStrictEqual(throttled.epics, [])
    const underBudget = decide([{ target, ready, wip: [], ...empty }], config, 24.99)
    assert.isFalse(underBudget.throttled)
    assert.strictEqual(underBudget.claims.length, 1)
  })

  it("decide assigns one intent per stage from the checkpoint labels", () => {
    const snapshots = [
      {
        target,
        ready: [summary(30, [Labels.ready])],
        wip: [],
        planned: [summary(31, [Labels.planned]), summary(32, [Labels.planned])],
        coded: [summary(33, [Labels.coded])],
        reviewed: [summary(34, [Labels.reviewed])],
        inReview: [summary(35, [Labels.review])],
        openNumbers: new Set<number>()
      }
    ]
    const decision = decide(snapshots, config)
    assert.deepStrictEqual(
      decision.stages.plan.map((intent) => intent.issue.number),
      [30]
    )
    // Code-stage cap is engineerParallelism (1): oldest planned issue only.
    assert.deepStrictEqual(
      decision.stages.code.map((intent) => intent.issue.number),
      [31]
    )
    assert.deepStrictEqual(
      decision.stages.review.map((intent) => intent.issue.number),
      [33]
    )
    assert.deepStrictEqual(
      decision.stages.qa.map((intent) => intent.issue.number),
      [34]
    )
    assert.deepStrictEqual(
      decision.stages.mend.map((intent) => intent.issue.number),
      [35]
    )
    const throttled = decide(snapshots, config, 25)
    assert.deepStrictEqual(throttled.stages.code, [])
    assert.deepStrictEqual(throttled.stages.qa, [])
  })

  it.effect("staged mode runs each stage worker on its claimed issue", () =>
    Effect.gen(function* () {
      const repo = repoRefOf(target)
      const listJson = (issues: string): ProcessResult =>
        ProcessResult.make({ stdout: [issues], exitCode: 0 })
      const row = (number: number, label: string): string =>
        `{"number":${number},"title":"T${number}","body":"B","author":{"login":"ceo"},` +
        `"labels":[{"name":"${label}"}],"updatedAt":"2026-07-31T00:00:00Z"}`
      const ok = ProcessResult.make({ stdout: [], exitCode: 0 })
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(["gh", ...issueListArgs(repo, { labels: [Labels.ready] })]),
            listJson("[]")
          ],
          [
            processCommandKey(["gh", ...issueListArgs(repo, { labels: [Labels.wip] })]),
            listJson("[]")
          ],
          [
            processCommandKey(["gh", ...issueListArgs(repo, { labels: [Labels.planned] })]),
            listJson(`[${row(41, Labels.planned)}]`)
          ],
          [
            processCommandKey(["gh", ...issueListArgs(repo, { labels: [Labels.coded] })]),
            listJson(`[${row(42, Labels.coded)}]`)
          ],
          [
            processCommandKey(["gh", ...issueListArgs(repo, { labels: [Labels.reviewed] })]),
            listJson(`[${row(43, Labels.reviewed)}]`)
          ],
          [
            processCommandKey(["gh", ...issueListArgs(repo, { labels: [Labels.review] })]),
            listJson("[]")
          ],
          [
            processCommandKey(["gh", ...issueListArgs(repo, { state: "open" })]),
            listJson("[]")
          ],
          [
            processCommandKey([
              "gh",
              ...issueEditLabelsArgs(summary(41, []).ref(repo), [Labels.wip], [])
            ]),
            ok
          ],
          [
            processCommandKey([
              "gh",
              ...issueEditLabelsArgs(summary(42, []).ref(repo), [Labels.wip], [])
            ]),
            ok
          ],
          [
            processCommandKey([
              "gh",
              ...issueEditLabelsArgs(summary(43, []).ref(repo), [Labels.wip], [])
            ]),
            ok
          ]
        ])
      })
      const events = yield* makeCollectingFlowEvents
      const gh = makeGitHubTool(fake.executor, "/anywhere", events)
      const ran: Array<string> = []
      const stageWorker =
        (stage: string) =>
        (intent: { issue: { number: number } }): Effect.Effect<{
          outcome: "Shipped" | "Bounced" | "Failed" | "Advanced"
          costUsd: number
        }> =>
          Effect.sync(() => {
            ran.push(`${stage}:${intent.issue.number}`)
            return { outcome: "Advanced" as const, costUsd: 0.1 }
          })

      yield* heartbeat(gh, config, events, {
        claimMode: true,
        stageWorkers: {
          plan: stageWorker("plan"),
          code: stageWorker("code"),
          review: stageWorker("review"),
          qa: stageWorker("qa"),
          mend: stageWorker("mend")
        }
      })
      // Stage workers are forked detached; give the runtime a few ticks.
      for (let i = 0; i < 10; i += 1) {
        yield* Effect.yieldNow
      }
      assert.deepStrictEqual([...ran].sort(), ["code:41", "qa:43", "review:42"])
    })
  )

  it.effect("claims via gh in claim mode and stays read-only in observe mode", () =>
    Effect.gen(function* () {
      const repo = repoRefOf(target)
      const listJson = (issues: string): ProcessResult =>
        ProcessResult.make({ stdout: [issues], exitCode: 0 })
      const readyRow =
        '[{"number":3,"title":"T","body":"B","author":{"login":"ceo"},' +
        `"labels":[{"name":"${Labels.ready}"}],"updatedAt":"2026-07-31T00:00:00Z"},` +
        '{"number":5,"title":"E","body":"Epic body","author":{"login":"ceo"},' +
        `"labels":[{"name":"${Labels.ready}"},{"name":"${Labels.epic}"}],` +
        '"updatedAt":"2026-07-31T00:00:00Z"}]'
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
            processCommandKey(["gh", ...issueListArgs(repo, { labels: [Labels.planned] })]),
            listJson("[]")
          ],
          [
            processCommandKey(["gh", ...issueListArgs(repo, { labels: [Labels.coded] })]),
            listJson("[]")
          ],
          [
            processCommandKey(["gh", ...issueListArgs(repo, { labels: [Labels.reviewed] })]),
            listJson("[]")
          ],
          [
            processCommandKey(["gh", ...issueListArgs(repo, { labels: [Labels.review] })]),
            listJson("[]")
          ],
          [
            processCommandKey(["gh", ...issueListArgs(repo, { state: "open" })]),
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

      const worker = (): Effect.Effect<{
        outcome: "Shipped" | "Bounced" | "Failed"
        costUsd: number
      }> => Effect.succeed({ outcome: "Shipped" as const, costUsd: 1.25 })

      const epicReports: Array<number> = []
      const epicWorker = (intent: {
        issue: { number: number }
      }): Effect.Effect<{ outcome: "Shipped" | "Bounced" | "Failed"; costUsd: number }> =>
        Effect.sync(() => {
          epicReports.push(intent.issue.number)
          return { outcome: "Shipped" as const, costUsd: 0.5 }
        })

      const observed = yield* heartbeat(gh, config, events, { claimMode: false })
      const readOnlyCalls = (yield* fake.recorded).length
      const claimed = yield* heartbeat(gh, config, events, { claimMode: true, worker, epicWorker })
      const allCalls = yield* fake.recorded
      assert.deepStrictEqual(epicReports, [5])

      assert.strictEqual(observed.claims.length, 1)
      assert.strictEqual(readOnlyCalls, 7)
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
