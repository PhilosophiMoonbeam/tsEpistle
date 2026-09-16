export const LOGO_POINTER_EXPLOSION_CAPACITY = 6
export const LOGO_POINTER_EXPLOSION_MIN_SCALE = 0.9
export const LOGO_POINTER_EXPLOSION_MAX_SCALE = 1.45
export const LOGO_POINTER_EXPLOSION_HOLD_SECONDS = 0.35
export const LOGO_POINTER_EXPLOSION_REFILL_SECONDS = 2.4
export const LOGO_POINTER_EXPLOSION_RECOVERY_END_SECONDS = 2.75
export const LOGO_POINTER_EXPLOSION_LIFETIME_SECONDS = 2.8

const smoothstepScalar = (edge0: number, edge1: number, value: number): number => {
  if (!(edge1 > edge0) || !Number.isFinite(value)) return 0
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Shared finite displacement envelope. It is exactly zero at and after recovery end. */
export const explosionEnvelope = (ageSeconds: number): number => {
  if (!Number.isFinite(ageSeconds) || ageSeconds <= 0 || ageSeconds >= LOGO_POINTER_EXPLOSION_RECOVERY_END_SECONDS) return 0
  return (
    smoothstepScalar(0, LOGO_POINTER_EXPLOSION_HOLD_SECONDS, ageSeconds) *
    (1 - smoothstepScalar(LOGO_POINTER_EXPLOSION_HOLD_SECONDS, LOGO_POINTER_EXPLOSION_RECOVERY_END_SECONDS, ageSeconds))
  )
}

/** Add one slot's CSS displacement to a preallocated output pair. */
export const addExplosionDisplacement = (
  output: Float32Array,
  outputOffset: number,
  baseX: number,
  baseY: number,
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  renderedLongAxis: number,
  depth: number,
  seed: number,
  scale: number,
  ageSeconds: number
): void => {
  const envelope = explosionEnvelope(ageSeconds)
  if (envelope <= 0) return
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 1
  const localX = baseX - centerX * safeWidth * 0.5
  const localY = baseY - centerY * safeHeight * 0.5
  const distance = Math.hypot(localX, localY)
  const safeAxis = Number.isFinite(renderedLongAxis) ? Math.max(0, renderedLongAxis) : 0
  const safeScale = Number.isFinite(scale) ? Math.max(LOGO_POINTER_EXPLOSION_MIN_SCALE, Math.min(LOGO_POINTER_EXPLOSION_MAX_SCALE, scale)) : 1
  const radius = Math.max(100, Math.min(240, safeAxis * 0.3)) * safeScale
  const influence = 1 - smoothstepScalar(0, radius, distance)
  if (!(influence > 0)) return
  const normalization = Math.sqrt(localX * localX + localY * localY + 1)
  const radialX = localX / normalization
  const radialY = localY / normalization
  const tangentX = -radialY
  const tangentY = radialX
  const safeSeed = Number.isFinite(seed) ? seed : 0
  const safeDepth = Number.isFinite(depth) ? depth : 0
  const burst = 0.75 + 0.55 * (safeSeed * 13 - Math.floor(safeSeed * 13))
  const tangent = 0.32 * Math.sin(2.4 * Math.max(0, ageSeconds) + safeDepth)
  const travel = radius * influence * envelope
  output[outputOffset] = (output[outputOffset] ?? 0) + (radialX * burst + tangentX * tangent) * travel
  output[outputOffset + 1] = (output[outputOffset + 1] ?? 0) + (radialY * burst + tangentY * tangent) * travel
}
