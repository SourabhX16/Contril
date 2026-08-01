import * as THREE from 'three';
import { waterVert, waterFrag } from '../shaders/water';
import { WAVES } from '../physics/WaveQuery';

/**
 * WaterSystem — infinite projected-grid ocean with 5 Gerstner waves
 * The grid recenters to the camera every frame (no seams, no tiling repetition).
 */
export class WaterSystem {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  private geometry: THREE.BufferGeometry;

  // Grid config
  private readonly GRID_SIZE = 512;   // world units (half-extent each side)
  private readonly SEGMENTS = 200;    // vertex count per side (higher = smoother waves)

  constructor(scene: THREE.Scene) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: waterVert,
      fragmentShader: waterFrag,
      uniforms: this.buildUniforms(),
      side: THREE.FrontSide,
      fog: false,
    });

    this.geometry = this.buildGrid();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false; // always render (it covers the viewport)
    this.mesh.renderOrder = 0;
    scene.add(this.mesh);
  }

  private buildUniforms(): Record<string, THREE.IUniform> {
    const u: Record<string, THREE.IUniform> = {
      uTime:       { value: 0 },
      uCameraX:    { value: 0 },
      uCameraZ:    { value: 0 },
      uSunDir:     { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
      uCamPos:     { value: new THREE.Vector3() },
    };

    WAVES.forEach((w, i) => {
      u[`uWave${i}`]      = { value: new THREE.Vector4(w.dir[0], w.dir[1], w.amplitude, w.wavelength) };
      u[`uWaveSpeed${i}`] = { value: w.speed };
      u[`uSteepness${i}`] = { value: w.steepness };
    });

    return u;
  }

  private buildGrid(): THREE.BufferGeometry {
    // Flat PlaneGeometry — displaced in shader
    const geo = new THREE.PlaneGeometry(
      this.GRID_SIZE * 2,
      this.GRID_SIZE * 2,
      this.SEGMENTS,
      this.SEGMENTS
    );
    geo.rotateX(-Math.PI / 2); // horizontal plane
    return geo;
  }

  update(time: number, cameraPos: THREE.Vector3): void {
    // Recenter grid to camera (creates infinite ocean illusion)
    this.mesh.position.x = cameraPos.x;
    this.mesh.position.z = cameraPos.z;

    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uCameraX.value = cameraPos.x;
    u.uCameraZ.value = cameraPos.z;
    u.uCamPos.value.copy(cameraPos);
  }

  setSunDirection(dir: THREE.Vector3): void {
    this.material.uniforms.uSunDir.value.copy(dir);
  }
}
