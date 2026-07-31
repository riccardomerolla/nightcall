import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import type { FlowError } from "@llm4ts/flow/FlowError"
import { Info, type FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import {
  IssueSummary,
  RepoRef,
  type GitHubToolShape,
  type IssueRef
} from "@llm4ts/flow/GitHubTool"
import type { CompanyConfig, TargetRepo } from "./Config.ts"
import { LedgerEntry, appendLedger, readLedger, spentToday } from "./Ledger.ts"
import { Labels, claim, isEpic, phaseOf, signed } from "./Protocol.ts"

// One heartbeat of the Chief of Staff: poll → decide → act. Polling and
// acting go through GitHubTool; the decision in between is a pure function
// so the claim policy is testable without any fake at all. The heartbeat
// is idempotent — every action is derived fresh from GitHub label state
// plus the durable ledger (for the daily spend throttle).

export interface TargetSnapshot {
  readonly target: TargetRepo
  readonly ready: ReadonlyArray<IssueSummary>
  readonly wip: ReadonlyArray<IssueSummary>
}

export interface ClaimIntent {
  readonly target: TargetRepo
  readonly issue: IssueSummary
}

export interface HeartbeatDecision {
  readonly claims: ReadonlyArray<ClaimIntent>
  readonly skippedEpics: ReadonlyArray<ClaimIntent>
  readonly inFlight: number
  readonly throttled: boolean
}

export const repoRefOf = (target: TargetRepo): RepoRef =>
  RepoRef.make({ owner: target.owner, repo: target.repo })

export const poll = (
  gh: GitHubToolShape,
  targets: ReadonlyArray<TargetRepo>
): Effect.Effect<ReadonlyArray<TargetSnapshot>, FlowError> =>
  Effect.forEach(targets, (target) =>
    Effect.gen(function* () {
      const repo = repoRefOf(target)
      const ready = yield* gh.listIssues(repo, { labels: [Labels.ready] })
      const wip = yield* gh.listIssues(repo, { labels: [Labels.wip] })
      return {
        target,
        // The ready query is label-based; phaseOf re-checks precedence so an
        // issue carrying leftover wip/failed markers is never claimed twice.
        ready: ready.filter((issue) => phaseOf(issue.labels) === "Ready"),
        wip: wip.filter((issue) => phaseOf(issue.labels) === "InProgress")
      }
    })
  )

// Claim the oldest plain ready issues, capped by free engineer seats
// across all targets — unless today's ledger spend already exhausted the
// company's daily budget, in which case nothing new is claimed. Epics are
// skipped until the Tech Lead can decompose them; they are reported,
// never silently dropped.
export const decide = (
  snapshots: ReadonlyArray<TargetSnapshot>,
  config: CompanyConfig,
  spentTodayUsd = 0
): HeartbeatDecision => {
  const inFlight = snapshots.reduce((count, snapshot) => count + snapshot.wip.length, 0)
  const throttled = spentTodayUsd >= config.dailyBudgetUsd
  let seats = throttled ? 0 : Math.max(0, config.engineerParallelism - inFlight)
  const claims: Array<ClaimIntent> = []
  const skippedEpics: Array<ClaimIntent> = []
  for (const snapshot of snapshots) {
    const oldestFirst = [...snapshot.ready].sort((a, b) => a.number - b.number)
    for (const issue of oldestFirst) {
      if (isEpic(issue.labels)) {
        skippedEpics.push({ target: snapshot.target, issue })
      } else if (seats > 0) {
        claims.push({ target: snapshot.target, issue })
        seats -= 1
      }
    }
  }
  return { claims, skippedEpics, inFlight, throttled }
}

export const claimComment = signed(
  [
    "Claimed. An engineer has been assigned to this issue;",
    "progress and the invoice will be reported here."
  ].join(" ")
)

// The claim transition is the FIRST write for an issue (first-write-wins);
// the comment follows so a crash between the two leaves a claimed issue
// with no comment, not an unclaimed issue with a promise on it.
export const executeClaim = (
  gh: GitHubToolShape,
  intent: ClaimIntent
): Effect.Effect<void, FlowError> =>
  Effect.gen(function* () {
    const ref = intent.issue.ref(repoRefOf(intent.target))
    yield* gh.editIssueLabels(ref, claim.add, claim.remove)
    yield* gh.writeIssueComment(ref, claimComment)
  })

export interface WorkerReport {
  readonly outcome: "Shipped" | "Bounced" | "Failed"
  readonly costUsd: number
}

export interface HeartbeatOptions {
  // Observe mode (false) logs claim intents without writing to GitHub —
  // the safety default, so the factory never claims work it cannot do.
  readonly claimMode: boolean
  // Works one claimed issue to completion; wired to Engineer.runIssue by
  // the daemon, injectable for tests. Must never fail.
  readonly worker?: (intent: ClaimIntent) => Effect.Effect<WorkerReport>
  // Where the ledger lives; no ledger (and no spend throttle) when unset.
  readonly workspaceDir?: string
  // Optional standup issue: a heartbeat with activity posts a summary
  // comment there so the CEO can watch the company from one thread.
  readonly standupIssue?: IssueRef
}

export const standupSummary = (
  decision: HeartbeatDecision,
  worked: ReadonlyArray<{ readonly intent: ClaimIntent; readonly report: WorkerReport }>,
  spentTodayUsd: number,
  dailyBudgetUsd: number
): string =>
  [
    "### Standup",
    "",
    `- In flight: ${decision.inFlight}`,
    `- Claimed this beat: ${worked.length}`,
    ...worked.map(
      ({ intent, report }) =>
        `  - ${intent.target.slug}#${intent.issue.number}: ${report.outcome} ` +
        `($${report.costUsd.toFixed(4)})`
    ),
    `- Epics waiting for decomposition: ${decision.skippedEpics.length}`,
    `- Spent today: $${spentTodayUsd.toFixed(2)} of $${dailyBudgetUsd.toFixed(2)}` +
      (decision.throttled ? " — claim throttle active" : "")
  ].join("\n")

export const heartbeat = (
  gh: GitHubToolShape,
  config: CompanyConfig,
  events: FlowEventsShape,
  options: HeartbeatOptions
): Effect.Effect<HeartbeatDecision, FlowError> =>
  Effect.gen(function* () {
    const say = (message: string): Effect.Effect<void> =>
      events.publish(Info.make({ message }))
    const nowMs = yield* Clock.currentTimeMillis
    const nowIso = new Date(nowMs).toISOString()
    const ledger =
      options.workspaceDir === undefined ? [] : yield* readLedger(options.workspaceDir)
    let spent = spentToday(ledger, nowIso)

    const snapshots = yield* poll(gh, config.targets)
    const decision = decide(snapshots, config, spent)

    yield* say(
      `heartbeat: ${decision.inFlight} in flight, ` +
        `${decision.claims.length} claimable, ${decision.skippedEpics.length} epic(s) waiting` +
        (decision.throttled ? ", daily budget exhausted — not claiming" : "")
    )
    for (const epic of decision.skippedEpics) {
      yield* say(
        `epic ${epic.target.slug}#${epic.issue.number} needs a Tech Lead to decompose — skipped`
      )
    }

    const worked: Array<{ intent: ClaimIntent; report: WorkerReport }> = []
    for (const intent of decision.claims) {
      // Claiming without a worker would strand the issue in factory:wip,
      // so a missing worker falls back to observe behavior.
      if (!options.claimMode || options.worker === undefined) {
        yield* say(
          `observe mode: would claim ${intent.target.slug}#${intent.issue.number}: ` +
            intent.issue.title
        )
        continue
      }
      yield* executeClaim(gh, intent)
      yield* say(`claimed ${intent.target.slug}#${intent.issue.number}: ${intent.issue.title}`)
      const report = yield* options.worker(intent)
      worked.push({ intent, report })
      spent += report.costUsd
      yield* say(
        `${intent.target.slug}#${intent.issue.number} → ${report.outcome} ` +
          `($${report.costUsd.toFixed(4)}, $${spent.toFixed(2)} today)`
      )
      if (options.workspaceDir !== undefined) {
        yield* appendLedger(
          options.workspaceDir,
          LedgerEntry.make({
            at: nowIso,
            target: intent.target.slug,
            issue: intent.issue.number,
            outcome: report.outcome,
            costUsd: report.costUsd
          })
        )
      }
      if (spent >= config.dailyBudgetUsd) {
        yield* say("daily budget reached mid-beat — stopping claims until tomorrow")
        break
      }
    }

    if (options.standupIssue !== undefined && (worked.length > 0 || decision.throttled)) {
      yield* Effect.ignore(
        gh.writeIssueComment(
          options.standupIssue,
          signed(standupSummary(decision, worked, spent, config.dailyBudgetUsd))
        )
      )
    }
    return decision
  })
