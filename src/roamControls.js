import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';

/**
 * First-person walkthrough on top of PointerLockControls.
 * WASD move, Q/E vertical, mouse look.
 */
export class RoamControls {
  constructor(camera, domElement, options = {}) {
    this.camera = camera;
    this.domElement = domElement;
    this.enabled = false;
    this.eyeHeight = options.eyeHeight ?? 1.55;
    this.speed = options.speed ?? 2.4;
    this.sprintMul = options.sprintMul ?? 2.2;
    this.bounds = options.bounds ?? null;

    this.controls = new PointerLockControls(camera, domElement);
    this.velocity = new THREE.Vector3();
    this.direction = new THREE.Vector3();
    this.keys = {
      forward: false,
      back: false,
      left: false,
      right: false,
      up: false,
      down: false,
      sprint: false,
    };

    this._onKeyDown = (e) => this.#setKey(e.code, true, e);
    this._onKeyUp = (e) => this.#setKey(e.code, false, e);
    this._onLock = () => {
      this.enabled = true;
      this.onLockChange?.(true);
    };
    this._onUnlock = () => {
      this.enabled = false;
      this.#clearKeys();
      this.onLockChange?.(false);
    };

    this.controls.addEventListener('lock', this._onLock);
    this.controls.addEventListener('unlock', this._onUnlock);
  }

  get isLocked() {
    return this.controls.isLocked;
  }

  setBounds(box) {
    this.bounds = box ? box.clone() : null;
  }

  enter(spawn) {
    if (spawn?.position) {
      this.camera.position.copy(spawn.position);
      // Keep explicit spawn height (do not raise to ceiling-ish values)
      this.camera.position.y = spawn.position.y ?? this.eyeHeight;
      if (spawn.lookAt) this.camera.lookAt(spawn.lookAt);
    } else {
      this.camera.position.y = this.eyeHeight;
    }
    this.controls.lock();
  }

  exit() {
    if (this.controls.isLocked) this.controls.unlock();
    this.enabled = false;
    this.#clearKeys();
  }

  attach() {
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);
  }

  detach() {
    this.exit();
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);
    this.controls.removeEventListener('lock', this._onLock);
    this.controls.removeEventListener('unlock', this._onUnlock);
  }

  update(dt) {
    if (!this.controls.isLocked) return;

    const damp = Math.exp(-10 * dt);
    this.velocity.x *= damp;
    this.velocity.z *= damp;
    this.velocity.y *= damp;

    this.direction.set(0, 0, 0);
    if (this.keys.forward) this.direction.z += 1;
    if (this.keys.back) this.direction.z -= 1;
    if (this.keys.left) this.direction.x -= 1;
    if (this.keys.right) this.direction.x += 1;
    if (this.direction.lengthSq() > 0) this.direction.normalize();

    const speed = this.speed * (this.keys.sprint ? this.sprintMul : 1);
    this.velocity.x -= this.direction.x * speed * dt * 8;
    this.velocity.z -= this.direction.z * speed * dt * 8;

    if (this.keys.up) this.velocity.y += speed * dt * 6;
    if (this.keys.down) this.velocity.y -= speed * dt * 6;

    this.controls.moveRight(-this.velocity.x * dt);
    this.controls.moveForward(-this.velocity.z * dt);
    this.camera.position.y += this.velocity.y * dt;

    if (this.bounds) {
      const b = this.bounds;
      this.camera.position.x = THREE.MathUtils.clamp(this.camera.position.x, b.min.x, b.max.x);
      this.camera.position.y = THREE.MathUtils.clamp(this.camera.position.y, b.min.y, b.max.y);
      this.camera.position.z = THREE.MathUtils.clamp(this.camera.position.z, b.min.z, b.max.z);
    }
  }

  #setKey(code, pressed, event) {
    if (!this.controls.isLocked && pressed) return;
    switch (code) {
      case 'KeyW':
      case 'ArrowUp':
        this.keys.forward = pressed;
        break;
      case 'KeyS':
      case 'ArrowDown':
        this.keys.back = pressed;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        this.keys.left = pressed;
        break;
      case 'KeyD':
      case 'ArrowRight':
        this.keys.right = pressed;
        break;
      case 'KeyE':
      case 'Space':
        this.keys.up = pressed;
        if (pressed && code === 'Space') event?.preventDefault();
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.keys.sprint = pressed;
        break;
      case 'KeyQ':
      case 'ControlLeft':
      case 'ControlRight':
        this.keys.down = pressed;
        break;
      default:
        break;
    }
  }

  #clearKeys() {
    Object.keys(this.keys).forEach((k) => {
      this.keys[k] = false;
    });
    this.velocity.set(0, 0, 0);
  }
}
