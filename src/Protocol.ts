import * as Schema from "effect/Schema"

// The factory:* label protocol (DESIGN.md "Issue protocol"). Labels on the
// target repo are the only org-level state; these pure functions are the
// entire state machine. Anything effectful (gh calls, fibers, budgets)
// lives above this module.

export const Labels = {
  ready: "factory:ready",
  epic: "factory:epic",
  needsInfo: "factory:needs-info",
  wip: "factory:wip",
  review: "factory:review",
  failed: "factory:failed",
  // One-shot modifier set by the CEO next to factory:ready: discard all
  // prior state for the issue (worktree, persisted plan, branch — local
  // and remote) and start from a brand-new branch off origin/HEAD. The
  // orchestrator strips it once the reset is applied.
  fresh: "factory:fresh",
  // Staged-pipeline checkpoints (orchestrator-owned). An issue sits at
  // exactly one of these between stage runs; wip marks a stage worker on
  // it right now. ready → planned → coded → reviewed → review.
  planned: "factory:planned",
  coded: "factory:coded",
  reviewed: "factory:reviewed",
  // All of an epic's children are closed: the orchestrator asks the CEO
  // to validate the shipped result. Comment feedback + re-add ready to
  // iterate; close the epic if satisfied.
  validate: "factory:validate"
} as const

export const budgetLabelPrefix = "factory:budget-"

export const IssuePhase = Schema.Literals([
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
export type IssuePhase = typeof IssuePhase.Type

// Precedence resolves contradictory label sets left over from partial
// writes: a terminal or in-flight marker outranks stage checkpoints,
// which outrank readiness.
export const phaseOf = (labels: ReadonlyArray<string>): IssuePhase => {
  const has = (label: string): boolean => labels.includes(label)
  return has(Labels.failed)
    ? "Failed"
    : has(Labels.review)
      ? "InReview"
      : has(Labels.wip)
        ? "InProgress"
        : has(Labels.reviewed)
          ? "Reviewed"
          : has(Labels.coded)
            ? "Coded"
            : has(Labels.planned)
              ? "Planned"
              : has(Labels.needsInfo)
                ? "NeedsInfo"
                : has(Labels.ready)
                  ? "Ready"
                  : "Unmanaged"
}

export const isEpic = (labels: ReadonlyArray<string>): boolean => labels.includes(Labels.epic)

export const isFresh = (labels: ReadonlyArray<string>): boolean => labels.includes(Labels.fresh)

export const budgetOverrideUsd = (labels: ReadonlyArray<string>): number | undefined => {
  const parsed = labels
    .filter((label) => label.startsWith(budgetLabelPrefix))
    .map((label) => Number.parseInt(label.slice(budgetLabelPrefix.length), 10))
    .filter((value) => Number.isInteger(value) && value > 0)
  return parsed.length === 0 ? undefined : Math.max(...parsed)
}

// A transition names the label edit that moves an issue between phases.
// The orchestrator performs it as its FIRST write for the issue
// (first-write-wins claim; see DESIGN.md).
export class Transition extends Schema.Class<Transition>("Transition")({
  add: Schema.Array(Schema.String),
  remove: Schema.Array(Schema.String)
}) {}

export const claim = Transition.make({ add: [Labels.wip], remove: [Labels.ready] })
// Staged pipeline: a stage worker marks wip while running, then swaps the
// checkpoint on success. Failure removes only wip (Engineer adds failed),
// keeping the checkpoint so a retry resumes at the same stage.
export const stageClaim = Transition.make({ add: [Labels.wip], remove: [] })
export const donePlan = Transition.make({
  add: [Labels.planned],
  remove: [Labels.wip, Labels.ready]
})
export const doneCode = Transition.make({
  add: [Labels.coded],
  remove: [Labels.wip, Labels.planned]
})
export const doneReview = Transition.make({
  add: [Labels.reviewed],
  remove: [Labels.wip, Labels.coded]
})
export const doneQa = Transition.make({
  add: [Labels.review],
  remove: [Labels.wip, Labels.reviewed]
})
// Bounce can happen before a claim (epic triage) or after one (engineer
// pipeline), so it clears both queue markers — a bounced issue must never
// keep occupying an engineer seat via a leftover wip label.
export const bounce = Transition.make({
  add: [Labels.needsInfo],
  remove: [Labels.ready, Labels.wip]
})
export const sendToReview = Transition.make({ add: [Labels.review], remove: [Labels.wip] })
export const fail = Transition.make({
  add: [Labels.failed],
  remove: [Labels.wip, Labels.review]
})

export const branchFor = (issueNumber: number): string => `factory/issue-${issueNumber}`

// Attempt bookkeeping lives in labels like everything else, so the
// max-attempts guard survives daemon restarts without local state.
export const attemptPrefix = "factory:attempt-"

export const attemptLabel = (attempt: number): string => `${attemptPrefix}${attempt}`

export const attemptOf = (labels: ReadonlyArray<string>): number => {
  const attempts = labels
    .filter((label) => label.startsWith(attemptPrefix))
    .map((label) => Number.parseInt(label.slice(attemptPrefix.length), 10))
    .filter((value) => Number.isInteger(value) && value > 0)
  return attempts.length === 0 ? 0 : Math.max(...attempts)
}

export const signature = "— Nightcall 🌙"

export const signed = (body: string): string => `${body.trimEnd()}\n\n${signature}`
