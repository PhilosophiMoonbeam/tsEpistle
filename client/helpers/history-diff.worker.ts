import type { HistoryDiffOutcome, HistoryDiffRequest } from './history-diff.ts'
import { createHistoryDiffEngine } from './history-diff-engine.ts'

// Page history comparisons run here so that a large diff never blocks the
// page. The worker holds no credentials and makes no requests. It receives
// two texts and returns diff2html markup or a limit status.
type WorkerMessage = { readonly id: number, readonly request: HistoryDiffRequest }
type WorkerScope = {
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerMessage>) => void): void
  postMessage(message: { readonly id: number, readonly outcome: HistoryDiffOutcome }): void
}

const scope = self as unknown as WorkerScope
const compare = createHistoryDiffEngine()

scope.addEventListener('message', event => {
  const { id, request } = event.data
  let outcome: HistoryDiffOutcome
  try {
    outcome = compare(request)
  } catch {
    outcome = { status: 'failed' }
  }
  scope.postMessage({ id, outcome })
})
