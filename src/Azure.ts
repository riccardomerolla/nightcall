import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Capabilities } from "@llm4ts/core/Capability"
import type { ProcessExecutorShape, ProcessResult } from "@llm4ts/core/ProcessExecutor"
import type { TemporaryFilesShape } from "@llm4ts/core/TemporaryFiles"
import {
  AdoConfig,
  GitArtifact,
  type GitRepository,
  parseDevelopmentLinks,
  parseRepository,
  relationAddArgs,
  repositoryShowArgs,
  workItemShowArgs as relationsShowArgs
} from "@llm4ts/flow/AzureDevOpsTool"
import { guarded } from "@llm4ts/flow/CapabilityGuard"
import { ProcessError, type FlowError } from "@llm4ts/flow/FlowError"
import type { FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import {
  BuildOutcome,
  Comment,
  CommentRef,
  PullRef,
  WorkItemRef,
  WorkItemSummary,
  type HostingShape,
  type ProjectRef,
  type WorkItemFilter
} from "./Hosting.ts"

// The only module that knows the control plane is Azure DevOps. Every call
// is the `az` CLI (with the azure-devops extension) driven through llm4ts's
// ProcessExecutor, in the same args-builder / schema-decoded-JSON shape
// llm4ts's own forge tools use.
//
// Credentials are never handled here. `az` owns them — `az devops login`,
// or AZURE_DEVOPS_EXT_PAT read by the CLI itself — exactly as `gh` owned
// GitHub's before this branch, so no token can reach argv, a log line, a
// trace, or a persisted plan. Git operations on the clone authenticate
// through the operator's git credential helper for the same reason.
//
// Development-link handling comes from `@llm4ts/flow/AzureDevOpsTool`: the
// `vstfs:` URI encoding, the relation decoding, and the GUID resolution are
// Azure DevOps protocol and live there. What stays here is what that tool's
// single-project config cannot express — the board queries — plus the two
// things Nightcall needs that it does not offer: the HTML round trip, and
// comments that come back with an id so a checklist can be edited in place.

export interface AzureConfig {
  // Organization URL, e.g. https://dev.azure.com/acme
  readonly orgUrl: string
  // How to launch the Azure CLI, as argv — a program plus any leading
  // arguments, so an install that needs an interpreter can say so. `az` is
  // right on every platform: llm4ts's executor resolves it through PATHEXT
  // and runs the batch file Windows installs, which is the same thing a
  // shell does for a human at a prompt.
  readonly azCommand: ReadonlyArray<string>
  // Work item type created for epic children, e.g. "Task", "User Story".
  readonly workItemType: string
  // Target branch for pull requests when the repo default is not wanted.
  readonly targetBranch: string
  // `az devops invoke` is the only route to the work-item comments API.
  readonly apiVersion: string
}

export const defaultAzCommand = (): ReadonlyArray<string> => ["az"]

// An operator-supplied command is argv, not a sentence: split on whitespace
// but keep quoted runs together, so a Windows path with spaces survives.
export const parseCommand = (raw: string): ReadonlyArray<string> =>
  (raw.match(/"[^"]*"|\S+/g) ?? [])
    .map((token) => token.replace(/^"(.*)"$/, "$1"))
    .filter((token) => token.length > 0)

// A batch file that will not spawn means the runtime is older than the
// llm4ts release that taught the executor to run one.
export const batchFileHint = (detail: string): string =>
  /EINVAL/.test(detail)
    ? "\nspawn EINVAL means a batch file could not be launched. Windows needs " +
      "@llm4ts/runner 0.13.1 or newer, which resolves PATHEXT and runs the " +
      "batch file through cmd.exe; NIGHTCALL_AZ_BIN can name an interpreter " +
      "directly if that is not an option."
    : ""

export const defaultAzureConfig: AzureConfig = {
  orgUrl: "",
  azCommand: defaultAzCommand(),
  workItemType: "Task",
  targetBranch: "main",
  apiVersion: "7.1-preview.3"
}

// ---------------------------------------------------------------------------
// HTML round trip
// ---------------------------------------------------------------------------

// Azure DevOps stores work item descriptions and comments as HTML, while
// the whole protocol above this module is line-oriented plain text:
// `Blocked-by: #12`, `Parent: #7 (epic)` (anchored at end of body), the
// report signature, checklist lines. Both directions are lossless for the
// plain text Nightcall writes, so a marker written by the Tech Lead is
// still parseable when the heartbeat reads it back.

export const toHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .split(/\r?\n/)
    .join("<br/>")

export const toText = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    // Tags go before entities, so an escaped `&lt;div&gt;` in the text is
    // never mistaken for markup and stripped.
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    // Ampersand last: decoding it first would turn `&amp;lt;` into `<`.
    .replace(/&amp;/gi, "&")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

// Without --detect false the CLI infers the organization from the working
// directory's git remote — inside a worktree of a target repo, that is a
// different organization than the one the daemon was configured with.
const org = (config: AzureConfig): ReadonlyArray<string> => [
  "--org",
  config.orgUrl,
  "--detect",
  "false"
]

const json = ["--output", "json"]

export const branchName = (ref: string): string => ref.trim().replace(/^refs\/heads\//, "")

// WIQL literals are single-quoted and escape an embedded quote by doubling
// it. Tags come from labels a human typed, so this is the difference
// between a tag named `won't fix` working and rewriting the query.
export const quoteWiql = (value: string): string => `'${value.replace(/'/g, "''")}'`

export const workItemFields: ReadonlyArray<string> = [
  "System.Id",
  "System.Title",
  "System.Description",
  "System.State",
  "System.Tags",
  "System.CreatedBy",
  "System.ChangedDate"
]

export const wiqlFor = (project: ProjectRef, filter: WorkItemFilter): string => {
  const clauses = [
    `[System.TeamProject] = ${quoteWiql(project.project)}`,
    ...(filter.state === "all"
      ? []
      : filter.state === "closed"
        ? ["[System.State] = 'Closed'"]
        : ["[System.State] <> 'Closed'"]),
    ...(filter.tags ?? []).map((tag) => `[System.Tags] CONTAINS ${quoteWiql(tag)}`)
  ]
  const select = workItemFields.map((name) => `[${name}]`).join(", ")
  // No TOP. WIQL looks like SQL but its grammar is only SELECT / FROM /
  // WHERE / ORDER BY / ASOF; the row cap is the REST `$top` parameter, and
  // `az boards query` does not expose it. A `TOP n` leaves the SELECT list
  // unparseable, so the server never reaches FROM and answers "TF51006: the
  // query statement is missing a FROM clause". The limit is applied to the
  // result instead — with the ORDER BY, that is the same rows in the same
  // order TOP would have given.
  return (
    `SELECT ${select} FROM WorkItems ` +
    `WHERE ${clauses.join(" AND ")} ORDER BY [System.Id] ASC`
  )
}

export const defaultWorkItemLimit = 200

export const queryArgs = (
  config: AzureConfig,
  project: ProjectRef,
  wiql: string
): ReadonlyArray<string> => [
  "boards",
  "query",
  "--wiql",
  wiql,
  "--project",
  project.project,
  ...org(config),
  ...json
]

export const workItemShowArgs = (config: AzureConfig, id: number): ReadonlyArray<string> => [
  "boards",
  "work-item",
  "show",
  "--id",
  String(id),
  ...org(config),
  ...json
]

export const setTagsArgs = (
  config: AzureConfig,
  id: number,
  tags: ReadonlyArray<string>
): ReadonlyArray<string> => [
  "boards",
  "work-item",
  "update",
  "--id",
  String(id),
  "--fields",
  `System.Tags=${tags.join("; ")}`,
  ...org(config),
  ...json
]

export const createWorkItemArgs = (
  config: AzureConfig,
  project: ProjectRef,
  title: string,
  body: string,
  tags: ReadonlyArray<string>
): ReadonlyArray<string> => [
  "boards",
  "work-item",
  "create",
  "--title",
  title,
  "--type",
  config.workItemType,
  "--description",
  toHtml(body),
  "--project",
  project.project,
  ...(tags.length === 0 ? [] : ["--fields", `System.Tags=${tags.join("; ")}`]),
  ...org(config),
  ...json
]

// Work item comments have no first-class `az boards` verb, so all three
// operations go through the REST resource. Create and update take a JSON
// body, which `az devops invoke` reads only from a file.
export const commentsArgs = (
  config: AzureConfig,
  project: string,
  workItemId: number,
  method: "GET" | "POST" | "PATCH",
  commentId?: number,
  inFile?: string
): ReadonlyArray<string> => [
  "devops",
  "invoke",
  "--area",
  "wit",
  "--resource",
  "comments",
  "--route-parameters",
  `project=${project}`,
  `workItemId=${String(workItemId)}`,
  ...(commentId === undefined ? [] : [`commentId=${String(commentId)}`]),
  "--api-version",
  config.apiVersion,
  "--http-method",
  method,
  ...(inFile === undefined ? [] : ["--in-file", inFile, "--media-type", "application/json"]),
  ...org(config),
  ...json
]

export const prListArgs = (
  config: AzureConfig,
  project: ProjectRef,
  branch: string
): ReadonlyArray<string> => [
  "repos",
  "pr",
  "list",
  "--repository",
  project.repository,
  "--project",
  project.project,
  "--status",
  "active",
  "--source-branch",
  branchName(branch),
  ...org(config),
  ...json
]

export const prCreateArgs = (
  config: AzureConfig,
  project: ProjectRef,
  branch: string,
  workItemId: number,
  title: string,
  body: string
): ReadonlyArray<string> => [
  "repos",
  "pr",
  "create",
  "--repository",
  project.repository,
  "--project",
  project.project,
  "--source-branch",
  branchName(branch),
  "--target-branch",
  branchName(config.targetBranch),
  "--title",
  title,
  "--description",
  body,
  // The Azure DevOps way to say "Closes #N": a real work-item link, so the
  // board shows the deliverable and completing the PR can resolve the item.
  "--work-items",
  String(workItemId),
  ...org(config),
  ...json
]

export const prPolicyArgs = (config: AzureConfig, id: number): ReadonlyArray<string> => [
  "repos",
  "pr",
  "policy",
  "list",
  "--id",
  String(id),
  ...org(config),
  ...json
]

export const prCompleteArgs = (config: AzureConfig, id: number): ReadonlyArray<string> => [
  "repos",
  "pr",
  "update",
  "--id",
  String(id),
  "--status",
  "completed",
  "--squash",
  "true",
  "--delete-source-branch",
  "true",
  ...org(config),
  ...json
]

// Azure DevOps has no `az repos clone`; the remote is a plain HTTPS git URL
// and git's credential helper authenticates it, so no PAT is ever written
// into a URL or an argument.
export const cloneUrl = (config: AzureConfig, project: ProjectRef): string =>
  `${config.orgUrl}/${encodeURIComponent(project.project)}/_git/` +
  `${encodeURIComponent(project.repository)}`

export const prWebUrl = (config: AzureConfig, project: ProjectRef, id: number): string =>
  `${cloneUrl(config, project)}/pullrequest/${String(id)}`

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const Identity = Schema.Union([
  Schema.String,
  Schema.Struct({
    displayName: Schema.optionalKey(Schema.String),
    uniqueName: Schema.optionalKey(Schema.String)
  })
])

const identityName = (value: typeof Identity.Type | undefined): string =>
  value === undefined
    ? ""
    : typeof value === "string"
      ? value
      : (value.displayName ?? value.uniqueName ?? "")

const AdoWorkItem = Schema.Struct({
  id: Schema.Int,
  fields: Schema.Struct({
    "System.Title": Schema.optionalKey(Schema.String),
    "System.Description": Schema.optionalKey(Schema.String),
    "System.State": Schema.optionalKey(Schema.String),
    "System.Tags": Schema.optionalKey(Schema.String),
    "System.CreatedBy": Schema.optionalKey(Identity),
    "System.ChangedDate": Schema.optionalKey(Schema.String)
  })
})

export const parseTags = (raw: string): ReadonlyArray<string> =>
  raw
    .split(";")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)

const toSummary = (item: typeof AdoWorkItem.Type): WorkItemSummary =>
  WorkItemSummary.make({
    id: item.id,
    title: item.fields["System.Title"] ?? "",
    body: toText(item.fields["System.Description"] ?? ""),
    author: identityName(item.fields["System.CreatedBy"]),
    tags: parseTags(item.fields["System.Tags"] ?? ""),
    state: item.fields["System.State"] ?? "",
    updatedAt: item.fields["System.ChangedDate"] ?? ""
  })

const decodeFailure =
  (message: string) =>
  (error: unknown): ProcessError =>
    ProcessError.make({ message, detail: String(error) })

export const parseWorkItem = (payload: string): Effect.Effect<WorkItemSummary, ProcessError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AdoWorkItem))(payload).pipe(
    Effect.map(toSummary),
    Effect.mapError(decodeFailure("az boards work-item show"))
  )

// `az boards query` flattens a WIQL result into whole work items, so a
// heartbeat poll is one call per tag rather than a fan-out over ids.
export const parseWorkItems = (
  payload: string
): Effect.Effect<ReadonlyArray<WorkItemSummary>, ProcessError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(AdoWorkItem)))(payload).pipe(
    Effect.map((items) => items.map(toSummary)),
    Effect.mapError(decodeFailure("az boards query"))
  )

const AdoComment = Schema.Struct({
  id: Schema.Int,
  text: Schema.optionalKey(Schema.String),
  createdBy: Schema.optionalKey(Identity),
  createdDate: Schema.optionalKey(Schema.String)
})

const AdoComments = Schema.Struct({
  comments: Schema.Array(AdoComment).pipe(
    Schema.withConstructorDefault(Effect.succeed(Object.freeze([])))
  )
})

export const parseComments = (
  payload: string
): Effect.Effect<ReadonlyArray<Comment>, ProcessError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AdoComments))(payload).pipe(
    Effect.map((parsed) =>
      // Oldest first: guidanceSince scans for the last signed report by
      // index, so comment order is load-bearing, not cosmetic.
      [...parsed.comments]
        .sort((left, right) => left.id - right.id)
        .map((comment) =>
          Comment.make({
            author: identityName(comment.createdBy),
            body: toText(comment.text ?? ""),
            createdAt: comment.createdDate ?? ""
          })
        )
    ),
    Effect.mapError(decodeFailure("az devops invoke wit comments"))
  )

export const parseComment = (payload: string): Effect.Effect<number, ProcessError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AdoComment))(payload).pipe(
    Effect.map((comment) => comment.id),
    Effect.mapError(decodeFailure("az devops invoke wit comments create"))
  )

const AdoPr = Schema.Struct({ pullRequestId: Schema.Int })

export const parsePullRequests = (
  payload: string
): Effect.Effect<ReadonlyArray<number>, ProcessError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(AdoPr)))(payload).pipe(
    Effect.map((prs) => prs.map((pr) => pr.pullRequestId)),
    Effect.mapError(decodeFailure("az repos pr list"))
  )

export const parsePullRequest = (payload: string): Effect.Effect<number, ProcessError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AdoPr))(payload).pipe(
    Effect.map((pr) => pr.pullRequestId),
    Effect.mapError(decodeFailure("az repos pr create"))
  )

const AdoPolicies = Schema.Array(Schema.Struct({ status: Schema.optionalKey(Schema.String) }))

// Branch policy evaluations are Azure DevOps' check rollup. queued/running
// are still deciding; rejected/broken have decided against the PR.
export const outcomeFromPolicies = (payload: string): Effect.Effect<BuildOutcome, ProcessError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AdoPolicies))(payload).pipe(
    Effect.map((policies) => {
      const statuses = policies.map((policy) => policy.status?.toLowerCase() ?? "")
      return statuses.some((value) => ["queued", "running"].includes(value))
        ? "Pending"
        : statuses.some((value) => ["rejected", "broken"].includes(value))
          ? "Failure"
          : "Success"
    }),
    Effect.mapError(decodeFailure("az repos pr policy list"))
  )

// Development-link work is llm4ts's: the `vstfs:` URI encoding, the
// relation decoding, and the GUID resolution all live in
// `@llm4ts/flow/AzureDevOpsTool`, which binds one project+repository per
// config value. Nightcall polls many boards, so it mints that config per
// call rather than holding one — the value is cheap and immutable.
export const adoConfigFor = (
  config: AzureConfig,
  project: string,
  repository: string
): AdoConfig =>
  AdoConfig.make({
    orgUrl: config.orgUrl,
    project,
    repository,
    apiVersion: config.apiVersion
  })

export const hasAllTags =
  (required: ReadonlyArray<string> | undefined) =>
  (item: WorkItemSummary): boolean =>
    (required ?? []).every((tag) =>
      item.tags.some((present) => present.toLowerCase() === tag.toLowerCase())
    )

// Tags are one semicolon-joined field, so an edit is read-merge-write —
// Azure DevOps compares tags case-insensitively, and so does this.
export const mergeTags = (
  current: ReadonlyArray<string>,
  add: ReadonlyArray<string>,
  remove: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const removed = new Set(remove.map((tag) => tag.toLowerCase()))
  const kept = current.filter((tag) => !removed.has(tag.toLowerCase()))
  const present = new Set(kept.map((tag) => tag.toLowerCase()))
  const added = add.filter(
    (tag) => !present.has(tag.toLowerCase()) && !removed.has(tag.toLowerCase())
  )
  return [...kept, ...added]
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

const output = (result: ProcessResult): string => result.stdout.join("\n").trim()

export const makeAzureHosting = (
  config: AzureConfig,
  processExecutor: ProcessExecutorShape,
  temporaryFiles: TemporaryFilesShape,
  workDir: string,
  events: FlowEventsShape
): HostingShape => {
  // No shell, ever. The executor spawns argv directly, so every argument
  // reaches `az` exactly as built — WIQL operators like `<>` included. Under
  // a shell those would be redirection, which is why the command printed in
  // an error is a description of what ran, not something to paste into
  // PowerShell: pasting it asks a shell to parse text that was deliberately
  // never given to one.
  const shown = config.azCommand.join(" ")
  const run = (args: ReadonlyArray<string>): Effect.Effect<string, FlowError> =>
    processExecutor.run([...config.azCommand, ...args], workDir, {}).pipe(
      Effect.mapError((error) =>
        ProcessError.make({
          message: `${shown} ${args.join(" ")}`,
          detail: error.message + batchFileHint(error.message)
        })
      ),
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(output(result))
          : Effect.fail(
              ProcessError.make({
                message: `${shown} ${args.join(" ")}`,
                detail:
                  [...result.stdout, ...result.stderr].join("\n").trim() ||
                  `exit code ${result.exitCode}`
              })
            )
      )
    )

  // A comment body reaches the REST resource as a JSON document; the temp
  // file is scoped so it is removed as soon as the call returns.
  const withCommentBody = (
    body: string,
    use: (path: string) => Effect.Effect<string, FlowError>
  ): Effect.Effect<string, FlowError> =>
    Effect.scoped(
      temporaryFiles
        .write("nightcall-comment", ".json", JSON.stringify({ text: toHtml(body) }))
        .pipe(
          Effect.mapError((error) =>
            ProcessError.make({ message: "comment body", detail: error.message })
          ),
          Effect.flatMap(use)
        )
    )

  const readTags = (ref: WorkItemRef): Effect.Effect<ReadonlyArray<string>, FlowError> =>
    run(workItemShowArgs(config, ref.id)).pipe(
      Effect.flatMap(parseWorkItem),
      Effect.map((item) => item.tags)
    )

  const repositoryOf = (
    project: string,
    nameOrId: string
  ): Effect.Effect<GitRepository, FlowError> =>
    run(repositoryShowArgs(adoConfigFor(config, project, nameOrId), nameOrId)).pipe(
      Effect.flatMap(parseRepository)
    )

  // Adding a link that already exists is an error from the service, so the
  // Development section is read first. That also makes re-linking on a
  // resumed stage a no-op instead of a noisy failure.
  const linkTo = (
    ref: WorkItemRef,
    repository: string,
    artifactOf: (repo: GitRepository) => GitArtifact
  ): Effect.Effect<void, FlowError> =>
    Effect.gen(function* () {
      const repo = yield* repositoryOf(ref.project, repository)
      const artifact = artifactOf(repo)
      const existing = yield* run(
        relationsShowArgs(adoConfigFor(config, ref.project, repository), ref.id, "relations")
      ).pipe(Effect.flatMap(parseDevelopmentLinks))
      const already = existing.some(
        (link) =>
          link.kind === artifact.kind &&
          link.repositoryId === artifact.repositoryId &&
          link.value === artifact.value
      )
      if (!already) {
        yield* run(
          relationAddArgs(adoConfigFor(config, ref.project, repository), ref.id, artifact)
        )
      }
    })

  const findOpenPr = (
    project: ProjectRef,
    branch: string
  ): Effect.Effect<PullRef | undefined, FlowError> =>
    run(prListArgs(config, project, branch)).pipe(
      Effect.flatMap(parsePullRequests),
      Effect.map((ids) => {
        const id = ids[0]
        return id === undefined
          ? undefined
          : PullRef.make({ id, url: prWebUrl(config, project, id) })
      })
    )

  // Every call goes through llm4ts's capability guard, the same one the
  // library's own forge tools use: a run restricted to AdoRead can poll and
  // triage but cannot write a tag, a comment, or a pull request, and each
  // denial is published as an event rather than failing silently. Outside a
  // restricted scope the grants default to permissive, so the heartbeat is
  // unaffected — the guard bites exactly where a flow narrowed it.
  const read = <A>(
    operation: string,
    effect: Effect.Effect<A, FlowError>
  ): Effect.Effect<A, FlowError> => guarded(Capabilities.AdoRead, operation, events, effect)
  const write = <A>(
    operation: string,
    effect: Effect.Effect<A, FlowError>
  ): Effect.Effect<A, FlowError> => guarded(Capabilities.AdoWrite, operation, events, effect)

  return {
    listWorkItems: (project, filter = {}) =>
      read(
        "ado listWorkItems",
        run(queryArgs(config, project, wiqlFor(project, filter))).pipe(
          Effect.flatMap(parseWorkItems),
          // WIQL's CONTAINS is a substring match, so a query for
          // `factory:review` also returns `factory:reviewed` items. The
          // heartbeat's phaseOf pass would drop them, but a caller that
          // trusts this filter directly (boot reconciliation, epic watch)
          // would not — so the exact match happens here, once.
          Effect.map((items) => items.filter(hasAllTags(filter.tags))),
          // After that filter, so a limit counts items the caller will
          // actually see rather than ones CONTAINS matched by accident.
          Effect.map((items) => items.slice(0, filter.limit ?? defaultWorkItemLimit))
        )
      ),
    createWorkItem: (project, title, body, tags = []) =>
      write(
        "ado createWorkItem",
        run(createWorkItemArgs(config, project, title, body, tags)).pipe(
          Effect.flatMap(parseWorkItem),
          Effect.map((item) =>
            WorkItemRef.make({
              project: project.project,
              repository: project.repository,
              id: item.id
            })
          )
        )
      ),
    editTags: (ref, add, remove) =>
      add.length === 0 && remove.length === 0
        ? Effect.void
        : write(
            "ado editTags",
            readTags(ref).pipe(
              Effect.flatMap((current) => {
                const next = mergeTags(current, add, remove)
                return next.length === current.length &&
                  next.every((tag, index) => tag === current[index])
                  ? Effect.void
                  : run(setTagsArgs(config, ref.id, next)).pipe(Effect.asVoid)
              })
            )
          ),
    writeComment: (ref, body) =>
      write(
        "ado writeComment",
        withCommentBody(body, (path) =>
          run(commentsArgs(config, ref.project, ref.id, "POST", undefined, path))
        ).pipe(
          // The POST itself must still fail loudly — a comment that never
          // posted is lost governance. Only an unreadable id degrades: the
          // comment is on the work item, the caller merely cannot edit it
          // later and falls back to per-task tick comments.
          Effect.flatMap((payload) =>
            parseComment(payload).pipe(
              Effect.map(
                (id): CommentRef | undefined =>
                  CommentRef.make({ project: ref.project, workItemId: ref.id, id })
              ),
              Effect.orElseSucceed(() => undefined)
            )
          )
        )
      ),
    editComment: (comment, body) =>
      write(
        "ado editComment",
        withCommentBody(body, (path) =>
          run(commentsArgs(config, comment.project, comment.workItemId, "PATCH", comment.id, path))
        ).pipe(Effect.asVoid)
      ),
    readComments: (ref) =>
      read(
        "ado readComments",
        run(commentsArgs(config, ref.project, ref.id, "GET")).pipe(Effect.flatMap(parseComments))
      ),
    openPr: (project, branch) => read("ado openPr", findOpenPr(project, branch)),
    createPr: (project, branch, workItemId, title, body) =>
      write(
        "ado createPr",
        // An active PR for the branch already IS the deliverable; a second
        // one would be rejected by the server and lose the first's reviews.
        findOpenPr(project, branch).pipe(
          Effect.flatMap((existing) =>
            existing !== undefined
              ? Effect.succeed(existing)
              : run(prCreateArgs(config, project, branch, workItemId, title, body)).pipe(
                  Effect.flatMap(parsePullRequest),
                  Effect.map((id) => PullRef.make({ id, url: prWebUrl(config, project, id) }))
                )
          )
        )
      ),
    prChecks: (pr) =>
      read(
        "ado prChecks",
        run(prPolicyArgs(config, pr.id)).pipe(Effect.flatMap(outcomeFromPolicies))
      ),
    mergePr: (pr) =>
      write("ado mergePr", run(prCompleteArgs(config, pr.id)).pipe(Effect.asVoid)),
    developmentLinks: (ref) =>
      read(
        "ado developmentLinks",
        run(
          relationsShowArgs(adoConfigFor(config, ref.project, ref.repository), ref.id, "relations")
        ).pipe(Effect.flatMap(parseDevelopmentLinks))
      ),
    linkBranch: (ref, repository, branch) =>
      write(
        "ado linkBranch",
        linkTo(ref, repository, (repo) =>
          GitArtifact.make({
            kind: "Branch",
            projectId: repo.projectId,
            repositoryId: repo.id,
            value: branchName(branch)
          })
        )
      ),
    linkPullRequest: (ref, repository, pullRequestId) =>
      write(
        "ado linkPullRequest",
        linkTo(ref, repository, (repo) =>
          GitArtifact.make({
            kind: "PullRequest",
            projectId: repo.projectId,
            repositoryId: repo.id,
            value: String(pullRequestId)
          })
        )
      ),
    repository: (project, nameOrId) => read("ado repository", repositoryOf(project, nameOrId))
  }
}
