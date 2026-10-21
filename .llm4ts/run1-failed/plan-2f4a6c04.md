# Plan: llm4ts-2-45-upgrade

## [x] Bump llm4ts packages and effect, then regenerate the lockfile
In package.json, set @llm4ts/core, @llm4ts/flow and @llm4ts/runner to 2.45.0. Change effect from ^4.0.0-beta.102 to the 4.0.0 release that llm4ts 2.45.0 requires. If @effect/vitest (currently 'beta') has to move too so it matches effect 4.0.0, update it. Run `pnpm install` so pnpm rewrites pnpm-lock.yaml. Done when the install finishes without peer-dependency errors, node_modules contains llm4ts 2.45.0 and effect 4.0.0, and the lockfile matches package.json. The typecheck is allowed to fail at this point.

## [ ] Fix imports of llm4ts modules that moved or were renamed
Run `pnpm typecheck` and fix every 'cannot find module' or 'has no exported member' error that comes from the @llm4ts/core, @llm4ts/flow and @llm4ts/runner subpath imports. These are ConnectorConfig, ProcessExecutor, Chat, CostLedger, CostTracker, Flow, FlowContext, FlowError, FlowEvents, GitHubTool, Persistence, Plan, Planner, Review, Connectors, FlowRunner, NodePlainFileStore, NodeProcessExecutor and Terminal. Point each import at the module's 2.x location or name. Behavior must not change. Done when the typecheck reports no unresolved llm4ts imports or exports in src/ or test/.

## [ ] Adapt the leaf modules to the changed GitHubTool, FlowEvents and CostLedger APIs
Fix the type errors in the small modules that use llm4ts value types and service shapes: Prompts.ts, Progress.ts, Checklist.ts, Heartbeat.ts, EpicWatch.ts and Surface.ts. The types involved are IssueRef, IssueSummary, IssueCommentRef, GitHubToolShape, FlowEventsShape, Info, CostCell and makePlainTerminalSurface. Keep each module's observable behavior the same: the same comments get posted, the same progress events are emitted and the same prompt text is produced. Done when the typecheck is clean for these files and their tests (Prompts, Progress, Checklist, Heartbeat) pass.

## [ ] Adapt the Engineer, TechLead and Stages orchestration to the llm4ts 2.x flow and runner APIs
Fix the type errors in Engineer.ts, TechLead.ts and Stages.ts. These files call makeChat, makeCostTracker, CostBudget, implementPlanFlow, flowReviewer, reviewAndFixLoop, minimalReviewers, lintCommand, makePlanStore, planFrom, Plan and Task, coderFromEnv, withTurnLimit, FlowRunner exports, nodePlainFileStore, nodeProcessExecutor, parseVerbosity, CliConnectorConfig and ProcessError. Keep the current behavior intact: budget exhaustion still pauses and strips queue labels, a red gate still seeds the fix round, CEO guidance is still injected on every code round, and NIGHTCALL_CODER_MODEL still sets the model for each seat. Done when the typecheck is clean for these files and Engineer.test.ts passes.

## [ ] Fix the remaining Effect 4.0.0 API changes in main, Config, Ledger and Protocol
Fix any errors that come from moving from the effect 4 beta to the 4.0.0 release, such as changed signatures in Schema, Semaphore, Schedule, Clock or Ref. This covers main.ts, Config.ts, Ledger.ts and Protocol.ts, plus anywhere else these errors appear. Fix only what the compiler or tests flag and refactor nothing else. Done when `pnpm typecheck` exits with code 0.

## [ ] Get the whole test suite passing
Run `pnpm test` and fix the remaining failures caused by the upgrade, for example changed test helpers like makeCollectingFlowEvents or the fake ProcessExecutor, different event shapes, or changes in @effect/vitest. Only adapt test fixtures and fakes to the new APIs. Do not weaken any assertions. Done when both `pnpm typecheck` and `pnpm test` pass, and the diff touches only package.json, pnpm-lock.yaml and the files needed for the upgrade.

# Brief

Upgrade @llm4ts/core, @llm4ts/flow and @llm4ts/runner from 0.7.6 to 2.45.0, and effect from 4.0.0-beta.102 to 4.0.0. Change only what the new APIs require so that `pnpm typecheck` and `pnpm test` pass. The llm4ts imports are in src/Stages.ts, src/Engineer.ts, src/TechLead.ts, src/Heartbeat.ts, src/Progress.ts, src/Checklist.ts, src/EpicWatch.ts, src/Prompts.ts, src/Surface.ts and src/main.ts, plus the tests for Checklist, Heartbeat, Progress, Prompts and Engineer.