import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { defaultAzureConfig, type AzureConfig } from "./Azure.ts"
import { ProjectRef } from "./Hosting.ts"

// Company configuration, decoded once at startup from the environment.
// No secret is ever read here: the Azure DevOps credential stays inside
// the `az` CLI's own auth store (`az devops login`, or AZURE_DEVOPS_EXT_PAT
// which `az` reads for itself), and git authenticates the clone through the
// operator's credential helper.

export class TargetRepo extends Schema.Class<TargetRepo>("TargetRepo")({
  project: Schema.String,
  repository: Schema.String
}) {
  get slug(): string {
    return `${this.project}/${this.repository}`
  }
}

export class ConfigError extends Schema.TaggedErrorClass<ConfigError>("nightcall/ConfigError")(
  "ConfigError",
  {
    message: Schema.String
  }
) {}

export class CompanyConfig extends Schema.Class<CompanyConfig>("CompanyConfig")({
  targets: Schema.Array(TargetRepo),
  heartbeatSeconds: Schema.Int,
  issueBudgetUsd: Schema.Number,
  dailyBudgetUsd: Schema.Number,
  maxAttempts: Schema.Int,
  engineerParallelism: Schema.Int
}) {}

export const parseTarget = (input: string): TargetRepo | undefined => {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(input.trim())
  const project = match?.[1]
  const repository = match?.[2]
  return project === undefined || repository === undefined
    ? undefined
    : TargetRepo.make({ project, repository })
}

export const projectRefOf = (target: TargetRepo): ProjectRef =>
  ProjectRef.make({ project: target.project, repository: target.repository })

const positiveOr = (raw: string | undefined, fallback: number): number => {
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
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
    workItemType: trimmed(env["NIGHTCALL_ADO_WORK_ITEM_TYPE"], defaultAzureConfig.workItemType),
    targetBranch: trimmed(env["NIGHTCALL_ADO_TARGET_BRANCH"], defaultAzureConfig.targetBranch),
    apiVersion: trimmed(env["NIGHTCALL_ADO_API_VERSION"], defaultAzureConfig.apiVersion)
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
  const targets: Array<TargetRepo> = []
  for (const raw of rawTargets) {
    const target = parseTarget(raw)
    if (target === undefined) {
      return Effect.fail(
        new ConfigError({
          message: `NIGHTCALL_TARGETS entry is not project/repository: ${raw}`
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
