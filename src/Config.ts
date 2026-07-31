import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

// Company configuration, decoded once at startup from the environment.
// Secrets (the GitHub token) stay inside the gh CLI's own auth store —
// Nightcall never reads or holds the token itself.

export class TargetRepo extends Schema.Class<TargetRepo>("TargetRepo")({
  owner: Schema.String,
  repo: Schema.String
}) {
  get slug(): string {
    return `${this.owner}/${this.repo}`
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
  const owner = match?.[1]
  const repo = match?.[2]
  return owner === undefined || repo === undefined ? undefined : TargetRepo.make({ owner, repo })
}

const positiveOr = (raw: string | undefined, fallback: number): number => {
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// NIGHTCALL_TARGETS is a comma-separated list of owner/repo slugs; every
// other knob has the DESIGN.md default and a NIGHTCALL_* override.
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
      new ConfigError({ message: "NIGHTCALL_TARGETS must list at least one owner/repo" })
    )
  }
  const targets: Array<TargetRepo> = []
  for (const raw of rawTargets) {
    const target = parseTarget(raw)
    if (target === undefined) {
      return Effect.fail(
        new ConfigError({ message: `NIGHTCALL_TARGETS entry is not owner/repo: ${raw}` })
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
