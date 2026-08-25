import * as Effect from "effect/Effect"
import type { TargetBoard } from "./Config.ts"
import type { GitArtifact, HostingShape, WorkItemRef } from "./Hosting.ts"
import { branchFor } from "./Protocol.ts"

// Where does a work item's code live?
//
// On GitHub the question does not exist: an issue belongs to a repository.
// On Azure DevOps a work item belongs to a project BOARD, and a project
// holds many repositories — so the repository, and often the branch, come
// from the item's Development links. A human who creates a branch from a
// work item has already answered "where does this go"; ignoring that answer
// and inventing `factory/item-N` in some default repo would be the factory
// overruling its CEO.
//
// Resolution, in order:
//   1. A Branch development link — that repository, that branch, as-is.
//   2. The board's default repository — a fresh `factory/item-N` off
//      origin/HEAD, which is then linked BACK so the board shows the work.
//   3. Neither — the item is not actionable here and says so.

export interface Workspace {
  readonly repository: string
  // The branch the engineer commits on and the PR is opened from.
  readonly branch: string
  // Whether a human designated this branch. Nightcall must not delete or
  // force-reset a branch it did not create.
  readonly linked: boolean
}

const branchLink = (links: ReadonlyArray<GitArtifact>): GitArtifact | undefined =>
  links.find((link) => link.kind === "Branch")

// Development links carry repository GUIDs, so the name has to be resolved
// back before anything can clone it.
export const resolveWorkspace = (
  hosting: HostingShape,
  target: TargetBoard,
  ref: WorkItemRef,
  itemId: number
  // Never fails: every lookup below degrades to a decision rather than an
  // error, because a board hiccup must not stall the whole beat.
): Effect.Effect<Workspace | undefined> =>
  Effect.gen(function* () {
    // A board that cannot be read is not a routing decision — fall back to
    // the default repository rather than stalling the whole beat.
    const links = yield* hosting
      .developmentLinks(ref)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<GitArtifact> => []))
    const linked = branchLink(links)
    if (linked !== undefined) {
      const repository = yield* hosting
        .repository(target.project, linked.repositoryId)
        .pipe(Effect.orElseSucceed(() => undefined))
      if (repository !== undefined) {
        return { repository: repository.name, branch: linked.value, linked: true }
      }
      // The link names a repository this account cannot see. Falling back to
      // the default would silently work the item in the wrong repo.
      return undefined
    }
    return target.defaultRepository.length === 0
      ? undefined
      : { repository: target.defaultRepository, branch: branchFor(itemId), linked: false }
  })

export const unroutableNotice = (target: TargetBoard): string =>
  [
    "This work item has no Development link and the board has no default",
    `repository configured (\`${target.project}\`), so the factory cannot tell`,
    "which repository to work in.",
    "",
    "Create a branch from this work item (Development → Create a branch), or",
    "configure a default repository for the board, then re-add `factory:ready`."
  ].join("\n")
