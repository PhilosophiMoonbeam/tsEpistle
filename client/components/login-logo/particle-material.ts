import {
  BufferAttribute,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  NormalBlending,
  SpriteNodeMaterial,
  SRGBColorSpace,
  StaticDrawUsage
} from 'three/webgpu'
import {
  If,
  Fn,
  attribute,
  float,
  length,
  mix,
  positionGeometry,
  smoothstep,
  vec2,
  vec3,
  vec4,
  workingToColorSpace
} from 'three/tsl'
import type { Node, Vector2, Vector4 } from 'three/webgpu'

import { CLOUD_BEAD_FRACTION, CLOUD_DUST_FRACTION } from './particle-cloud'
import type { ParticleCloud } from './particle-cloud'
import type { ParsedLogoParticles } from './particle-logo'

type ParticleUniform<TNodeType extends string, TValue> = Node<TNodeType> & { value: TValue }

const CLOUD_BEAD_START = 1 - CLOUD_BEAD_FRACTION
const CLOUD_DUST_END = CLOUD_DUST_FRACTION
export interface ParticleNodeUniforms {
  readonly aspectRatio: ParticleUniform<'float', number>
  readonly pixelRatio: ParticleUniform<'float', number>
  readonly brushPositionRadius: ParticleUniform<'vec4', Vector4>
  readonly brushDirection: ParticleUniform<'vec2', Vector2>
  readonly explosionPositionAge: readonly ParticleUniform<'vec4', Vector4>[]
  readonly medianStroke: ParticleUniform<'float', number>
  readonly renderedLongAxis: ParticleUniform<'float', number>
  readonly elapsedSeconds: ParticleUniform<'float', number>
  readonly viewportSize: ParticleUniform<'vec2', Vector2>
}

type ParticleColorInput = BufferAttribute | Float32Array

/** Build the single indexed quad and its source-order per-particle attributes. */
export const createParticleSpriteGeometry = (
  particles: ParsedLogoParticles,
  cloud: ParticleCloud,
  particleColor: ParticleColorInput
): { geometry: InstancedBufferGeometry; cloudMotion: InstancedBufferAttribute } => {
  const geometry = new InstancedBufferGeometry()
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(
      new Float32Array([
        -0.5, -0.5, 0,
        0.5, -0.5, 0,
        0.5, 0.5, 0,
        -0.5, 0.5, 0
      ]),
      3
    )
  )
  geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1))

  const physical = new Uint8Array(particles.count)
  for (const index of cloud.indices) physical[index] = 1

  const logoParameters = new Float32Array(particles.count * 4)
  for (let index = 0; index < particles.count; index += 1) {
    const offset = index * 4
    logoParameters[offset] = particles.depth[index]! / 127
    logoParameters[offset + 1] = particles.size[index]! / 255
    logoParameters[offset + 2] = particles.seed[index]! / 65535
    logoParameters[offset + 3] = physical[index]!
  }

  geometry.setAttribute('logoXY', new InstancedBufferAttribute(particles.xy, 2, true))
  geometry.setAttribute('logoParameters', new InstancedBufferAttribute(logoParameters, 4, false))

  const colors = particleColor instanceof Float32Array ? particleColor : particleColor.array
  if (!(colors instanceof Float32Array)) throw new Error('Particle colors must use Float32Array storage')
  const colorAttribute = particleColor instanceof InstancedBufferAttribute &&
    particleColor.itemSize === 4 &&
    particleColor.normalized === false &&
    particleColor.array instanceof Float32Array
    ? particleColor
    : new InstancedBufferAttribute(colors, 4, false)
  geometry.setAttribute('particleColor', colorAttribute)

  const cloudMotion = new InstancedBufferAttribute(cloud.motion, 2, false)
  cloudMotion.setUsage(cloud.count > 0 ? DynamicDrawUsage : StaticDrawUsage)
  geometry.setAttribute('cloudMotion', cloudMotion)
  geometry.instanceCount = particles.count

  return { geometry, cloudMotion }
}

const createExplosionDisplacement = (
  uniforms: ParticleNodeUniforms,
  basePosition: Node<'vec2'>,
  safeViewport: Node<'vec2'>,
  phase: Node<'float'>,
  depth: Node<'float'>,
  logoSeed: Node<'float'>
): Node<'vec2'> => Fn(() => {
  const displacement = vec2(0).toVar('explosionTotal')
  for (let explosionIndex = 0; explosionIndex < 6; explosionIndex += 1) {
    const positionAge = uniforms.explosionPositionAge[explosionIndex]!
    If(positionAge.w.greaterThan(0), () => {
      const ageSeconds = positionAge.z.clamp(0, 2.8)
      const localCss = basePosition.sub(positionAge.xy).mul(0.5).mul(safeViewport)
      const distanceCss = length(localCss)
      const radiusCss = uniforms.renderedLongAxis.mul(0.30).clamp(100, 240).mul(positionAge.w)
      const influence = float(1).sub(smoothstep(0, radiusCss, distanceCss))
      const radial = vec2(phase.cos(), phase.sin()).toVar(`explosionRadial${explosionIndex}`)
      If(distanceCss.greaterThan(0.001), () => radial.assign(localCss.div(distanceCss)))
      const tangent = vec2(radial.y.negate(), radial.x)
      const attack = float(1).sub(ageSeconds.mul(-12).exp())
      const recovery = float(1).sub(smoothstep(0.30, 2.8, ageSeconds))
      const travel = radiusCss.mul(influence).mul(attack).mul(recovery)
      const burstDirection = radial.mul(
        float(0.75).add(float(0.55).mul(logoSeed.mul(13).fract()))
      ).add(tangent.mul(float(0.32).mul(ageSeconds.mul(2.4).add(depth).sin())))
      displacement.addAssign(burstDirection.mul(travel))

    })
  }
  return displacement
}).setLayout({
  name: 'logoExplosionDisplacement',
  type: 'vec2',
  inputs: []
})()
const createVertexState = (uniforms: ParticleNodeUniforms) => {
  const logoXY = attribute<'vec2'>('logoXY', 'vec2')
  const logoParameters = attribute<'vec4'>('logoParameters', 'vec4')
  const cloudMotion = attribute<'vec2'>('cloudMotion', 'vec2')

  const safeViewport = uniforms.viewportSize.max(vec2(1)).toVar('safeViewport')
  const viewportAspect = safeViewport.x.div(safeViewport.y)
  const wideViewport = viewportAspect.greaterThanEqual(uniforms.aspectRatio)
  const fit = vec2(
    wideViewport.select(uniforms.aspectRatio.div(viewportAspect), 1),
    wideViewport.select(1, viewportAspect.div(uniforms.aspectRatio))
  )
  const basePosition = logoXY.mul(fit).toVar('basePosition')

  const depth = logoParameters.x.clamp(-1, 1).toVar('depth')
  const depthScale = float(1).add(float(0.18).mul(depth)).clamp(0.82, 1.18).toVar('depthScale')
  const displayedStroke = uniforms.medianStroke.mul(uniforms.renderedLongAxis).div(1024).toVar('displayedStroke')
  const idleAmplitudeCss = float(0.50).mul(displayedStroke).clamp(3.5, 10).toVar('idleAmplitudeCss')
  const sourcePosition = vec2(logoXY.x.mul(uniforms.aspectRatio), logoXY.y)
  const spatialPhase = vec2(
    sourcePosition.dot(vec2(2.15, 1.10)).add(float(1.35).mul(depth)),
    sourcePosition.dot(vec2(-1.25, 2.30)).sub(float(1.10).mul(depth))
  ).toVar('spatialPhase')
  const coherentFlowUnnormalized = vec2(
    spatialPhase.x.add(uniforms.elapsedSeconds.mul(0.46)).sin().add(
      spatialPhase.y.mul(0.71).sub(uniforms.elapsedSeconds.mul(0.21)).sin().mul(0.34)
    ),
    spatialPhase.y.add(uniforms.elapsedSeconds.mul(0.39)).cos().add(
      spatialPhase.x.mul(0.67).add(uniforms.elapsedSeconds.mul(0.18)).cos().mul(0.34)
    )
  ).div(1.34)
  const coherentFlow = coherentFlowUnnormalized.div(
    length(coherentFlowUnnormalized).max(1)
  ).toVar('coherentFlow')
  const idleScaleCss = idleAmplitudeCss.mul(depthScale).clamp(3.5, 10).toVar('idleScaleCss')
  const idleWarmup = smoothstep(0, 1, uniforms.elapsedSeconds)
  const phase = logoParameters.z.mul(6.28318530718).toVar('phase')
  const wander = mix(1.4, 9.0, logoParameters.z.mul(17).fract())
  const orbit = vec2(
    phase.add(uniforms.elapsedSeconds.mul(0.37)).sin(),
    phase.mul(1.7).add(uniforms.elapsedSeconds.mul(0.31)).cos()
  )
  const idleCss = coherentFlow.mul(idleScaleCss).add(orbit.mul(wander)).mul(idleWarmup).toVar('idleCss')

  const explosionCss = createExplosionDisplacement(
    uniforms,
    basePosition,
    safeViewport,
    phase,
    depth,
    logoParameters.z
  ).toVar('explosionCss')
  const cursorCss = Fn(() => {
    const displacement = vec2(0).toVar('cursorCss')
    const brushActive = uniforms.brushPositionRadius.w.greaterThan(0.01)
      .and(logoParameters.w.lessThan(0.5))
    If(brushActive, () => {
      const localCss = basePosition.sub(uniforms.brushPositionRadius.xy).mul(0.5).mul(safeViewport)
        .add(idleCss).add(explosionCss)
      const distanceCss = length(localCss)
      const radiusCss = uniforms.brushPositionRadius.z
      const influence = float(1).sub(smoothstep(0, radiusCss, distanceCss))
      const outward = localCss.div(localCss.dot(localCss).add(64).sqrt())
      const tangent = vec2(outward.y.negate(), outward.x)
      const response = mix(0.55, 1.0, logoParameters.z.mul(23).fract())
      displacement.assign(
        outward.mul(0.85).add(uniforms.brushDirection.mul(0.45)).add(
          tangent.mul(float(0.16).mul(phase.sin()))
        ).mul(influence).mul(uniforms.brushPositionRadius.w).mul(response)
      )
    })
    return displacement
  }).setLayout({
    name: 'logoCursorDisplacement',
    type: 'vec2',
    inputs: []
  })()
  const displacement = mix(
    idleCss.add(cursorCss).add(explosionCss),
    cloudMotion,
    logoParameters.w
  ).toVar('displacement')
  const position = basePosition.add(displacement.mul(2).div(safeViewport)).toVar('position')
  const ndcPosition = position.abs()
  const lifecycle = float(1).sub(
    smoothstep(0.94, 1.02, ndcPosition.x.max(ndcPosition.y))
  ).toVar('lifecycle')

  const dustSize = mix(4, 8, logoParameters.z.div(CLOUD_DUST_END))
  const moteSize = mix(
    8,
    12,
    logoParameters.z.sub(CLOUD_DUST_END).div(CLOUD_BEAD_START - CLOUD_DUST_END)
  )
  const beadSize = mix(
    13,
    20,
    logoParameters.z.sub(CLOUD_BEAD_START).div(1 - CLOUD_BEAD_START)
  )
  const diameter = logoParameters.z.lessThan(CLOUD_DUST_END).select(
    dustSize,
    logoParameters.z.lessThan(CLOUD_BEAD_START).select(moteSize, beadSize)
  ).toVar('diameter')
  const sourceCoverage = mix(0.65, 1.0, logoParameters.y)
  const coreCssPixels = diameter.mul(sourceCoverage).mul(depthScale).mul(uniforms.renderedLongAxis)
    .div(1024).min(22)
  const coreDevicePixels = coreCssPixels.mul(uniforms.pixelRatio).max(1.25).toVar('coreDevicePixels')
  const pointSize = coreDevicePixels.add(2).toVar('pointSize')
  const scale = vec2(
    pointSize.mul(2).div(safeViewport.x.mul(uniforms.pixelRatio)),
    pointSize.mul(2).div(safeViewport.y.mul(uniforms.pixelRatio))
  ).toVar('spriteScale')
  const halfPixel = float(1).div(pointSize).toVar('halfPixel')
  const coreRatio = coreDevicePixels.div(pointSize).toVar('coreRatio')
  const bead = smoothstep(0.70, 0.98, logoParameters.z).toVar('bead')

  const positionNode = vec3(position, depth.mul(0.04))
  return { bead, coreRatio, halfPixel, lifecycle, position, positionNode, scale }
}

/** Build the one-draw sprite material and its immutable TSL graph. */
export const createParticleSpriteMaterial = (uniforms: ParticleNodeUniforms): SpriteNodeMaterial => {
  const state = createVertexState(uniforms)
  const lifecycle = state.lifecycle.toVarying('particleLifecycle')
  const halfPixel = state.halfPixel.toVarying('particleHalfPixel')
  const coreRatio = state.coreRatio.toVarying('particleCoreRatio')
  const bead = state.bead.toVarying('particleBead')
  const particleColor = attribute<'vec4'>('particleColor', 'vec4')

  const material = new SpriteNodeMaterial()
  material.positionNode = state.positionNode
  material.scaleNode = state.scale
  material.fragmentNode = Fn(() => {
    const uv = positionGeometry.xy.mul(2).div(coreRatio)
    const r2 = uv.dot(uv).toVar('particleR2')
    r2.greaterThan(1).discard()
    const coverage = float(1).sub(smoothstep(float(1).sub(float(3).mul(halfPixel)), 1, r2))
    const color = particleColor.rgb.toVar('particleColor')

    If(bead.greaterThan(0), () => {
      const z = float(1).sub(r2).max(0).sqrt()
      const normal = vec3(uv, z)
      const diffuse = normal.dot(vec3(-0.38, -0.46, 0.80)).clamp(0, 1)
      const glint = normal.dot(vec3(-0.30, -0.36, 0.884)).max(0).pow(22)
      const k = mix(1.0, float(0.55).add(float(0.65).mul(diffuse)), bead)
        .add(float(0.38).mul(glint).mul(bead))
      const maxChannel = color.r.max(color.g.max(color.b))
      color.mulAssign(k.div(float(1).max(k.mul(maxChannel))))
    })

    return workingToColorSpace(
      vec4(color, particleColor.a.mul(lifecycle).mul(coverage)),
      SRGBColorSpace
    )
  }).setLayout({
    name: 'logoParticleFragment',
    type: 'vec4',
    inputs: []
  })()
  material.blending = NormalBlending
  material.transparent = true
  material.depthTest = false
  material.depthWrite = false
  material.premultipliedAlpha = false
  material.toneMapped = false
  material.fog = false
  return material
}
