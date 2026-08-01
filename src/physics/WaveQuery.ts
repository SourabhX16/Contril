// Gerstner wave parameters shared between GPU shader and CPU physics
// SINGLE SOURCE OF TRUTH — import from here everywhere

export interface GerstnerWave {
  dir: [number, number]; // normalized direction XZ
  amplitude: number;
  wavelength: number;
  speed: number;
  steepness: number;
}

// The 5 waves: 1 main swell + 4 chop layers
export const WAVES: GerstnerWave[] = [
  // Main long swell — low freq, high amp, directional
  { dir: [0.7, 0.3],  amplitude: 1.2, wavelength: 80,  speed: 1.0, steepness: 0.6 },
  // Secondary swell — slightly cross
  { dir: [-0.3, 0.8], amplitude: 0.7, wavelength: 50,  speed: 0.9, steepness: 0.5 },
  // Chop 1
  { dir: [0.9, 0.1],  amplitude: 0.3, wavelength: 20,  speed: 1.4, steepness: 0.35 },
  // Chop 2 — opposite angle
  { dir: [0.1, -0.9], amplitude: 0.25, wavelength: 15, speed: 1.6, steepness: 0.3 },
  // Fine chop
  { dir: [-0.6, 0.4], amplitude: 0.15, wavelength: 8,  speed: 2.0, steepness: 0.2 },
];

// Pre-computed constants per wave (avoid recomputing every sample)
interface WaveCache {
  ndx: number;
  ndz: number;
  k: number;       // 2π / wavelength
  c: number;       // phase speed = sqrt(g/k)
  qi: number;      // steepness / (k * amplitude * 5)
  amplitude: number;
  speed: number;
}

const WAVE_CACHE: WaveCache[] = WAVES.map(w => {
  const [dx, dz] = w.dir;
  const len = Math.sqrt(dx * dx + dz * dz);
  const ndx = dx / len;
  const ndz = dz / len;
  const k = (2 * Math.PI) / w.wavelength;
  const c = Math.sqrt(9.81 / k);
  const qi = w.steepness / (k * w.amplitude * 5);
  return { ndx, ndz, k, c, qi, amplitude: w.amplitude, speed: w.speed };
});

// CPU-side Gerstner height sampling (must match shader exactly)
export function sampleGerstnerHeight(x: number, z: number, time: number): number {
  let totalY = 0;
  for (let i = 0; i < WAVE_CACHE.length; i++) {
    const w = WAVE_CACHE[i];
    const f = w.k * (w.ndx * x + w.ndz * z - w.c * w.speed * time);
    totalY += w.amplitude * Math.sin(f);
  }
  return totalY;
}

// Full displacement (XYZ) for buoyancy
export function sampleGerstnerDisplacement(x: number, z: number, time: number): [number, number, number] {
  let tx = 0, ty = 0, tz = 0;
  for (let i = 0; i < WAVE_CACHE.length; i++) {
    const w = WAVE_CACHE[i];
    const f = w.k * (w.ndx * x + w.ndz * z - w.c * w.speed * time);
    const cosF = Math.cos(f);
    tx += w.qi * w.amplitude * w.ndx * cosF;
    ty += w.amplitude * Math.sin(f);
    tz += w.qi * w.amplitude * w.ndz * cosF;
  }
  return [tx, ty, tz];
}

/**
 * Compute approximate surface normal via finite differences.
 * Returns [nx, ny, nz] (not normalized — caller normalizes if needed).
 * Used for buoyancy tilt and wave-slope riding.
 */
export function sampleGerstnerNormal(x: number, z: number, time: number): [number, number, number] {
  const eps = 0.3;
  const hC  = sampleGerstnerHeight(x, z, time);
  const hPx = sampleGerstnerHeight(x + eps, z, time);
  const hPz = sampleGerstnerHeight(x, z + eps, time);
  // Tangent X = (eps, hPx - hC, 0), Tangent Z = (0, hPz - hC, eps)
  // Cross product gives normal
  const dhdx = (hPx - hC) / eps;
  const dhdz = (hPz - hC) / eps;
  // Normal = (-dhdx, 1, -dhdz) — unnormalized, Y-up dominant
  return [-dhdx, 1, -dhdz];
}

/**
 * Compute wave slope at a point (for wave-riding momentum).
 * Returns the slope vector [dx, dz] pointing downhill.
 */
export function sampleWaveSlope(x: number, z: number, time: number): [number, number] {
  const eps = 0.5;
  const hC  = sampleGerstnerHeight(x, z, time);
  const hPx = sampleGerstnerHeight(x + eps, z, time);
  const hPz = sampleGerstnerHeight(x, z + eps, time);
  return [-(hPx - hC) / eps, -(hPz - hC) / eps];
}
