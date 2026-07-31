import type { CostCell } from "@llm4ts/flow/CostLedger"
import type { IssueSummary } from "@llm4ts/flow/GitHubTool"

// Every prompt the company sends and every reply it parses, as pure
// functions. Verdicts use a single tagged line so parsing is a prefix
// scan, not an LLM call; an unparseable reply is treated conservatively
// by the caller (triage bounces, QA rejects).

export interface TriageAccept {
  readonly kind: "Accept"
  readonly criteria: string
}

export interface TriageBounce {
  readonly kind: "Bounce"
  readonly questions: string
}

export type Triage = TriageAccept | TriageBounce

export const triagePrompt = (issue: IssueSummary): string =>
  [
    "You are the Tech Lead of a small software company. Triage the",
    "following GitHub issue. Decide whether it is specified well enough",
    "for an engineer to implement without further input.",
    "",
    `Issue #${issue.number}: ${issue.title}`,
    "",
    issue.body.trim().length === 0 ? "(no body)" : issue.body,
    "",
    "The first line of your reply must be exactly one of:",
    "VERDICT: ACCEPT — followed by concise acceptance criteria as bullets, or",
    "VERDICT: BOUNCE — followed by the concrete questions the author must answer.",
    "No markdown decoration on the verdict line.",
    "Never propose code. Judge only whether the work is actionable."
  ].join("\n")

// Emphasis-tolerant: models bold or heading-ify the verdict line
// ("**VERDICT: APPROVE**", "## Verdict: reject"), so markdown decoration
// is stripped before matching.
const verdictRest = (reply: string, verdict: string): string | undefined => {
  const lines = reply.split(/\r?\n/)
  const index = lines.findIndex((line) =>
    line.replace(/[*_#>`]/g, "").trim().toUpperCase().startsWith(verdict)
  )
  return index === -1 ? undefined : lines.slice(index + 1).join("\n").trim()
}

export const parseTriage = (reply: string): Triage | undefined => {
  const accept = verdictRest(reply, "VERDICT: ACCEPT")
  if (accept !== undefined) {
    return { kind: "Accept", criteria: accept }
  }
  const bounce = verdictRest(reply, "VERDICT: BOUNCE")
  return bounce === undefined ? undefined : { kind: "Bounce", questions: bounce }
}

export interface EpicChild {
  readonly title: string
  readonly body: string
}

// Marker appended to every child body at creation; children carrying it
// were specified by the Tech Lead's decomposition and skip re-triage.
export const epicChildMarker = (parent: number): string => `Parent: #${parent} (epic)`

export const isEpicChild = (body: string): boolean => /Parent: #\d+ \(epic\)\s*$/.test(body.trim())

export const maxEpicChildren = 5

export const epicDecompositionPrompt = (issue: IssueSummary, handbook: string): string =>
  [
    "You are the Tech Lead of a small software company. The CEO marked the",
    "following GitHub issue as an epic. Decompose it into independently",
    `implementable child issues — at most ${maxEpicChildren}, in build order`,
    "(each child may depend only on earlier children).",
    "",
    `Epic #${issue.number}: ${issue.title}`,
    "",
    issue.body,
    "",
    "Format your reply as repeated blocks, nothing before the first block:",
    "CHILD: <one-line title>",
    "<the child issue body: concrete deliverables and acceptance criteria,",
    "including the verification command the epic requires>",
    "",
    "Rules: no markdown decoration on CHILD lines; every child must name",
    "concrete files/modules and testable acceptance criteria; never propose",
    "code. A child an engineer cannot finish in one sitting is too big.",
    "Children are worked strictly in the order you emit them: a later child",
    "may assume all earlier children are merged, and an earlier child must",
    "create everything later children need. Each child must be fully",
    "specified by its own body — never reference a child you do not emit,",
    "and never mark a child as blocked on anything outside this list.",
    ...(handbook.trim().length === 0 ? [] : ["", "Company handbook:", handbook])
  ].join("\n")

export const parseEpicChildren = (reply: string): ReadonlyArray<EpicChild> | undefined => {
  const children: Array<{ title: string; lines: Array<string> }> = []
  for (const line of reply.split(/\r?\n/)) {
    const cleaned = line.replace(/[*_#>`]/g, "").trim()
    if (cleaned.toUpperCase().startsWith("CHILD:")) {
      children.push({ title: cleaned.slice("CHILD:".length).trim(), lines: [] })
    } else if (children.length > 0) {
      children[children.length - 1]?.lines.push(line)
    }
  }
  const parsed = children
    .map((child) => ({ title: child.title, body: child.lines.join("\n").trim() }))
    .filter((child) => child.title.length > 0 && child.body.length > 0)
  return parsed.length === 0 ? undefined : parsed
}

export const engineerBrief = (
  issue: IssueSummary,
  criteria: string,
  handbook: string
): string =>
  [
    `Implement GitHub issue #${issue.number}: ${issue.title}`,
    "",
    issue.body,
    "",
    "Acceptance criteria from the Tech Lead:",
    criteria.trim().length === 0 ? "(none beyond the issue text)" : criteria,
    ...(handbook.trim().length === 0 ? [] : ["", "Company handbook:", handbook])
  ].join("\n")

export interface QaVerdict {
  readonly approved: boolean
  readonly findings: string
}

export const qaPrompt = (issue: IssueSummary, criteria: string, diff: string): string =>
  [
    "You are the QA reviewer of a small software company, seeing this",
    "change for the first time. Review the diff against the issue and the",
    "acceptance criteria. Judge correctness and scope only — style nits",
    "are not rejection grounds.",
    "",
    `Issue #${issue.number}: ${issue.title}`,
    "",
    "Acceptance criteria:",
    criteria.trim().length === 0 ? "(none beyond the issue text)" : criteria,
    "",
    "Diff:",
    "```diff",
    diff,
    "```",
    "",
    "The first line of your reply must be exactly one of:",
    "VERDICT: APPROVE — followed by a one-paragraph review summary, or",
    "VERDICT: REJECT — followed by the concrete findings that must be fixed.",
    "No markdown decoration on the verdict line."
  ].join("\n")

export const parseQa = (reply: string): QaVerdict | undefined => {
  const approve = verdictRest(reply, "VERDICT: APPROVE")
  if (approve !== undefined) {
    return { approved: true, findings: approve }
  }
  const reject = verdictRest(reply, "VERDICT: REJECT")
  return reject === undefined ? undefined : { approved: false, findings: reject }
}

const cost = (cell: CostCell): number => cell.costUsd ?? 0

export const renderInvoice = (
  cells: ReadonlyArray<CostCell>,
  budgetUsd: number
): string => {
  const byAgent = new Map<string, { tokens: number; costUsd: number }>()
  for (const cell of cells) {
    const row = byAgent.get(cell.agent) ?? { tokens: 0, costUsd: 0 }
    byAgent.set(cell.agent, {
      tokens: row.tokens + cell.total,
      costUsd: row.costUsd + cost(cell)
    })
  }
  const total = [...byAgent.values()].reduce((sum, row) => sum + row.costUsd, 0)
  const lines = [...byAgent.entries()].map(
    ([agent, row]) => `| ${agent} | ${row.tokens} | $${row.costUsd.toFixed(4)} |`
  )
  return [
    "### Invoice",
    "",
    "| Seat | Tokens | Cost |",
    "| --- | --- | --- |",
    ...(lines.length === 0 ? ["| (no usage reported) | 0 | $0.0000 |"] : lines),
    "",
    `Total: $${total.toFixed(4)} of $${budgetUsd.toFixed(2)} budget.`
  ].join("\n")
}

export const prBody = (issue: IssueSummary, qaSummary: string, invoice: string): string =>
  [
    `Closes #${issue.number}.`,
    "",
    "QA review:",
    qaSummary.trim().length === 0 ? "(approved without notes)" : qaSummary,
    "",
    invoice
  ].join("\n")
