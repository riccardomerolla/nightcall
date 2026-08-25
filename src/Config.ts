import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  azApiVersion,
  defaultAzCommand,
  defaultAzureConfig,
  parseCommand,
  type AzureConfig
} from "./Azure.ts"
import { ProjectRef } from "./Hosting.ts"

// Company configuration, decoded once at startup from the environment.
// No secret is ever read here: the Azure DevOps credential stays inside
// the `az` CLI's own auth store (`az devops login`, or AZURE_DEVOPS_EXT_PAT
// which `az` reads for itself), and git authenticates the clone through the
// operator's credential helper.

// A target is a BOARD, not a repository. Azure DevOps work items belong to
// a project; a project holds many repositories, and which one a given work
// item is worked in comes from its Development links (see Workspace.ts).
// `defaultRepository` is the fallback for work items that carry no link —
// empty means "a work item without a Development link is not actionable
// here", which is the right answer for a board spanning many repos.
export class TargetBoard extends Schema.Class<TargetBoard>("TargetBoard")({
  project: Schema.String,
  defaultRepository: Schema.String
}) {
  get slug(): string {
    return this.defaultRepository.length === 0
      ? this.project
      : `${this.project}/${this.defaultRepository}`
  }
}

export class ConfigError extends Schema.TaggedErrorClass<ConfigError>("nightcall/ConfigError")(
  "ConfigError",
  {
    message: Schema.String
  }
) {}

export class CompanyConfig extends Schema.Class<CompanyConfig>("CompanyConfig")({
  targets: Schema.Array(TargetBoard),
  heartbeatSeconds: Schema.Int,
  issueBudgetUsd: Schema.Number,
  dailyBudgetUsd: Schema.Number,
  maxAttempts: Schema.Int,
  engineerParallelism: Schema.Int
}) {}

// `project/repository` names a board plus its default repository;
// a bare `project` names a board whose work must route itself.
export const parseTarget = (input: string): TargetBoard | undefined => {
  const trimmed = input.trim()
  const pair = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed)
  if (pair?.[1] !== undefined && pair[2] !== undefined) {
    return TargetBoard.make({ project: pair[1], defaultRepository: pair[2] })
  }
  return /^[^/\s]+$/.test(trimmed)
    ? TargetBoard.make({ project: trimmed, defaultRepository: "" })
    : undefined
}

export const projectRefOf = (target: TargetBoard, repository?: string): ProjectRef =>
  ProjectRef.make({
    project: target.project,
    repository: repository ?? target.defaultRepository
  })

const positiveOr = (raw: string | undefined, fallback: number): number => {
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const azCommandFrom = (raw: string | undefined): ReadonlyArray<string> => {
  const parsed = parseCommand(raw ?? "")
  return parsed.length === 0 ? defaultAzCommand() : parsed
}

const trimmed = (raw: string | undefined, fallback: string): string => {
  const value = raw?.trim() ?? ""
  return value.length === 0 ? fallback : value
}

// The organization URL is required and has no sensible default: guessing it
// would point the company at somebody else's board. A trailing slash is
// stripped so every derived URL composes cleanly.
export const azureFromEnv = (
  env: Record<string, string | undefined>
): Effect.Effect<AzureConfig, ConfigError> => {
  const orgUrl = (env["NIGHTCALL_ADO_ORG"] ?? "").trim().replace(/\/+$/, "")
  if (orgUrl.length === 0) {
    return Effect.fail(
      new ConfigError({
        message: "NIGHTCALL_ADO_ORG must be the organization URL, e.g. https://dev.azure.com/acme"
      })
    )
  }
  return Effect.succeed({
    orgUrl,
    azCommand: azCommandFrom(env["NIGHTCALL_AZ_BIN"]),
    workItemType: trimmed(env["NIGHTCALL_ADO_WORK_ITEM_TYPE"], defaultAzureConfig.workItemType),
    targetBranch: trimmed(env["NIGHTCALL_ADO_TARGET_BRANCH"], defaultAzureConfig.targetBranch),
    // Normalized, not validated: the resource suffix Microsoft's REST docs
    // quote (`7.1-preview.3`) is the value an operator will reach for, and
    // `az devops invoke` cannot carry it — see azApiVersion.
    apiVersion: azApiVersion(trimmed(env["NIGHTCALL_ADO_API_VERSION"], defaultAzureConfig.apiVersion))
  })
}

// NIGHTCALL_TARGETS is a comma-separated list of project/repository pairs;
// every other knob has the DESIGN.md default and a NIGHTCALL_* override.
// Non-positive or malformed numeric overrides fall back to the default
// rather than failing startup; a bad target slug is a hard error because
// silently skipping a repo would darken part of the company.
export const configFromEnv = (
  env: Record<string, string | undefined>
): Effect.Effect<CompanyConfig, ConfigError> => {
  const rawTargets = (env["NIGHTCALL_TARGETS"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (rawTargets.length === 0) {
    return Effect.fail(
      new ConfigError({ message: "NIGHTCALL_TARGETS must list at least one project/repository" })
    )
  }
  const targets: Array<TargetBoard> = []
  for (const raw of rawTargets) {
    const target = parseTarget(raw)
    if (target === undefined) {
      return Effect.fail(
        new ConfigError({
          message: `NIGHTCALL_TARGETS entry is not project or project/repository: ${raw}`
        })
      )
    }
    // Two entries for one project would poll the same board twice and claim
    // every work item twice, in two different repositories. A board is
    // polled once; Development links route its work to repositories.
    if (targets.some((existing) => existing.project === target.project)) {
      return Effect.fail(
        new ConfigError({
          message:
            `NIGHTCALL_TARGETS lists project ${target.project} twice. A board is ` +
            "polled once — list it once and let each work item's Development " +
            "link choose its repository."
        })
      )
    }
    targets.push(target)
  }
  return Effect.succeed(
    CompanyConfig.make({
      targets,
      heartbeatSeconds: Math.floor(positiveOr(env["NIGHTCALL_HEARTBEAT_SECONDS"], 120)),
      issueBudgetUsd: positiveOr(env["NIGHTCALL_ISSUE_BUDGET_USD"], 5),
      dailyBudgetUsd: positiveOr(env["NIGHTCALL_DAILY_BUDGET_USD"], 25),
      maxAttempts: Math.floor(positiveOr(env["NIGHTCALL_MAX_ATTEMPTS"], 2)),
      engineerParallelism: Math.floor(positiveOr(env["NIGHTCALL_ENGINEER_PARALLELISM"], 1))
    })
  )
}
