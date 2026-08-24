import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Grants, allGrants, restricted } from "@llm4ts/core/Capability"
import {
  ProcessResult,
  makeFakeProcessExecutor,
  processCommandKey
} from "@llm4ts/core/ProcessExecutor"
import { makeFakeTemporaryFiles } from "@llm4ts/core/TemporaryFiles"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import {
  branchName,
  cloneUrl,
  commentsArgs,
  createWorkItemArgs,
  makeAzureHosting,
  mergeTags,
  outcomeFromPolicies,
  parseComments,
  parseWorkItems,
  prCreateArgs,
  prListArgs,
  queryArgs,
  quoteWiql,
  setTagsArgs,
  toHtml,
  toText,
  wiqlFor,
  workItemShowArgs,
  type AzureConfig
} from "../src/Azure.ts"
import { ProjectRef, WorkItemRef } from "../src/Hosting.ts"
import { blockedByRefs, epicChildMarker, isEpicChild } from "../src/Prompts.ts"
import { Tags, signature, signed } from "../src/Protocol.ts"

const azure: AzureConfig = {
  orgUrl: "https://dev.azure.com/acme",
  workItemType: "Task",
  targetBranch: "main",
  apiVersion: "7.1-preview.3"
}

const project = ProjectRef.make({ project: "acme", repository: "widgets" })
const ref = WorkItemRef.make({ project: "acme", repository: "widgets", id: 7 })

const ok = ProcessResult.make({ stdout: [], exitCode: 0 })
const json = (payload: string): ProcessResult =>
  ProcessResult.make({ stdout: [payload], exitCode: 0 })

const workItemJson = (fields: Readonly<Record<string, unknown>> = {}): string =>
  JSON.stringify({
    id: 7,
    fields: {
      "System.Title": "Add a --version flag",
      "System.Description": toHtml("The CLI should print its version."),
      "System.State": "Active",
      "System.Tags": `${Tags.ready}; urgent`,
      "System.CreatedBy": { displayName: "Ada" },
      "System.ChangedDate": "2026-08-01T00:00:00Z",
      ...fields
    }
  })

describe("Azure DevOps HTML round trip", () => {
  it("survives the protocol markers the state machine parses", () => {
    // These three markers are load-bearing: the body is stored as HTML by
    // Azure DevOps, so a lossy conversion would silently break epic-child
    // detection and the Blocked-by dependency graph.
    const body = [
      "Implement the importer.",
      "",
      "Blocked-by: #51, #52",
      "",
      epicChildMarker(50)
    ].join("\n")

    const roundTripped = toText(toHtml(body))

    assert.strictEqual(roundTripped, body)
    assert.isTrue(isEpicChild(roundTripped))
    assert.deepStrictEqual(blockedByRefs(roundTripped), [51, 52])
  })

  it("escapes and restores markup without mistaking it for tags", () => {
    const body = 'Use <div class="x"> & compare a < b, a > b.'
    const html = toHtml(body)

    assert.include(html, "&lt;div")
    assert.notInclude(html, "<div")
    assert.strictEqual(toText(html), body)
    // Double-escaped input decodes exactly once: &amp;lt; is the text
    // "&lt;", not a "<" that a second pass would produce.
    assert.strictEqual(toText("&amp;lt;b&amp;gt;"), "&lt;b&gt;")
  })

  it("reads the HTML Azure DevOps actually renders", () => {
    assert.strictEqual(toText("<div>one</div><div>two</div>"), "one\ntwo")
    assert.strictEqual(toText("<ul><li>a</li><li>b</li></ul>"), "- a\n- b")
    assert.strictEqual(toText("a<br>b<br />c"), "a\nb\nc")
    assert.strictEqual(toText("spaced&nbsp;out"), "spaced out")
  })

  it("keeps the report signature intact so guidance detection still works", () => {
    const report = signed("Shipped to review.")
    assert.include(toText(toHtml(report)), signature)
  })
})

describe("Azure DevOps argv", () => {
  it("pins the organization and never lets the CLI infer one", () => {
    // Without --detect false, `az` reads the working directory's git remote
    // — inside a target worktree that is a different organization.
    for (const args of [
      workItemShowArgs(azure, 7),
      setTagsArgs(azure, 7, ["a"]),
      prListArgs(azure, project, "feature"),
      commentsArgs(azure, "acme", 7, "GET")
    ]) {
      assert.include(args, "--detect")
      assert.deepStrictEqual(args.slice(args.indexOf("--detect"), args.indexOf("--detect") + 2), [
        "--detect",
        "false"
      ])
      assert.include(args, "--org")
      assert.include(args, "https://dev.azure.com/acme")
    }
  })

  it("normalizes refs, joins tags, and links the PR to its work item", () => {
    assert.strictEqual(branchName("refs/heads/factory/item-7"), "factory/item-7")
    assert.deepStrictEqual(setTagsArgs(azure, 7, ["a", "b"]).slice(5, 7), [
      "--fields",
      "System.Tags=a; b"
    ])
    const create = prCreateArgs(azure, project, "refs/heads/factory/item-7", 7, "T", "B")
    assert.deepStrictEqual(create.slice(7, 11), [
      "--source-branch",
      "factory/item-7",
      "--target-branch",
      "main"
    ])
    // "Closes #N" has no meaning on Azure DevOps; --work-items is the link.
    assert.deepStrictEqual(create.slice(15, 17), ["--work-items", "7"])
    assert.deepStrictEqual(createWorkItemArgs(azure, project, "T", "B", []).slice(5, 9), [
      "--type",
      "Task",
      "--description",
      "B"
    ])
    assert.strictEqual(cloneUrl(azure, project), "https://dev.azure.com/acme/acme/_git/widgets")
  })

  it("escapes WIQL literals so a tag cannot rewrite the query", () => {
    assert.strictEqual(quoteWiql("won't fix"), "'won''t fix'")
    const wiql = wiqlFor(project, { tags: [Tags.ready], limit: 5 })
    assert.match(wiql, /SELECT TOP 5 /)
    assert.match(wiql, /\[System\.TeamProject\] = 'acme'/)
    assert.match(wiql, /\[System\.State\] <> 'Closed'/)
    assert.match(wiql, /\[System\.Tags\] CONTAINS 'factory:ready'/)
    assert.match(wiqlFor(project, { state: "closed" }), /\[System\.State\] = 'Closed'/)
    // "all" drops the state predicate; System.State stays in the SELECT.
    assert.notMatch(wiqlFor(project, { state: "all" }), /\[System\.State\] (=|<>)/)
    assert.match(wiqlFor(project, { tags: ["a' OR 1=1 --"] }), /'a'' OR 1=1 --'/)
  })
})

describe("Azure DevOps parsing", () => {
  it.effect("decodes flattened WIQL rows into work item summaries", () =>
    Effect.gen(function* () {
      const items = yield* parseWorkItems(`[${workItemJson()}]`)
      const item = items[0]

      assert.strictEqual(item?.id, 7)
      assert.strictEqual(item?.title, "Add a --version flag")
      assert.strictEqual(item?.body, "The CLI should print its version.")
      assert.strictEqual(item?.author, "Ada")
      assert.deepStrictEqual([...(item?.tags ?? [])], [Tags.ready, "urgent"])
      assert.strictEqual(item?.state, "Active")

      // Older API versions hand back a bare identity string.
      const legacy = yield* parseWorkItems(`[${workItemJson({ "System.CreatedBy": "Linus" })}]`)
      assert.strictEqual(legacy[0]?.author, "Linus")
      // A work item with no description or tags is still a work item.
      const bare = yield* parseWorkItems('[{"id":8,"fields":{}}]')
      assert.strictEqual(bare[0]?.body, "")
      assert.deepStrictEqual([...(bare[0]?.tags ?? [])], [])
    })
  )

  it.effect("orders comments oldest first, because guidance detection is positional", () =>
    Effect.gen(function* () {
      const comments = yield* parseComments(
        JSON.stringify({
          comments: [
            { id: 3, text: toHtml("later"), createdBy: { displayName: "ceo" } },
            { id: 1, text: toHtml(signed("report")), createdBy: "bot" }
          ]
        })
      )

      assert.deepStrictEqual(
        comments.map((comment) => comment.body),
        [signed("report"), "later"]
      )
      assert.strictEqual(comments[0]?.author, "bot")
      assert.deepStrictEqual([...(yield* parseComments('{"comments":[]}'))], [])
    })
  )

  it.effect("maps branch-policy statuses onto a build outcome", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* outcomeFromPolicies('[{"status":"approved"},{"status":"queued"}]'),
        "Pending"
      )
      assert.strictEqual(
        yield* outcomeFromPolicies('[{"status":"approved"},{"status":"rejected"}]'),
        "Failure"
      )
      assert.strictEqual(yield* outcomeFromPolicies('[{"status":"broken"}]'), "Failure")
      // A queued policy outranks a rejected one: still deciding.
      assert.strictEqual(
        yield* outcomeFromPolicies('[{"status":"rejected"},{"status":"running"}]'),
        "Pending"
      )
      // No policies configured is not a failure — there is nothing to fail.
      assert.strictEqual(yield* outcomeFromPolicies("[]"), "Success")
      assert.strictEqual(yield* outcomeFromPolicies('[{"status":"notApplicable"}]'), "Success")
    })
  )

  it("merges tags case-insensitively, the way Azure DevOps compares them", () => {
    assert.deepStrictEqual(mergeTags([Tags.ready, Tags.epic], [Tags.wip], ["FACTORY:READY"]), [
      Tags.epic,
      Tags.wip
    ])
    assert.deepStrictEqual(mergeTags(["wip"], ["WIP"], []), ["wip"])
    assert.deepStrictEqual(mergeTags(["a"], ["b"], ["b"]), ["a"])
    assert.deepStrictEqual(mergeTags([], [], []), [])
  })
})

describe("Azure DevOps hosting", () => {
  const hostingWith = (responses: ReadonlyArray<readonly [string, ProcessResult]>) =>
    Effect.gen(function* () {
      const fake = yield* makeFakeProcessExecutor({ responses: new Map(responses) })
      const temp = yield* makeFakeTemporaryFiles("/fake/tmp")
      const events = yield* makeCollectingFlowEvents
      return {
        fake,
        temp,
        hosting: makeAzureHosting(azure, fake.executor, temp.temporaryFiles, "/work", events)
      }
    })

  it.effect("edits tags as one read-merge-write over System.Tags", () =>
    Effect.gen(function* () {
      const { fake, hosting } = yield* hostingWith([
        [processCommandKey(["az", ...workItemShowArgs(azure, 7)]), json(workItemJson())],
        [processCommandKey(["az", ...setTagsArgs(azure, 7, ["urgent", Tags.wip])]), ok]
      ])

      yield* hosting.editTags(ref, [Tags.wip], [Tags.ready])
      // A no-op edit must not spend a request.
      yield* hosting.editTags(ref, [], [])
      const calls = yield* fake.recorded

      assert.strictEqual(calls.length, 2)
      assert.isTrue(calls.some((call) => call.argv.includes("System.Tags=urgent; factory:wip")))
    })
  )

  it.effect("filters WIQL's substring CONTAINS down to an exact tag match", () =>
    Effect.gen(function* () {
      // `[System.Tags] CONTAINS 'factory:review'` also matches
      // `factory:reviewed`; polling must not treat that as an open PR.
      const reviewed = JSON.stringify({
        id: 8,
        fields: { "System.Title": "T8", "System.Tags": Tags.reviewed }
      })
      const { hosting } = yield* hostingWith([
        [
          processCommandKey([
            "az",
            ...queryArgs(azure, project, wiqlFor(project, { tags: [Tags.review] }))
          ]),
          json(`[${workItemJson({ "System.Tags": Tags.review })},${reviewed}]`)
        ]
      ])

      const items = yield* hosting.listWorkItems(project, { tags: [Tags.review] })

      assert.deepStrictEqual(
        items.map((item) => item.id),
        [7]
      )
    })
  )

  it.effect("fails loudly when a comment never posts", () =>
    Effect.gen(function* () {
      const { hosting } = yield* hostingWith([
        [
          processCommandKey([
            "az",
            ...commentsArgs(azure, "acme", 7, "POST", undefined, "/fake/tmp")
          ]),
          ProcessResult.make({ stdout: [], exitCode: 1, stderr: ["TF401019: forbidden"] })
        ]
      ])

      const error = yield* Effect.flip(hosting.writeComment(ref, "governance"))

      assert.strictEqual(error._tag, "Process")
    })
  )

  it.effect("degrades to an un-editable comment when only the id is unreadable", () =>
    Effect.gen(function* () {
      const { hosting } = yield* hostingWith([
        [
          processCommandKey([
            "az",
            ...commentsArgs(azure, "acme", 7, "POST", undefined, "/fake/tmp")
          ]),
          json("not json at all")
        ]
      ])

      // The comment IS on the work item; the caller just cannot edit it.
      assert.isUndefined(yield* hosting.writeComment(ref, "posted anyway"))
    })
  )

  it.effect("posts a comment body as a JSON file, never as an argument", () =>
    Effect.gen(function* () {
      const body = signed("Claimed. Secrets never travel in argv.")
      const { fake, temp, hosting } = yield* hostingWith([
        [
          processCommandKey([
            "az",
            ...commentsArgs(azure, "acme", 7, "POST", undefined, "/fake/tmp")
          ]),
          json(JSON.stringify({ id: 12, text: toHtml(body) }))
        ]
      ])

      const comment = yield* hosting.writeComment(ref, body)
      const calls = yield* fake.recorded
      const written = yield* temp.files

      assert.strictEqual(comment?.id, 12)
      assert.strictEqual(comment?.workItemId, 7)
      assert.include(calls[0]?.argv ?? [], "--in-file")
      assert.isTrue((calls[0]?.argv ?? []).every((arg) => !arg.includes("Secrets never")))
      assert.strictEqual(JSON.parse(written[0]?.contents ?? "{}").text, toHtml(body))
    })
  )

  it.effect("reuses an active pull request instead of opening a second one", () =>
    Effect.gen(function* () {
      const { fake, hosting } = yield* hostingWith([
        [
          processCommandKey(["az", ...prListArgs(azure, project, "factory/item-7")]),
          json('[{"pullRequestId":9}]')
        ]
      ])

      const pr = yield* hosting.createPr(project, "factory/item-7", 7, "T", "B")
      const open = yield* hosting.openPr(project, "factory/item-7")
      const calls = yield* fake.recorded

      assert.strictEqual(pr.id, 9)
      assert.strictEqual(open?.id, 9)
      assert.match(pr.url, /pullrequest\/9$/)
      // No `pr create` was attempted — the fake has no response for one.
      assert.isTrue(calls.every((call) => !call.argv.includes("create")))
    })
  )

  it.effect("enforces read/write separation before the CLI is reached", () =>
    Effect.gen(function* () {
      const { fake, hosting } = yield* hostingWith([
        [
          processCommandKey(["az", ...queryArgs(azure, project, wiqlFor(project, {}))]),
          json(`[${workItemJson()}]`)
        ]
      ])
      const readOnly = new Grants({ ...allGrants, ado: "Read" })

      const polled = yield* restricted(readOnly)(hosting.listWorkItems(project))
      const denied = yield* Effect.flip(
        restricted(readOnly)(hosting.editTags(ref, [Tags.wip], []))
      )
      const calls = yield* fake.recorded

      assert.strictEqual(polled.length, 1)
      assert.strictEqual(denied._tag, "CapabilityDenied")
      // Denied before transport: the read query is the only call made.
      assert.strictEqual(calls.length, 1)
    })
  )

  it.effect("surfaces a non-zero az exit as a typed process failure", () =>
    Effect.gen(function* () {
      const { hosting } = yield* hostingWith([
        [
          processCommandKey(["az", ...workItemShowArgs(azure, 7)]),
          ProcessResult.make({
            stdout: [],
            exitCode: 1,
            stderr: ["TF401232: Work item 7 does not exist"]
          })
        ]
      ])

      const error = yield* Effect.flip(hosting.editTags(ref, [Tags.wip], []))

      assert.strictEqual(error._tag, "Process")
      assert.match(String("detail" in error ? error.detail : ""), /TF401232/)
    })
  )
})
