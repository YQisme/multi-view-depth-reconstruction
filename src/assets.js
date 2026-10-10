/**
 * Asset loader + pose helpers.
 * Manifest pose is user 3D coords (x, y, z) with z = height.
 * Three.js mapping: (x, y, z)_three = (y, z, x)_user
 */

import * as THREE from 'three';

let cachedManifest = null;

export async function loadManifest(url = '/assets/manifest.json') {
  if (cachedManifest) return cachedManifest;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`无法加载资源清单：${url}`);
  cachedManifest = await res.json();
  return cachedManifest;
}

/** Clear cache after HMR / remount. */
export function clearManifestCache() {
  cachedManifest = null;
}

export function getCameras(manifest) {
  if (!manifest?.cameras?.length) {
    throw new Error('资源清单中没有 cameras');
  }
  return manifest.cameras;
}

/** user (x,y,z) z-up → Three.js y-up: three(x,y,z) = user(y, z, x) */
export function userToThree(pose, out = new THREE.Vector3()) {
  return out.set(pose.y ?? 0, pose.z ?? 0, pose.x ?? 0);
}

export function threeToUser(v) {
  return { x: v.z, y: v.x, z: v.y };
}

export function getLookAtTarget(manifest) {
  const la = manifest.lookAt;
  if (la) return userToThree(la);
  const cams = getCameras(manifest);
  const c = new THREE.Vector3();
  for (const cam of cams) c.add(userToThree(cam.pose || {}));
  c.multiplyScalar(1 / cams.length);
  c.y = 1.0;
  return c;
}

export function getCameraPoses(manifest) {
  return getCameras(manifest).map((cam) => ({
    id: cam.id,
    name: cam.name ?? cam.id,
    x: cam.pose?.x ?? 0,
    y: cam.pose?.y ?? 0,
    z: cam.pose?.z ?? 2.5,
    pitch: cam.pose?.pitch,
    yaw: cam.pose?.yaw,
  }));
}

export async function loadCameraAssets(loadImageData, manifest) {
  const cameras = getCameras(manifest);
  return Promise.all(
    cameras.map(async (cam) => {
      const [color, depth] = await Promise.all([
        loadImageData(cam.color),
        loadImageData(cam.depth),
      ]);
      return {
        id: cam.id,
        name: cam.name ?? cam.id,
        pose: {
          x: cam.pose?.x ?? 0,
          y: cam.pose?.y ?? 0,
          z: cam.pose?.z ?? 2.5,
          pitch: cam.pose?.pitch,
          yaw: cam.pose?.yaw,
        },
        color,
        depth,
      };
    }),
  );
}

/** Typical room span used for depth scale (max pairwise XY distance). */
export function maxPairwiseDistance(poses) {
  let max = 0;
  for (let i = 0; i < poses.length; i++) {
    for (let j = i + 1; j < poses.length; j++) {
      const dx = (poses[i].x ?? 0) - (poses[j].x ?? 0);
      const dy = (poses[i].y ?? 0) - (poses[j].y ?? 0);
      max = Math.max(max, Math.hypot(dx, dy));
    }
  }
  return max;
}
