import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import type { FlowError } from "@llm4ts/flow/FlowError"
import { Info, type FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import type { HostingShape, WorkItemRef, WorkItemSummary } from "./Hosting.ts"
import { projectRefOf, type CompanyConfig, type TargetBoard } from "./Config.ts"
import { watchEpics } from "./EpicWatch.ts"
import { blockedByRefs } from "./Prompts.ts"
import { LedgerEntry, appendLedger, readLedger, spentToday } from "./Ledger.ts"
import { Tags, claim, isEpic, phaseOf, signed, stageClaim } from "./Protocol.ts"

// One heartbeat of the Chief of Staff: poll → decide → act. Polling and
// acting go through the hosting port; the decision in between is a pure
// function, so the claim policy is testable without any fake at all. The
// heartbeat is idempotent — every action is derived fresh from work item
// tag state plus the durable ledger (for the daily spend throttle).

export interface TargetSnapshot {
  readonly target: TargetBoard
  readonly ready: ReadonlyArray<WorkItemSummary>
  readonly wip: ReadonlyArray<WorkItemSummary>
  readonly planned: ReadonlyArray<WorkItemSummary>
  readonly coded: ReadonlyArray<WorkItemSummary>
  readonly reviewed: ReadonlyArray<WorkItemSummary>
  readonly inReview: ReadonlyArray<WorkItemSummary>
  // Ids of ALL open work items in the target — the blocked-by check needs
  // to know whether a prerequisite is still open.
  readonly openIds: ReadonlySet<number>
}

export interface ClaimIntent {
  readonly target: TargetBoard
  readonly item: WorkItemSummary
}

export type Stage = "plan" | "code" | "review" | "qa" | "mend"

export interface HeartbeatDecision {
  readonly claims: ReadonlyArray<ClaimIntent>
  readonly epics: ReadonlyArray<ClaimIntent>
  // Staged pipeline: one intent list per stage, capped independently so
  // four different work items can advance one stage each per beat.
  readonly stages: Readonly<Record<Stage, ReadonlyArray<ClaimIntent>>>
  readonly inFlight: number
  readonly throttled: boolean
}

export const poll = (
  hosting: HostingShape,
  targets: ReadonlyArray<TargetBoard>
): Effect.Effect<ReadonlyArray<TargetSnapshot>, FlowError> =>
  Effect.forEach(targets, (target) =>
    Effect.gen(function* () {
      const repo = projectRefOf(target)
      const byTag = (tag: string): Effect.Effect<ReadonlyArray<WorkItemSummary>, FlowError> =>
        hosting.listWorkItems(repo, { tags: [tag] })
      const ready = yield* byTag(Tags.ready)
      const wip = yield* byTag(Tags.wip)
      const planned = yield* byTag(Tags.planned)
      const coded = yield* byTag(Tags.coded)
      const reviewed = yield* byTag(Tags.reviewed)
      const inReview = yield* byTag(Tags.review)
      const allOpen = yield* hosting.listWorkItems(repo, { state: "open" })
      // Queries are tag-based; phaseOf re-checks precedence so a work item
      // carrying leftover markers is never claimed at two stages at once.
      const inPhase = (
        items: ReadonlyArray<WorkItemSummary>,
        phase: ReturnType<typeof phaseOf>
      ): ReadonlyArray<WorkItemSummary> => items.filter((item) => phaseOf(item.tags) === phase)
      return {
        target,
        ready: inPhase(ready, "Ready"),
        wip: inPhase(wip, "InProgress"),
        planned: inPhase(planned, "Planned"),
        coded: inPhase(coded, "Coded"),
        reviewed: inPhase(reviewed, "Reviewed"),
        inReview: inPhase(inReview, "InReview"),
        openIds: new Set(allOpen.map((item) => item.id))
      }
    })
  )

// Ready epics go to the Tech Lead for decomposition; plain ready items
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
  const oldestFirst = (items: ReadonlyArray<WorkItemSummary>): ReadonlyArray<WorkItemSummary> =>
    [...items].sort((a, b) => a.id - b.id)
  // Plan and code stages respect Blocked-by: a child waits until its
  // prerequisites are closed. Later stages operate on work already built,
  // so blocking them would only strand finished branches.
  const blocked = (snapshot: TargetSnapshot, item: WorkItemSummary): boolean =>
    blockedByRefs(item.body).some((number) => snapshot.openIds.has(number))
  const takeStage = (
    pick: (snapshot: TargetSnapshot) => ReadonlyArray<WorkItemSummary>,
    cap: number,
    respectBlocking = false
  ): ReadonlyArray<ClaimIntent> => {
    if (throttled) {
      return []
    }
    const intents: Array<ClaimIntent> = []
    for (const snapshot of snapshots) {
      for (const item of oldestFirst(pick(snapshot))) {
        if (intents.length < cap && !(respectBlocking && blocked(snapshot, item))) {
          intents.push({ target: snapshot.target, item })
        }
      }
    }
    return intents
  }
  for (const snapshot of snapshots) {
    for (const item of oldestFirst(snapshot.ready)) {
      if (isEpic(item.tags)) {
        if (!throttled) {
          epics.push({ target: snapshot.target, item })
        }
      } else if (seats > 0 && !blocked(snapshot, item)) {
        claims.push({ target: snapshot.target, item })
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
      code: takeStage((snapshot) => snapshot.planned, config.engineerParallelism, true),
      review: takeStage((snapshot) => snapshot.coded, 1),
      qa: takeStage((snapshot) => snapshot.reviewed, 1)
    },
    inFlight,
    throttled
  }
}

export const claimComment = signed(
  [
    "Claimed. An engineer has been assigned to this item;",
    "progress and the invoice will be reported here."
  ].join(" ")
)

// The claim transition is the FIRST write for an item (first-write-wins);
// the comment follows so a crash between the two leaves a claimed item
// with no comment, not an unclaimed item with a promise on it.
export const executeClaim = (
  hosting: HostingShape,
  intent: ClaimIntent
): Effect.Effect<void, FlowError> =>
  Effect.gen(function* () {
    const ref = intent.item.ref(projectRefOf(intent.target))
    yield* hosting.editTags(ref, claim.add, claim.remove)
    yield* hosting.writeComment(ref, claimComment)
  })

export interface WorkerReport {
  readonly outcome: "Shipped" | "Bounced" | "Failed" | "Advanced" | "Iterated"
  readonly costUsd: number
}

export interface HeartbeatOptions {
  // Observe mode (false) logs claim intents without writing to the board —
  // the safety default, so the factory never claims work it cannot do.
  readonly claimMode: boolean
  // Works one claimed item to completion; wired to Engineer.runWorkItem by
  // the daemon, injectable for tests. Must never fail.
  readonly worker?: (intent: ClaimIntent) => Effect.Effect<WorkerReport>
  // Decomposes one ready epic into child work items; wired to
  // TechLead.runEpic. Epics are observed-only when unset.
  readonly epicWorker?: (intent: ClaimIntent) => Effect.Effect<WorkerReport>
  // Staged pipeline: one worker per stage. When set (and claimMode is on),
  // stage intents run CONCURRENTLY — up to four different items advance
  // one stage each per beat — and the monolithic `worker` is not used.
  readonly stageWorkers?: Readonly<Record<Stage, (intent: ClaimIntent) => Effect.Effect<WorkerReport>>>
  // Where the ledger lives; no ledger (and no spend throttle) when unset.
  readonly workspaceDir?: string
  // Optional standup work item: a heartbeat with activity posts a summary
  // comment there so the CEO can watch the company from one thread.
  readonly standupItem?: WorkItemRef
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
        `  - ${intent.target.slug}#${intent.item.id}: ${report.outcome} ` +
        `($${report.costUsd.toFixed(4)})`
    ),
    `- Epics decomposed this beat: ${decision.epics.length}`,
    `- Spent today: $${spentTodayUsd.toFixed(2)} of $${dailyBudgetUsd.toFixed(2)}` +
      (decision.throttled ? " — claim throttle active" : "")
  ].join("\n")

export const heartbeat = (
  hosting: HostingShape,
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

    const snapshots = yield* poll(hosting, config.targets)
    const decision = decide(snapshots, config, spent)

    yield* say(
      `heartbeat: ${decision.inFlight} in flight, ` +
        `${decision.claims.length} claimable, ${decision.epics.length} epic(s) to decompose` +
        (decision.throttled ? ", daily budget exhausted — not claiming" : "")
    )

    if (options.claimMode) {
      yield* Effect.ignore(watchEpics(hosting, config.targets, events))
    }

    const worked: Array<{ intent: ClaimIntent; report: WorkerReport }> = []
    for (const epic of decision.epics) {
      if (!options.claimMode || options.epicWorker === undefined) {
        yield* say(
          `observe mode: would decompose epic ${epic.target.slug}#${epic.item.id}: ` +
            epic.item.title
        )
        continue
      }
      const report = yield* options.epicWorker(epic)
      worked.push({ intent: epic, report })
      spent += report.costUsd
      yield* say(
        `epic ${epic.target.slug}#${epic.item.id} → ${report.outcome} ` +
          `($${report.costUsd.toFixed(4)}, $${spent.toFixed(2)} today)`
      )
      if (options.workspaceDir !== undefined) {
        yield* appendLedger(
          options.workspaceDir,
          LedgerEntry.make({
            at: nowIso,
            target: epic.target.slug,
            item: epic.item.id,
            outcome: report.outcome,
            costUsd: report.costUsd
          })
        )
      }
    }
    // Staged pipeline: claim and run every stage intent concurrently. Each
    // intent is a different item (an item sits at exactly one phase), so
    // the only shared resource is the target clone, which the workers
    // serialize internally.
    if (options.claimMode && options.stageWorkers !== undefined) {
      const stageWorkers = options.stageWorkers
      const spentRef = yield* Ref.make(spent)
      const stagePairs = (Object.entries(decision.stages) as ReadonlyArray<
        [Stage, ReadonlyArray<ClaimIntent>]
      >).flatMap(([stage, intents]) => intents.map((intent) => ({ stage, intent })))
      // Claim synchronously (the claim is the mutual-exclusion write),
      // then FORK each worker: the beat returns in seconds, so cheap
      // stages (mend's merge checks, new claims, epic-watch) tick every
      // heartbeat instead of waiting behind multi-minute coder runs. The
      // wip tag prevents double-claims across beats; boot reconciliation
      // recovers fibers lost to a restart. Outcomes are logged and
      // ledgered by each fiber as it finishes.
      yield* Effect.forEach(stagePairs, ({ stage, intent }) =>
        Effect.gen(function* () {
          if (stage === "plan") {
            yield* executeClaim(hosting, intent)
          } else {
            yield* Effect.ignore(
              hosting.editTags(intent.item.ref(projectRefOf(intent.target)), stageClaim.add, [])
            )
          }
          yield* say(`${stage}: claimed ${intent.target.slug}#${intent.item.id}`)
          yield* Effect.forkDetach(
            Effect.gen(function* () {
              const report = yield* stageWorkers[stage](intent)
              const total = yield* Ref.updateAndGet(spentRef, (value) => value + report.costUsd)
              yield* say(
                `${stage}: ${intent.target.slug}#${intent.item.id} → ${report.outcome} ` +
                  `($${report.costUsd.toFixed(4)}, $${total.toFixed(2)} today)`
              )
              if (options.workspaceDir !== undefined) {
                yield* appendLedger(
                  options.workspaceDir,
                  LedgerEntry.make({
                    at: nowIso,
                    target: intent.target.slug,
                    item: intent.item.id,
                    outcome: report.outcome,
                    costUsd: report.costUsd
                  })
                )
              }
            })
          )
        })
      )
      return decision
    }

    for (const intent of decision.claims) {
      // Claiming without a worker would strand the item in factory:wip,
      // so a missing worker falls back to observe behavior.
      if (!options.claimMode || options.worker === undefined) {
        yield* say(
          `observe mode: would claim ${intent.target.slug}#${intent.item.id}: ` +
            intent.item.title
        )
        continue
      }
      yield* executeClaim(hosting, intent)
      yield* say(`claimed ${intent.target.slug}#${intent.item.id}: ${intent.item.title}`)
      const report = yield* options.worker(intent)
      worked.push({ intent, report })
      spent += report.costUsd
      yield* say(
        `${intent.target.slug}#${intent.item.id} → ${report.outcome} ` +
          `($${report.costUsd.toFixed(4)}, $${spent.toFixed(2)} today)`
      )
      if (options.workspaceDir !== undefined) {
        yield* appendLedger(
          options.workspaceDir,
          LedgerEntry.make({
            at: nowIso,
            target: intent.target.slug,
            item: intent.item.id,
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

    if (options.standupItem !== undefined && (worked.length > 0 || decision.throttled)) {
      yield* Effect.ignore(
        hosting.writeComment(
          options.standupItem,
          signed(standupSummary(decision, worked, spent, config.dailyBudgetUsd))
        )
      )
    }
    return decision
  })
