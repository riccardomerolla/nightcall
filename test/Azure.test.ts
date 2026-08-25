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
  adoConfigFor,
  azApiVersion,
  branchName,
  batchFileHint,
  defaultAzCommand,
  defaultAzureConfig,
  parseCommand,
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
import {
  GitArtifact,
  artifactUri,
  relationAddArgs,
  repositoryShowArgs,
  workItemLinkArgs,
  workItemShowArgs as relationsShowArgs
} from "@llm4ts/flow/AzureDevOpsTool"
import { ProjectRef, WorkItemRef } from "../src/Hosting.ts"
import { blockedByRefs, epicChildMarker, isEpicChild } from "../src/Prompts.ts"
import { Tags, signature, signed } from "../src/Protocol.ts"

const azure: AzureConfig = {
  orgUrl: "https://dev.azure.com/acme",
  azCommand: ["az"],
  workItemType: "Task",
  targetBranch: "main",
  apiVersion: "7.1-preview"
}

const project = ProjectRef.make({ project: "acme", repository: "widgets" })
const ref = WorkItemRef.make({ project: "acme", repository: "widgets", id: 7 })
// The adapter builds link argv from llm4ts's per-project config.
const ado = adoConfigFor(azure, "acme", "widgets")

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
    // A child of an epic merges into the EPIC's branch, not the default:
    // the epic branch accumulates its children and reaches main once, as
    // one reviewable piece.
    const child = prCreateArgs(
      azure,
      project,
      "factory/item-7",
      7,
      "T",
      "B",
      "refs/heads/feature/importer"
    )
    assert.deepStrictEqual(child.slice(9, 11), ["--target-branch", "feature/importer"])
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
    assert.match(wiql, /\[System\.TeamProject\] = 'acme'/)
    assert.match(wiql, /\[System\.State\] <> 'Closed'/)
    assert.match(wiql, /\[System\.Tags\] CONTAINS 'factory:ready'/)
    assert.match(wiqlFor(project, { state: "closed" }), /\[System\.State\] = 'Closed'/)
    // "all" drops the state predicate; System.State stays in the SELECT.
    assert.notMatch(wiqlFor(project, { state: "all" }), /\[System\.State\] (=|<>)/)
    assert.match(wiqlFor(project, { tags: ["a' OR 1=1 --"] }), /'a'' OR 1=1 --'/)
  })

  it("builds a query WIQL's grammar accepts", () => {
    // WIQL reads like SQL and is not SQL: SELECT / FROM / WHERE / ORDER BY /
    // ASOF is the whole language. `SELECT TOP n` — the obvious way to cap
    // rows — leaves the SELECT list unparseable, so the server never reaches
    // FROM and rejects the whole query with "TF51006: the query statement is
    // missing a FROM clause". Every heartbeat ran this query, so the daemon
    // saw nothing at all.
    const wiql = wiqlFor(project, { tags: [Tags.ready], limit: 5 })

    assert.notMatch(wiql, /\bTOP\b/i)
    assert.match(wiql, /^SELECT \[System\.Id\], /)
    assert.match(wiql, / FROM WorkItems WHERE /)
    assert.match(wiql, / ORDER BY \[System\.Id\] ASC$/)
  })
})

describe("Azure DevOps API version", () => {
  it("drops a resource suffix `az devops invoke` cannot parse", () => {
    // The CLI compares versions with float(apiVersion.replace('-preview',
    // '')), so "7.1-preview.3" becomes "7.1.3" and it dies with "could not
    // convert string to float" before a request is ever built. Microsoft's
    // REST docs quote exactly that suffixed form, so it is the value an
    // operator reaches for first.
    assert.strictEqual(azApiVersion("7.1-preview.3"), "7.1-preview")
    assert.strictEqual(azApiVersion("6.0-preview.2"), "6.0-preview")

    // Forms the CLI can parse are left exactly as given.
    assert.strictEqual(azApiVersion("7.1-preview"), "7.1-preview")
    assert.strictEqual(azApiVersion("7.1"), "7.1")
    assert.strictEqual(azApiVersion(" 7.1 "), "7.1")
  })

  it("defaults to a version the CLI accepts", () => {
    assert.strictEqual(defaultAzureConfig.apiVersion, "7.1-preview")
    assert.strictEqual(azApiVersion(defaultAzureConfig.apiVersion), defaultAzureConfig.apiVersion)
  })
})

describe("Azure DevOps executable", () => {
  it("says `az` on every platform", () => {
    // Windows needs no special name here: @llm4ts/runner resolves `az`
    // through PATHEXT and runs the batch file it finds, which is the same
    // thing a shell does for a human typing `az` at a prompt.
    assert.deepStrictEqual([...defaultAzCommand()], ["az"])
  })

  it("reads an override as argv, keeping a quoted path with spaces whole", () => {
    // The Windows answer is a real executable plus leading arguments, so
    // the override has to be a command, not just a program name.
    assert.deepStrictEqual(
      [...parseCommand('"C:\\Program Files\\Azure\\CLI2\\python.exe" -Im azure.cli')],
      ["C:\\Program Files\\Azure\\CLI2\\python.exe", "-Im", "azure.cli"]
    )
    assert.deepStrictEqual([...parseCommand("az")], ["az"])
    assert.deepStrictEqual([...parseCommand("   ")], [])
  })

  it("turns Node's spawn EINVAL into something an operator can act on", () => {
    // "spawn EINVAL" names neither the cause nor a way out. It can only
    // reach an operator now on a runner too old to run a batch file.
    const hint = batchFileHint("az failed: spawn EINVAL")
    assert.include(hint, "batch file")
    assert.include(hint, "0.13.1")
    assert.strictEqual(batchFileHint("command not found"), "")
  })

  it.effect("launches the configured executable, not a hardcoded name", () =>
    Effect.gen(function* () {
      const windows = { ...azure, azCommand: ["az.cmd"] }
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(["az.cmd", ...workItemShowArgs(windows, 7)]),
            json(workItemJson())
          ]
        ])
      })
      const temp = yield* makeFakeTemporaryFiles("/fake/tmp")
      const events = yield* makeCollectingFlowEvents
      const hosting = makeAzureHosting(
        windows,
        fake.executor,
        temp.temporaryFiles,
        "/work",
        events
      )

      // editTags reads first; the read must have gone to az.cmd.
      yield* hosting.editTags(ref, [], [])
      yield* Effect.orElseSucceed(hosting.developmentLinks(ref), () => [])
      const calls = yield* fake.recorded

      assert.isTrue(calls.every((call) => call.argv[0] === "az.cmd"))
    })
  )

  it.effect("names the executable in the error, so the report matches reality", () =>
    Effect.gen(function* () {
      const windows = { ...azure, azCommand: ["az.cmd"] }
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(["az.cmd", ...workItemShowArgs(windows, 7)]),
            ProcessResult.make({ stdout: [], exitCode: 9009, stderr: ["not recognized"] })
          ]
        ])
      })
      const temp = yield* makeFakeTemporaryFiles("/fake/tmp")
      const events = yield* makeCollectingFlowEvents
      const hosting = makeAzureHosting(
        windows,
        fake.executor,
        temp.temporaryFiles,
        "/work",
        events
      )

      const error = yield* Effect.flip(hosting.editTags(ref, [Tags.wip], []))

      assert.match(error.message, /^az\.cmd boards work-item show/)
    })
  )
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

  it.effect("reads a quiet board as an empty queue, not a crash", () =>
    Effect.gen(function* () {
      // The Azure CLI prints NOTHING for a command that returns None, and
      // `az boards query` returns None exactly when the WIQL matches no
      // work items. So a board with nothing tagged for the factory — which
      // is what a heartbeat finds most of the time — arrives as empty
      // stdout with exit code 0, and decoding it as JSON fails with
      // "Unexpected end of JSON input".
      assert.deepStrictEqual([...(yield* parseWorkItems(""))], [])
      assert.deepStrictEqual([...(yield* parseWorkItems("  \r\n"))], [])

      // Emptiness is "no rows"; malformed output is still an error.
      const broken = yield* Effect.flip(parseWorkItems('[{"id":'))
      assert.strictEqual(broken._tag, "Process")
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

      // Read, write, and read BACK. The tag field is the whole state
      // machine: an add that lands while its removes do not leaves the
      // item wearing a checkpoint it has passed and a claim nobody holds,
      // which no stage will ever pick up. The read-back is what turns that
      // from silence into a logged warning.
      assert.strictEqual(calls.length, 3)
      assert.isTrue(calls.some((call) => call.argv.includes("System.Tags=urgent; factory:wip")))
    })
  )

  it.effect("tells the board a parent and a blocker as links, not only as prose", () =>
    Effect.gen(function* () {
      // `Parent: #3 (epic)` in a description reads the same to a human and
      // means nothing to the backlog tree. Predecessor is what Azure DevOps
      // calls "blocked by", and a work item link takes --target-id where an
      // artifact link takes --target-url.
      const { fake, hosting } = yield* hostingWith([
        [processCommandKey(["az", ...workItemLinkArgs(ado, 7, "Parent", 3)]), ok],
        [processCommandKey(["az", ...workItemLinkArgs(ado, 7, "Predecessor", 5)]), ok]
      ])

      yield* hosting.linkWorkItem(ref, "Parent", 3)
      yield* hosting.linkWorkItem(ref, "Predecessor", 5)
      const calls = yield* fake.recorded

      assert.strictEqual(calls.length, 2)
      assert.isTrue(calls.every((call) => call.argv.includes("--target-id")))
      assert.isTrue(calls.every((call) => !call.argv.includes("--target-url")))
      assert.deepStrictEqual(
        calls.map((call) => call.argv[call.argv.indexOf("--relation-type") + 1]),
        ["parent", "predecessor"]
      )
    })
  )

  it.effect("reads hierarchy and dependency links back off the work item", () =>
    Effect.gen(function* () {
      const relations = JSON.stringify({
        id: 7,
        relations: [
          {
            rel: "System.LinkTypes.Hierarchy-Reverse",
            url: "https://dev.azure.com/acme/_apis/wit/workItems/3"
          },
          {
            rel: "System.LinkTypes.Dependency-Reverse",
            url: "https://dev.azure.com/acme/_apis/wit/workItems/5"
          }
        ]
      })
      const { hosting } = yield* hostingWith([
        [processCommandKey(["az", ...relationsShowArgs(ado, 7, "relations")]), json(relations)]
      ])

      const links = yield* hosting.workItemLinks(ref)

      assert.deepStrictEqual(
        links.map((link) => [link.kind, link.id]),
        [
          ["Parent", 3],
          ["Predecessor", 5]
        ]
      )
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

  it.effect("links a branch back to the work item, and only once", () =>
    Effect.gen(function* () {
      const ado = adoConfigFor(azure, "acme", "widgets")
      const artifact = GitArtifact.make({
        kind: "Branch",
        projectId: "p-guid",
        repositoryId: "r-guid",
        value: "factory/item-7"
      })
      const repoJson = JSON.stringify({
        id: "r-guid",
        name: "widgets",
        project: { id: "p-guid", name: "acme" },
        defaultBranch: "refs/heads/main"
      })
      const { fake, hosting } = yield* hostingWith([
        [processCommandKey(["az", ...repositoryShowArgs(ado, "widgets")]), json(repoJson)],
        // First read: nothing linked. Second: the link this call just made.
        [
          processCommandKey(["az", ...relationsShowArgs(ado, 7, "relations")]),
          json(JSON.stringify({ id: 7, fields: {} }))
        ],
        [processCommandKey(["az", ...relationAddArgs(ado, 7, artifact)]), ok]
      ])

      yield* hosting.linkBranch(ref, "widgets", "refs/heads/factory/item-7")
      const calls = yield* fake.recorded

      // The ref arrived as a full ref name and is linked as a short one.
      assert.isTrue(
        calls.some((call) => call.argv.includes(artifactUri(artifact))),
        "the branch artifact URI was never sent"
      )
    })
  )

  it.effect("does not re-add a Development link that is already there", () =>
    Effect.gen(function* () {
      const ado = adoConfigFor(azure, "acme", "widgets")
      const artifact = GitArtifact.make({
        kind: "PullRequest",
        projectId: "p-guid",
        repositoryId: "r-guid",
        value: "42"
      })
      const { fake, hosting } = yield* hostingWith([
        [
          processCommandKey(["az", ...repositoryShowArgs(ado, "widgets")]),
          json(
            JSON.stringify({
              id: "r-guid",
              name: "widgets",
              project: { id: "p-guid", name: "acme" }
            })
          )
        ],
        [
          processCommandKey(["az", ...relationsShowArgs(ado, 7, "relations")]),
          json(
            JSON.stringify({
              id: 7,
              fields: {},
              relations: [
                {
                  rel: "ArtifactLink",
                  url: artifactUri(artifact),
                  attributes: { name: "Pull Request" }
                }
              ]
            })
          )
        ]
      ])

      // Adding a duplicate link is an error from the service, so a resumed
      // stage must recognise its own earlier work. The fake has no response
      // for `relation add`, so attempting one would fail this test.
      yield* hosting.linkPullRequest(ref, "widgets", 42)
      const calls = yield* fake.recorded

      assert.isTrue(calls.every((call) => !call.argv.includes("--target-url")))
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
