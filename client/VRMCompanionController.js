/**
 * VRMCompanionController
 * ----------------------
 * A drop-in, framework-agnostic engine that makes a @pixiv/three-vrm avatar
 * feel *alive*: layered procedural breathing, organic sway, human blinking,
 * saccadic eye darts, cursor gaze-tracking, audio-reactive lip-sync, and a
 * lerped emotion engine. Works with both VRM 0.0 and VRM 1.0.
 *
 * Usage:
 *   const companion = new VRMCompanionController(vrm);
 *   companion.trackCursor(window);          // optional
 *   await companion.attachMicrophone();     // OR companion.attachAudioElement(el)
 *   companion.setEmotion('joy');
 *   // in your render loop:
 *   companion.update(delta);                // delta in seconds
 *
 * Only dependency is the `vrm` instance you already loaded via VRMLoaderPlugin.
 */

import * as THREE from 'three';
import { VRMHumanBoneName } from '@pixiv/three-vrm';

// shared scratch objects (avoid per-frame allocations)
const _tmpEuler = new THREE.Euler();
const _tmpQuat = new THREE.Quaternion();

/* ------------------------------------------------------------------ *
 *  Tiny value-noise implementation (no deps).
 *  Gives smooth, non-repeating "organic" 1D signals — the thing that
 *  separates a living idle from a robotic sine loop.
 * ------------------------------------------------------------------ */
class ValueNoise {
  constructor(seed = Math.random() * 1e5) {
    this.seed = seed;
  }

  // deterministic hash -> [0,1)
  _hash(i) {
    const x = Math.sin((i + this.seed) * 127.1) * 43758.5453;
    return x - Math.floor(x);
  }

  // smoothstep-interpolated noise, domain = continuous float
  at(t) {
    const i = Math.floor(t);
    const f = t - i;
    const u = f * f * (3 - 2 * f); // smoothstep
    const a = this._hash(i);
    const b = this._hash(i + 1);
    return (a + (b - a) * u) * 2 - 1; // remap to [-1, 1]
  }
}

/* ------------------------------------------------------------------ *
 *  Small math helpers
 * ------------------------------------------------------------------ */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
// frame-rate independent exponential smoothing.
// `speed` ~ how fast we chase the target (higher = snappier).
const damp = (current, target, speed, dt) =>
  current + (target - current) * (1 - Math.exp(-speed * dt));

/* ------------------------------------------------------------------ *
 *  Emotion presets — expressed as VRM expression weights.
 *  Names cover both VRM1 ("happy","angry") and VRM0 ("joy","angry")
 *  fallbacks are resolved at runtime, so we just use canonical keys.
 * ------------------------------------------------------------------ */
const EMOTIONS = {
  neutral:   { happy: 0.0, angry: 0.0, sad: 0.0, surprised: 0.0, relaxed: 0.0 },
  joy:       { happy: 1.0, relaxed: 0.15 },
  smug:      { happy: 0.35, relaxed: 0.5, angry: 0.1 },
  angry:     { angry: 1.0 },
  sad:       { sad: 1.0 },
  surprised: { surprised: 1.0 },
  relaxed:   { relaxed: 1.0 },
};

// Canonical -> possible VRM expression names (spec differences).
const EXPRESSION_ALIASES = {
  happy:     ['happy', 'joy'],
  angry:     ['angry'],
  sad:       ['sad', 'sorrow'],
  surprised: ['surprised', 'surprise'],
  relaxed:   ['relaxed', 'fun'],
  blink:     ['blink'],
  aa:        ['aa', 'a'],
  ih:        ['ih', 'i'],
  ou:        ['ou', 'u'],
  ee:        ['ee', 'e'],
  oh:        ['oh', 'o'],
  lookUp:    ['lookUp'],
  lookDown:  ['lookDown'],
  lookLeft:  ['lookLeft'],
  lookRight: ['lookRight'],
};

export default class VRMCompanionController {
  /**
   * @param {import('@pixiv/three-vrm').VRM} vrm
   * @param {object} [opts]
   */
  constructor(vrm, opts = {}) {
    if (!vrm) throw new Error('VRMCompanionController requires a loaded VRM.');
    this.vrm = vrm;

    // ---- global tunables (mirror & extend Rayen's constants) ----
    this.cfg = {
      breathIntensity: 1.0,
      swayIntensity:   1.0,
      headIntensity:   1.0,
      blinkEnabled:    true,
      saccadeEnabled:  true,
      gazeStrength:    1.0,   // how far eyes/head follow the cursor
      lipSyncGain:     1.6,
      lipSyncDecay:    12.0,  // higher = mouth closes faster
      armRelaxation:   true,  // lowers arms naturally from T-pose to idle rest
      ...opts,
    };

    // ---- clocks & noise fields (independent seeds => decorrelated) ----
    this.time = 0;
    this.nBreath = new ValueNoise();
    this.nSwayX  = new ValueNoise();
    this.nSwayY  = new ValueNoise();
    this.nHeadX  = new ValueNoise();
    this.nHeadY  = new ValueNoise();
    this.nHeadZ  = new ValueNoise();

    // ---- resolve expression manager & cache which names exist ----
    this.expr = vrm.expressionManager || null;
    this._resolveExpressions();

    // ---- cache humanoid bones we animate (works VRM0/VRM1) ----
    this._bones = this._collectBones();
    // remember each bone's authored rest rotation so we ADD our motion
    // on top instead of overwriting the pose.
    this._restQuat = new Map();
    for (const [name, node] of Object.entries(this._bones)) {
      if (node) this._restQuat.set(name, node.quaternion.clone());
    }

    // ---- blink state machine ----
    this._blink = {
      value: 0,          // current lid closure 0..1
      timer: 0,          // countdown to next blink
      phase: 'idle',     // 'idle' | 'closing' | 'opening'
      next: this._randRange(2, 6),
      doublePending: false,
    };

    // ---- saccade (micro eye darts) ----
    this._sacc = { x: 0, y: 0, tx: 0, ty: 0, timer: 0, next: this._randRange(0.6, 2.5) };

    // ---- gaze target (from cursor), normalized [-1,1] ----
    this._gaze = { x: 0, y: 0, tx: 0, ty: 0, active: false };
    this._onPointerMove = null;
    this._pointerTarget = null;

    // ---- emotion state (canonical weights, lerped every frame) ----
    this._emoCurrent = { ...EMOTIONS.neutral };
    this._emoTarget  = { ...EMOTIONS.neutral };

    // ---- lip-sync ----
    this._audio = {
      ctx: null, analyser: null, data: null, source: null, enabled: false,
    };
    this._viseme = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 }; // smoothed
  }

  /* ============================================================== *
   *  SETUP / RESOLUTION
   * ============================================================== */

  _resolveExpressions() {
    // Build canonical -> actual-name map based on what the model ships.
    this._exprName = {};
    if (!this.expr) return;
    const has = (n) => {
      const e = this.expr.getExpression?.(n);
      return e !== undefined && e !== null;
    };
    for (const [canon, aliases] of Object.entries(EXPRESSION_ALIASES)) {
      for (const a of aliases) {
        if (has(a)) { this._exprName[canon] = a; break; }
      }
    }
  }

  _collectBones() {
    const h = this.vrm.humanoid;
    const get = (n) => h?.getNormalizedBoneNode?.(n) || h?.getBoneNode?.(n) || null;
    return {
      hips:          get(VRMHumanBoneName.Hips),
      spine:         get(VRMHumanBoneName.Spine),
      chest:         get(VRMHumanBoneName.Chest),
      upperChest:    get(VRMHumanBoneName.UpperChest),
      neck:          get(VRMHumanBoneName.Neck),
      head:          get(VRMHumanBoneName.Head),
      leftUpperArm:  get(VRMHumanBoneName.LeftUpperArm),
      rightUpperArm: get(VRMHumanBoneName.RightUpperArm),
      leftLowerArm:  get(VRMHumanBoneName.LeftLowerArm),
      rightLowerArm: get(VRMHumanBoneName.RightLowerArm),
      leftShoulder:  get(VRMHumanBoneName.LeftShoulder),
      rightShoulder: get(VRMHumanBoneName.RightShoulder),
      leftEye:       get(VRMHumanBoneName.LeftEye),
      rightEye:      get(VRMHumanBoneName.RightEye),
      leftHand:      get(VRMHumanBoneName.LeftHand),
      rightHand:     get(VRMHumanBoneName.RightHand),
    };
  }

  _randRange(a, b) { return a + Math.random() * (b - a); }

  /* ============================================================== *
   *  PUBLIC API
   * ============================================================== */

  /** Smoothly transition to an emotion preset. */
  setEmotion(name) {
    const preset = EMOTIONS[name] || EMOTIONS.neutral;
    // reset target then apply preset so lingering weights fade out.
    this._emoTarget = { happy: 0, angry: 0, sad: 0, surprised: 0, relaxed: 0, ...preset };
    return this;
  }

  /** Follow the mouse cursor. Pass window (or any element) to listen on. */
  trackCursor(target = window) {
    this.untrackCursor();
    this._pointerTarget = target;
    this._gaze.active = true;
    this._onPointerMove = (e) => {
      const w = window.innerWidth, hgt = window.innerHeight;
      // map to [-1,1]; +x right, +y up
      this._gaze.tx = (e.clientX / w) * 2 - 1;
      this._gaze.ty = -((e.clientY / hgt) * 2 - 1);
    };
    target.addEventListener('mousemove', this._onPointerMove, { passive: true });
    return this;
  }

  untrackCursor() {
    if (this._pointerTarget && this._onPointerMove) {
      this._pointerTarget.removeEventListener('mousemove', this._onPointerMove);
    }
    this._onPointerMove = null;
    this._gaze.active = false;
    return this;
  }

  /** Drive lip-sync from an <audio>/<video> element (e.g. TTS playback). */
  attachAudioElement(mediaEl) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaElementSource(mediaEl);
    const analyser = this._makeAnalyser(ctx);
    source.connect(analyser);
    analyser.connect(ctx.destination); // keep audio audible
    this._audio = { ctx, analyser, data: new Uint8Array(analyser.frequencyBinCount), source, enabled: true };
    return this;
  }

  /** Drive lip-sync from the microphone. */
  async attachMicrophone() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const source = ctx.createMediaStreamSource(stream);
    const analyser = this._makeAnalyser(ctx);
    source.connect(analyser); // do NOT connect to destination (no echo)
    this._audio = { ctx, analyser, data: new Uint8Array(analyser.frequencyBinCount), source, enabled: true };
    return this;
  }

  /** Attach an already-built AnalyserNode (advanced/custom pipelines). */
  attachAnalyser(analyser, ctx = null) {
    this._audio = { ctx, analyser, data: new Uint8Array(analyser.frequencyBinCount), source: null, enabled: true };
    return this;
  }

  _makeAnalyser(ctx) {
    const a = ctx.createAnalyser();
    a.fftSize = 1024;
    a.smoothingTimeConstant = 0.5;
    return a;
  }

  /* ============================================================== *
   *  MAIN UPDATE  (call every frame with delta in seconds)
   * ============================================================== */
  update(delta) {
    // guard against tab-switch delta spikes
    const dt = clamp(delta || 0, 0, 0.1);
    this.time += dt;

    // 1) reset animated bones to their authored rest pose so each layer
    //    is additive & we never accumulate drift.
    this._resetPose();

    // 2) procedural body layers
    this._applyBreathingAndSway(dt);

    // 3) head + gaze (updates gaze/saccade state, poses head bone)
    this._applyHeadAndGaze(dt);

    // 4) expression-driven systems
    this._applyBlink(dt);
    this._applyEyeExpressions(dt); // fallback gaze via lookX exprs if no eye bones
    this._applyLipSync(dt);
    this._applyEmotion(dt);

    // 5) commit expression weights + run three-vrm internal update
    this.expr?.update?.();
    this.vrm.update?.(dt);
  }

  /* ============================================================== *
   *  POSE LAYERS
   * ============================================================== */

  _resetPose() {
    for (const [name, node] of Object.entries(this._bones)) {
      const rest = this._restQuat.get(name);
      if (node && rest) node.quaternion.copy(rest);
    }
  }

  // additive euler rotation on top of a bone's rest quaternion
  _rotateBone(name, rx, ry, rz) {
    const node = this._bones[name];
    if (!node) return;
    _tmpEuler.set(rx, ry, rz, 'XYZ');
    _tmpQuat.setFromEuler(_tmpEuler);
    node.quaternion.multiply(_tmpQuat);
  }

  /**
   * Compound, multi-frequency breathing + organic sway.
   * Instead of one sine (Rayen's original), we sum several octaves and
   * modulate with value-noise so the loop never feels mechanical.
   */
  _applyBreathingAndSway(dt) {
    const t = this.time;
    const bi = this.cfg.breathIntensity;
    const si = this.cfg.swayIntensity;

    // --- breathing: primary ~0.25Hz (calm), secondary shimmer, noise drift
    const breathPrimary   = Math.sin(t * 2 * Math.PI * 0.23);
    const breathSecondary = Math.sin(t * 2 * Math.PI * 0.47 + 1.3) * 0.25;
    const breathNoise     = this.nBreath.at(t * 0.35) * 0.3;
    const breath = (breathPrimary + breathSecondary + breathNoise) * bi;

    // spine expands/lifts on inhale; chest a touch more; arms ride along.
    this._rotateBone('spine',      -breath * 0.020, 0, 0);
    this._rotateBone('chest',      -breath * 0.026, 0, 0);
    this._rotateBone('upperChest', -breath * 0.018, 0, 0);

    // natural resting arm pose (brings arms from stiff T-pose down to relaxed posture)
    if (this.cfg.armRelaxation) {
      const armSway = this.nSwayY.at(t * 0.16) * 0.025;
      this._rotateBone('leftUpperArm',  0.08, 0, -1.25 + armSway);
      this._rotateBone('rightUpperArm', 0.08, 0,  1.25 - armSway);
      this._rotateBone('leftLowerArm',  0, -0.25, 0.15);
      this._rotateBone('rightLowerArm', 0,  0.25, -0.15);
    }

    // shoulders/upper arms subtly abduct as the chest rises (breathing)
    this._rotateBone('rightUpperArm', 0, 0, -breath * 0.030);
    this._rotateBone('leftUpperArm',  0, 0,  breath * 0.030);

    // subtle natural wrist & hand micro-adjustments
    const handMicro = this.nSwayX.at(t * 0.22) * 0.035;
    const handMicroY = this.nBreath.at(t * 0.28) * 0.025;
    this._rotateBone('rightHand', handMicro * 0.4, handMicroY, -handMicro);
    this._rotateBone('leftHand',  handMicro * 0.4, -handMicroY,  handMicro);

    // --- weight-shift sway: slow organic noise on hips + counter on spine
    const swayX = this.nSwayX.at(t * 0.13) * si; // side to side
    const swayZ = this.nSwayY.at(t * 0.11) * si; // fwd/back lean
    this._rotateBone('hips',  swayZ * 0.012, swayX * 0.020, swayX * 0.014);
    this._rotateBone('spine', 0, -swayX * 0.010, -swayX * 0.008); // counter-rotate
  }

  /**
   * Head micro-motion (nod/tilt/turn) + smooth gaze toward cursor.
   * Head takes a *fraction* of the gaze; eyes take the rest, which is how
   * real people look at things (eyes lead, head trails).
   */
  _applyHeadAndGaze(dt) {
    const t = this.time;
    const hi = this.cfg.headIntensity;

    // organic idle head motion (decorrelated noise per axis)
    let nod  = this.nHeadX.at(t * 0.19) * 0.035 * hi;
    let tilt = this.nHeadZ.at(t * 0.16) * 0.030 * hi;
    let turn = this.nHeadY.at(t * 0.14) * 0.040 * hi;

    // smooth cursor gaze
    if (this._gaze.active) {
      this._gaze.x = damp(this._gaze.x, this._gaze.tx, 6, dt);
      this._gaze.y = damp(this._gaze.y, this._gaze.ty, 6, dt);
      const g = this.cfg.gazeStrength;
      turn += this._gaze.x * 0.28 * g;   // yaw toward cursor
      nod  += -this._gaze.y * 0.20 * g;  // pitch toward cursor
    }

    // split across neck + head for a natural bend
    this._rotateBone('neck', nod * 0.4, turn * 0.4, tilt * 0.4);
    this._rotateBone('head', nod * 0.6, turn * 0.6, tilt * 0.6);

    // advance saccade state (consumed by eyes)
    this._updateSaccade(dt);
  }

  _updateSaccade(dt) {
    if (!this.cfg.saccadeEnabled) { this._sacc.tx = this._sacc.ty = 0; }
    else {
      this._sacc.timer -= dt;
      if (this._sacc.timer <= 0) {
        // new tiny dart target
        this._sacc.tx = this._randRange(-1, 1) * 0.25;
        this._sacc.ty = this._randRange(-1, 1) * 0.15;
        this._sacc.next = this._randRange(0.6, 2.8);
        this._sacc.timer = this._sacc.next;
      }
    }
    // saccades are ballistic: snap fast toward target
    this._sacc.x = damp(this._sacc.x, this._sacc.tx, 22, dt);
    this._sacc.y = damp(this._sacc.y, this._sacc.ty, 22, dt);

    // if we have real eye bones, drive them here (gaze + saccade)
    const ex = clamp(this._gaze.x * this.cfg.gazeStrength + this._sacc.x, -1, 1);
    const ey = clamp(this._gaze.y * this.cfg.gazeStrength + this._sacc.y, -1, 1);
    this._eyeYaw = ex;   // stash for expression fallback
    this._eyePitch = ey;

    if (this._bones.leftEye || this._bones.rightEye) {
      const yaw = ex * 0.35;   // radians, small
      const pitch = -ey * 0.22;
      this._rotateBone('leftEye',  pitch, yaw, 0);
      this._rotateBone('rightEye', pitch, yaw, 0);
    }
  }

  /* ============================================================== *
   *  BLINK  — asymmetric curve: fast close, slower open + double blinks
   * ============================================================== */
  _applyBlink(dt) {
    if (!this.cfg.blinkEnabled) return;
    const b = this._blink;

    switch (b.phase) {
      case 'idle':
        b.timer -= dt;
        if (b.timer <= 0) {
          b.phase = 'closing';
          // 20% chance to queue a quick second blink
          b.doublePending = Math.random() < 0.2;
        }
        break;
      case 'closing':
        b.value += dt / 0.06; // ~60ms to fully close (fast)
        if (b.value >= 1) { b.value = 1; b.phase = 'opening'; }
        break;
      case 'opening':
        b.value -= dt / 0.12; // ~120ms to open (slower, more natural)
        if (b.value <= 0) {
          b.value = 0;
          if (b.doublePending) {
            b.doublePending = false;
            b.phase = 'closing';
          } else {
            b.phase = 'idle';
            b.next = this._randRange(2, 6);
            b.timer = b.next;
          }
        }
        break;
    }
    this._setExpr('blink', b.value);
  }

  /* ============================================================== *
   *  EYE EXPRESSION FALLBACK
   *  If the rig has no eye *bones*, use lookLeft/Right/Up/Down exprs.
   * ============================================================== */
  _applyEyeExpressions(dt) {
    if (this._bones.leftEye || this._bones.rightEye) return; // bones handle it
    const yaw = this._eyeYaw || 0;
    const pitch = this._eyePitch || 0;
    this._setExpr('lookRight', clamp(yaw, 0, 1));
    this._setExpr('lookLeft', clamp(-yaw, 0, 1));
    this._setExpr('lookUp',   clamp(pitch, 0, 1));
    this._setExpr('lookDown', clamp(-pitch, 0, 1));
  }

  /* ============================================================== *
   *  LIP-SYNC  — band-split RMS -> viseme weights w/ smooth decay
   * ============================================================== */
  _applyLipSync(dt) {
    const A = this._audio;
    let aa = 0, ih = 0, ou = 0, ee = 0, oh = 0;

    if (A.enabled && A.analyser) {
      A.analyser.getByteFrequencyData(A.data);
      const n = A.data.length;

      // split spectrum into rough formant-ish bands
      const band = (lo, hi) => {
        let s = 0, c = 0;
        const a = Math.floor(n * lo), b = Math.floor(n * hi);
        for (let i = a; i < b; i++) { s += A.data[i]; c++; }
        return c ? s / c / 255 : 0;
      };
      const low  = band(0.00, 0.06); // openness / "aa","oh"
      const mid  = band(0.06, 0.18); // "ou","oh"
      const high = band(0.18, 0.45); // "ih","ee"

      const g = this.cfg.lipSyncGain;
      const energy = clamp((low + mid + high) * g, 0, 1);

      // only shape mouth when there's real signal (kills idle jitter)
      if (energy > 0.06) {
        aa = clamp(low * 1.8 * g, 0, 1) * energy;
        oh = clamp(mid * 1.4 * g, 0, 1) * energy;
        ou = clamp(mid * 1.1 * g, 0, 1) * energy * 0.7;
        ih = clamp(high * 1.5 * g, 0, 1) * energy;
        ee = clamp(high * 1.2 * g, 0, 1) * energy * 0.8;
      }
    }

    // smooth decay so the mouth never snaps shut / chatters
    const k = this.cfg.lipSyncDecay;
    this._viseme.aa = damp(this._viseme.aa, aa, k, dt);
    this._viseme.ih = damp(this._viseme.ih, ih, k, dt);
    this._viseme.ou = damp(this._viseme.ou, ou, k, dt);
    this._viseme.ee = damp(this._viseme.ee, ee, k, dt);
    this._viseme.oh = damp(this._viseme.oh, oh, k, dt);

    this._setExpr('aa', this._viseme.aa);
    this._setExpr('ih', this._viseme.ih);
    this._setExpr('ou', this._viseme.ou);
    this._setExpr('ee', this._viseme.ee);
    this._setExpr('oh', this._viseme.oh);
  }

  /* ============================================================== *
   *  EMOTION  — lerp canonical weights every frame, then commit
   * ============================================================== */
  _applyEmotion(dt) {
    const speed = 6; // transition snappiness
    for (const key of Object.keys(this._emoTarget)) {
      const cur = this._emoCurrent[key] ?? 0;
      const tgt = this._emoTarget[key] ?? 0;
      this._emoCurrent[key] = damp(cur, tgt, speed, dt);
      this._setExpr(key, this._emoCurrent[key]);
    }
  }

  /* ============================================================== *
   *  EXPRESSION COMMIT — resolves canonical name to model's actual name
   * ============================================================== */
  _setExpr(canon, value) {
    if (!this.expr) return;
    const name = this._exprName[canon];
    if (!name) return;
    this.expr.setValue(name, clamp(value, 0, 1));
  }

  /* ============================================================== *
   *  CLEANUP
   * ============================================================== */
  dispose() {
    this.untrackCursor();
    if (this._audio.source && this._audio.source.disconnect) this._audio.source.disconnect();
    if (this._audio.ctx && this._audio.ctx.close) this._audio.ctx.close();
    this._audio = { ctx: null, analyser: null, data: null, source: null, enabled: false };
  }
}
