import { assert, describe, it } from "@effect/vitest"
import { CostCell } from "@llm4ts/flow/CostLedger"
import { IssueSummary } from "@llm4ts/flow/GitHubTool"
import {
  isEpicChild,
  parseEpicChildren,
  parseQa,
  parseTriage,
  prBody,
  renderInvoice
} from "../src/Prompts.ts"
import { Labels, attemptLabel, attemptOf, bounce } from "../src/Protocol.ts"

const issue = IssueSummary.make({
  number: 7,
  title: "Add a --version flag",
  body: "The CLI should print its version.",
  author: "ceo",
  labels: [],
  updatedAt: "2026-07-31T00:00:00Z"
})

describe("Prompts", () => {
  it("parses triage verdicts and treats anything else as unparseable", () => {
    const accept = parseTriage("Some preamble\nVERDICT: ACCEPT\n- prints semver\n- covered by test")
    assert.strictEqual(accept?.kind, "Accept")
    assert.include(accept !== undefined && accept.kind === "Accept" ? accept.criteria : "", "semver")

    const bounce = parseTriage("verdict: bounce\nWhich package version wins?")
    assert.strictEqual(bounce?.kind, "Bounce")
    assert.isUndefined(parseTriage("I think this looks fine."))
  })

  it("parses QA verdicts, tolerating markdown decoration", () => {
    assert.deepStrictEqual(parseQa("VERDICT: APPROVE\nLooks correct."), {
      kind: "Approve",
      summary: "Looks correct."
    })
    assert.strictEqual(parseQa("VERDICT: REJECT\nMissing test.")?.kind, "Reject")
    assert.strictEqual(parseQa("**VERDICT: APPROVE**\nSolid.")?.kind, "Approve")
    assert.strictEqual(parseQa("## Verdict: reject\nNo tests.")?.kind, "Reject")
    assert.strictEqual(parseTriage("**VERDICT: ACCEPT**\n- criteria")?.kind, "Accept")
    // Findings-first replies keep their payload; findings-free rejections
    // are no verdict at all.
    assert.deepStrictEqual(parseQa("The error type is wrong.\nVERDICT: REJECT"), {
      kind: "Reject",
      findings: "The error type is wrong."
    })
    // Same-line findings after an em-dash (the codex house style).
    assert.deepStrictEqual(
      parseQa("VERDICT: REJECT — The dashboard fetches fixtures the diff does not publish."),
      {
        kind: "Reject",
        findings: "The dashboard fetches fixtures the diff does not publish."
      }
    )
    assert.deepStrictEqual(
      parseQa("VERDICT: CLARIFY — is the EUR 500 minimum intended for sells too?"),
      {
        kind: "Clarify",
        questions: "is the EUR 500 minimum intended for sells too?"
      }
    )
    assert.isUndefined(parseQa("VERDICT: REJECT"))
    assert.isUndefined(parseQa("ship it"))
  })

  it("renders the invoice grouped by seat and the PR body with Closes", () => {
    const cells = [
      CostCell.make({
        stage: "task",
        agent: "coder",
        model: "m",
        prompt: 10,
        completion: 5,
        total: 15,
        costUsd: 0.5
      }),
      CostCell.make({
        stage: "plan",
        agent: "reasoning",
        model: "m",
        prompt: 4,
        completion: 2,
        total: 6,
        costUsd: 0.25
      }),
      CostCell.make({
        stage: "task2",
        agent: "coder",
        model: "m",
        prompt: 1,
        completion: 1,
        total: 2,
        costUsd: 0.25
      })
    ]
    const invoice = renderInvoice(cells, 5)
    assert.include(invoice, "| coder | 17 | $0.7500 |")
    assert.include(invoice, "| reasoning | 6 | $0.2500 |")
    assert.include(invoice, "Total: $1.0000 of $5.00 budget.")
    assert.include(renderInvoice([], 5), "(no usage reported)")

    const body = prBody(issue, {
      qaSummary: "Solid change.",
      taskTitles: ["Add kebabCase", "Cover kebabCase with tests"],
      commits: "abc123 add kebabCase",
      filesChanged: "src/strcase.js | 10 ++++",
      gateCommand: "npm run gate",
      invoice
    })
    assert.include(body, "Closes #7 — Add a --version flag.")
    assert.include(body, "- Add kebabCase")
    assert.include(body, "abc123 add kebabCase")
    assert.include(body, "`npm run gate`")
    assert.include(body, "Solid change.")
    assert.include(body, "### Invoice")

    const sparse = prBody(issue, {
      qaSummary: "",
      taskTitles: [],
      commits: "",
      filesChanged: "",
      gateCommand: undefined,
      invoice
    })
    assert.include(sparse, "approved without additional notes.")
    assert.include(sparse, "PR CI is the gate.")
  })

  it("parses epic decomposition replies into children", () => {
    const reply = [
      "CHILD: Domain schemas in lib/domain",
      "Deliverables: Position, Portfolio, MifidProfile schemas.",
      "Acceptance: npm run gate passes.",
      "**CHILD: Importers in lib/import**",
      "Deliverables: CSV and JSON importers.",
      "Acceptance: fixtures decode."
    ].join("\n")
    const children = parseEpicChildren(reply)
    assert.strictEqual(children?.length, 2)
    assert.strictEqual(children?.[0]?.title, "Domain schemas in lib/domain")
    assert.include(children?.[0]?.body, "Acceptance: npm run gate passes.")
    assert.strictEqual(children?.[1]?.title, "Importers in lib/import")
    assert.isUndefined(parseEpicChildren("I would split this into three parts."))
    assert.isUndefined(parseEpicChildren("CHILD: title only, no body"))
  })

  it("recognizes epic children and clears both queue markers on bounce", () => {
    assert.isTrue(isEpicChild("Do the thing.\n\nParent: #11 (epic)"))
    assert.isFalse(isEpicChild("Do the thing. See #11."))
    assert.deepStrictEqual([...bounce.remove], [Labels.ready, Labels.wip])
  })

  it("tracks attempts through labels", () => {
    assert.strictEqual(attemptOf([]), 0)
    assert.strictEqual(attemptOf(["factory:wip", attemptLabel(2)]), 2)
    assert.strictEqual(attemptOf([attemptLabel(1), attemptLabel(3)]), 3)
    assert.strictEqual(attemptLabel(1), "factory:attempt-1")
  })
})
