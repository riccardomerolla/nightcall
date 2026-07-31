import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The factory workspace holds clones and worktrees of target repos —
    // their test suites are theirs to run, not ours.
    exclude: ["**/node_modules/**", ".factory/**"]
  }
})
