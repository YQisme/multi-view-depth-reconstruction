import * as THREE from 'three';

/**
 * World axes in USER coordinates (x,y horizontal, z up/height).
 * Mapped to Three.js as: user(x,y,z) → three(y, z, x)
 */
export function createWorldAxes({
  size = 2.2,
  origin = new THREE.Vector3(0, 0, 0),
} = {}) {
  const root = new THREE.Group();
  root.name = 'worldAxes';
  root.position.copy(origin);

  // User X → Three +Z (red)
  root.add(makeAxisArrow(new THREE.Vector3(0, 0, 1), size, 0xff3355, 'X'));
  // User Y → Three +X (green)
  root.add(makeAxisArrow(new THREE.Vector3(1, 0, 0), size, 0x33dd66, 'Y'));
  // User Z (height) → Three +Y (blue)
  root.add(makeAxisArrow(new THREE.Vector3(0, 1, 0), size, 0x4488ff, 'Z'));

  // Origin marker
  const originDot = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  root.add(originDot);

  return root;
}

function makeAxisArrow(dir, length, color, label) {
  const group = new THREE.Group();
  const n = dir.clone().normalize();
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: true });

  const shaftLen = length * 0.82;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, shaftLen, 10), mat);
  shaft.position.copy(n.clone().multiplyScalar(shaftLen * 0.5));
  shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
  group.add(shaft);

  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.24, 14), mat);
  cone.position.copy(n.clone().multiplyScalar(length * 0.9));
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
  group.add(cone);

  const sprite = makeLabelSprite(label, color);
  sprite.position.copy(n.clone().multiplyScalar(length * 1.12));
  sprite.scale.set(0.42, 0.42, 0.42);
  group.add(sprite);

  return group;
}

function makeLabelSprite(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);

  ctx.font = 'bold 72px Segoe UI, Microsoft YaHei, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.strokeText(text, 64, 64);
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.fillText(text, 64, 64);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 999;
  return sprite;
}
