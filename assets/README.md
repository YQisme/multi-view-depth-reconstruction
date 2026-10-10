# 图像资源目录

## 结构

```
assets/
  source/                 # 原始采集（勿直接给前端用）
    cam01/
      color.jpg           # RGB 原图
      depth.webp          # Depth Anything V2 伪彩色深度图
    cam02/
      color.jpg
      depth.webp

public/assets/            # 前端可访问的处理后资源
  manifest.json           # 统一清单（路径 + 物理先验）
  cam01/
    color.jpg
    depth.png             # 灰度深度
  cam02/
    color.jpg
    depth.png
```

## 新增/更换摄像头画面

1. 把原图和深度图放到 `assets/source/<camId>/`
2. 在 `public/assets/manifest.json` 的 `cameras` 里登记
3. 运行：

```bash
npm run prepare-assets
```

前端只通过 `src/assets.js` + `manifest.json` 读取资源，不要再写死图片路径。
