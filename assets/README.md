# 图像资源目录

## 三维坐标约定

清单里的 `pose` 使用用户给定的三维坐标 **(x, y, z)**，单位米：

- **x, y**：水平面位置
- **z**：高度（当前四机均为 2.5）

映射到 Three.js（Y 轴向上）：

```
three(x, y, z) = user(y, z, x)
```

即：用户 X → 场景深度向，用户 Y → 场景水平向，用户 Z → 高度。

当前四机：

| 相机 | 坐标 (x, y, z) |
|------|----------------|
| cam01 | (0, 0, 2.5) |
| cam02 | (0, 3.8, 2.5) |
| cam03 | (4.7, 3.8, 2.5) |
| cam04 | (6.0, 0, 2.5) |

每台相机默认朝向 `lookAt`（桌面中心附近），可用面板里的「整体俯仰微调」调整。

## 目录结构

```
assets/source/<camId>/color.jpg + depth.webp
public/assets/manifest.json
public/assets/<camId>/color.jpg + depth.png
```

## 新增摄像头

1. 用 Depth Anything V2 在线 Demo 获取 **Spectral_r 伪彩**深度图（步骤见根目录 [README.md](../README.md#获取深度图depth-anything-v2-在线-demo)）
2. 放入 `assets/source/<camId>/`（`color.jpg` + `depth.webp`）
3. 在 `manifest.json` 登记路径与 `pose: {x,y,z}`
4. 运行 `npm run prepare-assets`
