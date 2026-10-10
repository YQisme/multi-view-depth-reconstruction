"""Convert Depth Anything V2 Spectral_r colorized depth maps to grayscale PNGs."""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "assets"


def build_lut(n: int = 1024) -> cKDTree:
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


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    tree, n = build_lut()
    for i in (1, 2):
        rgb = np.array(Image.open(ROOT / f"{i}.webp").convert("RGB"))
        gray = colorized_to_gray(rgb, tree, n)
        Image.fromarray(gray).resize((1024, 768), Image.BILINEAR).save(
            OUT / f"{i}_depth.png"
        )
        Image.open(ROOT / f"{i}.jpg").resize((2048, 1536), Image.LANCZOS).save(
            OUT / f"{i}.jpg", quality=88
        )
        print(f"wrote {OUT / f'{i}_depth.png'} and color image")


if __name__ == "__main__":
    main()
