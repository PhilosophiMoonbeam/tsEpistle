export interface LogoEffectDescriptor {
  readonly pipelineVersion: number
  readonly logoUrl: string
  readonly particleUrl: string
  readonly staticUrl: string
  readonly width: number
  readonly height: number
  readonly aspect: number
  readonly count: number
  readonly medianStroke: number
  readonly auraColor?: string
}
