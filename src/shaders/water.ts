// Water vertex shader — Gerstner waves + cel color bands
// Each wave: amplitude, wavelength, speed, direction, steepness

export const waterVert = /* glsl */`
  uniform float uTime;
  uniform float uCameraX;
  uniform float uCameraZ;

  // Gerstner wave parameters [amplitude, wavelength, speed, dirX, dirZ, steepness]
  uniform vec4 uWave0; // xy=dir, z=amp, w=wavelength
  uniform vec4 uWave1;
  uniform vec4 uWave2;
  uniform vec4 uWave3;
  uniform vec4 uWave4;
  uniform float uWaveSpeed0;
  uniform float uWaveSpeed1;
  uniform float uWaveSpeed2;
  uniform float uWaveSpeed3;
  uniform float uWaveSpeed4;
  uniform float uSteepness0;
  uniform float uSteepness1;
  uniform float uSteepness2;
  uniform float uSteepness3;
  uniform float uSteepness4;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vWaveHeight;
  varying float vFoamMask;
  varying vec2 vUV;
  varying float vDistToCam;

  // Single Gerstner wave contribution
  vec3 gerstner(vec3 pos, vec2 dir, float amp, float wavelength, float speed, float steep) {
    float k = 6.28318 / wavelength;
    float c = sqrt(9.81 / k);
    float f = k * (dot(dir, pos.xz) - c * speed * uTime);
    float qi = steep / (k * amp * 5.0); // limit steepness to avoid loops
    return vec3(
      qi * amp * dir.x * cos(f),
      amp * sin(f),
      qi * amp * dir.y * cos(f)
    );
  }

  void main() {
    vec3 pos = position;

    // Sum all 5 Gerstner waves
    vec3 d = vec3(0.0);
    d += gerstner(pos, normalize(uWave0.xy), uWave0.z, uWave0.w, uWaveSpeed0, uSteepness0);
    d += gerstner(pos, normalize(uWave1.xy), uWave1.z, uWave1.w, uWaveSpeed1, uSteepness1);
    d += gerstner(pos, normalize(uWave2.xy), uWave2.z, uWave2.w, uWaveSpeed2, uSteepness2);
    d += gerstner(pos, normalize(uWave3.xy), uWave3.z, uWave3.w, uWaveSpeed3, uSteepness3);
    d += gerstner(pos, normalize(uWave4.xy), uWave4.z, uWave4.w, uWaveSpeed4, uSteepness4);

    vec3 displaced = pos + d;
    vWaveHeight = d.y;
    vFoamMask = smoothstep(0.35, 0.75, d.y / (uWave0.z + uWave1.z));

    // Finite difference normals for correct lighting
    float eps = 0.5;
    vec3 px = pos + vec3(eps, 0.0, 0.0);
    vec3 pz = pos + vec3(0.0, 0.0, eps);
    vec3 dx = vec3(0.0);
    vec3 dz = vec3(0.0);
    dx += gerstner(px, normalize(uWave0.xy), uWave0.z, uWave0.w, uWaveSpeed0, uSteepness0);
    dx += gerstner(px, normalize(uWave1.xy), uWave1.z, uWave1.w, uWaveSpeed1, uSteepness1);
    dx += gerstner(px, normalize(uWave2.xy), uWave2.z, uWave2.w, uWaveSpeed2, uSteepness2);
    dx += gerstner(px, normalize(uWave3.xy), uWave3.z, uWave3.w, uWaveSpeed3, uSteepness3);
    dx += gerstner(px, normalize(uWave4.xy), uWave4.z, uWave4.w, uWaveSpeed4, uSteepness4);
    dz += gerstner(pz, normalize(uWave0.xy), uWave0.z, uWave0.w, uWaveSpeed0, uSteepness0);
    dz += gerstner(pz, normalize(uWave1.xy), uWave1.z, uWave1.w, uWaveSpeed1, uSteepness1);
    dz += gerstner(pz, normalize(uWave2.xy), uWave2.z, uWave2.w, uWaveSpeed2, uSteepness2);
    dz += gerstner(pz, normalize(uWave3.xy), uWave3.z, uWave3.w, uWaveSpeed3, uSteepness3);
    dz += gerstner(pz, normalize(uWave4.xy), uWave4.z, uWave4.w, uWaveSpeed4, uSteepness4);
    vec3 tang = normalize((px + dx) - displaced);
    vec3 btan = normalize((pz + dz) - displaced);
    vNormal = normalize(cross(btan, tang));

    vWorldPos = displaced;
    vUV = position.xz * 0.01;
    vDistToCam = length(displaced.xz - vec2(uCameraX, uCameraZ));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

export const waterFrag = /* glsl */`
  precision highp float;

  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uCamPos;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vWaveHeight;
  varying float vFoamMask;
  varying vec2 vUV;
  varying float vDistToCam;

  // Palette — refined for anime aesthetic
  const vec3 COLOR_DEEP    = vec3(0.040, 0.180, 0.380); // deep ocean
  const vec3 COLOR_MID     = vec3(0.100, 0.440, 0.620); // aqua body
  const vec3 COLOR_CREST   = vec3(0.450, 0.820, 0.950); // light crest
  const vec3 COLOR_FOAM    = vec3(0.945, 0.975, 1.000); // foam white
  const vec3 COLOR_RIM     = vec3(1.000, 0.580, 0.380); // warm rim
  const vec3 COLOR_SUN     = vec3(1.000, 0.900, 0.700); // sun reflection
  const vec3 COLOR_SSS     = vec3(0.200, 0.800, 0.600); // subsurface tint (green-blue)
  const vec3 COLOR_HORIZON = vec3(0.120, 0.300, 0.520); // distant water

  // Hash for sparkle
  float hash(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  // Better hash (less visible grid)
  float hash2(vec2 p) {
    vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // Cel quantize: 3 bands with subtle transition
  vec3 celWater(float h) {
    if (h > 0.7)  return COLOR_CREST;
    if (h > 0.12) return COLOR_MID;
    return COLOR_DEEP;
  }

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(uCamPos - vWorldPos);
    vec3 L = normalize(uSunDir);
    vec3 H = normalize(L + V);

    // --- CEL DIFFUSE (3 bands) ---
    float ndl = dot(N, L);
    vec3 baseColor = celWater(vWaveHeight * 0.6);

    // Banded diffuse: 4 steps
    float diff;
    if (ndl > 0.7)       diff = 1.0;
    else if (ndl > 0.3)  diff = 0.72;
    else if (ndl > -0.1) diff = 0.48;
    else                 diff = 0.28;

    vec3 color = baseColor * diff;

    // --- SUBSURFACE SCATTERING TINT at wave crests ---
    // When looking through thin crest areas, tint with green-blue
    float sss = smoothstep(0.5, 1.2, vWaveHeight) * (1.0 - abs(dot(N, V)));
    color = mix(color, COLOR_SSS * diff, sss * 0.25);

    // --- BANDED SPECULAR (hard edge) ---
    float spec = dot(N, H);
    if (spec > 0.96) {
      color = mix(color, COLOR_SUN, 0.9);
    } else if (spec > 0.92) {
      color = mix(color, COLOR_SUN, 0.3);
    }

    // --- SPARKLE (improved hash, less griddy) ---
    // Use rotated UVs and multi-scale sampling to hide grid
    float angle = uTime * 0.03;
    float ca = cos(angle), sa = sin(angle);
    vec2 rotUV = vec2(
      vWorldPos.x * ca - vWorldPos.z * sa,
      vWorldPos.x * sa + vWorldPos.z * ca
    ) * 0.18;

    vec2 cell = floor(rotUV + uTime * 0.05);
    float phase = hash2(cell) * 6.28;
    float glitter = step(0.88, sin(uTime * 4.5 + phase));
    // Second layer at different scale
    vec2 cell2 = floor(vWorldPos.xz * 0.12 + uTime * 0.03);
    float phase2 = hash2(cell2 + vec2(7.3, 1.1)) * 6.28;
    glitter += step(0.92, sin(uTime * 6.0 + phase2)) * 0.6;

    glitter *= step(0.45, dot(N, V)); // only on surfaces facing viewer
    glitter = clamp(glitter, 0.0, 1.0);
    color = mix(color, COLOR_FOAM, glitter * 0.5);

    // --- FRESNEL RIM (banded) ---
    float fresnel = pow(1.0 - max(dot(N, V), 0.0), 4.0);
    float fresnelBand = step(0.6, fresnel) * 0.4 + step(0.85, fresnel) * 0.4;
    color = mix(color, COLOR_RIM * 0.5, fresnelBand * 0.25);

    // --- FOAM (improved with dissolving edges) ---
    float foam = smoothstep(0.65, 0.85, vFoamMask);
    // Animated noise for foam texture — uses better hash for organic breakup
    vec2 foamUV = vWorldPos.xz * 0.35 + uTime * 0.02;
    float foamNoise = hash2(floor(foamUV * 4.0));
    // Dissolving edge: foam fades at boundaries
    foam *= smoothstep(0.4, 0.65, foamNoise);
    // Second foam layer for trailing dissolution
    vec2 foamUV2 = vWorldPos.xz * 0.6 + uTime * 0.04;
    float trailFoam = hash2(floor(foamUV2 * 3.0));
    foam += smoothstep(0.72, 0.9, vFoamMask) * step(0.6, trailFoam) * 0.4;
    foam = clamp(foam, 0.0, 1.0);
    color = mix(color, COLOR_FOAM, foam * 0.85);

    // --- DARK DEPTH TINTING ---
    float depthDarken = smoothstep(-0.3, -0.8, vWaveHeight);
    color = mix(color, COLOR_DEEP * 0.5, depthDarken * 0.5);

    // --- DISTANCE FOG (horizon blend) ---
    float fogFactor = smoothstep(150.0, 400.0, vDistToCam);
    color = mix(color, COLOR_HORIZON, fogFactor * 0.6);

    gl_FragColor = vec4(color, 1.0);
  }
`;
