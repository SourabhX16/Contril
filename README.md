# CONTRIL 🌊

> **A cel-shaded arcade boat racing game on an infinite procedural ocean.**
> Anime-inspired cel shading, procedural ocean physics, zero external assets.

[![Live Demo](https://img.shields.io/badge/Live%20Demo-Visit-3DDC84?style=for-the-badge&logo=vercel&logoColor=white)](https://contril-7zpy.vercel.app/)

---

## ⚡ Quick Start

```bash
# Install dependencies
npm install

# Start local development server
npm run dev
```

Visit **http://localhost:5173** to play locally.

---

## 🎮 Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| **Throttle** | `W` / `↑` | RT / A |
| **Brake / Reverse** | `S` / `↓` | LT |
| **Steer** | `A` `D` / `←` `→` | Left Stick |
| **Drift & Boost** | Hold `Shift` / `Space` | B / RB |
| **Restart Race** | `R` (on results screen) | — |
| **Change Camera** | `C` | — |

* **Drift Mechanic:** Hold `Shift` while steering through corners to build up your boost meter (3 tiers). Release for an instant speed burst!

---

## ✨ Highlights

* Procedural, infinite Gerstner ocean with six summed waves — no tiling, no seams, re-centred radial mesh.
* Dual-pass cel shading (inverted-hull silhouettes + G-buffer Sobel edges) for crisp, stylised ink outlines.
* Realistic buoyancy sampled across multiple hull points for dynamic pitch, roll and slam responses.
* Procedural riders and fully synthesised audio — every mesh, animation and sound is generated in code.

---

## 🏗️ Architecture & Conventions

Read `ARCHITECTURE.md` before changing rendering, wave, or physics code — it documents coordinate systems, the cel pipeline API, frame-loop order and performance budgets.

Quick orientation of the source layout:

```
src/
  core/       contracts, palette, config, input, maths, RNG
  water/      gerstner.ts (THE wave field), ocean mesh, water shader, foam
  render/     cel materials, procedural textures, post stack, sky
  boat/       hull geometry, buoyancy, handling
  rider/      rig + procedural animation
  race/       spline circuit, gates, lap logic, AI drivers
  camera/     spring-damped chase rig + harness presets
  ui/         canvas-2D HUD, minimap, screens
  audio/      Web Audio synthesis
harness/      Playwright retina screenshot harness
```

Two rules that matter more than anything else:

1. One wave field — `src/water/gerstner.ts` is the single source of truth. CPU calls `sampleOcean()`; GPU receives the same wave uniforms. If they diverge, boats will float incorrectly.
2. One palette — `src/core/palette.ts`. Avoid hard-coded colour literals in subsystems.

See `KNOWN_GAPS.md` for a measured list of outstanding work and performance targets.

---

## 🧪 Screenshot Harness & Deterministic Tests

A headless Playwright harness captures deterministic frames for visual regression and performance. Use it to verify shader changes against exact frames.

Common commands:

```bash
node harness/capture.mjs                        # full shot list
node harness/capture.mjs --shots=hero,foam_wake # named shots
node harness/capture.mjs --list                 # what each shot proves
node harness/capture.mjs --out=shots/round7 --dpr=2 --width=1600
```

The harness boots the game in a headless Chromium with a real Metal/ANGLE backend, seeds the RNG for deterministic simulation, and captures from named camera rigs so the same shot always produces the same frame.

The harness also exposes a window API when run with `?harness=1` so tests can drive simulation (`simulate()`), set camera presets (`setCameraPreset()`), set controls (`setControls()`), and gather metrics (`stats()`). See `ARCHITECTURE.md` for the complete table.

---

## 🐛 Debugging

Use `?debug=1` to display an on-screen perf overlay (fps, frame time, pixel ratio, draw calls, triangles). Add `?seed=<n>` to reproduce procedural variations.

---

## 🚀 Performance (measured)

Benchmarks are taken on the production build. Run:

```bash
npm run build && node harness/perf.mjs --seconds=14 --dpr=2
```

Measured on Apple MacBook Air M4 at `1440×810` (Device Pixel Ratio: `2.0`):

| Metric | Result | Target Budget |
|---|---|---|
| **Mean Frame Time** | **16.75 ms** (~59.7 FPS) | < 16.6 ms |
| **Median (p50)** | **16.70 ms** | — |
| **p95** | **17.40 ms** | — |
| **Draw Calls** | **73** | < 220 |
| **Triangles** | **200k** | < 1.6 M |
| **Adaptive Pixel Ratio** | **2.00 (Full Resolution)** | — |

Performance measurement is intentional: the adaptive pixel-ratio controller samples median frame time, backs off quickly when the budget is exceeded, and climbs slowly to avoid oscillation.

---

## 🛠️ Tech Stack

* **Core:** TypeScript, Three.js (r169+)
* **Build Tool:** Vite
* **Audio & FX:** Web Audio API
* **Testing / Harness:** Playwright
* **Deployment:** Vercel

---

## Contributing

Please read `ARCHITECTURE.md` and `KNOWN_GAPS.md` before proposing rendering, physics or audio changes. Keep changes small and verify visually with the harness.

If you'd like, I can open a branch and a PR with this README change — tell me the branch name you'd prefer or I can push to `readme/update`.
