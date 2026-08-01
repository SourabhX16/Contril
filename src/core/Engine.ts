import * as THREE from 'three';

/**
 * Engine — renderer setup with adaptive pixel ratio and performance monitoring
 */
export class Engine {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  private fpsHistory: number[] = [];
  private pixelRatio: number;

  constructor() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // we do our own edge detection
      powerPreference: 'high-performance',
      stencil: false,
    });

    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = false;
    this.renderer.sortObjects = true;
    this.renderer.info.autoReset = true;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    // Adaptive pixel ratio: start high, lower under load
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2.0);
    this.renderer.setPixelRatio(this.pixelRatio);

    document.body.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = null; // no fog in cel-shaded style

    window.addEventListener('resize', () => this.onResize());
  }

  private onResize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(this.pixelRatio); // restore DPR after resize
  }

  /** Adaptive pixel ratio: lower if FPS drops below threshold */
  adaptPixelRatio(fps: number): void {
    this.fpsHistory.push(fps);
    if (this.fpsHistory.length > 30) this.fpsHistory.shift();
    const avgFPS = this.fpsHistory.reduce((a, b) => a + b) / this.fpsHistory.length;

    if (avgFPS < 50 && this.pixelRatio > 1.0) {
      this.pixelRatio = Math.max(this.pixelRatio - 0.25, 1.0);
      this.renderer.setPixelRatio(this.pixelRatio);
    } else if (avgFPS > 58 && this.pixelRatio < 2.0) {
      const maxDPR = Math.min(window.devicePixelRatio || 1, 2.0);
      this.pixelRatio = Math.min(this.pixelRatio + 0.25, maxDPR);
      this.renderer.setPixelRatio(this.pixelRatio);
    }
  }
}
