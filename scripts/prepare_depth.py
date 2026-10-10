"""Prepare web assets from source images listed in public/assets/manifest.json.

Reads Depth Anything V2 Spectral_r depth maps from assets/source/,
writes grayscale depth + resized color into public/assets/<camId>/.
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "public" / "assets" / "manifest.json"
COLOR_SIZE = (2048, 1536)
DEPTH_SIZE = (1024, 768)


def build_lut(n: int = 1024):
    cmap = plt.get_cmap("Spectral_r")
    lut = (cmap(np.linspace(0, 1, n))[:, :3] * 255).astype(np.float32)
    return cKDTree(lut), n


def colorized_to_gray(rgb: np.ndarray, tree: cKDTree, n: int) -> np.ndarray:
    h, w = rgb.shape[:2]
    small = np.array(Image.fromarray(rgb).resize((w // 2, h // 2), Image.BILINEAR))
    flat = small.reshape(-1, 3).astype(np.float32)
    _, idx = tree.query(flat, k=1, workers=-1)
    gray_s = (idx.astype(np.float32) / (n - 1) * 255).astype(np.uint8).reshape(
        small.shape[:2]
    )
    return np.array(Image.fromarray(gray_s).resize((w, h), Image.BILINEAR))


def load_manifest() -> dict:
    if not MANIFEST_PATH.exists():
        raise FileNotFoundError(f"missing manifest: {MANIFEST_PATH}")
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def process_camera(cam: dict, tree: cKDTree, n: int) -> None:
    cam_id = cam["id"]
    source = cam.get("source") or {}
    color_src = ROOT / source.get("color", f"assets/source/{cam_id}/color.jpg")
    depth_src = ROOT / source.get("depth", f"assets/source/{cam_id}/depth.webp")

    out_dir = ROOT / "public" / "assets" / cam_id
    out_dir.mkdir(parents=True, exist_ok=True)
    color_out = out_dir / "color.jpg"
    depth_out = out_dir / "depth.png"

    if not color_src.exists():
        raise FileNotFoundError(f"[{cam_id}] missing color: {color_src}")
    if not depth_src.exists():
        raise FileNotFoundError(f"[{cam_id}] missing depth: {depth_src}")

    rgb = np.array(Image.open(depth_src).convert("RGB"))
    gray = colorized_to_gray(rgb, tree, n)
    Image.fromarray(gray).resize(DEPTH_SIZE, Image.BILINEAR).save(depth_out)
    Image.open(color_src).resize(COLOR_SIZE, Image.LANCZOS).save(color_out, quality=88)

    # Keep manifest web paths consistent
    cam["color"] = f"/assets/{cam_id}/color.jpg"
    cam["depth"] = f"/assets/{cam_id}/depth.png"
    print(f"[{cam_id}] {color_out.relative_to(ROOT)} + {depth_out.relative_to(ROOT)}")


def main() -> None:
    manifest = load_manifest()
    cameras = manifest.get("cameras") or []
    if not cameras:
        raise RuntimeError("manifest.cameras is empty")

    tree, n = build_lut()
    for cam in cameras:
        process_camera(cam, tree, n)

    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"updated {MANIFEST_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
