precision highp float;

varying vec4 vColor;
varying float vCoreRatio;
varying float vLifecycle;
varying vec3 vRingColor;
varying float vUseRing;
varying float vHalfPixel;

void main() {
  float radius = length(gl_PointCoord * 2.0 - 1.0);

  // Inset outer radius by half-pixel so the smoothstep transition
  // finishes completely within the hardware-rasterized sprite quad bounds.
  float rMax = 1.0 - vHalfPixel;
  float outerCoverage = 1.0 - smoothstep(rMax - vHalfPixel, rMax + vHalfPixel, radius);

  float coreMax = vCoreRatio * rMax;
  float coreCoverage = 1.0 - smoothstep(coreMax - vHalfPixel, coreMax + vHalfPixel, radius);

  // Continuous partition of unity: avoids the 50% alpha chasm between core and ring
  float totalCoverage = mix(coreCoverage, outerCoverage, vUseRing);
  float alpha = vColor.a * vLifecycle * totalCoverage;
  if (alpha <= 0.001) discard;

  // Selective ring mixing: strictly isolates ring color to particles with vUseRing > 0,
  // preventing outer edge discoloration on non-ring particles.
  vec3 ringBlendedColor = mix(vRingColor, vColor.rgb, coreCoverage);
  vec3 color = mix(vColor.rgb, ringBlendedColor, vUseRing);

  gl_FragColor = vec4(color, alpha);
  #include <colorspace_fragment>
}
