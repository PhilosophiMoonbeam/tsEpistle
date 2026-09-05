precision highp float;

attribute vec2 logoXY;
attribute float logoDepth;
attribute vec4 logoColor;
attribute float logoSize;
attribute float logoSeed;

uniform float uAspect;
uniform vec3 uBackground;
uniform float uCoreSizeFactor;
uniform float uDpr;
uniform vec4 uImpulseDirectionTravel[6];
uniform vec4 uImpulsePositionAge[6];
uniform vec4 uExplosionPositionAge[6];
uniform float uMedianStroke;
uniform float uRenderedLongAxis;
uniform float uTime;
uniform vec2 uViewport;

varying vec4 vColor;
varying float vCoreRatio;
varying float vLifecycle;
varying vec3 vRingColor;
varying float vUseRing;

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
  vec2 idleCss = coherentFlow * idleScaleCss;

  vec2 cursorCss = vec2(0.0);
  for (int impulseIndex = 0; impulseIndex < 6; impulseIndex++) {
    vec4 positionAge = uImpulsePositionAge[impulseIndex];
    vec4 directionTravel = uImpulseDirectionTravel[impulseIndex];
    if (positionAge.w < 0.5 || directionTravel.z <= 0.0) continue;

    float ageSeconds = clamp(positionAge.z, 0.0, 1.4);
    vec2 localCss = (basePosition - positionAge.xy) * 0.5 * safeViewport;
    float distanceCss = length(localCss);
    float radiusCss = clamp(directionTravel.w, 18.0, 32.0);
    float primaryFalloff = 1.0 - smoothstep(0.2 * radiusCss, radiusCss, distanceCss);
    float annulusFalloff = smoothstep(0.55 * radiusCss, radiusCss, distanceCss)
      * (1.0 - smoothstep(radiusCss, 2.15 * radiusCss, distanceCss));
    float outwardDelay = smoothstep(0.08, 0.24, ageSeconds);
    float outwardFade = 1.0 - smoothstep(0.72, 1.10, ageSeconds);
    float bounceDelay = smoothstep(0.72, 0.96, ageSeconds);
    float bounceFade = 1.0 - smoothstep(1.12, 1.4, ageSeconds);
    float spring = exp(-2.25 * ageSeconds) * sin(7.2 * ageSeconds);
    vec2 inputDirection = directionTravel.xy / max(length(directionTravel.xy), 0.000001);
    vec2 outwardDirection = distanceCss > 0.000001
      ? localCss / distanceCss
      : vec2(cos(6.28318530718 * logoSeed), sin(6.28318530718 * logoSeed));
    cursorCss += directionTravel.z * (
      inputDirection * primaryFalloff * spring
      + outwardDirection * 0.32 * annulusFalloff * outwardDelay * outwardFade
      - outwardDirection * 0.22 * annulusFalloff * bounceDelay * bounceFade
    );
  }
  float cursorMagnitude = length(cursorCss);
  cursorCss *= cursorMagnitude > 14.0 ? 14.0 / cursorMagnitude : 1.0;

  vec2 explosionCss = vec2(0.0);
  float explosionLifecycle = 1.0;
  for (int explosionIndex = 0; explosionIndex < 6; explosionIndex++) {
    vec4 positionAge = uExplosionPositionAge[explosionIndex];
    if (positionAge.w < 0.5) continue;

    float ageSeconds = clamp(positionAge.z, 0.0, 2.8);
    vec2 localCss = (basePosition - positionAge.xy) * 0.5 * safeViewport;
    float distanceCss = length(localCss);
    float radiusCss = clamp(0.10 * uRenderedLongAxis, 32.0, 88.0);
    float influence = 1.0 - smoothstep(0.15 * radiusCss, radiusCss, distanceCss);
    float oldFade = smoothstep(0.0, 0.35, ageSeconds);
    float refillFade = smoothstep(0.35, 0.57, ageSeconds);
    float oldScatter = oldFade * (1.0 - refillFade);
    float oldResidual = influence * oldFade;
    float replacementLifecycle = influence * refillFade;
    float refillStream = 1.0 - smoothstep(0.35, 2.75, ageSeconds);
    vec2 radial = distanceCss > 0.000001
      ? localCss / distanceCss
      : vec2(cos(6.28318530718 * logoSeed), sin(6.28318530718 * logoSeed));
    vec2 tangent = vec2(-radial.y, radial.x);
    float phase = 6.28318530718 * fract(
      logoSeed + dot(positionAge.xy, vec2(0.754877666, 0.569840296))
    );
    vec2 deterministicNearby = radial * (0.52 + 0.20 * sin(phase)) + tangent * (0.22 * cos(phase));
    explosionCss += radial * (0.46 * radiusCss * influence * oldScatter);
    explosionCss += deterministicNearby * (0.30 * radiusCss * influence * replacementLifecycle * refillStream);
    float slotLifecycle = clamp(1.0 - oldResidual + replacementLifecycle, 0.0, 1.0);
    explosionLifecycle = min(explosionLifecycle, slotLifecycle);
  }
  float explosionMagnitude = length(explosionCss);
  vec2 position = basePosition + 2.0 * (idleCss + cursorCss + explosionCss) / safeViewport;
  vec2 ndcPos = abs(position);
  float edgeFade = 1.0 - smoothstep(0.94, 1.02, max(ndcPos.x, ndcPos.y));
  vLifecycle = explosionLifecycle * edgeFade;

  vec3 linearColor = srgbToLinear(logoColor.rgb);
  vec3 compositedColor = mix(uBackground, linearColor, logoColor.a);
  float compositedLuminance = dot(compositedColor, vec3(0.2126, 0.7152, 0.0722));
  float backgroundLuminance = dot(uBackground, vec3(0.2126, 0.7152, 0.0722));
  float directContrast = contrastRatio(compositedLuminance, backgroundLuminance);
  float blackContrast = (backgroundLuminance + 0.05) / 0.05;
  float whiteContrast = 1.05 / (backgroundLuminance + 0.05);
  vUseRing = directContrast < 3.0 ? 1.0 : 0.0;
  vRingColor = whiteContrast > blackContrast ? vec3(1.0) : vec3(0.0);

  float sizeNorm = (logoSize * 255.0 - 1.0) / 254.0;
  float coreCssPixels = min(uCoreSizeFactor * (1.0 + 15.0 * sizeNorm) * depthScale * uRenderedLongAxis / 1024.0, 24.0);
  float ringCssPixels = vUseRing * mix(1.25, 2.0, clamp((3.0 - directContrast) / 2.0, 0.0, 1.0));
  float coreDevicePixels = max(coreCssPixels * uDpr, 1.5);
  float totalDevicePixels = max(coreDevicePixels + 2.0 * ringCssPixels * uDpr, 1.5);
  gl_PointSize = totalDevicePixels;
  vCoreRatio = coreDevicePixels / max(totalDevicePixels, 1.0);
  vColor = vec4(linearColor, logoColor.a);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, depth * 0.04, 1.0);
}
