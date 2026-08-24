import * as Effect from "effect/Effect"
import type { FlowError } from "@llm4ts/flow/FlowError"
import { Info, type FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import type { HostingShape, WorkItemSummary } from "./Hosting.ts"
import { projectRefOf, type TargetRepo } from "./Config.ts"
import { epicChildMarker } from "./Prompts.ts"
import { Tags, signed } from "./Protocol.ts"

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
  openItems: ReadonlyArray<WorkItemSummary>,
  allItems: ReadonlyArray<WorkItemSummary>
): EpicChildrenStatus => {
  const marker = epicChildMarker(epicNumber)
  const children = allItems.filter((item) => item.body.includes(marker))
  const stillOpen = openItems.filter((item) => item.body.includes(marker))
  return {
    complete: children.length > 0 && stillOpen.length === 0,
    shipped: children.map((item) => `#${item.id} ${item.title}`)
  }
}

export const watchEpics = (
  hosting: HostingShape,
  targets: ReadonlyArray<TargetRepo>,
  events: FlowEventsShape
): Effect.Effect<void, FlowError> =>
  Effect.forEach(targets, (target) =>
    Effect.gen(function* () {
      const repo = projectRefOf(target)
      const epics = yield* hosting.listWorkItems(repo, { tags: [Tags.epic], state: "open" })
      const candidates = epics.filter(
        (epic) =>
          !epic.tags.includes(Tags.ready) &&
          !epic.tags.includes(Tags.validate) &&
          !epic.tags.includes(Tags.needsInfo)
      )
      if (candidates.length === 0) {
        return
      }
      const openItems = yield* hosting.listWorkItems(repo, { state: "open" })
      const allItems = yield* hosting.listWorkItems(repo, { state: "all" })
      yield* Effect.forEach(candidates, (epic) =>
        Effect.gen(function* () {
          const status = epicChildrenStatus(epic.id, openItems, allItems)
          if (!status.complete) {
            return
          }
          const ref = epic.ref(repo)
          yield* hosting.editTags(ref, [Tags.validate], [])
          yield* Effect.ignore(
            hosting.writeComment(
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
              message: `epic ${target.slug}#${epic.id} complete — tagged for CEO validation`
            })
          )
        })
      )
    })
  ).pipe(Effect.asVoid)
