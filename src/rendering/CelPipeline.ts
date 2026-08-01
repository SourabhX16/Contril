import * as THREE from 'three';
import { toonVert, toonFrag, outlineVert, outlineFrag } from '../shaders/cel';

// Palette constants
export const PALETTE = {
  inkBlack:    new THREE.Color(0x0a0516),
  rimLight:    new THREE.Color(0xff9966),
  specular:    new THREE.Color(0xfff8e0),
  sunDir:      new THREE.Vector3(0.5, 0.8, 0.3).normalize(),
};

export interface CelMaterialOptions {
  baseColor: THREE.Color;
  shadowColor?: THREE.Color;
  rimColor?: THREE.Color;
  specColor?: THREE.Color;
}

/**
 * CelPipeline — factory for toon ShaderMaterials + outline meshes
 *
 * Optimizations:
 * - Single shared ramp texture (not per-material)
 * - Cached list of materials with uCamPos (avoids full scene traversal)
 */
export class CelPipeline {
  private sunDir: THREE.Vector3;
  private rampTexture: THREE.DataTexture;

  /** All materials that have a uCamPos uniform (for efficient updates) */
  private camPosMaterials: THREE.ShaderMaterial[] = [];

  constructor(sunDir: THREE.Vector3) {
    this.sunDir = sunDir;
    this.rampTexture = this.buildRampTexture();
  }

  /** Create the main toon material for an entity */
  createMaterial(opts: CelMaterialOptions): THREE.ShaderMaterial {
    const base = opts.baseColor;
    // Shadow: darken and shift hue toward blue
    const shadow = opts.shadowColor ?? new THREE.Color(
      base.r * 0.25,
      base.g * 0.25 + 0.05,
      base.b * 0.35 + 0.1
    );
    const mat = new THREE.ShaderMaterial({
      vertexShader: toonVert,
      fragmentShader: toonFrag,
      uniforms: {
        uBaseColor:   { value: base },
        uShadowColor: { value: shadow },
        uRimColor:    { value: opts.rimColor ?? PALETTE.rimLight },
        uSpecColor:   { value: opts.specColor ?? PALETTE.specular },
        uSunDir:      { value: this.sunDir },
        uCamPos:      { value: new THREE.Vector3() },
        uRamp:        { value: this.rampTexture }, // shared ramp
      },
    });
    this.camPosMaterials.push(mat);
    return mat;
  }

  /** Build a 1D 4-band ramp texture (NearestFilter, no interpolation) */
  private buildRampTexture(): THREE.DataTexture {
    const data = new Uint8Array([
      // band 0: deep shadow (15%)
      38, 20, 40, 255,
      // band 1: mid-dark (42%)
      107, 70, 120, 255,
      // band 2: lit (72%)
      184, 150, 200, 255,
      // band 3: highlight (100%)
      255, 248, 230, 255,
    ]);
    const tex = new THREE.DataTexture(data, 4, 1, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Add inverted-hull outline to a mesh.
   * Returns the outline mesh (add it to the same parent as the original).
   */
  addOutline(
    geo: THREE.BufferGeometry,
    parent: THREE.Object3D,
    width = 0.08
  ): THREE.Mesh {
    const smoothGeo = this.smoothNormals(geo);
    const outlineMat = new THREE.ShaderMaterial({
      vertexShader: outlineVert,
      fragmentShader: outlineFrag,
      uniforms: {
        uOutlineWidth:  { value: width },
        uOutlineColor:  { value: PALETTE.inkBlack },
        uCamPos:        { value: new THREE.Vector3() },
      },
      side: THREE.BackSide,
    });
    const mesh = new THREE.Mesh(smoothGeo, outlineMat);
    mesh.renderOrder = 1;
    parent.add(mesh);

    this.camPosMaterials.push(outlineMat);
    return mesh;
  }

  /**
   * Update camera position in ALL registered materials.
   * O(N) where N = number of materials, not scene objects.
   * Much faster than full scene traversal.
   */
  updateCamPos(_scene: THREE.Scene, camPos: THREE.Vector3): void {
    for (let i = 0; i < this.camPosMaterials.length; i++) {
      const mat = this.camPosMaterials[i];
      if (mat.uniforms.uCamPos) {
        mat.uniforms.uCamPos.value.copy(camPos);
      }
    }
  }

  /**
   * Smooth normals by averaging normals at coincident vertex positions.
   * Critical for outline to look correct at sharp model edges.
   */
  private smoothNormals(geo: THREE.BufferGeometry): THREE.BufferGeometry {
    const clone = geo.clone();
    clone.computeVertexNormals();

    const positions = clone.getAttribute('position');
    const normals = clone.getAttribute('normal');
    if (!positions || !normals) return clone;

    const count = positions.count;
    // Group normals by position (using string key for exact match)
    const normalMap = new Map<string, { sum: THREE.Vector3; indices: number[] }>();

    for (let i = 0; i < count; i++) {
      const key = `${positions.getX(i).toFixed(4)},${positions.getY(i).toFixed(4)},${positions.getZ(i).toFixed(4)}`;
      if (!normalMap.has(key)) {
        normalMap.set(key, { sum: new THREE.Vector3(), indices: [] });
      }
      const entry = normalMap.get(key)!;
      entry.sum.x += normals.getX(i);
      entry.sum.y += normals.getY(i);
      entry.sum.z += normals.getZ(i);
      entry.indices.push(i);
    }

    // Write averaged normals back
    for (const entry of normalMap.values()) {
      entry.sum.normalize();
      for (const idx of entry.indices) {
        normals.setXYZ(idx, entry.sum.x, entry.sum.y, entry.sum.z);
      }
    }
    normals.needsUpdate = true;

    return clone;
  }
}
