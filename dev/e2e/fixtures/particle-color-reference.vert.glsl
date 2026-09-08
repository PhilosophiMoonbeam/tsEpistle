// Frozen color treatment from 69fa4094, before theme color caching.
// Keep independent of production helpers so GPU equivalence catches formula drift.
precision highp float;
attribute vec4 logoColor;
attribute float logoSeed;
uniform vec3 uBackground;
varying vec4 vColor;

vec3 srgbToLinear(vec3 value) {
  vec3 lower = value / 12.92;
  vec3 higher = pow((value + 0.055) / 1.055, vec3(2.4));
  return mix(lower, higher, step(vec3(0.04045), value));
}

vec3 linearToSrgb(vec3 value) {
  vec3 lower = value * 12.92;
  vec3 higher = 1.055 * pow(value, vec3(1.0 / 2.4)) - 0.055;
  return mix(lower, higher, step(vec3(0.0031308), value));
}

float contrastRatio(float first, float second) {
  float lighter = max(first, second);
  float darker = min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

void main() {
  float opacity = mix(0.66, 0.94, smoothstep(0.0, 0.94, logoSeed));
  float coreAlpha = logoColor.a * opacity;
  vec3 luminanceWeights = vec3(0.2126, 0.7152, 0.0722);
  float backgroundLuminance = dot(uBackground, luminanceWeights);
  vec3 linearColor = srgbToLinear(logoColor.rgb);
  if (backgroundLuminance > 0.35) {
    // NormalBlending composites after the fragment's sRGB output conversion.
    // Solve for the lightest source tint that gives the actual translucent core
    // 3:1 contrast. Scaling sRGB channels together retains the source hue.
    vec3 backgroundSrgb = linearToSrgb(uBackground);
    float targetLuminance = (backgroundLuminance + 0.05) / 3.0 - 0.05;
    vec3 compositedSrgb = mix(backgroundSrgb, logoColor.rgb, coreAlpha);
    if (dot(srgbToLinear(compositedSrgb), luminanceWeights) > targetLuminance) {
      float lower = 0.0;
      float upper = 1.0;
      for (int iteration = 0; iteration < 7; iteration++) {
        float scale = (lower + upper) * 0.5;
        vec3 candidate = mix(backgroundSrgb, logoColor.rgb * scale, coreAlpha);
        if (dot(srgbToLinear(candidate), luminanceWeights) > targetLuminance) upper = scale;
        else lower = scale;
      }
      linearColor = srgbToLinear(logoColor.rgb * lower);
    }
  } else {
    // Preserve the luminous dark-surface treatment and its original source-alpha weighting.
    vec3 compositedColor = mix(uBackground, linearColor, logoColor.a);
    float directContrast = contrastRatio(dot(compositedColor, luminanceWeights), backgroundLuminance);
    float blackContrast = (backgroundLuminance + 0.05) / 0.05;
    float whiteContrast = 1.05 / (backgroundLuminance + 0.05);
    vec3 contrastTint = whiteContrast > blackContrast ? vec3(0.68, 0.76, 0.82) : vec3(0.08, 0.12, 0.16);
    linearColor = mix(linearColor, contrastTint, (1.0 - smoothstep(1.0, 3.0, directContrast)) * 0.52);
  }

  vColor = vec4(linearColor, coreAlpha);
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
}
