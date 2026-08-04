import { readFile, writeFile } from "node:fs/promises"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type { FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import { IssueCommentRef, type GitHubToolShape } from "@llm4ts/flow/GitHubTool"
import { formatDuration } from "./Progress.ts"
import { signature } from "./Protocol.ts"

// The plan lives on the issue as ONE GitHub task-list comment that the
// factory edits as work progresses — a living checklist instead of a
// scroll of tick comments:
//   - [x] Expose portfolio suitability violations (5m44s)
//   - [ ] ⏳ **Propose target-aligned portfolio changes**
//   - [ ] Apply suitability constraints to proposals
// The comment reference is persisted next to the plan so the code stage
// (a different process, possibly after a restart) can keep editing it.

export type TaskProgress = "pending" | "running" | "done" | "failed"

export interface ChecklistTask {
  readonly title: string
  readonly progress: TaskProgress
  readonly note?: string
}

export const renderChecklist = (
  epicId: string,
  tasks: ReadonlyArray<ChecklistTask>
): string =>
  [
    `### Plan: ${epicId}`,
    "",
    ...tasks.map((task) => {
      switch (task.progress) {
        case "done":
          return `- [x] ${task.title}${task.note === undefined ? "" : ` (${task.note})`}`
        case "running":
          return `- [ ] ⏳ **${task.title}**`
        case "failed":
          return `- [ ] ❌ ${task.title}${task.note === undefined ? "" : ` — ${task.note}`}`
        default:
          return `- [ ] ${task.title}`
      }
    }),
    "",
    signature
  ].join("\n")

const decodeCommentRef = Schema.decodeUnknownEffect(Schema.fromJsonString(IssueCommentRef))

export const saveCommentRef = (
  path: string,
  comment: IssueCommentRef
): Effect.Effect<void> =>
  Effect.ignore(
    Effect.tryPromise({
      try: () => writeFile(path, JSON.stringify(comment), "utf8"),
      catch: (error) => String(error)
    })
  )

export const loadCommentRef = (path: string): Effect.Effect<IssueCommentRef | undefined> =>
  Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: () => "missing" }).pipe(
    Effect.flatMap((content) => decodeCommentRef(content)),
    Effect.map((comment): IssueCommentRef | undefined => comment),
    Effect.catch(() => Effect.succeed(undefined))
  )

// Decorates the flow event sink: per-task stage events update the task
// map and re-render the checklist comment. Edits are best-effort — a
// failed edit never fails the flow — and unknown stage names (plumbing)
// pass through untouched.
export const makeChecklistEvents = (
  inner: FlowEventsShape,
  gh: GitHubToolShape,
  comment: IssueCommentRef,
  epicId: string,
  initial: ReadonlyArray<{ readonly title: string; readonly completed: boolean }>
): Effect.Effect<FlowEventsShape> =>
  Effect.gen(function* () {
    const tasks = yield* Ref.make<ReadonlyArray<ChecklistTask>>(
      initial.map((task) => ({
        title: task.title,
        progress: task.completed ? "done" : "pending"
      }))
    )
    const started = yield* Ref.make(new Map<string, number>())
    const update = (
      title: string,
      progress: TaskProgress,
      note?: string
    ): Effect.Effect<boolean> =>
      Ref.modify(tasks, (current) => {
        const known = current.some((task) => task.title === title)
        return [
          known,
          current.map((task) =>
            task.title === title
              ? { title, progress, ...(note === undefined ? {} : { note }) }
              : task
          )
        ]
      })
    const redraw = Ref.get(tasks).pipe(
      Effect.flatMap((current) =>
        Effect.ignore(gh.editIssueComment(comment, renderChecklist(epicId, current)))
      )
    )
    const elapsed = (title: string): Effect.Effect<string | undefined> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const startedAt = (yield* Ref.get(started)).get(title)
        return startedAt === undefined ? undefined : formatDuration(now - startedAt)
      })
    return {
      publish: (event) =>
        inner.publish(event).pipe(
          Effect.andThen(() => {
            switch (event._tag) {
              case "StageStarted":
                return Clock.currentTimeMillis.pipe(
                  Effect.flatMap((now) =>
                    Ref.update(started, (map) => new Map(map).set(event.stage, now))
                  ),
                  Effect.andThen(update(event.stage, "running")),
                  Effect.flatMap((known) => (known ? redraw : Effect.void))
                )
              case "StageCompleted":
                return elapsed(event.stage).pipe(
                  Effect.flatMap((note) => update(event.stage, "done", note)),
                  Effect.flatMap((known) => (known ? redraw : Effect.void))
                )
              case "StageFailed":
                return update(event.stage, "failed", event.message).pipe(
                  Effect.flatMap((known) => (known ? redraw : Effect.void))
                )
              default:
                return Effect.void
            }
          }),
          Effect.asVoid
        )
    }
  })
