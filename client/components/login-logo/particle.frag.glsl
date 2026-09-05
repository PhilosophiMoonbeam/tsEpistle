precision highp float;

varying vec4 vColor;
varying float vCoreRatio;
varying float vLifecycle;
varying vec3 vRingColor;
varying float vUseRing;

void main() {
  float radius = length(gl_PointCoord * 2.0 - 1.0);
  float pixelRadius = max(fwidth(radius), 0.001);
  float halfPixel = pixelRadius * 0.5;
  float outerCoverage = 1.0 - smoothstep(1.0 - halfPixel, 1.0 + halfPixel, radius);
  float coreCoverage = 1.0 - smoothstep(vCoreRatio - halfPixel, vCoreRatio + halfPixel, radius);
  float ringCoverage = max(0.0, outerCoverage - coreCoverage) * vUseRing;
  vec3 color = mix(vRingColor, vColor.rgb, coreCoverage);
  float alpha = vColor.a * vLifecycle * max(coreCoverage, ringCoverage);
  if (alpha <= 0.001) discard;

  gl_FragColor = vec4(color, alpha);
  #include <colorspace_fragment>
}
