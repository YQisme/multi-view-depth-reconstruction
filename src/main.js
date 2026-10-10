import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { createDepthMesh, loadImageData } from './depthMesh.js';

const statusEl = document.getElementById('status');
const setStatus = (html) => {
  statusEl.innerHTML = html;
};

const params = {
  viewMode: '融合',
  fov: 72,
  nearDepth: 0.45,
  farDepth: 8.5,
  depthGamma: 0.95,
  edgeThreshold: 0.09,
  stride: 3,
  invertDepth: false,
  roomLength: 7.2,
  camHeight: 1.45,
  yaw1: 0,
  yaw2: 180,
  pitch1: -8,
  pitch2: -8,
  offsetX1: 0,
  offsetX2: 0,
  showHelpers: false,
  opacity1: 1,
  opacity2: 1,
};

let renderer, scene, camera, controls, gui;
let mesh1, mesh2, group1, group2, helpers;
let color1, color2, depth1, depth2;
let rebuilding = false;

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

  scene.add(new THREE.AmbientLight(0xffffff, 1));

  const grid = new THREE.GridHelper(18, 36, 0x2a3a4e, 0x1a2433);
  scene.add(grid);

  group1 = new THREE.Group();
  group2 = new THREE.Group();
  scene.add(group1, group2);

  helpers = new THREE.Group();
  helpers.visible = false;
  scene.add(helpers);

  setupGui();
  window.addEventListener('resize', onResize);

  setStatus('正在加载图像与深度图…');
  try {
    [color1, color2, depth1, depth2] = await Promise.all([
      loadImageData('/assets/1.jpg'),
      loadImageData('/assets/2.jpg'),
      loadImageData('/assets/1_depth.png'),
      loadImageData('/assets/2_depth.png'),
    ]);
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

  const depthFolder = gui.addFolder('深度映射');
  depthFolder.add(params, 'fov', 40, 100, 0.5).name('相机 FOV').onFinishChange(rebuildMeshes);
  depthFolder.add(params, 'nearDepth', 0.15, 3, 0.01).name('近平面').onFinishChange(rebuildMeshes);
  depthFolder.add(params, 'farDepth', 3, 18, 0.05).name('远平面').onFinishChange(rebuildMeshes);
  depthFolder.add(params, 'depthGamma', 0.4, 2.2, 0.01).name('深度伽马').onFinishChange(rebuildMeshes);
  depthFolder.add(params, 'edgeThreshold', 0.02, 0.3, 0.005).name('边缘断裂').onFinishChange(rebuildMeshes);
  depthFolder.add(params, 'stride', 1, 4, 1).name('采样步进').onFinishChange(rebuildMeshes);
  depthFolder.add(params, 'invertDepth').name('反转深度').onFinishChange(rebuildMeshes);

  const poseFolder = gui.addFolder('双机对齐');
  poseFolder.add(params, 'roomLength', 3, 14, 0.05).name('机间距离').onChange(applyPoses);
  poseFolder.add(params, 'camHeight', 0.4, 2.8, 0.01).name('相机高度').onChange(applyPoses);
  poseFolder.add(params, 'yaw1', -180, 180, 0.5).name('视角1 偏航').onChange(applyPoses);
  poseFolder.add(params, 'yaw2', -180, 180, 0.5).name('视角2 偏航').onChange(applyPoses);
  poseFolder.add(params, 'pitch1', -35, 35, 0.5).name('视角1 俯仰').onChange(applyPoses);
  poseFolder.add(params, 'pitch2', -35, 35, 0.5).name('视角2 俯仰').onChange(applyPoses);
  poseFolder.add(params, 'offsetX1', -2.5, 2.5, 0.01).name('视角1 X偏移').onChange(applyPoses);
  poseFolder.add(params, 'offsetX2', -2.5, 2.5, 0.01).name('视角2 X偏移').onChange(applyPoses);
  poseFolder.add(params, 'opacity1', 0.15, 1, 0.01).name('视角1 透明度').onChange(applyOpacity);
  poseFolder.add(params, 'opacity2', 0.15, 1, 0.01).name('视角2 透明度').onChange(applyOpacity);

  gui.add(params, 'showHelpers').name('显示相机坐标').onChange((v) => {
    helpers.visible = v;
  });
  gui.add({ reset: () => controls.reset() }, 'reset').name('重置视角');
  gui.add({ fit: fitView }, 'fit').name('框住场景');
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
  mesh1.name = 'view1';

  mesh2 = createDepthMesh({
    ...common,
    colorImage: color2.image,
    depthData: depth2.data,
    colorWidth: color2.width,
    colorHeight: color2.height,
    depthWidth: depth2.width,
    depthHeight: depth2.height,
  });
  mesh2.name = 'view2';

  group1.add(mesh1);
  group2.add(mesh2);

  const axes1 = new THREE.AxesHelper(0.5);
  const axes2 = new THREE.AxesHelper(0.5);
  helpers.add(axes1, axes2);
  helpers.userData.axes1 = axes1;
  helpers.userData.axes2 = axes2;

  applyPoses();
  applyOpacity();
  applyVisibility();
  fitView();

  const faces1 = mesh1.geometry.index ? mesh1.geometry.index.count / 3 : 0;
  const faces2 = mesh2.geometry.index ? mesh2.geometry.index.count / 3 : 0;
  setStatus(
    `<strong>重建完成</strong><div class="hint">视角1 ${Math.round(faces1)} 三角面 · 视角2 ${Math.round(faces2)} 三角面 · 拖拽旋转 / 滚轮缩放</div>`,
  );
  rebuilding = false;
}

function applyPoses() {
  const half = params.roomLength * 0.5;

  // 相机位于房间两端，朝向房间中心
  group1.position.set(params.offsetX1, params.camHeight, half);
  group1.rotation.set(
    THREE.MathUtils.degToRad(params.pitch1),
    THREE.MathUtils.degToRad(params.yaw1),
    0,
    'YXZ',
  );

  group2.position.set(params.offsetX2, params.camHeight, -half);
  group2.rotation.set(
    THREE.MathUtils.degToRad(params.pitch2),
    THREE.MathUtils.degToRad(params.yaw2),
    0,
    'YXZ',
  );

  if (helpers.userData.axes1) {
    helpers.userData.axes1.position.copy(group1.position);
    helpers.userData.axes1.rotation.copy(group1.rotation);
    helpers.userData.axes2.position.copy(group2.position);
    helpers.userData.axes2.rotation.copy(group2.rotation);
  }
}

function applyOpacity() {
  if (mesh1) {
    mesh1.material.transparent = params.opacity1 < 0.999;
    mesh1.material.opacity = params.opacity1;
    mesh1.material.depthWrite = params.opacity1 > 0.95;
  }
  if (mesh2) {
    mesh2.material.transparent = params.opacity2 < 0.999;
    mesh2.material.opacity = params.opacity2;
    mesh2.material.depthWrite = params.opacity2 > 0.95;
  }
}

function applyVisibility() {
  const mode = params.viewMode;
  group1.visible = mode === '融合' || mode === '视角1';
  group2.visible = mode === '融合' || mode === '视角2';
}

function fitView() {
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
  controls.update();
  renderer.render(scene, camera);
}
