import * as THREE from 'three';

/**
 * Build a textured mesh by unprojecting RGB + grayscale depth.
 * Depth Anything V2 Spectral_r (decoded): brighter ≈ closer.
 */
export function createDepthMesh({
  colorImage,
  depthData,
  colorWidth,
  colorHeight,
  depthWidth,
  depthHeight,
  stride = 2,
  fovDeg = 70,
  nearDepth = 0.6,
  farDepth = 8.5,
  invertDepth = false,
  depthGamma = 1.0,
  edgeThreshold = 0.08,
}) {
  const fy = (0.5 * colorHeight) / Math.tan(THREE.MathUtils.degToRad(fovDeg) * 0.5);
  const fx = fy;
  const cx = (colorWidth - 1) * 0.5;
  const cy = (colorHeight - 1) * 0.5;

  const cols = Math.floor((colorWidth - 1) / stride) + 1;
  const rows = Math.floor((colorHeight - 1) / stride) + 1;

  const positions = new Float32Array(cols * rows * 3);
  const uvs = new Float32Array(cols * rows * 2);
  const depths = new Float32Array(cols * rows);

  const sampleDepth = (x, y) => {
    const u = x / (colorWidth - 1);
    const v = y / (colorHeight - 1);
    const dx = Math.min(depthWidth - 1, Math.max(0, Math.round(u * (depthWidth - 1))));
    const dy = Math.min(depthHeight - 1, Math.max(0, Math.round(v * (depthHeight - 1))));
    const i = (dy * depthWidth + dx) * 4;
    let d = depthData[i] / 255;
    if (invertDepth) d = 1 - d;
    d = Math.pow(Math.min(1, Math.max(0, d)), depthGamma);
    return nearDepth + (1 - d) * (farDepth - nearDepth);
  };

  let p = 0;
  let t = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.min(colorWidth - 1, c * stride);
      const y = Math.min(colorHeight - 1, r * stride);
      const z = sampleDepth(x, y);
      const idx = r * cols + c;
      depths[idx] = z;

      positions[p] = ((x - cx) / fx) * z;
      positions[p + 1] = -((y - cy) / fy) * z;
      positions[p + 2] = -z;
      p += 3;

      uvs[t] = x / (colorWidth - 1);
      uvs[t + 1] = 1 - y / (colorHeight - 1);
      t += 2;
    }
  }

  const indices = [];
  const depthSpan = Math.max(1e-5, farDepth - nearDepth);
  const thresh = edgeThreshold * depthSpan;

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const i00 = r * cols + c;
      const i10 = i00 + 1;
      const i01 = i00 + cols;
      const i11 = i01 + 1;

      const d00 = depths[i00];
      const d10 = depths[i10];
      const d01 = depths[i01];
      const d11 = depths[i11];

      const jumpA = Math.max(Math.abs(d00 - d10), Math.abs(d00 - d01), Math.abs(d10 - d01));
      const jumpB = Math.max(Math.abs(d10 - d11), Math.abs(d01 - d11), Math.abs(d10 - d01));

      if (jumpA < thresh) indices.push(i00, i01, i10);
      if (jumpB < thresh) indices.push(i10, i01, i11);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const texture = new THREE.Texture(colorImage);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  texture.anisotropy = 8;

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.userData.texture = texture;
  return mesh;
}

export async function loadImageData(url) {
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return {
    data,
    width: canvas.width,
    height: canvas.height,
    image: img,
  };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.src = url;
  });
}
