import { makePlainTerminalSurface, type TerminalSurface } from "@llm4ts/runner/Terminal"

// Daemon-appropriate rendering: every runner activity line (task starts,
// tool calls, capability notes, retries) is written as a plain line with
// an ISO 8601 timestamp instead of a TTY spinner, so long operations show
// when they started and quiet periods are visibly quiet.
export const timestampedSurface = (): TerminalSurface =>
  makePlainTerminalSurface((line) =>
    process.stdout.write(`[${new Date().toISOString()}] ${line}\n`)
  )

// A ProcessError's `message` is only the command that was run; the reason it
// failed is in `detail`. Reporting the message alone leaves an operator
// staring at a 200-character `az` command line with nothing said about it —
// which is how a plain "command not found" reads as a mysterious query
// failure, and sends people off pasting the command into a shell to find out
// what the daemon already knew.
export const describeError = (error: { readonly message: string }): string => {
  const detail = "detail" in error ? String(error.detail).trim() : ""
  return detail.length === 0 ? error.message : `${error.message}\n  ↳ ${detail}`
}
