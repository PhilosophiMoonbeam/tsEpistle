// Retain the selected reasoning policy independently of optimized prompt text.
// Changed source contracts must not restore obsolete calibrated descriptions.
export const WIKI_SYNTHESIS_CALIBRATION = {
  transportKind: 'gemini-api',
  model: 'gemini-3.8-flash',
  reasoningEffort: 'low'
} as const
