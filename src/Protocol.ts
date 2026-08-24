import * as Schema from "effect/Schema"

// The factory:* tag protocol (DESIGN.md "Work item protocol"). Tags on the
// target project's work items are the only org-level state; these pure
// functions are the entire state machine. Anything effectful (az calls,
// fibers, budgets) lives above this module.

export const Tags = {
  ready: "factory:ready",
  epic: "factory:epic",
  needsInfo: "factory:needs-info",
  wip: "factory:wip",
  review: "factory:review",
  failed: "factory:failed",
  // One-shot modifier set by the CEO next to factory:ready: discard all
  // prior state for the work item (worktree, persisted plan, branch — local
  // and remote) and start from a brand-new branch off origin/HEAD. The
  // orchestrator strips it once the reset is applied.
  fresh: "factory:fresh",
  // Staged-pipeline checkpoints (orchestrator-owned). A work item sits at
  // exactly one of these between stage runs; wip marks a stage worker on
  // it right now. ready → planned → coded → reviewed → review.
  planned: "factory:planned",
  coded: "factory:coded",
  reviewed: "factory:reviewed",
  // All of an epic's children are closed: the orchestrator asks the CEO
  // to validate the shipped result. Comment feedback + re-add ready to
  // iterate; close the epic if satisfied.
  validate: "factory:validate",
  // CEO override, human-only: skip the QA verdict and ship. For the rare
  // dispute where the CEO judges the work done and QA will not approve.
  // Stripped when consumed.
  ship: "factory:ship"
} as const

export const budgetTagPrefix = "factory:budget-"

export const WorkItemPhase = Schema.Literals([
  "Ready",
  "NeedsInfo",
  "InProgress",
  "Planned",
  "Coded",
  "Reviewed",
  "InReview",
  "Failed",
  "Unmanaged"
])
export type WorkItemPhase = typeof WorkItemPhase.Type

// Precedence resolves contradictory tag sets left over from partial
// writes: a terminal or in-flight marker outranks stage checkpoints,
// which outrank readiness.
export const phaseOf = (tags: ReadonlyArray<string>): WorkItemPhase => {
  const has = (tag: string): boolean => tags.includes(tag)
  return has(Tags.failed)
    ? "Failed"
    : has(Tags.review)
      ? "InReview"
      : has(Tags.wip)
        ? "InProgress"
        : has(Tags.reviewed)
          ? "Reviewed"
          : has(Tags.coded)
            ? "Coded"
            : has(Tags.planned)
              ? "Planned"
              : has(Tags.needsInfo)
                ? "NeedsInfo"
                : has(Tags.ready)
                  ? "Ready"
                  : "Unmanaged"
}

export const isEpic = (tags: ReadonlyArray<string>): boolean => tags.includes(Tags.epic)

export const isFresh = (tags: ReadonlyArray<string>): boolean => tags.includes(Tags.fresh)

export const budgetOverrideUsd = (tags: ReadonlyArray<string>): number | undefined => {
  const parsed = tags
    .filter((tag) => tag.startsWith(budgetTagPrefix))
    .map((tag) => Number.parseInt(tag.slice(budgetTagPrefix.length), 10))
    .filter((value) => Number.isInteger(value) && value > 0)
  return parsed.length === 0 ? undefined : Math.max(...parsed)
}

// A transition names the tag edit that moves a work item between phases.
// The orchestrator performs it as its FIRST write for the item
// (first-write-wins claim; see DESIGN.md).
export class Transition extends Schema.Class<Transition>("Transition")({
  add: Schema.Array(Schema.String),
  remove: Schema.Array(Schema.String)
}) {}

export const claim = Transition.make({ add: [Tags.wip], remove: [Tags.ready] })
// Staged pipeline: a stage worker marks wip while running, then swaps the
// checkpoint on success. Failure removes only wip (Engineer adds failed),
// keeping the checkpoint so a retry resumes at the same stage.
export const stageClaim = Transition.make({ add: [Tags.wip], remove: [] })
export const donePlan = Transition.make({
  add: [Tags.planned],
  remove: [Tags.wip, Tags.ready]
})
export const doneCode = Transition.make({
  add: [Tags.coded],
  remove: [Tags.wip, Tags.planned]
})
export const doneReview = Transition.make({
  add: [Tags.reviewed],
  remove: [Tags.wip, Tags.coded]
})
export const doneQa = Transition.make({
  add: [Tags.review],
  remove: [Tags.wip, Tags.reviewed]
})
// Bounce can happen before a claim (epic triage) or after one (engineer
// pipeline), so it clears both queue markers — a bounced work item must
// never keep occupying an engineer seat via a leftover wip tag.
export const bounce = Transition.make({
  add: [Tags.needsInfo],
  remove: [Tags.ready, Tags.wip]
})
export const sendToReview = Transition.make({ add: [Tags.review], remove: [Tags.wip] })
export const fail = Transition.make({
  add: [Tags.failed],
  remove: [Tags.wip, Tags.review]
})

export const branchFor = (workItemId: number): string => `factory/item-${workItemId}`

// Attempt bookkeeping lives in tags like everything else, so the
// max-attempts guard survives daemon restarts without local state.
export const attemptPrefix = "factory:attempt-"

export const attemptTag = (attempt: number): string => `${attemptPrefix}${attempt}`

export const attemptOf = (tags: ReadonlyArray<string>): number => {
  const attempts = tags
    .filter((tag) => tag.startsWith(attemptPrefix))
    .map((tag) => Number.parseInt(tag.slice(attemptPrefix.length), 10))
    .filter((value) => Number.isInteger(value) && value > 0)
  return attempts.length === 0 ? 0 : Math.max(...attempts)
}

export const signature = "— Nightcall 🌙"

export const signed = (body: string): string => `${body.trimEnd()}\n\n${signature}`
