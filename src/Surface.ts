import { makePlainTerminalSurface, type TerminalSurface } from "@llm4ts/runner/Terminal"

// Daemon-appropriate rendering: every runner activity line (task starts,
// tool calls, capability notes, retries) is written as a plain line with
// an ISO 8601 timestamp instead of a TTY spinner, so long operations show
// when they started and quiet periods are visibly quiet.
export const timestampedSurface = (): TerminalSurface =>
  makePlainTerminalSurface((line) =>
    process.stdout.write(`[${new Date().toISOString()}] ${line}\n`)
  )
