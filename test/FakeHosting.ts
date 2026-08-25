import * as Effect from "effect/Effect"
import type { HostingShape } from "../src/Hosting.ts"

// Every method dies by default, so a test that exercises an unexpected part
// of the control plane fails loudly instead of silently succeeding against
// a permissive stub. Tests override exactly the methods they mean to use.
export const stubHosting = (overrides: Partial<HostingShape> = {}): HostingShape => ({
  listWorkItems: () => Effect.die("listWorkItems: unused"),
  createWorkItem: () => Effect.die("createWorkItem: unused"),
  editTags: () => Effect.die("editTags: unused"),
  writeComment: () => Effect.die("writeComment: unused"),
  editComment: () => Effect.die("editComment: unused"),
  readComments: () => Effect.die("readComments: unused"),
  openPr: () => Effect.die("openPr: unused"),
  createPr: () => Effect.die("createPr: unused"),
  prChecks: () => Effect.die("prChecks: unused"),
  mergePr: () => Effect.die("mergePr: unused"),
  developmentLinks: () => Effect.die("developmentLinks: unused"),
  linkBranch: () => Effect.die("linkBranch: unused"),
  linkPullRequest: () => Effect.die("linkPullRequest: unused"),
  repository: () => Effect.die("repository: unused"),
  ...overrides
})
