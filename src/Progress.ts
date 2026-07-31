import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import type { FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import type { GitHubToolShape, IssueRef } from "@llm4ts/flow/GitHubTool"

// Live progress on the issue itself: every per-task stage the flow starts
// or finishes becomes a comment —
//   ▶ Implement kebabCase in src/strcase.js
//   ✔ Implement kebabCase in src/strcase.js (3m06s)
//   ✖ Add test coverage (12s): gate failed
// Comments are best-effort (a failed comment never fails the flow) and
// internal plumbing stages are filtered out.

export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes === 0 ? `${rest}s` : `${minutes}m${String(rest).padStart(2, "0")}s`
}

const internalStages = new Set(["branch"])

export const makeProgressEvents = (
  inner: FlowEventsShape,
  gh: GitHubToolShape,
  ref: IssueRef
): Effect.Effect<FlowEventsShape> =>
  Effect.map(Ref.make(new Map<string, number>()), (started) => {
    const tell = (body: string): Effect.Effect<void> =>
      Effect.ignore(gh.writeIssueComment(ref, body))
    const elapsed = (stage: string): Effect.Effect<string> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const startedAt = (yield* Ref.get(started)).get(stage)
        return startedAt === undefined ? "" : ` (${formatDuration(now - startedAt)})`
      })
    return {
      publish: (event) =>
        inner.publish(event).pipe(
          Effect.andThen(() => {
            switch (event._tag) {
              case "StageStarted":
                return internalStages.has(event.stage)
                  ? Effect.void
                  : Clock.currentTimeMillis.pipe(
                      Effect.flatMap((now) =>
                        Ref.update(started, (map) => new Map(map).set(event.stage, now))
                      ),
                      Effect.andThen(tell(`▶ ${event.stage}`))
                    )
              case "StageCompleted":
                return internalStages.has(event.stage)
                  ? Effect.void
                  : elapsed(event.stage).pipe(
                      Effect.flatMap((suffix) => tell(`✔ ${event.stage}${suffix}`))
                    )
              case "StageFailed":
                return internalStages.has(event.stage)
                  ? Effect.void
                  : elapsed(event.stage).pipe(
                      Effect.flatMap((suffix) =>
                        tell(`✖ ${event.stage}${suffix}: ${event.message}`)
                      )
                    )
              default:
                return Effect.void
            }
          }),
          Effect.asVoid
        )
    }
  })
