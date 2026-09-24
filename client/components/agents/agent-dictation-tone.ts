/**
 * Dictation waveform tone mapping. Levels come from the live microphone
 * analyser: `level` is the visual amplitude (0-1) used for bar height, and
 * `db` is the current RMS level in dBFS (0 = digital full scale). Tones map
 * to real-world headroom: neutral grey while no audio is detected, green
 * while there is comfortable headroom, yellow as the level approaches the
 * clipping zone, and red when peaks are within 8 dBFS of full scale — the
 * point where the recording is at extreme risk of distorting.
 */
export type DictationTone = 'neutral' | 'safe' | 'warn' | 'loud'

/** Amplitude below which bars stay neutral grey (no detected audio). */
export const DICTATION_NEUTRAL_LEVEL = 0.06

/** dBFS where the safe (green) range becomes a warning (yellow). */
export const DICTATION_WARN_DBFS = -20

/** dBFS where a recording is at extreme risk of exceeding full scale (red). */
export const DICTATION_LOUD_DBFS = -8

/** Fallback thresholds in level space when no dBFS source is available. */
export const DICTATION_WARN_LEVEL = 0.35
export const DICTATION_LOUD_LEVEL = 0.95

export const dictationTone = (level: number, db: number): DictationTone => {
  if (level < DICTATION_NEUTRAL_LEVEL) return 'neutral'
  if (Number.isFinite(db)) {
    if (db >= DICTATION_LOUD_DBFS) return 'loud'
    if (db >= DICTATION_WARN_DBFS) return 'warn'
    return 'safe'
  }
  if (level >= DICTATION_LOUD_LEVEL) return 'loud'
  if (level >= DICTATION_WARN_LEVEL) return 'warn'
  return 'safe'
}
