precision highp float;

attribute vec2 logoXY;
attribute vec3 cloudMotion;
attribute float logoDepth;
attribute vec4 logoColor;
attribute float logoSize;
attribute float logoSeed;

uniform float uAspect;
uniform vec3 uBackground;
uniform float uDpr;
uniform vec4 uImpulseDirectionTravel[6];
uniform vec4 uImpulsePositionAge[6];
uniform vec4 uExplosionPositionAge[6];
uniform float uMedianStroke;
uniform float uRenderedLongAxis;
uniform float uTime;
uniform vec2 uViewport;

varying vec4 vColor;
varying float vBead;
varying float vCoreRatio;
varying float vLifecycle;
varying float vHalfPixel;

vec3 srgbToLinear(vec3 value) {
  vec3 lower = value / 12.92;
  vec3 higher = pow((value + 0.055) / 1.055, vec3(2.4));
  return mix(lower, higher, step(vec3(0.04045), value));
}

float contrastRatio(float first, float second) {
  float lighter = max(first, second);
  float darker = min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

void main() {
  vec2 safeViewport = max(uViewport, vec2(1.0));
  float viewportAspect = safeViewport.x / safeViewport.y;
  vec2 fit = viewportAspect >= uAspect
    ? vec2(uAspect / viewportAspect, 1.0)
    : vec2(1.0, viewportAspect / uAspect);
  vec2 basePosition = logoXY * fit;

  float depth = clamp(logoDepth, -1.0, 1.0);
  float depthScale = clamp(1.0 + 0.18 * depth, 0.82, 1.18);
  float displayedStroke = uMedianStroke * uRenderedLongAxis / 1024.0;
  float idleAmplitudeCss = clamp(0.50 * displayedStroke, 3.5, 10.0);
  vec2 sourcePosition = vec2(logoXY.x * uAspect, logoXY.y);
  vec2 spatialPhase = vec2(
    dot(sourcePosition, vec2(2.15, 1.10)) + 1.35 * depth,
    dot(sourcePosition, vec2(-1.25, 2.30)) - 1.10 * depth
  );
  vec2 coherentFlow = vec2(
    sin(spatialPhase.x + 0.46 * uTime) + 0.34 * sin(0.71 * spatialPhase.y - 0.21 * uTime),
    cos(spatialPhase.y + 0.39 * uTime) + 0.34 * cos(0.67 * spatialPhase.x + 0.18 * uTime)
  ) / 1.34;
  float coherentFlowMagnitude = length(coherentFlow);
  coherentFlow /= max(coherentFlowMagnitude, 1.0);
  float idleScaleCss = clamp(idleAmplitudeCss * depthScale, 3.5, 10.0);
  float idleWarmup = smoothstep(0.0, 1.0, uTime);
  // Independent orbits break the sampling grid; a coherent current keeps the cloud legible.
  float phase = logoSeed * 6.28318530718;
  float wander = mix(1.4, 9.0, fract(logoSeed * 17.0));
  vec2 orbit = vec2(sin(phase + uTime * 0.37), cos(phase * 1.7 + uTime * 0.31));
  vec2 idleCss = (coherentFlow * idleScaleCss + orbit * wander) * idleWarmup;

  vec2 cursorCss = vec2(0.0);
  for (int impulseIndex = 0; impulseIndex < 6; impulseIndex++) {
    vec4 positionAge = uImpulsePositionAge[impulseIndex];
    vec4 directionTravel = uImpulseDirectionTravel[impulseIndex];
    if (positionAge.w <= 0.0 || directionTravel.z <= 0.0) continue;

    float strength = clamp(positionAge.w, 0.9, 3.2);
    float ageSeconds = clamp(positionAge.z, 0.0, 1.4);
    vec2 localCss = (basePosition - positionAge.xy) * 0.5 * safeViewport;
    float distanceCss = length(localCss);
    float radiusCss = clamp(directionTravel.w, 18.0, 72.0);
    float primaryFalloff = 1.0 - smoothstep(0.16 * radiusCss, radiusCss, distanceCss);
    float annulusFalloff = smoothstep(0.42 * radiusCss, radiusCss, distanceCss)
      * (1.0 - smoothstep(radiusCss, 2.35 * radiusCss, distanceCss));
    float attack = smoothstep(0.0, 0.035, ageSeconds);
    float kickFade = 1.0 - smoothstep(0.38, 0.92, ageSeconds);
    float settle = smoothstep(0.48, 0.84, ageSeconds)
      * (1.0 - smoothstep(0.92, 1.26, ageSeconds));
    vec2 inputDirection = directionTravel.xy / max(length(directionTravel.xy), 0.000001);
    vec2 outwardDirection = distanceCss > 0.000001
      ? localCss / distanceCss
      : vec2(cos(6.28318530718 * logoSeed), sin(6.28318530718 * logoSeed));
    vec2 tangentDirection = vec2(-outwardDirection.y, outwardDirection.x);
    float turbulence = sin(6.28318530718 * logoSeed + 5.4 * ageSeconds);
    vec2 disruptiveKick =
      inputDirection * (0.72 * primaryFalloff + 0.20 * annulusFalloff)
      + outwardDirection * (0.90 * primaryFalloff + 0.72 * annulusFalloff)
      + tangentDirection * (0.22 + 0.18 * turbulence) * annulusFalloff;
    vec2 restorativePull =
      inputDirection * 0.48 * primaryFalloff
      + outwardDirection * (0.72 * primaryFalloff + 0.56 * annulusFalloff);
    cursorCss += strength * directionTravel.z * (
      disruptiveKick * attack * kickFade
      - restorativePull * settle
    );
  }
  float cursorMagnitude = length(cursorCss);
  cursorCss *= cursorMagnitude > 42.0 ? 42.0 / cursorMagnitude : 1.0;

  vec2 explosionCss = vec2(0.0);
  for (int explosionIndex = 0; explosionIndex < 6; explosionIndex++) {
    vec4 positionAge = uExplosionPositionAge[explosionIndex];
    if (positionAge.w < 0.5) continue;

    float ageSeconds = clamp(positionAge.z, 0.0, 2.8);
    vec2 localCss = (basePosition - positionAge.xy) * 0.5 * safeViewport;
    float distanceCss = length(localCss);
    float radiusCss = clamp(0.30 * uRenderedLongAxis, 100.0, 240.0);
    float influence = 1.0 - smoothstep(0.0, radiusCss, distanceCss);
    vec2 radial = distanceCss > 0.001 ? localCss / distanceCss : vec2(cos(phase), sin(phase));
    vec2 tangent = vec2(-radial.y, radial.x);
    // An expanding, twisting burst with a damped return. Particles keep their identity.
    float attack = 1.0 - exp(-12.0 * ageSeconds);
    float recovery = 1.0 - smoothstep(0.30, 2.8, ageSeconds);
    float travel = radiusCss * influence * attack * recovery;
    explosionCss += (radial * (0.75 + 0.55 * fract(logoSeed * 13.0))
      + tangent * 0.32 * sin(ageSeconds * 2.4 + depth)) * travel;
  }
  vec2 displacement = mix(idleCss + cursorCss + explosionCss, cloudMotion.xy, cloudMotion.z);
  vec2 position = basePosition + 2.0 * displacement / safeViewport;
  vec2 ndcPos = abs(position);
  float edgeFade = 1.0 - smoothstep(0.94, 1.02, max(ndcPos.x, ndcPos.y));
  vLifecycle = edgeFade;

  vec3 linearColor = srgbToLinear(logoColor.rgb);
  vec3 compositedColor = mix(uBackground, linearColor, logoColor.a);
  float compositedLuminance = dot(compositedColor, vec3(0.2126, 0.7152, 0.0722));
  float backgroundLuminance = dot(uBackground, vec3(0.2126, 0.7152, 0.0722));
  float directContrast = contrastRatio(compositedLuminance, backgroundLuminance);
  float blackContrast = (backgroundLuminance + 0.05) / 0.05;
  float whiteContrast = 1.05 / (backgroundLuminance + 0.05);
  // Lift low-contrast source colors into the surface palette, avoiding heavy black/white outlines.
  vec3 contrastTint = whiteContrast > blackContrast ? vec3(0.68, 0.76, 0.82) : vec3(0.08, 0.12, 0.16);
  linearColor = mix(linearColor, contrastTint, (1.0 - smoothstep(1.0, 3.0, directContrast)) * 0.52);

  // 70% fine dust, 23.5% mid-size motes, 6.5% collision beads. Alpha is not particle size.
  float dustSize = mix(2.2, 5.0, logoSeed / CLOUD_DUST_END);
  float moteSize = mix(5.0, 9.0, (logoSeed - CLOUD_DUST_END) / (CLOUD_BEAD_START - CLOUD_DUST_END));
  float beadSize = mix(11.0, 18.0, (logoSeed - CLOUD_BEAD_START) / (1.0 - CLOUD_BEAD_START));
  float diameter = logoSeed < CLOUD_DUST_END ? dustSize : (logoSeed < CLOUD_BEAD_START ? moteSize : beadSize);
  float sourceCoverage = mix(0.65, 1.0, logoSize);
  float coreCssPixels = min(diameter * sourceCoverage * depthScale * uRenderedLongAxis / 1024.0, 22.0);
  float coreDevicePixels = max(coreCssPixels * uDpr, 1.25);
  gl_PointSize = coreDevicePixels + 2.0;
  vHalfPixel = 1.0 / gl_PointSize;
  vCoreRatio = coreDevicePixels / gl_PointSize;
  vBead = smoothstep(0.70, 0.98, logoSeed);
  float opacity = mix(0.50, 0.94, smoothstep(0.0, 0.94, logoSeed));
  vColor = vec4(linearColor, logoColor.a * opacity);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, depth * 0.04, 1.0);
}
