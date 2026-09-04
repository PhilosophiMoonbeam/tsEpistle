precision highp float;

attribute vec2 logoXY;
attribute float logoDepth;
attribute vec4 logoColor;
attribute float logoSize;
attribute float logoSeed;

uniform float uAspect;
uniform vec3 uBackground;
uniform float uDpr;
uniform float uMedianStroke;
uniform vec2 uPointer;
uniform float uPointerDisplacement;
uniform float uPointerRadius;
uniform float uPointerStrength;
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
  float viewportAspect = uViewport.x / max(uViewport.y, 1.0);
  vec2 fit = viewportAspect >= uAspect
    ? vec2(uAspect / viewportAspect, 1.0)
    : vec2(1.0, viewportAspect / uAspect);

  float displayedStroke = uMedianStroke * uRenderedLongAxis / 1024.0;
  float driftAmplitude = min(1.25, 0.08 * displayedStroke);
  float phase = ((logoSeed * 65535.0 - 1.0) / 65534.0) * 6.28318530718;
  vec2 drift = vec2(
    sin(uTime * 0.43 + phase) + 0.35 * sin(uTime * 0.19 + phase * 2.17),
    cos(uTime * 0.37 + phase * 1.31) + 0.35 * cos(uTime * 0.23 + phase * 2.73)
  ) * (driftAmplitude / 1.35);

  vec2 basePosition = logoXY * fit;
  vec2 pointerDeltaDevice = (basePosition - uPointer) * 0.5 * uViewport * uDpr;
  float pointerDistanceDevice = length(pointerDeltaDevice);
  float pointerRadiusDevice = uPointerRadius * uDpr;
  float pointerFalloff = 1.0 - smoothstep(0.0, max(pointerRadiusDevice, 0.001), pointerDistanceDevice);
  vec2 pointerDirection = pointerDistanceDevice > 0.001
    ? pointerDeltaDevice / pointerDistanceDevice
    : vec2(cos(phase), sin(phase));
  float pointerDevicePixels = min(uPointerDisplacement * uDpr, 24.0 * uDpr)
    * pointerFalloff
    * clamp(uPointerStrength, 0.0, 1.0);
  vec2 pointerCssDisplacement = pointerDirection * pointerDevicePixels / max(uDpr, 1.0);
  vec2 position = basePosition + (2.0 * (drift + pointerCssDisplacement) / max(uViewport, vec2(1.0)));

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
  float coreCssPixels = min((1.0 + 15.0 * sizeNorm) * uRenderedLongAxis / 1024.0, 24.0);
  float ringCssPixels = vUseRing * mix(1.25, 2.0, clamp((3.0 - directContrast) / 2.0, 0.0, 1.0));
  float coreDevicePixels = coreCssPixels * uDpr;
  float totalDevicePixels = coreDevicePixels + 2.0 * ringCssPixels * uDpr;
  gl_PointSize = totalDevicePixels;
  vCoreRatio = coreDevicePixels / max(totalDevicePixels, 1.0);
  vColor = vec4(linearColor, logoColor.a);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, logoDepth * 0.04, 1.0);
}
