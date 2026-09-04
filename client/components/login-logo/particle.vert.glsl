precision highp float;

attribute vec2 logoXY;
attribute float logoDepth;
attribute vec4 logoColor;
attribute float logoSize;
attribute float logoSeed;

uniform float uAspect;
uniform vec3 uBackground;
uniform float uDpr;
uniform vec4 uImpulseDirectionTravel[4];
uniform vec4 uImpulsePositionAge[4];
uniform float uMedianStroke;
uniform float uRenderedLongAxis;
uniform float uTime;
uniform vec2 uViewport;

varying vec4 vColor;
varying float vCoreRatio;
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
  float idleAmplitudeCss = clamp(0.35 * displayedStroke, 2.5, 7.0);
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
  float idleScaleCss = clamp(idleAmplitudeCss * depthScale, 2.5, 7.0);
  vec2 idleCss = coherentFlow * idleScaleCss;

  vec2 impulseCss = vec2(0.0);
  for (int impulseIndex = 0; impulseIndex < 4; impulseIndex++) {
    vec4 positionAge = uImpulsePositionAge[impulseIndex];
    vec4 directionTravel = uImpulseDirectionTravel[impulseIndex];
    if (positionAge.w < 0.5 || directionTravel.z <= 0.0) continue;

    float ageSeconds = clamp(positionAge.z, 0.0, 0.9);
    vec2 localCss = (basePosition - positionAge.xy) * 0.5 * safeViewport;
    float distanceCss = length(localCss);
    float radiusCss = clamp(directionTravel.w, 18.0, 32.0);
    float primaryFalloff = 1.0 - smoothstep(0.2 * radiusCss, radiusCss, distanceCss);
    float propagationStartCss = 0.85 * radiusCss;
    float propagationEndCss = 2.1 * radiusCss;
    float propagationFalloff = smoothstep(
      propagationStartCss,
      radiusCss,
      distanceCss
    ) * (1.0 - smoothstep(
      radiusCss,
      propagationEndCss,
      distanceCss
    ));
    float lifetimeFade = 1.0 - smoothstep(0.72, 0.9, ageSeconds);
    float seededFrequency = mix(9.0, 11.0, logoSeed);
    float seededAmplitude = mix(0.9, 1.1, logoSeed);
    float dampedSpring = seededAmplitude
      * exp(-3.2 * ageSeconds)
      * cos(seededFrequency * ageSeconds)
      * lifetimeFade;
    vec2 inputDirection = directionTravel.xy / max(length(directionTravel.xy), 0.000001);
    vec2 outwardDirection = distanceCss > 0.000001
      ? localCss / distanceCss
      : vec2(cos(6.28318530718 * logoSeed), sin(6.28318530718 * logoSeed));
    float propagationDelay = 0.08 + 0.18 * clamp(
      (distanceCss - propagationStartCss) / max(propagationEndCss - propagationStartCss, 0.000001),
      0.0,
      1.0
    );
    float propagationLobe = smoothstep(
      propagationDelay,
      propagationDelay + 0.1,
      ageSeconds
    ) * exp(-3.2 * ageSeconds) * lifetimeFade;
    impulseCss += directionTravel.z * (
      inputDirection * primaryFalloff * dampedSpring
      + outwardDirection * 0.18 * propagationFalloff * propagationLobe
    );
  }
  float impulseMagnitude = length(impulseCss);
  impulseCss *= impulseMagnitude > 8.0 ? 8.0 / impulseMagnitude : 1.0;
  vec2 position = basePosition + 2.0 * (idleCss + impulseCss) / safeViewport;

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
  float coreCssPixels = min((1.0 + 15.0 * sizeNorm) * depthScale * uRenderedLongAxis / 1024.0, 24.0);
  float ringCssPixels = vUseRing * mix(1.25, 2.0, clamp((3.0 - directContrast) / 2.0, 0.0, 1.0));
  float coreDevicePixels = coreCssPixels * uDpr;
  float totalDevicePixels = (coreCssPixels + 2.0 * ringCssPixels) * uDpr;
  gl_PointSize = totalDevicePixels;
  vCoreRatio = coreDevicePixels / max(totalDevicePixels, 1.0);
  vColor = vec4(linearColor, logoColor.a);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, depth * 0.04, 1.0);
}
