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
      approved: true,
      findings: "Looks correct."
    })
    assert.strictEqual(parseQa("VERDICT: REJECT\nMissing test.")?.approved, false)
    assert.strictEqual(parseQa("**VERDICT: APPROVE**\nSolid.")?.approved, true)
    assert.strictEqual(parseQa("## Verdict: reject\nNo tests.")?.approved, false)
    assert.strictEqual(parseTriage("**VERDICT: ACCEPT**\n- criteria")?.kind, "Accept")
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

    const body = prBody(issue, "Solid change.", invoice)
    assert.include(body, "Closes #7.")
    assert.include(body, "Solid change.")
    assert.include(body, "### Invoice")
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
