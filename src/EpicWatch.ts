import * as Effect from "effect/Effect"
import type { FlowError } from "@llm4ts/flow/FlowError"
import { Info, type FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import type { GitHubToolShape, IssueSummary } from "@llm4ts/flow/GitHubTool"
import type { TargetRepo } from "./Config.ts"
import { repoRefOf } from "./Heartbeat.ts"
import { epicChildMarker } from "./Prompts.ts"
import { Labels, signed } from "./Protocol.ts"

// The epic validation loop's deterministic half. When every child of a
// decomposed epic is closed, the epic is tagged factory:validate and the
// CEO gets the summary plus their two moves: comment feedback and re-add
// factory:ready to iterate, or close the epic if satisfied. The
// iteration itself runs through the ordinary epic path — TechLead sees
// validate+ready and decomposes from the feedback.

export interface EpicChildrenStatus {
  readonly complete: boolean
  readonly shipped: ReadonlyArray<string>
}

export const epicChildrenStatus = (
  epicNumber: number,
  openIssues: ReadonlyArray<IssueSummary>,
  allIssues: ReadonlyArray<IssueSummary>
): EpicChildrenStatus => {
  const marker = epicChildMarker(epicNumber)
  const children = allIssues.filter((issue) => issue.body.includes(marker))
  const stillOpen = openIssues.filter((issue) => issue.body.includes(marker))
  return {
    complete: children.length > 0 && stillOpen.length === 0,
    shipped: children.map((issue) => `#${issue.number} ${issue.title}`)
  }
}

export const watchEpics = (
  gh: GitHubToolShape,
  targets: ReadonlyArray<TargetRepo>,
  events: FlowEventsShape
): Effect.Effect<void, FlowError> =>
  Effect.forEach(targets, (target) =>
    Effect.gen(function* () {
      const repo = repoRefOf(target)
      const epics = yield* gh.listIssues(repo, { labels: [Labels.epic], state: "open" })
      const candidates = epics.filter(
        (epic) =>
          !epic.labels.includes(Labels.ready) &&
          !epic.labels.includes(Labels.validate) &&
          !epic.labels.includes(Labels.needsInfo)
      )
      if (candidates.length === 0) {
        return
      }
      const openIssues = yield* gh.listIssues(repo, { state: "open" })
      const allIssues = yield* gh.listIssues(repo, { state: "all" })
      yield* Effect.forEach(candidates, (epic) =>
        Effect.gen(function* () {
          const status = epicChildrenStatus(epic.number, openIssues, allIssues)
          if (!status.complete) {
            return
          }
          const ref = epic.ref(repo)
          yield* gh.editIssueLabels(ref, [Labels.validate], [])
          yield* Effect.ignore(
            gh.writeIssueComment(
              ref,
              signed(
                [
                  "All of this epic's children have shipped and closed:",
                  "",
                  ...status.shipped.map((line) => `- ${line}`),
                  "",
                  "CEO review requested. Two moves:",
                  "- If the result needs more work: comment your feedback on",
                  "  this epic and add `factory:ready` — the Tech Lead will",
                  "  plan an iteration from your comments.",
                  "- If you are satisfied: close this epic."
                ].join("\n")
              )
            )
          )
          yield* events.publish(
            Info.make({
              message: `epic ${target.slug}#${epic.number} complete — tagged for CEO validation`
            })
          )
        })
      )
    })
  ).pipe(Effect.asVoid)
