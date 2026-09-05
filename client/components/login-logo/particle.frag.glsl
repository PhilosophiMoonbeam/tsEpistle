precision highp float;

varying vec4 vColor;
varying float vCoreRatio;
varying float vLifecycle;
varying float vHalfPixel;
varying float vBead;

void main() {
  vec2 uv = (gl_PointCoord * 2.0 - 1.0) / vCoreRatio;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  float coverage = 1.0 - smoothstep(1.0 - 3.0 * vHalfPixel, 1.0, r2);
  vec3 color = vColor.rgb;
  // Fine dust needs coverage only. Skip sphere lighting for the majority population.
  if (vBead > 0.0) {
    float z = sqrt(max(0.0, 1.0 - r2));
    float diffuse = clamp(dot(vec3(uv, z), vec3(-0.38, -0.46, 0.80)), 0.0, 1.0);
    float glint = pow(max(0.0, dot(vec3(uv, z), vec3(-0.30, -0.36, 0.884))), 22.0);
    color *= mix(1.0, 0.55 + 0.65 * diffuse, vBead);
    color += vec3(0.55, 0.68, 0.74) * glint * vBead * 0.38;
  }
  gl_FragColor = vec4(color, vColor.a * vLifecycle * coverage);
  #include <colorspace_fragment>
}
