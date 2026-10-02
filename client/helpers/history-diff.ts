// Comparison limits. They bound the work done for one comparison so that a
// very large or wholly rewritten page cannot freeze or exhaust the tab. The
// same limits apply in the worker and in the main-thread fallback.
export const MAX_COMPARISON_CHARACTERS = 1_000_000
export const MAX_COMPARISON_LINES = 100_000
export const COMPARISON_TIMEOUT_MS = 150
export const MAX_COMPARISON_EDITS = 2_000
export const MAX_RENDERED_PATCH_LINES = 4_000
export const MAX_MATCHED_PATCH_LINES = 200

export type HistoryDiffFormat = 'line-by-line' | 'side-by-side'

export type HistoryDiffRequest = {
  /** Stable identity of the compared contents, for example `12:0`. */
  readonly key: string
  readonly path: string
  readonly source: string
  readonly target: string
  readonly format: HistoryDiffFormat
}

/**
 * `ready` carries rendered diff2html markup. `empty` means both sides hold the
 * same text. `limit` means the comparison exceeds a safety limit. `failed`
 * means the diff library threw. `timeout` means the worker did not answer in
 * time and was stopped.
 */
export type HistoryDiffOutcome =
  | { readonly status: 'ready', readonly html: string }
  | { readonly status: 'empty' }
  | { readonly status: 'limit' }
  | { readonly status: 'failed' }
  | { readonly status: 'timeout' }

export type HistoryPatchResult =
  | { readonly status: 'patch', readonly patch: string, readonly lines: number }
  | { readonly status: 'empty' }
  | { readonly status: 'limit' }
  | { readonly status: 'failed' }

export const countLines = (value: string): number => {
  if (value.length === 0) return 0
  let lines = 1
  let index = value.indexOf('\n')
  while (index !== -1) {
    lines += 1
    index = value.indexOf('\n', index + 1)
  }
  return lines
}

/** Cheap input check. Run it before a large text is copied to a worker. */
export const exceedsComparisonInputLimits = (source: string, target: string): boolean => {
  if (source.length + target.length > MAX_COMPARISON_CHARACTERS) return true
  return countLines(source) + countLines(target) > MAX_COMPARISON_LINES
}
