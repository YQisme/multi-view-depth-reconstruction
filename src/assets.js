/**
 * Central asset loader. All image paths come from /assets/manifest.json.
 */

let cachedManifest = null;

export async function loadManifest(url = '/assets/manifest.json') {
  if (cachedManifest) return cachedManifest;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`无法加载资源清单：${url}`);
  cachedManifest = await res.json();
  return cachedManifest;
}

export function getCameras(manifest) {
  if (!manifest?.cameras?.length) {
    throw new Error('资源清单中没有 cameras');
  }
  return manifest.cameras;
}

/**
 * Load color + depth ImageData for every camera in the manifest.
 * Returns [{ id, name, color, depth }, ...]
 */
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
        color,
        depth,
      };
    }),
  );
}

export function applyManifestPriors(params, manifest) {
  const p = manifest?.priors;
  if (!p) return;
  if (typeof p.camHeight === 'number') params.camHeight = p.camHeight;
  if (typeof p.baseline === 'number') params.baseline = p.baseline;
  if (Array.isArray(p.yaw) && p.yaw.length >= 2) {
    params.yaw1 = p.yaw[0];
    params.yaw2 = p.yaw[1];
  }
  if (Array.isArray(p.pitch) && p.pitch.length >= 2) {
    params.pitch1 = p.pitch[0];
    params.pitch2 = p.pitch[1];
  }
}
