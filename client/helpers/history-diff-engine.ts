import { createPatch } from 'diff'
import * as Diff2Html from 'diff2html'
import {
  COMPARISON_TIMEOUT_MS,
  countLines,
  exceedsComparisonInputLimits,
  type HistoryDiffFormat,
  type HistoryDiffOutcome,
  type HistoryDiffRequest,
  type HistoryPatchResult,
  MAX_COMPARISON_EDITS,
  MAX_MATCHED_PATCH_LINES,
  MAX_RENDERED_PATCH_LINES
} from './history-diff.ts'

// The diff libraries live here so that only the worker (and the rare
// main-thread fallback, loaded on demand) pulls them in.
export const computeHistoryPatch = (path: string, source: string, target: string): HistoryPatchResult => {
  if (source === target) return { status: 'empty' }
  if (exceedsComparisonInputLimits(source, target)) return { status: 'limit' }
  try {
    const patch = createPatch(`/${path}`, source, target, undefined, undefined, {
      timeout: COMPARISON_TIMEOUT_MS,
      maxEditLength: MAX_COMPARISON_EDITS
    })
    if (patch === undefined) return { status: 'limit' }
    const lines = countLines(patch)
    if (lines > MAX_RENDERED_PATCH_LINES) return { status: 'limit' }
    return { status: 'patch', patch, lines }
  } catch {
    return { status: 'failed' }
  }
}

export const renderHistoryPatch = (patch: string, lines: number, format: HistoryDiffFormat): HistoryDiffOutcome => {
  try {
    const matched = lines <= MAX_MATCHED_PATCH_LINES
    return {
      status: 'ready',
      html: Diff2Html.html(patch, {
        drawFileList: false,
        matching: matched ? 'lines' : 'none',
        matchingMaxComparisons: 100,
        maxLineLengthHighlight: matched ? 500 : 0,
        outputFormat: format
      })
    }
  } catch {
    return { status: 'failed' }
  }
}

const PATCH_CACHE_SIZE = 6

/**
 * Computes comparison outcomes and keeps a small cache of patches by content
 * key, so a format change only renders the markup again.
 */
export const createHistoryDiffEngine = () => {
  const patches = new Map<string, HistoryPatchResult>()
  return (request: HistoryDiffRequest): HistoryDiffOutcome => {
    let patch = patches.get(request.key)
    if (patch) {
      patches.delete(request.key)
    } else {
      patch = computeHistoryPatch(request.path, request.source, request.target)
    }
    patches.set(request.key, patch)
    while (patches.size > PATCH_CACHE_SIZE) {
      const oldest = patches.keys().next().value
      if (oldest === undefined) break
      patches.delete(oldest)
    }
    if (patch.status !== 'patch') return { status: patch.status }
    return renderHistoryPatch(patch.patch, patch.lines, request.format)
  }
}
