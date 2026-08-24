import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { FlowError } from "@llm4ts/flow/FlowError"

// The control-plane port. Nightcall's org chart, protocol, and pipeline
// speak only this interface; `Azure.ts` is the one module that knows the
// backend is Azure DevOps and the transport is the `az` CLI.
//
// The vocabulary is Azure DevOps': work items carry the work, tags are the
// state machine, pull requests are the deliverable. Where a concept has no
// analogue on the other side it is named for what it actually is rather
// than for what GitHub would have called it.

export class ProjectRef extends Schema.Class<ProjectRef>("ProjectRef")({
  project: Schema.String,
  repository: Schema.String
}) {
  get slug(): string {
    return `${this.project}/${this.repository}`
  }
}

export class WorkItemRef extends Schema.Class<WorkItemRef>("WorkItemRef")({
  project: Schema.String,
  repository: Schema.String,
  id: Schema.Int
}) {
  get shortRef(): string {
    return `${this.project}/${this.repository}#${this.id}`
  }
}

// `project/repository#id`, the way a human writes a work item in config.
export const parseWorkItemRef = (input: string): WorkItemRef | undefined => {
  const match = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(input.trim())
  const project = match?.[1]
  const repository = match?.[2]
  const id = Number.parseInt(match?.[3] ?? "", 10)
  return project === undefined || repository === undefined || !Number.isInteger(id) || id <= 0
    ? undefined
    : WorkItemRef.make({ project, repository, id })
}

export class WorkItemSummary extends Schema.Class<WorkItemSummary>("WorkItemSummary")({
  id: Schema.Int,
  title: Schema.String,
  // Plain text, always: Azure DevOps stores descriptions as HTML, and the
  // adapter normalizes on the way in so the protocol's line-oriented
  // markers (`Blocked-by:`, `Parent: #N (epic)`) survive a round trip.
  body: Schema.String,
  author: Schema.String,
  tags: Schema.Array(Schema.String),
  state: Schema.String,
  updatedAt: Schema.String
}) {
  ref(project: ProjectRef): WorkItemRef {
    return WorkItemRef.make({
      project: project.project,
      repository: project.repository,
      id: this.id
    })
  }
}

export class CommentRef extends Schema.Class<CommentRef>("CommentRef")({
  project: Schema.String,
  workItemId: Schema.Int,
  id: Schema.Int
}) {}

export class Comment extends Schema.Class<Comment>("Comment")({
  author: Schema.String,
  body: Schema.String,
  createdAt: Schema.String
}) {}

export class PullRef extends Schema.Class<PullRef>("PullRef")({
  id: Schema.Int,
  url: Schema.String
}) {}

export const WorkItemState = Schema.Literals(["open", "closed", "all"])
export type WorkItemState = typeof WorkItemState.Type

export interface WorkItemFilter {
  readonly tags?: ReadonlyArray<string>
  readonly state?: WorkItemState
  readonly limit?: number
}

// Azure DevOps branch policies decide a PR's fate; there is no "timed out"
// evaluation status, so the outcome set stops at three.
export const BuildOutcome = Schema.Literals(["Success", "Failure", "Pending"])
export type BuildOutcome = typeof BuildOutcome.Type

export interface HostingShape {
  readonly listWorkItems: (
    project: ProjectRef,
    filter?: WorkItemFilter
  ) => Effect.Effect<ReadonlyArray<WorkItemSummary>, FlowError>
  readonly createWorkItem: (
    project: ProjectRef,
    title: string,
    body: string,
    tags?: ReadonlyArray<string>
  ) => Effect.Effect<WorkItemRef, FlowError>
  readonly editTags: (
    ref: WorkItemRef,
    add: ReadonlyArray<string>,
    remove: ReadonlyArray<string>
  ) => Effect.Effect<void, FlowError>
  // Returns the created comment's reference so callers can edit it later —
  // the living plan checklist ticks items off by editing one comment.
  readonly writeComment: (
    ref: WorkItemRef,
    body: string
  ) => Effect.Effect<CommentRef | undefined, FlowError>
  readonly editComment: (comment: CommentRef, body: string) => Effect.Effect<void, FlowError>
  readonly readComments: (ref: WorkItemRef) => Effect.Effect<ReadonlyArray<Comment>, FlowError>
  // The pull request whose source branch is `branch`, if one is active.
  readonly openPr: (
    project: ProjectRef,
    branch: string
  ) => Effect.Effect<PullRef | undefined, FlowError>
  readonly createPr: (
    project: ProjectRef,
    branch: string,
    workItemId: number,
    title: string,
    body: string
  ) => Effect.Effect<PullRef, FlowError>
  readonly prChecks: (pr: PullRef) => Effect.Effect<BuildOutcome, FlowError>
  readonly mergePr: (pr: PullRef) => Effect.Effect<void, FlowError>
}
