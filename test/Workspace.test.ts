import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { GitArtifact, GitRepository, WorkItemLink } from "@llm4ts/flow/AzureDevOpsTool"
import { ProcessError } from "@llm4ts/flow/FlowError"
import { TargetBoard } from "../src/Config.ts"
import { WorkItemRef } from "../src/Hosting.ts"
import { resolveWorkspace, unroutableNotice } from "../src/Workspace.ts"
import { stubHosting } from "./FakeHosting.ts"

const board = TargetBoard.make({ project: "acme", defaultRepository: "widgets" })
const bare = TargetBoard.make({ project: "acme", defaultRepository: "" })
const ref = WorkItemRef.make({ project: "acme", repository: "widgets", id: 7 })

// An ordinary work item: no epic above it, so no repository to inherit.
const plain = { id: 7, body: "Add a --version flag." }
// A decomposed child carries the marker the Tech Lead appends.
const child = { id: 7, body: "Build the importer.\n\nParent: #3 (epic)" }

const repository = GitRepository.make({
  id: "r-guid",
  name: "gears",
  projectId: "p-guid",
  projectName: "acme",
  defaultBranch: "main",
  webUrl: "https://dev.azure.com/acme/acme/_git/gears"
})

const branchLink = GitArtifact.make({
  kind: "Branch",
  projectId: "p-guid",
  repositoryId: "r-guid",
  value: "feature/importer"
})

const prLink = GitArtifact.make({
  kind: "PullRequest",
  projectId: "p-guid",
  repositoryId: "r-guid",
  value: "42"
})

describe("Workspace resolution", () => {
  it.effect("follows a Branch development link to its repository and branch", () =>
    Effect.gen(function* () {
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      const hosting = stubHosting({
        developmentLinks: () => Effect.succeed([prLink, branchLink]),
        repository: (project, nameOrId) =>
          Ref.update(asked, (seen) => [...seen, `${project}/${nameOrId}`]).pipe(
            Effect.as(repository)
          )
      })

      const routing = yield* resolveWorkspace(hosting, board, ref, plain)

      // The human designated a branch; the factory works on it, in the
      // repository the link names — NOT the board's default.
      assert.deepStrictEqual(routing, {
        _tag: "Routed",
        workspace: { repository: "gears", branch: "feature/importer", linked: true }
      })
      // The link carries a GUID, so the name had to be resolved back.
      assert.deepStrictEqual([...(yield* Ref.get(asked))], ["acme/r-guid"])
    })
  )

  it.effect("falls back to the board's default repository and a factory branch", () =>
    Effect.gen(function* () {
      const hosting = stubHosting({
        // A pull-request link alone says nothing about where new work goes.
        developmentLinks: () => Effect.succeed([prLink])
      })

      assert.deepStrictEqual(yield* resolveWorkspace(hosting, board, ref, plain), {
        _tag: "Routed",
        workspace: { repository: "widgets", branch: "factory/item-7", linked: false }
      })
    })
  )

  it.effect("is unroutable when a board has no default and the item has no link", () =>
    Effect.gen(function* () {
      const hosting = stubHosting({ developmentLinks: () => Effect.succeed([]) })

      assert.deepStrictEqual(yield* resolveWorkspace(hosting, bare, ref, plain), {
        _tag: "Unroutable",
        links: []
      })
      const notice = unroutableNotice(bare)
      assert.include(notice, "no Development link")
      assert.include(notice, "acme")
      assert.include(notice, "factory:ready")
    })
  )

  it.effect("says what the Development links were when none is a branch", () =>
    Effect.gen(function* () {
      // "This work item has no Development link" is false when a human
      // linked a pull request; the item is unroutable because none of its
      // links names a branch, which is a different thing to be told.
      const hosting = stubHosting({ developmentLinks: () => Effect.succeed([prLink]) })

      const routing = yield* resolveWorkspace(hosting, bare, ref, plain)

      assert.deepStrictEqual(routing, { _tag: "Unroutable", links: [prLink] })
      const notice = unroutableNotice(bare, routing._tag === "Unroutable" ? routing.links : [])
      assert.notInclude(notice, "has no Development link")
      assert.include(notice, "pull request !42")
      assert.include(notice, "name no branch")
    })
  )

  it.effect("will not call an unreadable Development section 'no link'", () =>
    Effect.gen(function* () {
      // The bug this replaces: a failed lookup became an empty link list,
      // so an item with a perfectly good Branch link was bounced with a
      // comment telling it that it had none — and stripped of
      // `factory:ready`, so it never came back.
      const hosting = stubHosting({
        developmentLinks: () =>
          Effect.fail(ProcessError.make({ message: "az boards", detail: "TF401019" }))
      })

      const routing = yield* resolveWorkspace(hosting, bare, ref, plain)

      assert.strictEqual(routing._tag, "Undetermined")
      // The reason travels with the answer, so the log can name it.
      assert.include(routing._tag === "Undetermined" ? routing.detail : "", "TF401019")
    })
  )

  it.effect("does not reroute to the default repository when the board went quiet", () =>
    Effect.gen(function* () {
      // The same failure on a board that HAS a default was worse than a
      // false comment: the item was worked in the default repository, on a
      // fresh `factory/item-7`, ignoring the branch a human had designated.
      const hosting = stubHosting({
        developmentLinks: () =>
          Effect.fail(ProcessError.make({ message: "az boards", detail: "throttled" }))
      })

      const routing = yield* resolveWorkspace(hosting, board, ref, plain)

      assert.strictEqual(routing._tag, "Undetermined")
    })
  )

  it.effect("works a decomposed child in the repository its epic names", () =>
    Effect.gen(function* () {
      // The human linked the epic to a branch; the children the Tech Lead
      // created carry no Development link of their own. They are how that
      // epic gets built, so they belong in the same repository — and on a
      // board with no default, inheriting is the difference between a
      // decomposition that works and five unroutable children.
      const asked = yield* Ref.make<ReadonlyArray<number>>([])
      const hosting = stubHosting({
        developmentLinks: (target) =>
          Ref.update(asked, (seen) => [...seen, target.id]).pipe(
            Effect.as(target.id === 3 ? [branchLink] : [])
          ),
        repository: () => Effect.succeed(repository)
      })

      const routing = yield* resolveWorkspace(hosting, bare, ref, child)

      assert.deepStrictEqual(routing, {
        _tag: "Routed",
        // The epic's repository — but the child's OWN branch. Sharing the
        // epic's branch would put every child on one ref, and Azure DevOps
        // answers five pull requests from one source ref with one PR.
        workspace: { repository: "gears", branch: "factory/item-7", linked: false }
      })
      // The child was asked first, then its parent.
      assert.deepStrictEqual([...(yield* Ref.get(asked))], [7, 3])
    })
  )

  it.effect("falls back to the board default when the epic has no branch either", () =>
    Effect.gen(function* () {
      const hosting = stubHosting({ developmentLinks: () => Effect.succeed([]) })

      assert.deepStrictEqual(yield* resolveWorkspace(hosting, board, ref, child), {
        _tag: "Routed",
        workspace: { repository: "widgets", branch: "factory/item-7", linked: false }
      })
    })
  )

  it.effect("finds the parent of a child a human created, which has no marker", () =>
    Effect.gen(function* () {
      // A child made under the epic in the Azure DevOps UI has the native
      // Parent link and none of the Tech Lead's prose, so the marker alone
      // would miss it.
      const hosting = stubHosting({
        developmentLinks: (target) => Effect.succeed(target.id === 3 ? [branchLink] : []),
        workItemLinks: () => Effect.succeed([WorkItemLink.make({ kind: "Parent", id: 3 })]),
        repository: () => Effect.succeed(repository)
      })

      const routing = yield* resolveWorkspace(hosting, bare, ref, plain)

      assert.deepStrictEqual(routing, {
        _tag: "Routed",
        workspace: { repository: "gears", branch: "factory/item-7", linked: false }
      })
    })
  )

  it.effect("refuses to guess when a linked repository cannot be read", () =>
    Effect.gen(function* () {
      const hosting = stubHosting({
        developmentLinks: () => Effect.succeed([branchLink]),
        repository: () =>
          Effect.fail(ProcessError.make({ message: "az repos show", detail: "TF401019" }))
      })

      const routing = yield* resolveWorkspace(hosting, board, ref, plain)

      // Falling back to the default would silently work the item in the
      // wrong repository — worse than doing nothing. And the item has a
      // link, so it is not "unroutable" either: it is unread.
      assert.strictEqual(routing._tag, "Undetermined")
      assert.include(routing._tag === "Undetermined" ? routing.detail : "", "r-guid")
    })
  )
})
