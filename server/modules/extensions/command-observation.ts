import { execFile, type ChildProcess } from 'node:child_process'

type CheckedCommand = 'git' | 'pandoc'
export type CommandObservationOutcome = 'usable' | 'missing' | 'unknown'

const commandArguments: Record<CheckedCommand, readonly ['--version']> = {
  git: ['--version'],
  pandoc: ['--version']
}
const observationTimeoutMs = 2_000
const killGraceMs = 100

/** Executes only fixed, no-input version commands and intentionally discards their output. */
export const observeBundledCommand = (command: CheckedCommand): Promise<CommandObservationOutcome> => {
  const { promise, resolve } = Promise.withResolvers<CommandObservationOutcome>()
  let settled = false
  let child: ChildProcess | undefined
  let escalation: NodeJS.Timeout | undefined

  const finish = (outcome: CommandObservationOutcome) => {
    if (settled) return
    settled = true
    clearTimeout(deadline)
    resolve(outcome)
  }
  const deadline = setTimeout(() => {
    child?.kill('SIGTERM')
    escalation = setTimeout(() => child?.kill('SIGKILL'), killGraceMs)
    finish('unknown')
  }, observationTimeoutMs)

  try {
    child = execFile(command, commandArguments[command], { maxBuffer: 1_024, windowsHide: true }, error => {
      clearTimeout(escalation)
      finish(!error ? 'usable' : error.code === 'ENOENT' ? 'missing' : 'unknown')
    })
  } catch (error) {
    finish((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown')
  }
  return promise
}
