// Toon/cel shading shader for all game entities
// Implements: 4-band ramp diffuse, banded specular, fresnel rim, inverted-hull outline

export const toonVert = /* glsl */`
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vViewDir;
  varying vec2 vUv;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mvPos.xyz);
    vUv = uv;
    gl_Position = projectionMatrix * mvPos;
  }
`;

export const toonFrag = /* glsl */`
  precision highp float;

  uniform vec3 uBaseColor;
  uniform vec3 uShadowColor;
  uniform vec3 uRimColor;
  uniform vec3 uSpecColor;
  uniform vec3 uSunDir;
  uniform vec3 uCamPos;
  uniform sampler2D uRamp;

  // Band thresholds tuned by eye for anime look
  const float BAND2 = 0.3;
  const float BAND3 = 0.6;
  const float BAND4 = 0.85;
  const float SPEC_THRESH = 0.93;

  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vViewDir;
  varying vec2 vUv;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(vViewDir);
    vec3 L = normalize(uSunDir);
    vec3 H = normalize(L + V);

    // 4-band step-quantized diffuse
    float ndl = dot(N, L) * 0.5 + 0.5;
    float ramp;
    if (ndl > BAND4)      ramp = 1.0;
    else if (ndl > BAND3) ramp = 0.72;
    else if (ndl > BAND2) ramp = 0.42;
    else                  ramp = 0.15;

    vec3 color = mix(uShadowColor, uBaseColor, ramp);

    // Hard-edge banded specular
    float spec = dot(N, H);
    if (spec > SPEC_THRESH) {
      color = mix(color, uSpecColor, 0.85);
    }

    // Banded fresnel rim
    float fresnel = 1.0 - max(dot(N, V), 0.0);
    float rim = step(0.65, fresnel) + step(0.82, fresnel);
    rim = clamp(rim, 0.0, 1.0);
    color = mix(color, uRimColor, rim * 0.55);

    gl_FragColor = vec4(color, 1.0);
  }
`;

// Inverted-hull outline: BackSide, push along normals, distance-scaled
export const outlineVert = /* glsl */`
  uniform float uOutlineWidth;
  uniform vec3 uCamPos;

  varying vec3 vWorldPos;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    float dist = distance(worldPos.xyz, uCamPos);
    // Scale with distance to keep constant screen-space width
    float scale = uOutlineWidth * (dist * 0.012 + 0.5);
    scale = clamp(scale, uOutlineWidth * 0.25, uOutlineWidth * 2.8);

    vec3 norm = normalize(normalMatrix * normal);
    vec4 pos = projectionMatrix * modelViewMatrix * vec4(position + norm * scale, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = pos;
  }
`;

export const outlineFrag = /* glsl */`
  precision highp float;
  uniform vec3 uOutlineColor;
  varying vec3 vWorldPos;
  void main() {
    gl_FragColor = vec4(uOutlineColor, 1.0);
  }
`;

// Sky dome shader — gradient + cel clouds + sun
// Softened band transitions for more polished look
export const skyVert = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const skyFrag = /* glsl */`
  precision highp float;

  uniform float uTime;
  uniform vec3 uSunDir;

  varying vec3 vDir;

  const vec3 SKY_TOP   = vec3(0.098, 0.035, 0.220);
  const vec3 SKY_MID   = vec3(0.310, 0.150, 0.490);
  const vec3 SKY_HORIZ = vec3(1.000, 0.420, 0.208);
  const vec3 SKY_GLOW  = vec3(1.000, 0.700, 0.200);
  const vec3 SUN_COLOR = vec3(1.000, 0.980, 0.800);

  float hash21(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 17.23);
    return fract(p.x * p.y);
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = dir.y;

    // Softened 3-band sky gradient with smooth transitions
    // Instead of hard step(), use smoothstep() with narrow bands for cel-ish but not jarring
    vec3 sky;
    float topMix    = smoothstep(0.50, 0.58, h);  // soften top edge
    float midMix    = smoothstep(0.08, 0.15, h);   // soften horizon edge
    float horizMix  = smoothstep(-0.06, 0.0, h);   // soften below horizon

    // Layer blending: bottom to top
    sky = SKY_HORIZ * 0.75;                          // below horizon
    sky = mix(sky, SKY_HORIZ, horizMix);              // horizon
    sky = mix(sky, SKY_MID, midMix);                  // mid sky
    sky = mix(sky, SKY_TOP, topMix);                  // top sky

    // Sun disc with inner/outer halo
    float sunDot = dot(dir, normalize(uSunDir));
    if (sunDot > 0.996) {
      sky = SUN_COLOR;
    } else if (sunDot > 0.988) {
      sky = mix(sky, SKY_GLOW, 0.92);
    } else if (sunDot > 0.96) {
      sky = mix(sky, SKY_GLOW * 0.5, 0.5);
    }

    // Cel oval clouds in upper sky
    if (h > 0.08 && sunDot < 0.96) {
      // Spherical UV
      float phi = atan(dir.x, dir.z) / 6.28318 + 0.5 + uTime * 0.003;
      vec2 cloudUV = vec2(phi, dir.y * 0.7);

      // Large cloud layer
      float c1 = 0.0;
      {
        vec2 uv1 = cloudUV * vec2(7.0, 2.5);
        vec2 id1 = floor(uv1);
        vec2 p1  = fract(uv1);
        float ox = hash21(id1) * 0.4 - 0.2;
        float oy = hash21(id1 + vec2(3.7, 1.1)) * 0.3 - 0.15;
        float d1 = length((p1 - 0.5 + vec2(ox, oy)) * vec2(1.6, 3.2));
        float t1 = hash21(id1 + vec2(2.1, 4.3)) * 0.3 + 0.32;
        c1 = step(t1, 1.0 - d1) * step(0.42, hash21(id1 + vec2(9.0, 2.5)));
      }
      // Small cloud layer
      float c2 = 0.0;
      {
        vec2 uv2 = cloudUV * vec2(14.0, 4.5) + vec2(uTime * 0.005, 0.0);
        vec2 id2 = floor(uv2);
        vec2 p2  = fract(uv2);
        float ox2 = hash21(id2) * 0.35 - 0.175;
        float oy2 = hash21(id2 + vec2(11.7, 0.3)) * 0.25 - 0.125;
        float d2 = length((p2 - 0.5 + vec2(ox2, oy2)) * vec2(2.0, 3.5));
        float t2 = hash21(id2 + vec2(3.3, 8.1)) * 0.25 + 0.38;
        c2 = step(t2, 1.0 - d2) * step(0.52, hash21(id2 + vec2(13.0, 5.5)));
      }
      float cloud = clamp(c1 + c2 * 0.55, 0.0, 1.0) * smoothstep(0.08, 0.22, h);

      // Cloud shading: top lit (white), bottom shaded (purple)
      vec3 cloudLit    = vec3(0.97, 0.95, 1.00);
      vec3 cloudShadow = vec3(0.50, 0.42, 0.65);
      float litFace = clamp(sunDot * 2.0, 0.0, 1.0);
      sky = mix(sky, mix(cloudShadow, cloudLit, litFace), cloud);
    }

    gl_FragColor = vec4(sky, 1.0);
  }
`;
