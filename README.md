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

## ✨ Features & Architecture

* **Infinite Gerstner Ocean:** 6-wave procedural swell system calculated on CPU & GPU without seams or tiling repetition.
* **Dual-Pass Cel Shading:** Inverted-hull silhouettes combined with MRT G-buffer Sobel edge detection for crisp ink outlines.
* **Realistic Buoyancy Physics:** Hull height sampled across 6 hull points for dynamic pitch, roll, and wave trough impacts.
* **Procedural Riders & Synthesised Audio:** Skeletal animation and Web Audio engine sounds tracking real-time RPM, speed, and impacts—100% code generated.

---

## 🚀 Performance Benchmarks (Apple MacBook Air M4)

Measured on production build at `1440×810` (Device Pixel Ratio: `2.0`):

```bash
npm run build && node harness/perf.mjs --seconds=14 --dpr=2
```

| Metric | Result | Target Budget |
|---|---|---|
| **Mean Frame Time** | **16.75 ms** (~59.7 FPS) | < 16.6 ms |
| **Median (p50)** | **16.70 ms** | — |
| **p95** | **17.40 ms** | — |
| **Draw Calls** | **73** | < 220 |
| **Triangles** | **200k** | < 1.6 M |
| **Adaptive Pixel Ratio** | **2.00 (Full Resolution)** | — |

---

## 🛠️ Tech Stack

* **Core:** TypeScript, Three.js (r169+)
* **Build Tool:** Vite
* **Audio & FX:** Web Audio API
* **Deployment:** Vercel
