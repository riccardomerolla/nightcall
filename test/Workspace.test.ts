import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { GitArtifact, GitRepository } from "@llm4ts/flow/AzureDevOpsTool"
import { ProcessError } from "@llm4ts/flow/FlowError"
import { TargetBoard } from "../src/Config.ts"
import { WorkItemRef } from "../src/Hosting.ts"
import { resolveWorkspace, unroutableNotice } from "../src/Workspace.ts"
import { stubHosting } from "./FakeHosting.ts"

const board = TargetBoard.make({ project: "acme", defaultRepository: "widgets" })
const bare = TargetBoard.make({ project: "acme", defaultRepository: "" })
const ref = WorkItemRef.make({ project: "acme", repository: "widgets", id: 7 })

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

      const workspace = yield* resolveWorkspace(hosting, board, ref, 7)

      // The human designated a branch; the factory works on it, in the
      // repository the link names — NOT the board's default.
      assert.deepStrictEqual(workspace, {
        repository: "gears",
        branch: "feature/importer",
        linked: true
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

      assert.deepStrictEqual(yield* resolveWorkspace(hosting, board, ref, 7), {
        repository: "widgets",
        branch: "factory/item-7",
        linked: false
      })
    })
  )

  it.effect("is unroutable when a board has no default and the item has no link", () =>
    Effect.gen(function* () {
      const hosting = stubHosting({ developmentLinks: () => Effect.succeed([]) })

      assert.isUndefined(yield* resolveWorkspace(hosting, bare, ref, 7))
      const notice = unroutableNotice(bare)
      assert.include(notice, "no Development link")
      assert.include(notice, "acme")
      assert.include(notice, "factory:ready")
    })
  )

  it.effect("refuses to guess when a linked repository cannot be read", () =>
    Effect.gen(function* () {
      const hosting = stubHosting({
        developmentLinks: () => Effect.succeed([branchLink]),
        repository: () =>
          Effect.fail(ProcessError.make({ message: "az repos show", detail: "TF401019" }))
      })

      // Falling back to the default would silently work the item in the
      // wrong repository — worse than doing nothing.
      assert.isUndefined(yield* resolveWorkspace(hosting, board, ref, 7))
    })
  )

  it.effect("treats an unreadable Development section as no link, not a stall", () =>
    Effect.gen(function* () {
      const hosting = stubHosting({
        developmentLinks: () =>
          Effect.fail(ProcessError.make({ message: "az boards", detail: "throttled" }))
      })

      assert.deepStrictEqual(yield* resolveWorkspace(hosting, board, ref, 7), {
        repository: "widgets",
        branch: "factory/item-7",
        linked: false
      })
    })
  )
})
