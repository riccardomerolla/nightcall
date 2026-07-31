import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { LedgerEntry, appendLedger, readLedger, spentToday } from "../src/Ledger.ts"

const entry = (at: string, costUsd: number): LedgerEntry =>
  LedgerEntry.make({ at, target: "acme/widgets", issue: 1, outcome: "Shipped", costUsd })

describe("Ledger", () => {
  it.effect("appends and reads back entries, skipping corrupt lines", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "nightcall-ledger-")))
      yield* appendLedger(dir, entry("2026-07-31T01:00:00Z", 1.5))
      yield* appendLedger(dir, entry("2026-07-31T02:00:00Z", 2))
      yield* Effect.promise(() =>
        import("node:fs/promises").then((fs) =>
          fs.appendFile(join(dir, "ledger.jsonl"), "not json\n", "utf8")
        )
      )
      const entries = yield* readLedger(dir)
      assert.strictEqual(entries.length, 2)
      assert.strictEqual(entries[1]?.costUsd, 2)
    })
  )

  it("sums only today's spend", () => {
    const entries = [
      entry("2026-07-30T23:00:00Z", 10),
      entry("2026-07-31T01:00:00Z", 1.5),
      entry("2026-07-31T09:00:00Z", 2)
    ]
    assert.strictEqual(spentToday(entries, "2026-07-31T12:00:00Z"), 3.5)
    assert.strictEqual(spentToday(entries, "2026-08-01T00:00:00Z"), 0)
  })

  it.effect("reads an empty ledger from a missing file", () =>
    Effect.gen(function* () {
      const entries = yield* readLedger("/nonexistent/nightcall")
      assert.deepStrictEqual(entries, [])
    })
  )
})
