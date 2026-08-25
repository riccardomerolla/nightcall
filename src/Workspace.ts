import * as Effect from "effect/Effect"
import type { TargetBoard } from "./Config.ts"
import { WorkItemRef, type GitArtifact, type HostingShape } from "./Hosting.ts"
import { epicParentOf } from "./Prompts.ts"
import { branchFor } from "./Protocol.ts"
import { describeError } from "./Surface.ts"

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
//   2. The PARENT epic's Branch link — that repository, on the child's own
//      `factory/item-N`. A decomposed child has no Development link of its
//      own: the human linked the epic, and the children are how that epic
//      gets built, so they belong in the repository the epic names. On a
//      board with no default repository this is the difference between a
//      decomposition that works and five children that are all unroutable.
//   3. The board's default repository — a fresh `factory/item-N` off
//      origin/HEAD, which is then linked BACK so the board shows the work.
//   4. Neither — the item is not actionable here and says so.
//
// The repository is inherited; the branch is NOT. Handing every child the
// epic's branch would put five concurrent engineers on one branch, opening
// five pull requests from the same source ref — which Azure DevOps answers
// by giving them all the same pull request.
//
// A fourth answer has to exist and did not: "the board would not tell us".
// A failed lookup used to collapse into case 2 or 3, so a work item with a
// perfectly good Branch link was either worked in the wrong repository or
// bounced with a comment stating it had no Development link. Not knowing is
// not a routing decision, and it must never be written onto the board as
// one — it is a reason to leave the item exactly as it is and try again.

export interface Workspace {
  readonly repository: string
  // The branch the engineer commits on and the PR is opened from.
  readonly branch: string
  // Whether a human designated this branch. Nightcall must not delete or
  // force-reset a branch it did not create.
  readonly linked: boolean
}

// Routed: work it here. Unroutable: a human must act, and the notice says
// what. Undetermined: the board did not answer — say so and change nothing.
export type Routing =
  | { readonly _tag: "Routed"; readonly workspace: Workspace }
  // Carries what the Development section did hold, so the notice can say
  // "none of these is a branch" rather than "there is nothing here" — the
  // difference between a fact and an accusation when a human linked a PR.
  | { readonly _tag: "Unroutable"; readonly links: ReadonlyArray<GitArtifact> }
  | { readonly _tag: "Undetermined"; readonly detail: string }

const branchLink = (links: ReadonlyArray<GitArtifact>): GitArtifact | undefined =>
  links.find((link) => link.kind === "Branch")

// Effect.either without the import: a failure becomes a value so the three
// answers can be told apart at the call site.
const attempt = <A>(
  effect: Effect.Effect<A, { readonly message: string }>
): Effect.Effect<{ readonly value: A } | { readonly failure: string }> =>
  effect.pipe(
    Effect.map((value) => ({ value })),
    Effect.catch((error) => Effect.succeed({ failure: describeError(error) }))
  )

type ParentRepository =
  | { readonly _tag: "None" }
  | { readonly _tag: "Repository"; readonly repository: string }
  | { readonly _tag: "Undetermined"; readonly detail: string }

// The repository the item's parent epic is worked in, if it has one.
//
// The `Parent: #N (epic)` marker is checked first because it is free and
// the Tech Lead always writes it. The native Parent link is the fallback,
// and not a redundant one: a child a human created under the epic in the
// Azure DevOps UI has the link and no marker.
const parentRepository = (
  hosting: HostingShape,
  target: TargetBoard,
  ref: WorkItemRef,
  body: string
): Effect.Effect<ParentRepository> =>
  Effect.gen(function* () {
    const marked = epicParentOf(body)
    let parentId = marked
    if (parentId === undefined) {
      const links = yield* attempt(hosting.workItemLinks(ref))
      if ("failure" in links) {
        return { _tag: "Undetermined", detail: `work item links: ${links.failure}` }
      }
      parentId = links.value.find((link) => link.kind === "Parent")?.id
    }
    if (parentId === undefined) {
      return { _tag: "None" }
    }
    const parentRef = WorkItemRef.make({
      project: ref.project,
      repository: ref.repository,
      id: parentId
    })
    const links = yield* attempt(hosting.developmentLinks(parentRef))
    if ("failure" in links) {
      return { _tag: "Undetermined", detail: `parent #${parentId} links: ${links.failure}` }
    }
    const linked = branchLink(links.value)
    if (linked === undefined) {
      // The parent has no branch either. Not an error: the board default
      // is still a perfectly good answer for both of them.
      return { _tag: "None" }
    }
    const repository = yield* attempt(hosting.repository(target.project, linked.repositoryId))
    return "failure" in repository
      ? {
          _tag: "Undetermined",
          detail: `parent #${parentId} repository ${linked.repositoryId}: ${repository.failure}`
        }
      : { _tag: "Repository", repository: repository.value.name }
  })

// Development links carry repository GUIDs, so the name has to be resolved
// back before anything can clone it.
export const resolveWorkspace = (
  hosting: HostingShape,
  target: TargetBoard,
  ref: WorkItemRef,
  item: { readonly id: number; readonly body: string }
  // Never fails: a board that will not answer is reported as Undetermined
  // rather than thrown, because one unreadable item must not stall the beat.
): Effect.Effect<Routing> =>
  Effect.gen(function* () {
    const links = yield* attempt(hosting.developmentLinks(ref))
    if ("failure" in links) {
      // The one answer that used to be impossible to give. Falling back to
      // the default repository here would work the item somewhere the human
      // did not choose; calling it "no Development link" would be false.
      return { _tag: "Undetermined", detail: `Development links: ${links.failure}` }
    }
    const linked = branchLink(links.value)
    if (linked !== undefined) {
      const repository = yield* attempt(hosting.repository(target.project, linked.repositoryId))
      // A link we cannot resolve is still a link: never fall back to the
      // default, which would silently work the item in the wrong repository.
      return "failure" in repository
        ? {
            _tag: "Undetermined",
            detail: `repository ${linked.repositoryId}: ${repository.failure}`
          }
        : {
            _tag: "Routed",
            workspace: { repository: repository.value.name, branch: linked.value, linked: true }
          }
    }
    // No link of its own — but a child's parent may have answered already.
    const parent = yield* parentRepository(hosting, target, ref, item.body)
    if (parent._tag !== "None") {
      return parent._tag === "Undetermined"
        ? parent
        : {
            _tag: "Routed",
            workspace: {
              repository: parent.repository,
              branch: branchFor(item.id),
              linked: false
            }
          }
    }
    return target.defaultRepository.length === 0
      ? { _tag: "Unroutable", links: links.value }
      : {
          _tag: "Routed",
          workspace: {
            repository: target.defaultRepository,
            branch: branchFor(item.id),
            linked: false
          }
        }
  })

const describeLink = (link: GitArtifact): string =>
  link.kind === "PullRequest" ? `pull request !${link.value}` : `commit ${link.value.slice(0, 8)}`

// Only ever said when the Development section was read successfully. If the
// board could not be read, the daemon says that in its own log and writes
// nothing here — a work item is never told something about itself that the
// daemon does not know.
export const unroutableNotice = (
  target: TargetBoard,
  links: ReadonlyArray<GitArtifact> = []
): string =>
  [
    links.length === 0
      ? "This work item has no Development link"
      : "This work item's Development links — " +
        `${links.map(describeLink).join(", ")} — name no branch`,
    `and the board has no default repository configured (\`${target.project}\`),`,
    "so the factory cannot tell which repository to work in.",
    "",
    "Create a branch from this work item (Development → Create a branch) —",
    "or from its parent epic, which its children inherit — or configure a",
    "default repository for the board, then re-add `factory:ready`."
  ].join("\n")
