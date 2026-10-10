import * as THREE from 'three';

/**
 * Place two opposite-facing reconstructions using physical priors.
 * Known camera height + baseline is far more stable than free Sim(3) ICP
 * on relative Depth-Anything maps.
 */
export function placeWithPriors({
  camHeight = 1.8,
  baseline = 5.0,
  yaw1 = 0,
  yaw2 = 180,
  pitch1 = -6,
  pitch2 = -6,
  offsetX1 = 0,
  offsetX2 = 0,
  depthScale1 = 1,
  depthScale2 = 1,
} = {}) {
  const half = baseline * 0.5;

  const m1 = composeCameraMatrix({
    x: offsetX1,
    y: camHeight,
    z: half,
    pitchDeg: pitch1,
    yawDeg: yaw1,
    scale: depthScale1,
  });

  const m2 = composeCameraMatrix({
    x: offsetX2,
    y: camHeight,
    z: -half,
    pitchDeg: pitch2,
    yawDeg: yaw2,
    scale: depthScale2,
  });

  return {
    m1,
    m2,
    scale: depthScale2 / Math.max(1e-6, depthScale1),
    rmse: NaN,
    inlierRatio: 0,
    hypothesis: 'physical-prior',
    mode: 'prior',
  };
}

/**
 * Estimate a metric scale so each view's "far wall" roughly matches baseline.
 * Returns per-view scale factors around 1.0.
 */
export function estimateDepthScales(mesh1, mesh2, baseline, farDepth) {
  const target = baseline * 0.92;
  const d1 = estimateFarDistance(mesh1);
  const d2 = estimateFarDistance(mesh2);
  const fallback = farDepth * 0.85;
  const s1 = clamp(target / Math.max(0.5, d1 || fallback), 0.55, 1.8);
  const s2 = clamp(target / Math.max(0.5, d2 || fallback), 0.55, 1.8);
  return { depthScale1: s1, depthScale2: s2, far1: d1, far2: d2 };
}

/**
 * Small rigid refinement of view2 onto view1. Does not free-scale wildly.
 */
export function refineRigid(mesh1, mesh2, m1, m2, {
  iterations = 12,
  maxDist = 0.35,
  maxSamples = 12000,
} = {}) {
  const srcLocal = samplePoints(mesh2, maxSamples);
  const dstLocal = samplePoints(mesh1, maxSamples);
  const dst = dstLocal.map((p) => p.clone().applyMatrix4(m1));
  let T = m2.clone();
  let cur = srcLocal.map((p) => p.clone().applyMatrix4(T));
  let rmse = Infinity;
  let inlierRatio = 0;
  let distCap = maxDist;
  const index = new HashGrid(dst, Math.max(0.1, distCap));

  for (let it = 0; it < iterations; it++) {
    const srcH = [];
    const dstH = [];
    for (let i = 0; i < cur.length; i += 2) {
      const nn = index.nearest(cur[i]);
      if (!nn) continue;
      if (nn.distanceTo(cur[i]) < distCap) {
        srcH.push(cur[i]);
        dstH.push(nn);
      }
    }
    if (srcH.length < 40) break;
    const step = kabschRigid(srcH, dstH);
    T = step.clone().multiply(T);
    cur = srcLocal.map((p) => p.clone().applyMatrix4(T));
    let sse = 0;
    for (let i = 0; i < srcH.length; i++) sse += srcH[i].distanceToSquared(dstH[i]);
    rmse = Math.sqrt(sse / srcH.length);
    inlierRatio = srcH.length / Math.max(1, Math.floor(cur.length / 2));
    distCap = Math.max(0.08, distCap * 0.9);
    index.rebuild(dst, Math.max(0.08, distCap));
  }

  return {
    m1: m1.clone(),
    m2: T,
    rmse,
    inlierRatio,
    hypothesis: 'prior+rigid-icp',
    mode: 'refine',
  };
}

function composeCameraMatrix({ x, y, z, pitchDeg, yawDeg, scale }) {
  const S = new THREE.Matrix4().makeScale(scale, scale, scale);
  const R = new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(pitchDeg),
      THREE.MathUtils.degToRad(yawDeg),
      0,
      'YXZ',
    ),
  );
  const T = new THREE.Matrix4().makeTranslation(x, y, z);
  // world = T * R * S * local
  return T.multiply(R).multiply(S);
}

function estimateFarDistance(mesh) {
  const pos = mesh.geometry.attributes.position;
  const uv = mesh.geometry.attributes.uv;
  const n = pos.count;
  const step = Math.max(1, Math.floor(n / 20000));
  const depths = [];
  for (let i = 0; i < n; i += step) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    // central band looking down the room
    if (u < 0.35 || u > 0.65) continue;
    if (v < 0.35 || v > 0.75) continue;
    const z = -pos.getZ(i);
    if (z > 0.8) depths.push(z);
  }
  if (depths.length < 30) {
    for (let i = 0; i < n; i += step * 2) {
      const z = -pos.getZ(i);
      if (z > 1) depths.push(z);
    }
  }
  if (!depths.length) return 0;
  depths.sort((a, b) => a - b);
  return percentile(depths, 0.85);
}

function samplePoints(mesh, maxCount) {
  const pos = mesh.geometry.attributes.position;
  const n = pos.count;
  const step = Math.max(1, Math.floor(n / maxCount));
  const points = [];
  for (let i = 0; i < n; i += step) {
    const p = new THREE.Vector3().fromBufferAttribute(pos, i);
    if (!Number.isFinite(p.x + p.y + p.z)) continue;
    if (-p.z < 0.05) continue;
    points.push(p);
  }
  return points;
}

function kabschRigid(src, dst) {
  const cs = centroid(src);
  const cd = centroid(dst);
  const H = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < src.length; i++) {
    const a = src[i].clone().sub(cs);
    const b = dst[i].clone().sub(cd);
    H[0][0] += a.x * b.x; H[0][1] += a.x * b.y; H[0][2] += a.x * b.z;
    H[1][0] += a.y * b.x; H[1][1] += a.y * b.y; H[1][2] += a.y * b.z;
    H[2][0] += a.z * b.x; H[2][1] += a.z * b.y; H[2][2] += a.z * b.z;
  }
  const { U, V } = svd3(H);
  let R = mul3(V, transpose3(U));
  if (det3(R) < 0) {
    V[0][2] *= -1; V[1][2] *= -1; V[2][2] *= -1;
    R = mul3(V, transpose3(U));
  }
  const t = cd.sub(apply3(R, cs));
  return matFromRT(R, t);
}

function svd3(A) {
  const AtA = mul3(transpose3(A), A);
  const { values, vectors: V } = eigenSym3(AtA);
  const order = [0, 1, 2].sort((i, j) => values[j] - values[i]);
  const Vord = [
    [V[0][order[0]], V[0][order[1]], V[0][order[2]]],
    [V[1][order[0]], V[1][order[1]], V[1][order[2]]],
    [V[2][order[0]], V[2][order[1]], V[2][order[2]]],
  ];
  const S = order.map((i) => Math.sqrt(Math.max(0, values[i])));
  const U = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let k = 0; k < 3; k++) {
    const col = apply3(A, new THREE.Vector3(Vord[0][k], Vord[1][k], Vord[2][k]));
    if (S[k] > 1e-10) col.multiplyScalar(1 / S[k]);
    else col.set(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0);
    U[0][k] = col.x; U[1][k] = col.y; U[2][k] = col.z;
  }
  return { U, V: Vord, S };
}

function eigenSym3(A) {
  const M = [A[0].slice(), A[1].slice(), A[2].slice()];
  const V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iter = 0; iter < 24; iter++) {
    let p = 0;
    let q = 1;
    let max = Math.abs(M[0][1]);
    if (Math.abs(M[0][2]) > max) {
      max = Math.abs(M[0][2]);
      p = 0;
      q = 2;
    }
    if (Math.abs(M[1][2]) > max) {
      max = Math.abs(M[1][2]);
      p = 1;
      q = 2;
    }
    if (max < 1e-12) break;
    const app = M[p][p];
    const aqq = M[q][q];
    const apq = M[p][q];
    const tau = (aqq - app) / (2 * apq);
    const t = Math.sign(tau) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;
    for (let k = 0; k < 3; k++) {
      const mkp = M[k][p];
      const mkq = M[k][q];
      M[k][p] = c * mkp - s * mkq;
      M[k][q] = s * mkp + c * mkq;
    }
    for (let k = 0; k < 3; k++) {
      const mpk = M[p][k];
      const mqk = M[q][k];
      M[p][k] = c * mpk - s * mqk;
      M[q][k] = s * mpk + c * mqk;
    }
    M[p][q] = 0;
    M[q][p] = 0;
    for (let k = 0; k < 3; k++) {
      const vkp = V[k][p];
      const vkq = V[k][q];
      V[k][p] = c * vkp - s * vkq;
      V[k][q] = s * vkp + c * vkq;
    }
  }
  return { values: [M[0][0], M[1][1], M[2][2]], vectors: V };
}

class HashGrid {
  constructor(points, cell) {
    this.rebuild(points, cell);
  }
  rebuild(points, cell) {
    this.cell = cell;
    this.map = new Map();
    for (const p of points) {
      const key = this.hash(p);
      let arr = this.map.get(key);
      if (!arr) {
        arr = [];
        this.map.set(key, arr);
      }
      arr.push(p);
    }
  }
  hash(p) {
    const c = this.cell;
    return `${Math.floor(p.x / c)},${Math.floor(p.y / c)},${Math.floor(p.z / c)}`;
  }
  nearest(p) {
    const c = this.cell;
    const ix = Math.floor(p.x / c);
    const iy = Math.floor(p.y / c);
    const iz = Math.floor(p.z / c);
    let best = null;
    let bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const arr = this.map.get(`${ix + dx},${iy + dy},${iz + dz}`);
          if (!arr) continue;
          for (const q of arr) {
            const d = p.distanceToSquared(q);
            if (d < bestD) {
              bestD = d;
              best = q;
            }
          }
        }
      }
    }
    return best;
  }
}

function matFromRT(R, t) {
  const m = new THREE.Matrix4();
  m.set(
    R[0][0], R[0][1], R[0][2], t.x,
    R[1][0], R[1][1], R[1][2], t.y,
    R[2][0], R[2][1], R[2][2], t.z,
    0, 0, 0, 1,
  );
  return m;
}

function centroid(points) {
  const c = new THREE.Vector3();
  if (!points.length) return c;
  for (const p of points) c.add(p);
  return c.multiplyScalar(1 / points.length);
}

function percentile(sorted, p) {
  const i = clamp((sorted.length - 1) * p, 0, sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  const t = i - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function transpose3(A) {
  return [
    [A[0][0], A[1][0], A[2][0]],
    [A[0][1], A[1][1], A[2][1]],
    [A[0][2], A[1][2], A[2][2]],
  ];
}

function mul3(A, B) {
  const C = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
    }
  }
  return C;
}

function det3(R) {
  return (
    R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) -
    R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) +
    R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0])
  );
}

function apply3(R, v) {
  return new THREE.Vector3(
    R[0][0] * v.x + R[0][1] * v.y + R[0][2] * v.z,
    R[1][0] * v.x + R[1][1] * v.y + R[1][2] * v.z,
    R[2][0] * v.x + R[2][1] * v.y + R[2][2] * v.z,
  );
}
