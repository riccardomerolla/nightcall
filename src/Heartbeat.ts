import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
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
import { Labels, claim, isEpic, phaseOf, signed, stageClaim } from "./Protocol.ts"

// One heartbeat of the Chief of Staff: poll → decide → act. Polling and
// acting go through GitHubTool; the decision in between is a pure function
// so the claim policy is testable without any fake at all. The heartbeat
// is idempotent — every action is derived fresh from GitHub label state
// plus the durable ledger (for the daily spend throttle).

export interface TargetSnapshot {
  readonly target: TargetRepo
  readonly ready: ReadonlyArray<IssueSummary>
  readonly wip: ReadonlyArray<IssueSummary>
  readonly planned: ReadonlyArray<IssueSummary>
  readonly coded: ReadonlyArray<IssueSummary>
  readonly reviewed: ReadonlyArray<IssueSummary>
  readonly inReview: ReadonlyArray<IssueSummary>
}

export interface ClaimIntent {
  readonly target: TargetRepo
  readonly issue: IssueSummary
}

export type Stage = "plan" | "code" | "review" | "qa" | "mend"

export interface HeartbeatDecision {
  readonly claims: ReadonlyArray<ClaimIntent>
  readonly epics: ReadonlyArray<ClaimIntent>
  // Staged pipeline: one intent list per stage, capped independently so
  // four different issues can advance one stage each per beat.
  readonly stages: Readonly<Record<Stage, ReadonlyArray<ClaimIntent>>>
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
      const byLabel = (label: string): Effect.Effect<ReadonlyArray<IssueSummary>, FlowError> =>
        gh.listIssues(repo, { labels: [label] })
      const ready = yield* byLabel(Labels.ready)
      const wip = yield* byLabel(Labels.wip)
      const planned = yield* byLabel(Labels.planned)
      const coded = yield* byLabel(Labels.coded)
      const reviewed = yield* byLabel(Labels.reviewed)
      const inReview = yield* byLabel(Labels.review)
      // Queries are label-based; phaseOf re-checks precedence so an issue
      // carrying leftover markers is never claimed at two stages at once.
      const inPhase = (
        issues: ReadonlyArray<IssueSummary>,
        phase: ReturnType<typeof phaseOf>
      ): ReadonlyArray<IssueSummary> => issues.filter((issue) => phaseOf(issue.labels) === phase)
      return {
        target,
        ready: inPhase(ready, "Ready"),
        wip: inPhase(wip, "InProgress"),
        planned: inPhase(planned, "Planned"),
        coded: inPhase(coded, "Coded"),
        reviewed: inPhase(reviewed, "Reviewed"),
        inReview: inPhase(inReview, "InReview")
      }
    })
  )

// Ready epics go to the Tech Lead for decomposition; plain ready issues
// are claimed oldest-first, capped by free engineer seats across all
// targets — unless today's ledger spend already exhausted the company's
// daily budget, in which case nothing new starts. Epics are decomposed
// before claims so their children enter the queue as early as possible.
export const decide = (
  snapshots: ReadonlyArray<TargetSnapshot>,
  config: CompanyConfig,
  spentTodayUsd = 0
): HeartbeatDecision => {
  const inFlight = snapshots.reduce((count, snapshot) => count + snapshot.wip.length, 0)
  const throttled = spentTodayUsd >= config.dailyBudgetUsd
  let seats = throttled ? 0 : Math.max(0, config.engineerParallelism - inFlight)
  const claims: Array<ClaimIntent> = []
  const epics: Array<ClaimIntent> = []
  const oldestFirst = (issues: ReadonlyArray<IssueSummary>): ReadonlyArray<IssueSummary> =>
    [...issues].sort((a, b) => a.number - b.number)
  const takeStage = (
    pick: (snapshot: TargetSnapshot) => ReadonlyArray<IssueSummary>,
    cap: number
  ): ReadonlyArray<ClaimIntent> => {
    if (throttled) {
      return []
    }
    const intents: Array<ClaimIntent> = []
    for (const snapshot of snapshots) {
      for (const issue of oldestFirst(pick(snapshot))) {
        if (intents.length < cap) {
          intents.push({ target: snapshot.target, issue })
        }
      }
    }
    return intents
  }
  for (const snapshot of snapshots) {
    for (const issue of oldestFirst(snapshot.ready)) {
      if (isEpic(issue.labels)) {
        if (!throttled) {
          epics.push({ target: snapshot.target, issue })
        }
      } else if (seats > 0) {
        claims.push({ target: snapshot.target, issue })
        seats -= 1
      }
    }
  }
  return {
    claims,
    epics,
    stages: {
      // Mend first: an open PR knocked out of mergeability by a sibling
      // merge is repaired (rebase + agent conflict resolution) before new
      // work piles more branches onto the same base.
      mend: takeStage((snapshot) => snapshot.inReview, 1),
      plan: claims.slice(0, 1),
      code: takeStage((snapshot) => snapshot.planned, config.engineerParallelism),
      review: takeStage((snapshot) => snapshot.coded, 1),
      qa: takeStage((snapshot) => snapshot.reviewed, 1)
    },
    inFlight,
    throttled
  }
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
  readonly outcome: "Shipped" | "Bounced" | "Failed" | "Advanced" | "Iterated"
  readonly costUsd: number
}

export interface HeartbeatOptions {
  // Observe mode (false) logs claim intents without writing to GitHub —
  // the safety default, so the factory never claims work it cannot do.
  readonly claimMode: boolean
  // Works one claimed issue to completion; wired to Engineer.runIssue by
  // the daemon, injectable for tests. Must never fail.
  readonly worker?: (intent: ClaimIntent) => Effect.Effect<WorkerReport>
  // Decomposes one ready epic into child issues; wired to
  // TechLead.runEpic. Epics are observed-only when unset.
  readonly epicWorker?: (intent: ClaimIntent) => Effect.Effect<WorkerReport>
  // Staged pipeline: one worker per stage. When set (and claimMode is on),
  // stage intents run CONCURRENTLY — up to four different issues advance
  // one stage each per beat — and the monolithic `worker` is not used.
  readonly stageWorkers?: Readonly<Record<Stage, (intent: ClaimIntent) => Effect.Effect<WorkerReport>>>
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
    `- Epics decomposed this beat: ${decision.epics.length}`,
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
        `${decision.claims.length} claimable, ${decision.epics.length} epic(s) to decompose` +
        (decision.throttled ? ", daily budget exhausted — not claiming" : "")
    )

    const worked: Array<{ intent: ClaimIntent; report: WorkerReport }> = []
    for (const epic of decision.epics) {
      if (!options.claimMode || options.epicWorker === undefined) {
        yield* say(
          `observe mode: would decompose epic ${epic.target.slug}#${epic.issue.number}: ` +
            epic.issue.title
        )
        continue
      }
      const report = yield* options.epicWorker(epic)
      worked.push({ intent: epic, report })
      spent += report.costUsd
      yield* say(
        `epic ${epic.target.slug}#${epic.issue.number} → ${report.outcome} ` +
          `($${report.costUsd.toFixed(4)}, $${spent.toFixed(2)} today)`
      )
      if (options.workspaceDir !== undefined) {
        yield* appendLedger(
          options.workspaceDir,
          LedgerEntry.make({
            at: nowIso,
            target: epic.target.slug,
            issue: epic.issue.number,
            outcome: report.outcome,
            costUsd: report.costUsd
          })
        )
      }
    }
    // Staged pipeline: claim and run every stage intent concurrently. Each
    // intent is a different issue (an issue sits at exactly one phase), so
    // the only shared resource is the target clone, which the workers
    // serialize internally.
    if (options.claimMode && options.stageWorkers !== undefined) {
      const stageWorkers = options.stageWorkers
      const spentRef = yield* Ref.make(spent)
      const stagePairs = (Object.entries(decision.stages) as ReadonlyArray<
        [Stage, ReadonlyArray<ClaimIntent>]
      >).flatMap(([stage, intents]) => intents.map((intent) => ({ stage, intent })))
      const results = yield* Effect.all(
        stagePairs.map(({ stage, intent }) =>
          Effect.gen(function* () {
            if (stage === "plan") {
              yield* executeClaim(gh, intent)
            } else {
              yield* Effect.ignore(
                gh.editIssueLabels(intent.issue.ref(repoRefOf(intent.target)), stageClaim.add, [])
              )
            }
            yield* say(`${stage}: claimed ${intent.target.slug}#${intent.issue.number}`)
            const report = yield* stageWorkers[stage](intent)
            const total = yield* Ref.updateAndGet(spentRef, (value) => value + report.costUsd)
            yield* say(
              `${stage}: ${intent.target.slug}#${intent.issue.number} → ${report.outcome} ` +
                `($${report.costUsd.toFixed(4)}, $${total.toFixed(2)} today)`
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
            return { intent, report }
          })
        ),
        { concurrency: 4 }
      )
      worked.push(...results)
      spent = yield* Ref.get(spentRef)
      if (options.standupIssue !== undefined && (worked.length > 0 || decision.throttled)) {
        yield* Effect.ignore(
          gh.writeIssueComment(
            options.standupIssue,
            signed(standupSummary(decision, worked, spent, config.dailyBudgetUsd))
          )
        )
      }
      return decision
    }

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
