import * as THREE from 'three';
import { CelPipeline } from '../rendering/CelPipeline';
import { sampleGerstnerHeight } from '../physics/WaveQuery';

/**
 * Race course — CatmullRomCurve3 circuit with interesting layout:
 * - Long back straight
 * - Sharp hairpin (left)
 * - Wide sweeping S-bend
 * - Chicane
 * - Swell-crossing section (boats get airtime)
 * - Fast straight home
 *
 * Uses pre-computed lookup table for O(1) progress queries instead of O(N) brute force.
 */

export const COURSE_WAYPOINTS: THREE.Vector3[] = [
  new THREE.Vector3(  0,    0,    0   ),
  new THREE.Vector3( 60,   0,   -20  ),
  new THREE.Vector3(120,   0,   -50  ),
  new THREE.Vector3(180,   0,   -40  ),
  new THREE.Vector3(220,   0,   -10  ),
  new THREE.Vector3(230,   0,    30  ),
  new THREE.Vector3(210,   0,    60  ),
  new THREE.Vector3(160,   0,    75  ),
  new THREE.Vector3( 90,   0,    90  ),
  new THREE.Vector3( 40,   0,    80  ),
  new THREE.Vector3( 20,   0,    55  ),
  new THREE.Vector3( 10,   0,    30  ),
  new THREE.Vector3(-20,   0,    10  ),
  new THREE.Vector3(-30,   0,   -15  ),
  new THREE.Vector3(-10,   0,   -20  ),
];

export const TOTAL_LAPS = 3;

// Lookup table resolution for progress queries
const LUT_RESOLUTION = 500;

export class Course {
  curve: THREE.CatmullRomCurve3;
  totalLength: number;

  racingLineMesh: THREE.Mesh;
  private racingLineGeo: THREE.BufferGeometry;
  gates: THREE.Group[] = [];
  /** Direct references to halo meshes — avoid traverse() each frame */
  private gateHalos: THREE.Mesh[] = [];

  private readonly NUM_GATES = 12;

  // Pre-computed lookup table for fast progress queries
  private lutPoints: THREE.Vector3[] = [];
  private lutT: number[] = [];

  constructor(scene: THREE.Scene, cel?: CelPipeline) {
    this.curve = new THREE.CatmullRomCurve3(COURSE_WAYPOINTS, true, 'catmullrom', 0.5);
    this.totalLength = this.curve.getLength();

    // Build lookup table
    for (let i = 0; i < LUT_RESOLUTION; i++) {
      const t = i / LUT_RESOLUTION;
      this.lutPoints.push(this.curve.getPoint(t));
      this.lutT.push(t);
    }

    this.racingLineGeo = new THREE.BufferGeometry();
    const racingLineMat = new THREE.MeshBasicMaterial({
      color: 0x00ff88,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.racingLineMesh = new THREE.Mesh(this.racingLineGeo, racingLineMat);
    this.racingLineMesh.renderOrder = 2;
    this.racingLineMesh.frustumCulled = false;
    scene.add(this.racingLineMesh);

    this.buildGates(scene, cel);
  }

  private buildGates(scene: THREE.Scene, cel?: CelPipeline): void {
    const gateColor = new THREE.Color(0x00ff88);

    for (let i = 0; i < this.NUM_GATES; i++) {
      const t = (i + 0.5) / this.NUM_GATES;
      const point = this.curve.getPoint(t);
      const tangent = this.curve.getTangent(t);

      const gate = new THREE.Group();
      gate.position.copy(point);
      gate.position.y = 1.5;
      gate.rotation.y = Math.atan2(tangent.x, tangent.z);

      // Gate posts — use cel material if available for consistency
      this.makeGatePost(gate, -4, gateColor, cel);
      this.makeGatePost(gate,  4, gateColor, cel);

      // Top bar
      const barGeo = new THREE.BoxGeometry(8.5, 0.3, 0.3);
      const barMat = cel
        ? cel.createMaterial({ baseColor: gateColor })
        : new THREE.MeshBasicMaterial({ color: 0x00ff88 });
      const bar = new THREE.Mesh(barGeo, barMat);
      bar.position.y = 2.5;
      gate.add(bar);

      this.gates.push(gate);
      scene.add(gate);
    }
  }

  private makeGatePost(parent: THREE.Group, x: number, color: THREE.Color, cel?: CelPipeline): void {
    const geo = new THREE.CylinderGeometry(0.18, 0.22, 5, 8);
    const mat = cel
      ? cel.createMaterial({ baseColor: color })
      : new THREE.MeshBasicMaterial({ color: color.getHex() });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 0, 0);
    parent.add(mesh);

    // Glowing halo
    const haloGeo = new THREE.SphereGeometry(0.4, 8, 6);
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0x88ffcc,
      transparent: true,
      opacity: 0.6,
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.position.set(x, 2.8, 0);
    parent.add(halo);
    // Store direct reference
    this.gateHalos.push(halo);
  }

  update(time: number): void {
    // Animate gates — direct references, no traverse()
    for (let i = 0; i < this.gates.length; i++) {
      this.gates[i].position.y = 1.5 + Math.sin(time * 1.5 + i * 0.8) * 0.15;
    }
    for (let i = 0; i < this.gateHalos.length; i++) {
      const haloIdx = Math.floor(i / 2); // 2 halos per gate
      (this.gateHalos[i].material as THREE.MeshBasicMaterial).opacity =
        0.4 + Math.sin(time * 3 + haloIdx) * 0.3;
    }
  }

  /**
   * Fast progress query using pre-computed lookup table.
   * O(N) scan of LUT instead of N×getPoint() calls.
   */
  getProgress(pos: THREE.Vector3): { t: number; point: THREE.Vector3 } {
    let bestT = 0;
    let bestDist = Infinity;
    let bestPoint = this.lutPoints[0];

    for (let i = 0; i < LUT_RESOLUTION; i++) {
      const pt = this.lutPoints[i];
      // Distance squared (XZ plane — ignore Y for track progress)
      const dx = pos.x - pt.x;
      const dz = pos.z - pt.z;
      const d = dx * dx + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        bestT = this.lutT[i];
        bestPoint = pt;
      }
    }

    return { t: bestT, point: bestPoint };
  }

  isWrongWay(pos: THREE.Vector3, velocity: THREE.Vector3): boolean {
    const { t } = this.getProgress(pos);
    const tangent = this.curve.getTangent(t);
    return velocity.dot(tangent) < -2.0;
  }

  getStartTransform(): { position: THREE.Vector3; direction: THREE.Vector3 } {
    return {
      position: this.curve.getPoint(0).clone(),
      direction: this.curve.getTangent(0).clone(),
    };
  }

  /** Get auto-computed minimap bounds from actual waypoints */
  getBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const wp of COURSE_WAYPOINTS) {
      minX = Math.min(minX, wp.x);
      maxX = Math.max(maxX, wp.x);
      minZ = Math.min(minZ, wp.z);
      maxZ = Math.max(maxZ, wp.z);
    }
    // Add padding
    const pad = 20;
    return { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
  }
}
