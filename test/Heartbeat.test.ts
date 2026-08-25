import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  ProcessResult,
  makeFakeProcessExecutor,
  processCommandKey
} from "@llm4ts/core/ProcessExecutor"
import { makeFakeTemporaryFiles } from "@llm4ts/core/TemporaryFiles"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import {
  commentsArgs,
  makeAzureHosting,
  queryArgs,
  setTagsArgs,
  toHtml,
  wiqlFor,
  workItemShowArgs,
  type AzureConfig
} from "../src/Azure.ts"
import { CompanyConfig, TargetBoard, projectRefOf } from "../src/Config.ts"
import { claimComment, decide, heartbeat } from "../src/Heartbeat.ts"
import { WorkItemSummary } from "../src/Hosting.ts"
import { Tags } from "../src/Protocol.ts"

const target = TargetBoard.make({ project: "acme", defaultRepository: "widgets" })
const project = projectRefOf(target)

const azure: AzureConfig = {
  orgUrl: "https://dev.azure.com/acme",
  azBin: "az",
  workItemType: "Task",
  targetBranch: "main",
  apiVersion: "7.1-preview.3"
}

const config = CompanyConfig.make({
  targets: [target],
  heartbeatSeconds: 120,
  issueBudgetUsd: 5,
  dailyBudgetUsd: 25,
  maxAttempts: 2,
  engineerParallelism: 1
})

const empty = { planned: [], coded: [], reviewed: [], inReview: [], openIds: new Set<number>() }

const summary = (id: number, tags: ReadonlyArray<string>): WorkItemSummary =>
  WorkItemSummary.make({
    id,
    title: `Item ${id}`,
    body: "",
    author: "ceo",
    tags,
    state: "Active",
    updatedAt: "2026-07-31T00:00:00Z"
  })

// One `az boards query` row, shaped the way the CLI flattens WIQL results.
const row = (id: number, tag: string, body = "B"): string =>
  JSON.stringify({
    id,
    fields: {
      "System.Title": `T${id}`,
      "System.Description": toHtml(body),
      "System.State": "Active",
      "System.Tags": tag,
      "System.CreatedBy": { displayName: "ceo" },
      "System.ChangedDate": "2026-07-31T00:00:00Z"
    }
  })

const ok = ProcessResult.make({ stdout: [], exitCode: 0 })
const json = (payload: string): ProcessResult =>
  ProcessResult.make({ stdout: [payload], exitCode: 0 })

const queryKey = (tags: ReadonlyArray<string>): string =>
  processCommandKey(["az", ...queryArgs(azure, project, wiqlFor(project, { tags }))])

const openQueryKey = processCommandKey([
  "az",
  ...queryArgs(azure, project, wiqlFor(project, { state: "open" }))
])

// The poll queries: one per checkpoint tag, plus the open-item sweep the
// Blocked-by check needs.
const pollResponses = (
  rows: Readonly<Record<string, string>> = {}
): ReadonlyArray<readonly [string, ProcessResult]> => [
  ...[Tags.ready, Tags.wip, Tags.planned, Tags.coded, Tags.reviewed, Tags.review].map(
    (tag) => [queryKey([tag]), json(rows[tag] ?? "[]")] as const
  ),
  [openQueryKey, json(rows["open"] ?? "[]")] as const
]

// A tag edit is read-merge-write over the single System.Tags field: show
// the work item, then write the merged list back.
const tagEditResponses = (
  id: number,
  current: ReadonlyArray<string>,
  next: ReadonlyArray<string>
): ReadonlyArray<readonly [string, ProcessResult]> => [
  [processCommandKey(["az", ...workItemShowArgs(azure, id)]), json(row(id, current.join("; ")))],
  [processCommandKey(["az", ...setTagsArgs(azure, id, next)]), ok]
]

describe("Heartbeat", () => {
  it("decide claims oldest first, caps by free seats, and reports epics", () => {
    const ready = [
      summary(9, [Tags.ready]),
      summary(3, [Tags.ready]),
      summary(5, [Tags.ready, Tags.epic])
    ]
    const idle = decide([{ target, ready, wip: [], ...empty }], config)
    assert.deepStrictEqual(
      idle.claims.map((intent) => intent.item.id),
      [3]
    )
    assert.deepStrictEqual(
      idle.epics.map((intent) => intent.item.id),
      [5]
    )

    const busy = decide([{ target, ready, wip: [summary(1, [Tags.wip])], ...empty }], config)
    assert.deepStrictEqual(busy.claims, [])
    assert.strictEqual(busy.inFlight, 1)
  })

  it("decide blocks plan and code claims until Blocked-by prerequisites close", () => {
    const blocked = WorkItemSummary.make({
      id: 52,
      title: "Apply shell design",
      body: "Work.\nBlocked-by: #51\n\nParent: #50 (epic)",
      author: "bot",
      tags: [Tags.planned],
      state: "Active",
      updatedAt: "2026-08-04T00:00:00Z"
    })
    const snapshot = (openIds: ReadonlySet<number>) => ({
      target,
      ready: [],
      wip: [],
      planned: [blocked],
      coded: [],
      reviewed: [],
      inReview: [],
      openIds
    })
    assert.deepStrictEqual(decide([snapshot(new Set([51]))], config).stages.code, [])
    assert.strictEqual(decide([snapshot(new Set<number>())], config).stages.code.length, 1)
  })

  it("decide stops claiming when today's spend exhausts the daily budget", () => {
    const ready = [summary(3, [Tags.ready])]
    const throttled = decide([{ target, ready, wip: [], ...empty }], config, 25)
    assert.isTrue(throttled.throttled)
    assert.deepStrictEqual(throttled.claims, [])
    assert.deepStrictEqual(throttled.epics, [])
    const underBudget = decide([{ target, ready, wip: [], ...empty }], config, 24.99)
    assert.isFalse(underBudget.throttled)
    assert.strictEqual(underBudget.claims.length, 1)
  })

  it("decide assigns one intent per stage from the checkpoint tags", () => {
    const snapshots = [
      {
        target,
        ready: [summary(30, [Tags.ready])],
        wip: [],
        planned: [summary(31, [Tags.planned]), summary(32, [Tags.planned])],
        coded: [summary(33, [Tags.coded])],
        reviewed: [summary(34, [Tags.reviewed])],
        inReview: [summary(35, [Tags.review])],
        openIds: new Set<number>()
      }
    ]
    const decision = decide(snapshots, config)
    const ids = (stage: keyof typeof decision.stages): ReadonlyArray<number> =>
      decision.stages[stage].map((intent) => intent.item.id)

    assert.deepStrictEqual(ids("plan"), [30])
    // Code-stage cap is engineerParallelism (1): oldest planned item only.
    assert.deepStrictEqual(ids("code"), [31])
    assert.deepStrictEqual(ids("review"), [33])
    assert.deepStrictEqual(ids("qa"), [34])
    assert.deepStrictEqual(ids("mend"), [35])
    const throttled = decide(snapshots, config, 25)
    assert.deepStrictEqual(throttled.stages.code, [])
    assert.deepStrictEqual(throttled.stages.qa, [])
  })

  it.effect("staged mode runs each stage worker on its claimed work item", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          ...pollResponses({
            [Tags.planned]: `[${row(41, Tags.planned)}]`,
            [Tags.coded]: `[${row(42, Tags.coded)}]`,
            [Tags.reviewed]: `[${row(43, Tags.reviewed)}]`
          }),
          ...tagEditResponses(41, [Tags.planned], [Tags.planned, Tags.wip]),
          ...tagEditResponses(42, [Tags.coded], [Tags.coded, Tags.wip]),
          ...tagEditResponses(43, [Tags.reviewed], [Tags.reviewed, Tags.wip])
        ])
      })
      const temp = yield* makeFakeTemporaryFiles()
      const events = yield* makeCollectingFlowEvents
      const hosting = makeAzureHosting(
        azure,
        fake.executor,
        temp.temporaryFiles,
        "/anywhere",
        events
      )
      const ran: Array<string> = []
      const stageWorker =
        (stage: string) =>
        (intent: { item: { id: number } }): Effect.Effect<{
          outcome: "Shipped" | "Bounced" | "Failed" | "Advanced"
          costUsd: number
        }> =>
          Effect.sync(() => {
            ran.push(`${stage}:${intent.item.id}`)
            return { outcome: "Advanced" as const, costUsd: 0.1 }
          })

      yield* heartbeat(hosting, config, events, {
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

  it.effect("claims via az in claim mode and stays read-only in observe mode", () =>
    Effect.gen(function* () {
      const readyRows =
        `[${row(3, Tags.ready)},${row(5, `${Tags.ready}; ${Tags.epic}`, "Epic body")}]`
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          ...pollResponses({ [Tags.ready]: readyRows }),
          ...tagEditResponses(3, [Tags.ready], [Tags.wip]),
          [
            processCommandKey([
              "az",
              ...commentsArgs(azure, project.project, 3, "POST", undefined, "/fake/tmp")
            ]),
            json(JSON.stringify({ id: 900, text: toHtml(claimComment) }))
          ]
        ])
      })
      const temp = yield* makeFakeTemporaryFiles("/fake/tmp")
      const events = yield* makeCollectingFlowEvents
      const hosting = makeAzureHosting(
        azure,
        fake.executor,
        temp.temporaryFiles,
        "/anywhere",
        events
      )

      const worker = (): Effect.Effect<{
        outcome: "Shipped" | "Bounced" | "Failed"
        costUsd: number
      }> => Effect.succeed({ outcome: "Shipped" as const, costUsd: 1.25 })

      const epicReports: Array<number> = []
      const epicWorker = (intent: {
        item: { id: number }
      }): Effect.Effect<{ outcome: "Shipped" | "Bounced" | "Failed"; costUsd: number }> =>
        Effect.sync(() => {
          epicReports.push(intent.item.id)
          return { outcome: "Shipped" as const, costUsd: 0.5 }
        })

      const observed = yield* heartbeat(hosting, config, events, { claimMode: false })
      const readOnly = yield* fake.recorded
      const claimed = yield* heartbeat(hosting, config, events, {
        claimMode: true,
        worker,
        epicWorker
      })
      const allCalls = yield* fake.recorded
      assert.deepStrictEqual(epicReports, [5])

      assert.strictEqual(observed.claims.length, 1)
      // Observe mode is exactly the seven poll queries and nothing else: no
      // tag write, no comment, nothing the CEO did not ask for.
      assert.strictEqual(readOnly.length, 7)
      assert.isTrue(readOnly.every((call) => call.argv.includes("query")))
      assert.strictEqual(claimed.claims.length, 1)
      // The claim swapped ready for wip through a real System.Tags write.
      const setKey = processCommandKey(["az", ...setTagsArgs(azure, 3, [Tags.wip])])
      assert.isTrue(allCalls.map((call) => processCommandKey(call.argv)).includes(setKey))
      // The comment body reaches az as a JSON file, never as an argument.
      const commentCall = allCalls.find((call) => call.argv.includes("comments"))
      assert.include(commentCall?.argv ?? [], "--in-file")
      const written = yield* temp.files
      assert.include(written.at(-1)?.contents ?? "", "Nightcall")
      // Nightcall adds no variables of its own to any child: `az` reads
      // its credential from the inherited environment, and nothing this
      // module builds can put one somewhere it would be logged.
      assert.isTrue(allCalls.every((call) => Object.keys(call.envVars).length === 0))
    })
  )
})
