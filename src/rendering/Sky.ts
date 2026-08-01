import * as THREE from 'three';
import { skyVert, skyFrag } from '../shaders/cel';

/**
 * Sky — gradient dome + cel clouds + sun disc with stylized flare
 * The dome is large and rendered first (renderOrder -1) with depth write off
 */
export class Sky {
  mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  readonly sunDir: THREE.Vector3 = new THREE.Vector3(0.5, 0.8, 0.3).normalize();

  constructor(scene: THREE.Scene) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: skyVert,
      fragmentShader: skyFrag,
      uniforms: {
        uTime:   { value: 0 },
        uSunDir: { value: this.sunDir },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });

    const geo = new THREE.SphereGeometry(900, 32, 16);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  update(time: number, cameraPos: THREE.Vector3): void {
    this.mesh.position.copy(cameraPos);
    this.material.uniforms.uTime.value = time;
  }
}
