import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { createDepthMesh, loadImageData } from './depthMesh.js';
import { placeWithPriors, estimateDepthScales, refineRigid } from './calibrate.js';
import { RoamControls } from './roamControls.js';
import { loadManifest, loadCameraAssets, applyManifestPriors } from './assets.js';

const statusEl = document.getElementById('status');
const roamBanner = document.getElementById('roamBanner');
const roamHud = document.getElementById('roamHud');

const setStatus = (html) => {
  statusEl.innerHTML = html;
};

const params = {
  viewMode: '融合',
  controlMode: '轨道观察',
  fov: 72,
  nearDepth: 0.45,
  farDepth: 6.0,
  depthGamma: 0.95,
  edgeThreshold: 0.09,
  stride: 3,
  invertDepth: false,
  // Physical camera priors (meters / degrees)
  camHeight: 1.8,
  baseline: 5.0,
  yaw1: 0,
  yaw2: 180,
  pitch1: -6,
  pitch2: -6,
  offsetX1: 0,
  offsetX2: 0,
  autoDepthScale: true,
  depthScale1: 1,
  depthScale2: 1,
  refineIcp: false,
  ghostBlend: true,
  offsetX: 0,
  offsetY: 0,
  offsetZ: 0,
  extraYaw: 0,
  extraPitch: 0,
  extraRoll: 0,
  showHelpers: false,
  eyeHeight: 1.7,
  walkSpeed: 2.4,
};

let renderer, scene, camera, controls, roam, gui;
let mesh1, mesh2, group1, group2, helpers;
let color1, color2, depth1, depth2;
let assetManifest = null;
let rebuilding = false;
let calib = null;
let sceneBounds = null;
const fineDummy = new THREE.Object3D();
const clock = new THREE.Clock();
const orbitSnapshot = {
  position: new THREE.Vector3(),
  target: new THREE.Vector3(),
};

init();

async function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.getElementById('app').appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0f14);
  scene.fog = new THREE.Fog(0x0b0f14, 14, 32);

  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 80);
  camera.position.set(5.5, 3.2, 0.8);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 1.2, 0);
  controls.maxDistance = 24;
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
  scene.add(new THREE.GridHelper(18, 36, 0x2a3a4e, 0x1a2433));

  group1 = new THREE.Group();
  group2 = new THREE.Group();
  group1.matrixAutoUpdate = false;
  group2.matrixAutoUpdate = false;
  scene.add(group1, group2);

  helpers = new THREE.Group();
  helpers.visible = false;
  scene.add(helpers);

  setupGui();
  window.addEventListener('resize', onResize);

  setStatus('正在加载资源清单与图像…');
  try {
    assetManifest = await loadManifest();
    applyManifestPriors(params, assetManifest);
    const views = await loadCameraAssets(loadImageData, assetManifest);
    if (views.length < 2) throw new Error('清单中至少需要两个摄像头资源');
    color1 = views[0].color;
    depth1 = views[0].depth;
    color2 = views[1].color;
    depth2 = views[1].depth;
    await rebuildMeshes();
  } catch (err) {
    console.error(err);
    setStatus(`加载失败：${err.message}`);
  }

  animate();
}

function setupGui() {
  gui = new GUI({ title: '重建控制' });

  gui
    .add(params, 'viewMode', ['融合', '视角1', '视角2'])
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
  depthFolder.add(params, 'fov', 40, 100, 0.5).name('相机 FOV').onFinishChange(rebuildMeshes);
  depthFolder.add(params, 'nearDepth', 0.15, 3, 0.01).name('近平面').onFinishChange(rebuildMeshes);
  depthFolder.add(params, 'farDepth', 3, 18, 0.05).name('远平面').onFinishChange(rebuildMeshes);
  depthFolder.add(params, 'depthGamma', 0.4, 2.2, 0.01).name('深度伽马').onFinishChange(rebuildMeshes);
  depthFolder.add(params, 'edgeThreshold', 0.02, 0.3, 0.005).name('边缘断裂').onFinishChange(rebuildMeshes);
  depthFolder.add(params, 'stride', 1, 4, 1).name('采样步进').onFinishChange(rebuildMeshes);
  depthFolder.add(params, 'invertDepth').name('反转深度').onFinishChange(rebuildMeshes);

  const priorFolder = gui.addFolder('相机物理参数');
  priorFolder.add(params, 'camHeight', 0.6, 2.8, 0.01).name('相机高度(m)').onFinishChange(applyPriors);
  priorFolder.add(params, 'baseline', 2, 14, 0.05).name('机间距(m)').onFinishChange(applyPriors);
  priorFolder.add(params, 'yaw1', -180, 180, 0.5).name('视角1 偏航').onFinishChange(applyPriors);
  priorFolder.add(params, 'yaw2', -180, 180, 0.5).name('视角2 偏航').onFinishChange(applyPriors);
  priorFolder.add(params, 'pitch1', -30, 30, 0.5).name('视角1 俯仰').onFinishChange(applyPriors);
  priorFolder.add(params, 'pitch2', -30, 30, 0.5).name('视角2 俯仰').onFinishChange(applyPriors);
  priorFolder.add(params, 'offsetX1', -2, 2, 0.01).name('视角1 X偏移').onFinishChange(applyPriors);
  priorFolder.add(params, 'offsetX2', -2, 2, 0.01).name('视角2 X偏移').onFinishChange(applyPriors);
  priorFolder.add(params, 'autoDepthScale').name('按机间距估尺度').onFinishChange(applyPriors);
  priorFolder.add(params, 'depthScale1', 0.4, 2.2, 0.01).name('视角1 深度尺度').onFinishChange(applyPriors);
  priorFolder.add(params, 'depthScale2', 0.4, 2.2, 0.01).name('视角2 深度尺度').onFinishChange(applyPriors);
  priorFolder.add(params, 'refineIcp').name('ICP 小幅精修').onFinishChange(applyPriors);
  priorFolder.add({ run: () => applyPriors() }, 'run').name('应用位姿');

  const calibFolder = gui.addFolder('融合微调');
  calibFolder.add(params, 'ghostBlend').name('半透明叠加').onChange(applyOpacity);
  calibFolder.add(params, 'offsetX', -1.5, 1.5, 0.005).name('视角2 微调X').onChange(applyPoses);
  calibFolder.add(params, 'offsetY', -1.2, 1.2, 0.005).name('视角2 微调Y').onChange(applyPoses);
  calibFolder.add(params, 'offsetZ', -2, 2, 0.005).name('视角2 微调Z').onChange(applyPoses);
  calibFolder.add(params, 'extraYaw', -25, 25, 0.1).name('视角2 微调偏航').onChange(applyPoses);
  calibFolder.add(params, 'extraPitch', -15, 15, 0.1).name('视角2 微调俯仰').onChange(applyPoses);
  calibFolder.add(params, 'extraRoll', -15, 15, 0.1).name('视角2 微调滚转').onChange(applyPoses);
  calibFolder.add({ resetFine }, 'resetFine').name('清零微调');

  gui.add(params, 'showHelpers').name('显示相机坐标').onChange((v) => {
    helpers.visible = v;
  });
  gui.add({ reset: () => {
    if (params.controlMode === '轨道观察') controls.reset();
  } }, 'reset').name('重置视角');
  gui.add({ fit: fitView }, 'fit').name('框住场景');
}

function resetFine() {
  params.offsetX = params.offsetY = params.offsetZ = 0;
  params.extraYaw = params.extraPitch = params.extraRoll = 0;
  gui.controllers.forEach((c) => c.updateDisplay());
  gui.folders.forEach((f) => f.controllers.forEach((c) => c.updateDisplay()));
  applyPoses();
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

  const spawn = toCenter || !Number.isFinite(camera.position.x)
    ? getRoamSpawn()
    : {
        position: new THREE.Vector3(camera.position.x, params.eyeHeight, camera.position.z),
        lookAt: controls.target.clone().setY(params.eyeHeight),
      };

  // Prefer a room-center spawn when first entering from orbit far away.
  if (!toCenter && camera.position.distanceTo(controls.target) > 4) {
    Object.assign(spawn, getRoamSpawn());
  }

  roam.enter(spawn);
  setStatus('<strong>漫游中</strong><div class="hint">WASD 移动 · 鼠标环视 · Esc 退出指针锁定</div>');
}

function getRoamSpawn() {
  updateSceneBounds();
  const center = sceneBounds
    ? sceneBounds.getCenter(new THREE.Vector3())
    : new THREE.Vector3(0, 0, 0);
  const position = new THREE.Vector3(center.x, params.eyeHeight, center.z + 1.6);
  const lookAt = new THREE.Vector3(center.x, params.eyeHeight, center.z - 2.5);
  return { position, lookAt };
}

function updateSceneBounds() {
  group1.updateWorldMatrix(true, true);
  group2.updateWorldMatrix(true, true);
  const box = new THREE.Box3();
  if (group1.visible) box.expandByObject(group1);
  if (group2.visible) box.expandByObject(group2);
  if (box.isEmpty()) {
    sceneBounds = new THREE.Box3(
      new THREE.Vector3(-4, 0.3, -6),
      new THREE.Vector3(4, 3.2, 6),
    );
    return;
  }
  // Slightly shrink so the camera stays inside the reconstructed volume.
  const pad = 0.35;
  sceneBounds = box.clone();
  sceneBounds.min.addScalar(pad);
  sceneBounds.max.subScalar(pad);
  sceneBounds.min.y = Math.min(sceneBounds.min.y, 0.4);
  sceneBounds.max.y = Math.max(sceneBounds.max.y, params.eyeHeight + 1.2);
  if (sceneBounds.min.x > sceneBounds.max.x) {
    const c = box.getCenter(new THREE.Vector3());
    sceneBounds.min.set(c.x - 2, 0.4, c.z - 3);
    sceneBounds.max.set(c.x + 2, 3, c.z + 3);
  }
}

async function rebuildMeshes() {
  if (rebuilding || !color1) return;
  rebuilding = true;
  setStatus('正在重建网格…');

  disposeMesh(mesh1);
  disposeMesh(mesh2);
  group1.clear();
  group2.clear();
  helpers.clear();
  calib = null;

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

  mesh1 = createDepthMesh({
    ...common,
    colorImage: color1.image,
    depthData: depth1.data,
    colorWidth: color1.width,
    colorHeight: color1.height,
    depthWidth: depth1.width,
    depthHeight: depth1.height,
  });
  mesh2 = createDepthMesh({
    ...common,
    colorImage: color2.image,
    depthData: depth2.data,
    colorWidth: color2.width,
    colorHeight: color2.height,
    depthWidth: depth2.width,
    depthHeight: depth2.height,
  });

  group1.add(mesh1);
  group2.add(mesh2);

  const axes1 = new THREE.AxesHelper(0.45);
  const axes2 = new THREE.AxesHelper(0.45);
  axes1.matrixAutoUpdate = false;
  axes2.matrixAutoUpdate = false;
  helpers.add(axes1, axes2);
  helpers.userData.axes1 = axes1;
  helpers.userData.axes2 = axes2;

  applyOpacity();
  applyVisibility();

  await applyPriors(true);
  rebuilding = false;
}

async function applyPriors(fit = false) {
  if (!mesh1 || !mesh2) return;
  setStatus('正在按物理参数放置双机…');
  await new Promise((r) => setTimeout(r, 20));

  try {
    let depthScale1 = params.depthScale1;
    let depthScale2 = params.depthScale2;
    let scaleNote = '';

    if (params.autoDepthScale) {
      const est = estimateDepthScales(mesh1, mesh2, params.baseline, params.farDepth);
      depthScale1 = est.depthScale1;
      depthScale2 = est.depthScale2;
      params.depthScale1 = depthScale1;
      params.depthScale2 = depthScale2;
      gui.folders.forEach((f) => f.controllers.forEach((c) => c.updateDisplay()));
      scaleNote = ` · 远距≈${est.far1.toFixed(1)}/${est.far2.toFixed(1)}m`;
    }

    calib = placeWithPriors({
      camHeight: params.camHeight,
      baseline: params.baseline,
      yaw1: params.yaw1,
      yaw2: params.yaw2,
      pitch1: params.pitch1,
      pitch2: params.pitch2,
      offsetX1: params.offsetX1,
      offsetX2: params.offsetX2,
      depthScale1,
      depthScale2,
    });

    if (params.refineIcp) {
      setStatus('正在 ICP 小幅精修…');
      await new Promise((r) => setTimeout(r, 20));
      const refined = refineRigid(mesh1, mesh2, calib.m1, calib.m2, {
        iterations: 12,
        maxDist: 0.4,
      });
      calib = { ...calib, ...refined, scale: depthScale2 / depthScale1 };
    }

    applyPoses();
    if (fit && params.controlMode === '轨道观察') fitView();
    else updateSceneBounds();

    const rmseTxt = Number.isFinite(calib.rmse) ? ` · RMSE ${calib.rmse.toFixed(3)}` : '';
    reportReady(
      `物理先验对齐 · 高度 ${params.camHeight.toFixed(2)}m · 间距 ${params.baseline.toFixed(2)}m · 尺度 ${depthScale1.toFixed(2)}/${depthScale2.toFixed(2)}${scaleNote}${rmseTxt}`,
    );
  } catch (err) {
    console.error(err);
    setStatus(`对齐失败：${err.message}`);
  }
}

function reportReady(extra) {
  const faces1 = mesh1.geometry.index ? mesh1.geometry.index.count / 3 : 0;
  const faces2 = mesh2.geometry.index ? mesh2.geometry.index.count / 3 : 0;
  setStatus(
    `<strong>${extra}</strong><div class="hint">视角1 ${Math.round(faces1)} 面 · 视角2 ${Math.round(faces2)} 面 · 可切换「漫游视角」走进场景</div>`,
  );
}

function applyPoses() {
  if (!calib) return;

  group1.matrix.copy(calib.m1);

  fineDummy.position.set(params.offsetX, params.offsetY, params.offsetZ);
  fineDummy.rotation.set(
    THREE.MathUtils.degToRad(params.extraPitch),
    THREE.MathUtils.degToRad(params.extraYaw),
    THREE.MathUtils.degToRad(params.extraRoll),
    'YXZ',
  );
  fineDummy.updateMatrix();
  group2.matrix.copy(fineDummy.matrix).multiply(calib.m2);
  group1.matrixWorldNeedsUpdate = true;
  group2.matrixWorldNeedsUpdate = true;

  if (helpers.userData.axes1) {
    helpers.userData.axes1.matrix.copy(group1.matrix);
    helpers.userData.axes2.matrix.copy(group2.matrix);
    helpers.userData.axes1.matrixWorldNeedsUpdate = true;
    helpers.userData.axes2.matrixWorldNeedsUpdate = true;
  }
  updateSceneBounds();
  roam?.setBounds(sceneBounds);
}

function applyOpacity() {
  const ghost = params.ghostBlend && params.viewMode === '融合';
  setMeshOpacity(mesh1, ghost ? 0.78 : 1);
  setMeshOpacity(mesh2, ghost ? 0.62 : 1);
}

function setMeshOpacity(mesh, opacity) {
  if (!mesh) return;
  mesh.material.transparent = opacity < 0.999;
  mesh.material.opacity = opacity;
  mesh.material.depthWrite = opacity > 0.9;
  mesh.material.needsUpdate = true;
}

function applyVisibility() {
  const mode = params.viewMode;
  group1.visible = mode === '融合' || mode === '视角1';
  group2.visible = mode === '融合' || mode === '视角2';
  applyOpacity();
  updateSceneBounds();
  roam?.setBounds(sceneBounds);
}

function fitView() {
  if (params.controlMode === '漫游视角') {
    startRoam(true);
    return;
  }

  group1.updateWorldMatrix(true, true);
  group2.updateWorldMatrix(true, true);
  const box = new THREE.Box3();
  if (group1.visible) box.expandByObject(group1);
  if (group2.visible) box.expandByObject(group2);
  if (box.isEmpty()) return;

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const dist = maxDim * 0.95;

  controls.target.copy(center);
  camera.position.set(center.x + dist * 0.85, center.y + dist * 0.45, center.z + dist * 0.15);
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
  if (params.controlMode === '漫游视角') {
    roam.update(dt);
  } else {
    controls.update();
  }
  renderer.render(scene, camera);
}
