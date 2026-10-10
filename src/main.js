import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { createDepthMesh, loadImageData } from './depthMesh.js';
import { placeWithPriors, estimateDepthScalesForViews } from './calibrate.js';
import { RoamControls } from './roamControls.js';
import {
  loadManifest,
  loadCameraAssets,
  getLookAtTarget,
  getCameraPoses,
  maxPairwiseDistance,
  userToThree,
  clearManifestCache,
} from './assets.js';
import { createWorldAxes } from './worldAxes.js';

const statusEl = document.getElementById('status');
const roamBanner = document.getElementById('roamBanner');
const roamHud = document.getElementById('roamHud');

const setStatus = (html) => {
  statusEl.innerHTML = html;
};

const params = {
  viewMode: '融合',
  controlMode: '轨道观察',
  fov: 78,
  nearDepth: 0.4,
  farDepth: 8,
  depthGamma: 0.95,
  edgeThreshold: 0.09,
  stride: 3,
  invertDepth: false,
  lookTilt: -18,
  autoDepthScale: true,
  blendMode: '半透明', // 不透明 | 半透明 | 视角跟随
  showGrid: true,
  showWorldAxes: true,
  showHelpers: true,
  eyeHeight: 1.7,
  walkSpeed: 2.4,
};

let renderer, scene, camera, controls, roam, gui;
let viewRoot;
let helpers;
let worldAxes;
let gridHelper;
let views = []; // { id, name, color, depth, mesh, group, axes, depthScale }
let assetManifest = null;
let poses = [];
let matrices = [];
let rebuilding = false;
let sceneBounds = null;
const clock = new THREE.Clock();
const orbitSnapshot = {
  position: new THREE.Vector3(),
  target: new THREE.Vector3(),
};
let viewModeController = null;
let depthScaleFolder = null;
const _viewDir = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
let lastFollowId = null;

init();

async function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.getElementById('app').appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0f14);
  scene.fog = new THREE.Fog(0x0b0f14, 16, 36);

  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 80);
  camera.position.set(8, 5, 6);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(2.7, 1.2, 1.9);
  controls.maxDistance = 30;
  controls.minDistance = 0.25;

  roam = new RoamControls(camera, renderer.domElement, {
    eyeHeight: params.eyeHeight,
    speed: params.walkSpeed,
  });
  roam.attach();
  roam.onLockChange = (locked) => {
    updateRoamUi(locked);
    if (!locked && params.controlMode === '漫游视角') {
      setStatus('<strong>漫游已暂停</strong><div class="hint">点击画面重新锁定指针，或切换回轨道观察</div>');
    }
  };

  roamBanner.addEventListener('click', () => {
    if (params.controlMode === '漫游视角') startRoam();
  });
  renderer.domElement.addEventListener('click', () => {
    if (params.controlMode === '漫游视角' && !roam.isLocked) startRoam();
  });

  scene.add(new THREE.AmbientLight(0xffffff, 1));
  gridHelper = new THREE.GridHelper(20, 40, 0x2a3a4e, 0x1a2433);
  gridHelper.visible = params.showGrid;
  scene.add(gridHelper);

  viewRoot = new THREE.Group();
  scene.add(viewRoot);

  // User-frame axes at origin (0,0,0): X红 Y绿 Z蓝(高度)
  worldAxes = createWorldAxes({ size: 2.4, origin: new THREE.Vector3(0, 0, 0) });
  worldAxes.visible = params.showWorldAxes;
  scene.add(worldAxes);

  helpers = new THREE.Group();
  helpers.visible = params.showHelpers;
  scene.add(helpers);

  setupGui();
  window.addEventListener('resize', onResize);

  setStatus('正在加载资源清单与图像…');
  try {
    clearManifestCache();
    assetManifest = await loadManifest();
    poses = getCameraPoses(assetManifest);
    views = await loadCameraAssets(loadImageData, assetManifest);
    if (views.length < 1) throw new Error('清单中至少需要一个摄像头资源');
    refreshViewModeOptions();
    refreshDepthScaleControls();
    await rebuildMeshes();
  } catch (err) {
    console.error(err);
    setStatus(`加载失败：${err.message}`);
  }

  animate();
}

function setupGui() {
  gui = new GUI({ title: '重建控制' });

  viewModeController = gui
    .add(params, 'viewMode', ['融合'])
    .name('显示')
    .onChange(applyVisibility);

  gui
    .add(params, 'controlMode', ['轨道观察', '漫游视角'])
    .name('交互模式')
    .onChange(applyControlMode);

  const roamFolder = gui.addFolder('漫游参数');
  roamFolder.add(params, 'eyeHeight', 0.8, 2.2, 0.01).name('视点高度').onChange((v) => {
    roam.eyeHeight = v;
  });
  roamFolder.add(params, 'walkSpeed', 0.6, 6, 0.05).name('步行速度').onChange((v) => {
    roam.speed = v;
  });
  roamFolder.add({ enter: () => startRoam() }, 'enter').name('进入漫游');
  roamFolder.add({ spawn: () => startRoam(true) }, 'spawn').name('传送到房间中心');

  const depthFolder = gui.addFolder('深度映射');
  depthFolder.add(params, 'fov', 40, 110, 0.5).name('相机 FOV').onFinishChange(rebuildMeshes);
  depthFolder.add(params, 'nearDepth', 0.15, 3, 0.01).name('近平面').onFinishChange(rebuildMeshes);
  depthFolder.add(params, 'farDepth', 3, 18, 0.05).name('远平面').onFinishChange(rebuildMeshes);
  depthFolder.add(params, 'depthGamma', 0.4, 2.2, 0.01).name('深度伽马').onFinishChange(rebuildMeshes);
  depthFolder.add(params, 'edgeThreshold', 0.02, 0.3, 0.005).name('边缘断裂').onFinishChange(rebuildMeshes);
  depthFolder.add(params, 'stride', 1, 4, 1).name('采样步进').onFinishChange(rebuildMeshes);
  depthFolder.add(params, 'invertDepth').name('反转深度').onFinishChange(rebuildMeshes);

  const priorFolder = gui.addFolder('三维位姿');
  priorFolder.add(params, 'lookTilt', -40, 0, 0.5).name('整体俯仰微调').onFinishChange(applyPriors);
  priorFolder.add(params, 'autoDepthScale').name('按房间尺度估深度').onFinishChange(applyPriors);
  depthScaleFolder = priorFolder.addFolder('各视角深度尺度');
  priorFolder.add({ run: () => applyPriors() }, 'run').name('应用位姿');

  gui
    .add(params, 'blendMode', ['不透明', '半透明', '视角跟随'])
    .name('叠加方式')
    .onChange(() => {
      lastFollowId = null;
      applyVisibility();
    });
  gui.add(params, 'showGrid').name('显示网格').onChange((v) => {
    if (gridHelper) gridHelper.visible = v;
  });
  gui.add(params, 'showWorldAxes').name('显示 XYZ 轴').onChange((v) => {
    if (worldAxes) worldAxes.visible = v;
  });
  gui.add(params, 'showHelpers').name('显示相机坐标').onChange((v) => {
    helpers.visible = v;
  });
  gui.add({
    reset: () => {
      if (params.controlMode === '轨道观察') controls.reset();
    },
  }, 'reset').name('重置视角');
  gui.add({ fit: fitView }, 'fit').name('框住场景');
}

function refreshViewModeOptions() {
  const options = ['融合', ...views.map((v) => v.name)];
  if (!options.includes(params.viewMode)) params.viewMode = '融合';
  if (viewModeController) {
    viewModeController.destroy();
    viewModeController = gui
      .add(params, 'viewMode', options)
      .name('显示')
      .onChange(applyVisibility);
    // keep near top: lil-gui appends; acceptable
  }
}

function refreshDepthScaleControls() {
  if (!depthScaleFolder) return;
  // Clear previous controllers
  [...depthScaleFolder.controllers].forEach((c) => c.destroy());
  views.forEach((v, i) => {
    const key = `scale_${v.id}`;
    params[key] = v.depthScale ?? 1;
    depthScaleFolder.add(params, key, 0.4, 2.2, 0.01).name(v.name).onFinishChange(applyPriors);
  });
}

function updateRoamUi(locked = roam?.isLocked) {
  const roaming = params.controlMode === '漫游视角';
  roamBanner.classList.toggle('visible', roaming && !locked);
  roamBanner.hidden = !(roaming && !locked);
  roamHud.classList.toggle('visible', roaming && !!locked);
}

function applyControlMode() {
  const roaming = params.controlMode === '漫游视角';
  if (roaming) {
    orbitSnapshot.position.copy(camera.position);
    orbitSnapshot.target.copy(controls.target);
    controls.enabled = false;
    updateRoamUi(false);
    setStatus('<strong>漫游模式</strong><div class="hint">点击画面锁定鼠标后开始走动</div>');
  } else {
    roam.exit();
    controls.enabled = true;
    camera.position.copy(orbitSnapshot.position);
    controls.target.copy(orbitSnapshot.target);
    controls.update();
    updateRoamUi(false);
    setStatus('<strong>轨道观察</strong><div class="hint">拖拽旋转 · 滚轮缩放 · 右键平移</div>');
  }
}

function startRoam(toCenter = false) {
  if (params.controlMode !== '漫游视角') {
    params.controlMode = '漫游视角';
    gui.controllers.forEach((c) => {
      if (c._name === '交互模式') c.updateDisplay();
    });
    applyControlMode();
  }

  roam.eyeHeight = params.eyeHeight;
  roam.speed = params.walkSpeed;
  updateSceneBounds();
  roam.setBounds(sceneBounds);

  const spawn = toCenter || camera.position.distanceTo(controls.target) > 4
    ? getRoamSpawn()
    : {
        position: new THREE.Vector3(camera.position.x, params.eyeHeight, camera.position.z),
        lookAt: controls.target.clone().setY(params.eyeHeight),
      };

  roam.enter(spawn);
  setStatus('<strong>漫游中</strong><div class="hint">WASD 移动 · Q/E 升降 · 鼠标环视 · Esc 退出</div>');
}

function getRoamSpawn() {
  updateSceneBounds();
  const center = sceneBounds
    ? sceneBounds.getCenter(new THREE.Vector3())
    : getLookAtTarget(assetManifest);
  return {
    position: new THREE.Vector3(center.x, params.eyeHeight, center.z + 1.2),
    lookAt: new THREE.Vector3(center.x, params.eyeHeight, center.z - 1.5),
  };
}

function updateSceneBounds() {
  const box = new THREE.Box3();
  for (const v of views) {
    if (!v.group?.visible) continue;
    v.group.updateWorldMatrix(true, true);
    box.expandByObject(v.group);
  }
  if (box.isEmpty()) {
    sceneBounds = new THREE.Box3(
      new THREE.Vector3(-1, 0.3, -1),
      new THREE.Vector3(7, 3.5, 5),
    );
    return;
  }
  const pad = 0.3;
  sceneBounds = box.clone();
  sceneBounds.min.addScalar(pad);
  sceneBounds.max.subScalar(pad);
  sceneBounds.min.y = Math.min(sceneBounds.min.y, 0.35);
  sceneBounds.max.y = Math.max(sceneBounds.max.y, params.eyeHeight + 1.2);
}

async function rebuildMeshes() {
  if (rebuilding || !views.length) return;
  rebuilding = true;
  setStatus(`正在重建 ${views.length} 路网格…`);

  for (const v of views) {
    disposeMesh(v.mesh);
    v.mesh = null;
    if (v.group) {
      viewRoot.remove(v.group);
      v.group = null;
    }
  }
  helpers.clear();

  const common = {
    stride: params.stride,
    fovDeg: params.fov,
    nearDepth: params.nearDepth,
    farDepth: params.farDepth,
    invertDepth: params.invertDepth,
    depthGamma: params.depthGamma,
    edgeThreshold: params.edgeThreshold,
  };

  await new Promise((r) => setTimeout(r, 16));

  for (const v of views) {
    const mesh = createDepthMesh({
      ...common,
      colorImage: v.color.image,
      depthData: v.depth.data,
      colorWidth: v.color.width,
      colorHeight: v.color.height,
      depthWidth: v.depth.width,
      depthHeight: v.depth.height,
    });
    mesh.name = v.id;
    const group = new THREE.Group();
    group.name = v.id;
    group.matrixAutoUpdate = false;
    group.add(mesh);
    viewRoot.add(group);

    const axes = new THREE.AxesHelper(0.4);
    axes.matrixAutoUpdate = false;
    helpers.add(axes);

    v.mesh = mesh;
    v.group = group;
    v.axes = axes;
    v.depthScale = params[`scale_${v.id}`] ?? v.depthScale ?? 1;
  }

  applyOpacity();
  applyVisibility();
  await applyPriors(true);
  rebuilding = false;
}

async function applyPriors(fit = false) {
  if (!views.length || views.some((v) => !v.mesh)) return;
  setStatus('正在按三维坐标放置相机…');
  await new Promise((r) => setTimeout(r, 20));

  try {
    poses = getCameraPoses(assetManifest);
    const lookAt = getLookAtTarget(assetManifest);
    const roomSpan = maxPairwiseDistance(poses) || 6;

    let scales = views.map((v) => params[`scale_${v.id}`] ?? v.depthScale ?? 1);
    let scaleNote = '';

    if (params.autoDepthScale) {
      const est = estimateDepthScalesForViews(
        views.map((v) => v.mesh),
        roomSpan,
        params.farDepth,
      );
      scales = est.scales;
      views.forEach((v, i) => {
        v.depthScale = scales[i];
        params[`scale_${v.id}`] = scales[i];
      });
      depthScaleFolder?.controllers.forEach((c) => c.updateDisplay());
      scaleNote = ` · 远距[${est.fars.map((d) => d.toFixed(1)).join(',')}]`;
    }

    const calib = placeWithPriors({
      poses,
      lookAt,
      depthScales: scales,
      defaultPitchDeg: params.lookTilt,
    });
    matrices = calib.matrices;

    applyPoses();
    if (fit && params.controlMode === '轨道观察') fitView();
    else updateSceneBounds();

    const poseTxt = poses
      .map((p) => `${p.id}(${p.x},${p.y},${p.z})`)
      .join(' · ');
    reportReady(`四机三维位姿 · ${poseTxt}${scaleNote}`);
  } catch (err) {
    console.error(err);
    setStatus(`对齐失败：${err.message}`);
  }
}

function reportReady(extra) {
  const faceTxt = views
    .map((v) => {
      const n = v.mesh?.geometry?.index ? v.mesh.geometry.index.count / 3 : 0;
      return `${v.name} ${Math.round(n)}`;
    })
    .join(' · ');
  setStatus(
    `<strong>${extra}</strong><div class="hint">${faceTxt} 三角面 · 可切换单视角或漫游</div>`,
  );
}

function applyPoses() {
  if (!matrices.length) return;
  views.forEach((v, i) => {
    const m = matrices[i];
    if (!m || !v.group) return;
    v.group.matrix.copy(m);
    v.group.matrixWorldNeedsUpdate = true;
    if (v.axes) {
      v.axes.matrix.copy(m);
      v.axes.matrixWorldNeedsUpdate = true;
    }
  });
  updateSceneBounds();
  roam?.setBounds(sceneBounds);
}

function applyOpacity() {
  const fuse = params.viewMode === '融合';
  const n = Math.max(1, views.length);
  views.forEach((v, i) => {
    let opacity = 1;
    if (fuse && params.blendMode === '半透明') {
      opacity = Math.max(0.48, 0.88 - i * (0.32 / n));
    }
    setMeshOpacity(v.mesh, opacity);
  });
}

function setMeshOpacity(mesh, opacity) {
  if (!mesh) return;
  const transparent = opacity < 0.999;
  mesh.material.transparent = transparent;
  mesh.material.opacity = opacity;
  mesh.material.depthWrite = opacity > 0.85;
  mesh.material.depthTest = true;
  mesh.material.needsUpdate = true;
}

function applyVisibility() {
  if (params.viewMode === '融合' && params.blendMode === '视角跟随') {
    updateViewFollow(true);
    return;
  }

  const mode = params.viewMode;
  views.forEach((v) => {
    if (v.group) v.group.visible = mode === '融合' || mode === v.name;
  });
  applyOpacity();
  updateSceneBounds();
  roam?.setBounds(sceneBounds);
}

/**
 * Show only the reconstruction whose capture direction best matches
 * the current orbit/roam camera looking direction.
 */
function updateViewFollow(force = false) {
  if (!views.length || params.viewMode !== '融合' || params.blendMode !== '视角跟随') {
    return;
  }

  camera.getWorldDirection(_viewDir);
  let best = null;
  let bestDot = -Infinity;

  for (const v of views) {
    if (!v.group) continue;
    // Depth mesh looks along local -Z
    _camFwd.set(0, 0, -1).transformDirection(v.group.matrixWorld);
    const dot = _camFwd.dot(_viewDir);
    if (dot > bestDot) {
      bestDot = dot;
      best = v;
    }
  }

  if (!best) return;
  if (!force && best.id === lastFollowId) return;
  lastFollowId = best.id;

  views.forEach((v) => {
    if (v.group) v.group.visible = v.id === best.id;
    setMeshOpacity(v.mesh, 1);
  });
}

function fitView() {
  if (params.controlMode === '漫游视角') {
    startRoam(true);
    return;
  }

  updateSceneBounds();
  const box = sceneBounds?.clone();
  if (!box || box.isEmpty()) {
    const t = getLookAtTarget(assetManifest);
    controls.target.copy(t);
    camera.position.set(t.x + 5, t.y + 3, t.z + 5);
    controls.update();
    return;
  }

  // Also include camera rig positions so empty depth doesn't collapse view
  for (const p of poses) box.expandByPoint(userToThree(p));

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const dist = maxDim * 1.1;

  controls.target.copy(center);
  camera.position.set(center.x + dist * 0.7, center.y + dist * 0.55, center.z + dist * 0.7);
  camera.near = Math.max(0.05, dist / 120);
  camera.far = dist * 25;
  camera.updateProjectionMatrix();
  controls.update();

  orbitSnapshot.position.copy(camera.position);
  orbitSnapshot.target.copy(controls.target);
}

function disposeMesh(mesh) {
  if (!mesh) return;
  mesh.geometry?.dispose();
  mesh.userData.texture?.dispose();
  if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
  else mesh.material?.dispose();
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());
  if (params.controlMode === '漫游视角') roam.update(dt);
  else controls.update();
  updateViewFollow();
  renderer.render(scene, camera);
}
