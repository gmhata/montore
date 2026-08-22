import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMExpressionPresetName } from "@pixiv/three-vrm";

const video = document.getElementById("video");
const overlayCanvas = document.getElementById("overlayCanvas");
const overlayContext = overlayCanvas.getContext("2d");
const avatarViewport = document.getElementById("avatarViewport");
const loadModelButton = document.getElementById("loadModelButton");
const debugDumpButton = document.getElementById("debugDumpButton");
const modelInput = document.getElementById("modelInput");
const avatarModelNote = document.getElementById("avatarModelNote");
const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");
const cameraOverlay = document.getElementById("cameraOverlay");
const yawValue = document.getElementById("yawValue");
const pitchValue = document.getElementById("pitchValue");
const blinkValue = document.getElementById("blinkValue");
const mouthValue = document.getElementById("mouthValue");
const DEFAULT_AVATAR_URL = new URL("assets/Avatar.vrm", document.baseURI).toString();
const DEFAULT_AVATAR_NAME = "Avatar.vrm";

function createRelaxedPoseArm(relaxedReach) {
  return {
    active: 0,
    raise: 0.18,
    reach: relaxedReach,
    bend: 0.12,
    wristLift: 0.1,
    upperAngle: Math.PI * 0.5,
    lowerAngle: Math.PI * 0.5,
    shoulderPoint: null,
    elbowPoint: null,
    wristPoint: null,
    shoulderX: 0.5 + relaxedReach,
    shoulderY: 0.48,
    elbowX: 0.5 + relaxedReach,
    elbowY: 0.63,
    wristX: 0.5 + relaxedReach,
    wristY: 0.8,
  };
}

const appState = {
  destroyed: false,
  processing: false,
  stream: null,
  faceMesh: null,
  hands: null,
  pose: null,
  poseDetections: [],
  face: {
    detected: false,
    yaw: 0,
    pitch: 0,
    roll: 0,
    mouth: 0,
    leftEye: 1,
    rightEye: 1,
    blink: 0,
    centerX: 0,
    centerY: 0,
    gazeX: 0,
    gazeY: 0,
    points: [],
  },
  handsDetected: [],
  poseArms: [
    createRelaxedPoseArm(-0.08),
    createRelaxedPoseArm(0.08),
  ],
  avatar: {
    yaw: 0,
    pitch: 0,
    roll: 0,
    mouth: 0,
    leftEye: 1,
    rightEye: 1,
    centerX: 0,
    centerY: 0,
    gazeX: 0,
    gazeY: 0,
    hands: [
      { x: 0.3, y: 0.82, active: 0, angle: -0.08, openness: 0.45, raise: 0.2, pinch: 0 },
      { x: 0.7, y: 0.82, active: 0, angle: 0.08, openness: 0.45, raise: 0.2, pinch: 0 },
    ],
    time: 0,
  },
  scene3d: null,
  activeModelUrl: null,
  loadedModel: null,
};

const TUNE_STORAGE_KEY = "live_avatar_tune_v4";
const TUNE_DEFAULTS = {
  // Forearm twist applied AFTER IK aim, to orient the palm.
  // Positive values rotate the forearm around its own length axis.
  palmTwistL: 0.0,
  palmTwistR: 0.0,
  palmFollowHands: 0.8, // gain for MediaPipe-Hands-driven palm roll (0 = off)
  fingerAxis: "z",      // "x" or "z" — which local Euler axis curls the finger
  fingerGain: 1.0,      // overall finger curl magnitude (0..2)
  fingerSignL: -1,      // sign for avatar LEFT finger curl
  fingerSignR: 1,       // sign for avatar RIGHT finger curl
};
function loadTune() {
  try {
    const raw = localStorage.getItem(TUNE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return { ...TUNE_DEFAULTS, ...parsed };
  } catch {
    return { ...TUNE_DEFAULTS };
  }
}
function saveTune() {
  try {
    localStorage.setItem(TUNE_STORAGE_KEY, JSON.stringify(appState.tune));
  } catch {
    // ignore quota / privacy errors
  }
}
appState.tune = loadTune();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function distance2d(pointA, pointB) {
  return Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);
}

function averagePoint(points) {
  const total = points.reduce(
    (memo, point) => {
      memo.x += point.x;
      memo.y += point.y;
      return memo;
    },
    { x: 0, y: 0 }
  );
  return {
    x: total.x / points.length,
    y: total.y / points.length,
  };
}

function setStatus(message, active = false, error = false) {
  statusText.textContent = message;
  statusDot.classList.toggle("active", active && !error);
  if (error) {
    statusDot.classList.remove("active");
  }
}

function setOverlayMessage(message, isError = false) {
  cameraOverlay.textContent = isError ? message : "";
  cameraOverlay.classList.toggle("error", isError);
}

function setModelNote(message) {
  avatarModelNote.textContent = message;
}

function cleanupObject3D(root) {
  root.traverse((node) => {
    if (node.geometry) {
      node.geometry.dispose();
    }
    if (node.material) {
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((material) => material?.dispose?.());
    }
  });
}

function normalizeNodeName(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findBoneByPatterns(root, patterns) {
  let found = null;
  root.traverse((node) => {
    if (found || !node.isBone) {
      return;
    }
    const normalized = normalizeNodeName(node.name);
    if (patterns.some((pattern) => normalized.includes(pattern))) {
      found = node;
    }
  });
  return found;
}

function findMorphTargets(root, patterns) {
  const matches = [];
  root.traverse((node) => {
    if (!node.morphTargetDictionary || !node.morphTargetInfluences) {
      return;
    }
    Object.entries(node.morphTargetDictionary).forEach(([name, index]) => {
      const normalized = normalizeNodeName(name);
      if (patterns.some((pattern) => normalized.includes(pattern))) {
        matches.push({ node, index });
      }
    });
  });
  return matches;
}

function captureBoneTransform(bone) {
  if (!bone) {
    return null;
  }
  return {
    position: bone.position.clone(),
    rotation: bone.rotation.clone(),
  };
}

function resizeOverlay() {
  const frame = document.getElementById("cameraFrame");
  const rect = frame.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (overlayCanvas.width !== width || overlayCanvas.height !== height) {
    overlayCanvas.width = width;
    overlayCanvas.height = height;
    overlayContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function getOverlayMetrics() {
  const frame = document.getElementById("cameraFrame");
  const frameWidth = frame.clientWidth || 640;
  const frameHeight = frame.clientHeight || 480;
  const videoWidth = video.videoWidth || 640;
  const videoHeight = video.videoHeight || 480;
  const videoAspect = videoWidth / videoHeight;
  const frameAspect = frameWidth / frameHeight;

  if (videoAspect > frameAspect) {
    const drawWidth = frameHeight * videoAspect;
    return {
      frameWidth,
      frameHeight,
      drawWidth,
      drawHeight: frameHeight,
      offsetX: (frameWidth - drawWidth) * 0.5,
      offsetY: 0,
    };
  }

  const drawHeight = frameWidth / videoAspect;
  return {
    frameWidth,
    frameHeight,
    drawWidth: frameWidth,
    drawHeight,
    offsetX: 0,
    offsetY: (frameHeight - drawHeight) * 0.5,
  };
}

function projectPointToOverlay(point, metrics) {
  return {
    x: metrics.offsetX + point.x * metrics.drawWidth,
    y: metrics.offsetY + point.y * metrics.drawHeight,
  };
}

function toDisplayLandmarks(rawLandmarks) {
  return rawLandmarks.map((point) => ({
    x: 1 - point.x,
    y: point.y,
    z: point.z ?? 0,
  }));
}

function computeEyeOpenness(points, topA, topB, bottomA, bottomB, outer, inner) {
  const vertical =
    (distance2d(points[topA], points[bottomA]) + distance2d(points[topB], points[bottomB])) * 0.5;
  const horizontal = Math.max(0.001, distance2d(points[outer], points[inner]));
  const ratio = vertical / horizontal;
  return clamp((ratio - 0.05) / 0.05, 0, 1);
}

function computeFaceData(rawLandmarks) {
  const points = toDisplayLandmarks(rawLandmarks);
  const nose = points[1];
  const forehead = points[10];
  const chin = points[152];
  const leftEyeOuter = points[33];
  const rightEyeOuter = points[263];
  const leftCheek = points[234];
  const rightCheek = points[454];
  const eyeCenterX = (leftEyeOuter.x + rightEyeOuter.x) / 2;
  const eyeWidth = Math.max(0.001, Math.abs(rightEyeOuter.x - leftEyeOuter.x));
  const faceWidth = Math.max(0.001, Math.abs(rightCheek.x - leftCheek.x));
  const faceHeight = Math.max(0.001, Math.abs(chin.y - forehead.y));

  const yaw = clamp(((nose.x - (leftCheek.x + rightCheek.x) * 0.5) / faceWidth) * 92, -24, 24);
  const pitch = clamp((((nose.y - forehead.y) / faceHeight) - 0.47) * 92, -18, 18);
  const roll = clamp(
    Math.atan2(rightEyeOuter.y - leftEyeOuter.y, rightEyeOuter.x - leftEyeOuter.x) * (180 / Math.PI),
    -16,
    16
  );

  const leftEye = computeEyeOpenness(points, 159, 158, 145, 153, 33, 133);
  const rightEye = computeEyeOpenness(points, 386, 385, 374, 380, 362, 263);
  const blink = clamp(1 - (leftEye + rightEye) * 0.5, 0, 1);

  const mouthRatio =
    distance2d(points[13], points[14]) /
    Math.max(0.001, distance2d(points[78], points[308]));
  const mouth = clamp((mouthRatio - 0.018) / 0.18, 0, 1);

  const irisLeft = points[468] || points[159];
  const irisRight = points[473] || points[386];
  const gazeX = clamp((((irisLeft.x + irisRight.x) * 0.5) - eyeCenterX) / eyeWidth * 12, -1, 1);
  const gazeY = clamp((((irisLeft.y + irisRight.y) * 0.5) - nose.y) / faceHeight * 10, -1, 1);

  return {
    detected: true,
    yaw,
    pitch,
    roll,
    mouth,
    leftEye,
    rightEye,
    blink,
    centerX: clamp((nose.x - 0.5) * 1.15, -0.26, 0.26),
    centerY: clamp((nose.y - 0.5) * 1.02, -0.2, 0.2),
    gazeX,
    gazeY,
    points,
  };
}

function computeHandData(multiHandLandmarks) {
  return (multiHandLandmarks || [])
    .map((rawLandmarks) => {
      const points = toDisplayLandmarks(rawLandmarks);
      const wrist = points[0];
      const indexBase = points[5];
      const middleBase = points[9];
      const pinkyBase = points[17];
      const thumbTip = points[4];
      const indexTip = points[8];
      const middleTip = points[12];
      const ringTip = points[16];
      const pinkyTip = points[20];
      const palmCenter = averagePoint([wrist, indexBase, middleBase, points[13], pinkyBase]);
      const palmWidth = Math.max(0.001, distance2d(indexBase, pinkyBase));
      const openness = clamp((distance2d(indexTip, pinkyTip) / (palmWidth * 2.1) - 0.34) / 0.42, 0, 1);
      const angle = Math.atan2(indexBase.y - pinkyBase.y, indexBase.x - pinkyBase.x);
      const raise = clamp((0.9 - palmCenter.y) / 0.52, 0, 1);
      const pinch = clamp((0.19 - distance2d(thumbTip, indexTip)) / 0.12, 0, 1);

      return {
        points,
        x: palmCenter.x,
        y: palmCenter.y,
        openness,
        angle,
        raise,
        pinch,
      };
    })
    .sort((handA, handB) => handA.x - handB.x)
    .slice(0, 2);
}

function computePoseArmData(poseDetections) {
  if (!poseDetections || !poseDetections.length) {
    return [createRelaxedPoseArm(-0.08), createRelaxedPoseArm(0.08)];
  }

  const landmarks = poseDetections[0]?.poseLandmarks;
  if (!landmarks || landmarks.length < 17) {
    return [createRelaxedPoseArm(-0.08), createRelaxedPoseArm(0.08)];
  }

  function toLm(lm) {
    if (!lm) return null;
    return { x: 1 - lm.x, y: lm.y, z: lm.z ?? 0, visibility: lm.visibility ?? 0 };
  }

  // MediaPipe Pose landmark indices (after 1-x flip):
  // 11=person's left shoulder → display left, 12=person's right shoulder → display right
  const leftShoulder = toLm(landmarks[11]);
  const rightShoulder = toLm(landmarks[12]);
  const leftElbow = toLm(landmarks[13]);
  const rightElbow = toLm(landmarks[14]);
  const leftPoseWrist = toLm(landmarks[15]);
  const rightPoseWrist = toLm(landmarks[16]);

  if (!leftShoulder || !rightShoulder ||
      leftShoulder.visibility < 0.22 || rightShoulder.visibility < 0.22) {
    return [createRelaxedPoseArm(-0.08), createRelaxedPoseArm(0.08)];
  }

  // Match each hand to the nearest shoulder by x-position (avoids cross-arm confusion)
  const usedHands = new Set();
  function findHandForShoulder(shoulder) {
    let best = null;
    let bestXDist = 0.28;
    for (const hand of appState.handsDetected) {
      if (usedHands.has(hand)) continue;
      const hw = hand.points?.[0];
      if (!hw) continue;
      const xDist = Math.abs(hw.x - shoulder.x);
      if (xDist < bestXDist) { bestXDist = xDist; best = hand; }
    }
    if (best) usedHands.add(best);
    return best;
  }

  return [
    { shoulder: leftShoulder, elbow: leftElbow, poseWrist: leftPoseWrist, relaxedReach: -0.08 },
    { shoulder: rightShoulder, elbow: rightElbow, poseWrist: rightPoseWrist, relaxedReach: 0.08 },
  ].map((config) => {
    const { shoulder, elbow, poseWrist, relaxedReach } = config;

    // Prefer MediaPipe Hands wrist (more accurate when hand is visible), fall back to Pose wrist
    const handWrist = findHandForShoulder(shoulder)?.points?.[0] ?? null;
    const wrist = handWrist ?? (poseWrist?.visibility >= 0.12 ? poseWrist : null);

    // Use elbow if visible; otherwise keep at resting position beside shoulder.
    // Do NOT estimate from wrist midpoint — that causes the upper arm to rise
    // when the user waves (forearm up, upper arm down) because the estimated
    // elbow would also be raised, incorrectly lifting the whole arm.
    const goodElbow = elbow?.visibility >= 0.12 ? elbow : null;
    const effectiveElbow = goodElbow ?? { x: shoulder.x + relaxedReach * 0.6, y: shoulder.y + 0.18 };

    // Need at least elbow to compute a direction
    const hasDirection = goodElbow || wrist;
    if (!hasDirection) return createRelaxedPoseArm(relaxedReach);

    const effectiveWrist = wrist ?? {
      x: effectiveElbow.x + (effectiveElbow.x - shoulder.x) * 0.72,
      y: effectiveElbow.y + (effectiveElbow.y - shoulder.y) * 0.72,
    };

    const upperAngle = Math.atan2(effectiveElbow.y - shoulder.y, effectiveElbow.x - shoulder.x);
    const lowerAngle = Math.atan2(effectiveWrist.y - effectiveElbow.y, effectiveWrist.x - effectiveElbow.x);
    let elbowAngle = Math.abs(lowerAngle - upperAngle);
    if (elbowAngle > Math.PI) elbowAngle = Math.PI * 2 - elbowAngle;

    return {
      screenX: shoulder.x,
      active: 1,
      raise: clamp((shoulder.y - effectiveWrist.y + 0.08) / 0.48, 0, 1),
      reach: clamp((effectiveWrist.x - shoulder.x) * 1.85, -0.55, 0.55),
      bend: clamp((Math.PI - elbowAngle) / (Math.PI * 0.72), 0, 1),
      wristLift: clamp((effectiveElbow.y - effectiveWrist.y + 0.06) / 0.32, 0, 1),
      upperAngle,
      lowerAngle,
      shoulderPoint: shoulder,
      elbowPoint: effectiveElbow,
      wristPoint: effectiveWrist,
      shoulderX: shoulder.x,
      shoulderY: shoulder.y,
      shoulderZ: shoulder.z ?? 0,
      elbowX: effectiveElbow.x,
      elbowY: effectiveElbow.y,
      elbowZ: effectiveElbow.z ?? 0,
      wristX: effectiveWrist.x,
      wristY: effectiveWrist.y,
      wristZ: (wrist?.z ?? effectiveWrist.z) ?? 0,
    };
  }).sort((armA, armB) => (armA.screenX ?? 0) - (armB.screenX ?? 0))
    .map(({ screenX, ...arm }) => arm);
}

function drawPoints(points, color, size) {
  const metrics = getOverlayMetrics();
  overlayContext.fillStyle = color;
  for (const point of points) {
    const projected = projectPointToOverlay(point, metrics);
    overlayContext.beginPath();
    overlayContext.arc(projected.x, projected.y, size, 0, Math.PI * 2);
    overlayContext.fill();
  }
}

function drawHandLines(hand) {
  const metrics = getOverlayMetrics();
  const pairs = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17],
  ];

  overlayContext.strokeStyle = "rgba(255, 236, 179, 0.86)";
  overlayContext.lineWidth = 2.3;
  for (const [start, end] of pairs) {
    const pointA = projectPointToOverlay(hand.points[start], metrics);
    const pointB = projectPointToOverlay(hand.points[end], metrics);
    overlayContext.beginPath();
    overlayContext.moveTo(pointA.x, pointA.y);
    overlayContext.lineTo(pointB.x, pointB.y);
    overlayContext.stroke();
  }
}

function drawPoseArmLines(arm) {
  if (!arm.active || !arm.shoulderPoint || !arm.elbowPoint || !arm.wristPoint) {
    return;
  }

  const metrics = getOverlayMetrics();
  const shoulder = projectPointToOverlay(arm.shoulderPoint, metrics);
  const elbow = projectPointToOverlay(arm.elbowPoint, metrics);
  const wrist = projectPointToOverlay(arm.wristPoint, metrics);

  overlayContext.strokeStyle = "rgba(248, 113, 113, 0.96)";
  overlayContext.lineWidth = 4.2;
  overlayContext.lineCap = "round";
  overlayContext.lineJoin = "round";
  overlayContext.beginPath();
  overlayContext.moveTo(shoulder.x, shoulder.y);
  overlayContext.lineTo(elbow.x, elbow.y);
  overlayContext.lineTo(wrist.x, wrist.y);
  overlayContext.stroke();

  drawPoints(
    [arm.shoulderPoint, arm.elbowPoint, arm.wristPoint],
    "rgba(254, 202, 202, 0.98)",
    4.1
  );
}

function drawOverlay() {
  resizeOverlay();
  const frame = document.getElementById("cameraFrame");
  overlayContext.clearRect(0, 0, frame.clientWidth || 640, frame.clientHeight || 480);

  if (appState.face.detected) {
    drawPoints(appState.face.points, "rgba(74, 222, 128, 0.92)", 2.05);
    drawPoints(
      [
        appState.face.points[1],
        appState.face.points[13],
        appState.face.points[14],
        appState.face.points[33],
        appState.face.points[263],
        appState.face.points[159],
        appState.face.points[145],
        appState.face.points[386],
        appState.face.points[374],
      ],
      "rgba(240, 253, 250, 0.98)",
      3.35
    );
  }

  for (const arm of appState.poseArms) {
    drawPoseArmLines(arm);
  }

  for (const hand of appState.handsDetected) {
    drawHandLines(hand);
    drawPoints(hand.points, "rgba(253, 230, 138, 0.96)", 3.05);
  }
}

function updateStats() {
  yawValue.textContent = `${Math.round(appState.face.yaw)}°`;
  pitchValue.textContent = `${Math.round(appState.face.pitch)}°`;
  blinkValue.textContent = `${Math.round(appState.face.blink * 100)}%`;
  mouthValue.textContent = `${Math.round(appState.face.mouth * 100)}%`;
}

function updateAvatarState(deltaMs) {
  const avatar = appState.avatar;
  const face = appState.face;
  avatar.time += deltaMs * 0.001;

  avatar.yaw = lerp(avatar.yaw, face.detected ? face.yaw / 48 : 0, face.detected ? 0.12 : 0.08);
  avatar.pitch = lerp(avatar.pitch, face.detected ? face.pitch / 33 : 0, face.detected ? 0.36 : 0.14);
  avatar.roll = lerp(avatar.roll, face.detected ? face.roll / 136 : 0, face.detected ? 0.1 : 0.05);
  avatar.centerX = lerp(avatar.centerX, face.detected ? face.centerX : 0, face.detected ? 0.1 : 0.07);
  avatar.centerY = lerp(avatar.centerY, face.detected ? face.centerY : 0, face.detected ? 0.1 : 0.07);
  avatar.mouth = lerp(avatar.mouth, face.detected ? face.mouth : 0.02, face.detected ? 0.24 : 0.08);
  avatar.leftEye = lerp(avatar.leftEye, face.detected ? face.leftEye : 1, 0.46);
  avatar.rightEye = lerp(avatar.rightEye, face.detected ? face.rightEye : 1, 0.46);
  avatar.gazeX = lerp(avatar.gazeX, face.detected ? face.gazeX : 0, 0.12);
  avatar.gazeY = lerp(avatar.gazeY, face.detected ? face.gazeY : 0, 0.12);

  const relaxedHands = [
    { x: 0.31 + Math.sin(avatar.time * 1.2) * 0.012, y: 0.83, active: 0, angle: -0.08, openness: 0.45, raise: 0.16, pinch: 0 },
    { x: 0.69 - Math.sin(avatar.time * 1.2) * 0.012, y: 0.83, active: 0, angle: 0.08, openness: 0.45, raise: 0.16, pinch: 0 },
  ];

  for (let index = 0; index < 2; index += 1) {
    const hand = appState.handsDetected[index];
    const target = hand
      ? {
          x: clamp(hand.x * 0.72 + 0.14, 0.16, 0.84),
          y: clamp(hand.y * 0.68 + 0.2, 0.26, 0.92),
          active: 1,
          angle: clamp(hand.angle * 0.62, -0.72, 0.72),
          openness: hand.openness,
          raise: clamp(hand.raise * 0.82, 0, 1),
          pinch: clamp(hand.pinch, 0, 1),
        }
      : relaxedHands[index];
    avatar.hands[index].x = lerp(avatar.hands[index].x, target.x, 0.16);
    avatar.hands[index].y = lerp(avatar.hands[index].y, target.y, 0.16);
    avatar.hands[index].active = lerp(avatar.hands[index].active, target.active, 0.14);
    avatar.hands[index].angle = lerp(avatar.hands[index].angle, target.angle, 0.18);
    avatar.hands[index].openness = lerp(avatar.hands[index].openness, target.openness, 0.18);
    avatar.hands[index].raise = lerp(avatar.hands[index].raise, target.raise, 0.18);
    avatar.hands[index].pinch = lerp(avatar.hands[index].pinch, target.pinch, 0.18);
  }
}

function createMaterial(color, params = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.54,
    metalness: 0.04,
    ...params,
  });
}

function createFinger(material, xOffset) {
  const finger = new THREE.Group();
  finger.position.x = xOffset;

  const base = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.22, 6, 10), material);
  base.rotation.z = Math.PI * 0.5;
  base.position.x = 0.16;
  finger.add(base);

  return { group: finger, base };
}

function createHandRig(side, skinMaterial, cuffMaterial) {
  const rig = new THREE.Group();
  const armPivot = new THREE.Group();
  const elbowPivot = new THREE.Group();
  const wristPivot = new THREE.Group();
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.18, 0.18), skinMaterial);
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.16, 18), cuffMaterial);
  const upperArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.78, 8, 16), cuffMaterial);
  const foreArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.095, 0.68, 8, 16), cuffMaterial);

  rig.position.set(side * 1.6, -1.05, 0);

  upperArm.rotation.z = Math.PI * 0.5;
  upperArm.position.set(side * 0.48, -0.08, 0);
  armPivot.add(upperArm);

  elbowPivot.position.set(side * 0.94, -0.02, 0);
  foreArm.rotation.z = Math.PI * 0.5;
  foreArm.position.set(side * 0.38, -0.02, 0);
  elbowPivot.add(foreArm);

  wristPivot.position.set(side * 0.78, 0, 0);
  cuff.rotation.z = Math.PI * 0.5;
  cuff.position.set(side * 0.08, 0, 0);
  wristPivot.add(cuff);

  palm.position.set(side * 0.25, 0, 0);
  wristPivot.add(palm);

  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.16, 4, 10), skinMaterial);
  thumb.rotation.set(0, 0, side * -0.9);
  thumb.position.set(side * 0.18, -0.09, 0.02);
  wristPivot.add(thumb);

  const fingers = [
    createFinger(skinMaterial, -0.1),
    createFinger(skinMaterial, -0.03),
    createFinger(skinMaterial, 0.04),
    createFinger(skinMaterial, 0.11),
  ];

  for (const finger of fingers) {
    finger.group.position.set(side * 0.38, finger.group.position.x, 0.02);
    wristPivot.add(finger.group);
  }

  elbowPivot.add(wristPivot);
  armPivot.add(elbowPivot);
  rig.add(armPivot);

  return {
    rig,
    armPivot,
    elbowPivot,
    wristPivot,
    palm,
    thumb,
    fingers,
    side,
  };
}

function createAvatarScene() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  avatarViewport.replaceChildren(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x30406f, 10, 20);

  const camera = new THREE.PerspectiveCamera(21, 4 / 3, 0.1, 60);
  camera.position.set(0, -0.18, 9.35);

  const ambient = new THREE.HemisphereLight(0xd8fbff, 0x1b2653, 1.7);
  scene.add(ambient);

  const keyLight = new THREE.DirectionalLight(0xfff6df, 2.2);
  keyLight.position.set(4.2, 6, 8);
  scene.add(keyLight);

  const fillLight = new THREE.PointLight(0x89d8ff, 1.8, 30, 2);
  fillLight.position.set(-5.5, 2.4, 5.5);
  scene.add(fillLight);

  const rimLight = new THREE.PointLight(0xf59de4, 1.4, 30, 2);
  rimLight.position.set(4.5, 4, -5);
  scene.add(rimLight);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(2.9, 48),
    new THREE.MeshBasicMaterial({ color: 0x111a3f, transparent: true, opacity: 0.28 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -3.36;
  scene.add(floor);

  const avatarRoot = new THREE.Group();
  avatarRoot.position.y = -0.08;
  scene.add(avatarRoot);

  const externalModelRoot = new THREE.Group();
  externalModelRoot.visible = false;
  scene.add(externalModelRoot);

  const hoodieMaterial = createMaterial(0xf7c84b);
  const hoodieShadeMaterial = createMaterial(0xd8972b);
  const hoodieAccentMaterial = createMaterial(0x7fb5ff, { emissive: 0x3458aa, emissiveIntensity: 0.12 });
  const skinMaterial = createMaterial(0xffd7cd);
  const blushMaterial = createMaterial(0xff9cbc, { transparent: true, opacity: 0.44 });
  const hairMaterial = createMaterial(0x17285f);
  const hairHighlightMaterial = createMaterial(0x6b88ff, { emissive: 0x2d45ae, emissiveIntensity: 0.18 });
  const eyeWhiteMaterial = createMaterial(0xffffff, { roughness: 0.24 });
  const irisMaterial = createMaterial(0x74b4ff, { emissive: 0x143a84, emissiveIntensity: 0.16 });
  const pupilMaterial = createMaterial(0x091531, { roughness: 0.35 });
  const lipMaterial = createMaterial(0xf38dae, { emissive: 0x922c56, emissiveIntensity: 0.1 });
  const mouthInnerMaterial = createMaterial(0x6d2748, { roughness: 0.7 });
  const headphoneDarkMaterial = createMaterial(0x1a2355);
  const headphoneGoldMaterial = createMaterial(0xd9a53f, { metalness: 0.28, roughness: 0.36 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(1.52, 1.95, 16, 26), hoodieMaterial);
  torso.position.set(0, -2.25, 0);
  torso.scale.z = 0.92;
  avatarRoot.add(torso);

  const collarLeft = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.26, 0.58), hoodieShadeMaterial);
  collarLeft.position.set(-0.46, -1.2, 0.42);
  collarLeft.rotation.z = 0.52;
  avatarRoot.add(collarLeft);

  const collarRight = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.26, 0.58), hoodieShadeMaterial);
  collarRight.position.set(0.46, -1.2, 0.42);
  collarRight.rotation.z = -0.52;
  avatarRoot.add(collarRight);

  const tiePanel = new THREE.Mesh(new THREE.ConeGeometry(0.38, 1.22, 4), hoodieAccentMaterial);
  tiePanel.position.set(0, -2.08, 0.74);
  tiePanel.rotation.x = Math.PI;
  avatarRoot.add(tiePanel);

  const stringMaterial = createMaterial(0xffefc4);
  const drawStringLeft = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.94, 10), stringMaterial);
  drawStringLeft.position.set(-0.18, -1.86, 0.82);
  drawStringLeft.rotation.z = 0.08;
  avatarRoot.add(drawStringLeft);

  const drawStringRight = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.94, 10), stringMaterial);
  drawStringRight.position.set(0.18, -1.86, 0.82);
  drawStringRight.rotation.z = -0.08;
  avatarRoot.add(drawStringRight);

  const leftHandRig = createHandRig(-1, skinMaterial, hoodieShadeMaterial);
  const rightHandRig = createHandRig(1, skinMaterial, hoodieShadeMaterial);
  leftHandRig.rig.scale.setScalar(0.9);
  rightHandRig.rig.scale.setScalar(0.9);
  avatarRoot.add(leftHandRig.rig);
  avatarRoot.add(rightHandRig.rig);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.38, 0.7, 18), skinMaterial);
  neck.position.set(0, -1.1, 0.1);
  avatarRoot.add(neck);

  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.34, 0.18);
  avatarRoot.add(headPivot);

  const head = new THREE.Mesh(new THREE.SphereGeometry(1.28, 42, 42), skinMaterial);
  head.scale.set(0.98, 1.18, 0.94);
  headPivot.add(head);

  const faceGlow = new THREE.Mesh(
    new THREE.SphereGeometry(1.16, 32, 32),
    createMaterial(0xfff2ec, { transparent: true, opacity: 0.18, depthWrite: false })
  );
  faceGlow.position.set(0, 0.08, 0.25);
  faceGlow.scale.set(0.92, 1.02, 0.74);
  headPivot.add(faceGlow);

  const blushLeft = new THREE.Mesh(new THREE.SphereGeometry(0.18, 18, 18), blushMaterial);
  blushLeft.position.set(-0.62, -0.2, 1.02);
  blushLeft.scale.set(1.8, 1.1, 0.3);
  headPivot.add(blushLeft);

  const blushRight = blushLeft.clone();
  blushRight.position.x *= -1;
  headPivot.add(blushRight);

  const headTopLight = new THREE.Mesh(
    new THREE.SphereGeometry(0.26, 14, 14),
    createMaterial(0xffffff, { transparent: true, opacity: 0.18, depthWrite: false })
  );
  headTopLight.position.set(-0.34, 0.72, 0.86);
  headTopLight.scale.set(1.8, 0.9, 0.4);
  headPivot.add(headTopLight);

  const hairCap = new THREE.Mesh(
    new THREE.SphereGeometry(1.36, 42, 42, 0, Math.PI * 2, 0, Math.PI * 0.56),
    hairMaterial
  );
  hairCap.position.set(0, 0.24, -0.08);
  hairCap.scale.set(1.02, 1.06, 0.98);
  headPivot.add(hairCap);

  const hairBack = new THREE.Mesh(new THREE.CapsuleGeometry(1.02, 1.04, 14, 24), hairMaterial);
  hairBack.position.set(0, -0.12, -0.82);
  hairBack.scale.set(1.04, 1.12, 0.8);
  headPivot.add(hairBack);

  const bangs = [];
  for (const config of [
    { x: -0.5, y: 0.48, z: 0.92, rz: -0.2, length: 0.82, radius: 0.12 },
    { x: -0.16, y: 0.54, z: 1.02, rz: -0.08, length: 0.92, radius: 0.11 },
    { x: 0.16, y: 0.54, z: 1.02, rz: 0.08, length: 0.92, radius: 0.11 },
    { x: 0.48, y: 0.48, z: 0.92, rz: 0.2, length: 0.82, radius: 0.12 },
  ]) {
    const bang = new THREE.Mesh(new THREE.CapsuleGeometry(config.radius, config.length, 8, 14), hairMaterial);
    bang.position.set(config.x, config.y, config.z);
    bang.rotation.z = config.rz;
    bang.rotation.x = Math.PI * 0.5;
    headPivot.add(bang);
    bangs.push(bang);
  }

  const sideLockLeft = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.96, 8, 14), hairMaterial);
  sideLockLeft.position.set(-0.96, -0.06, 0.72);
  sideLockLeft.rotation.z = -0.24;
  headPivot.add(sideLockLeft);

  const sideLockRight = sideLockLeft.clone();
  sideLockRight.position.x *= -1;
  sideLockRight.rotation.z = 0.24;
  headPivot.add(sideLockRight);

  const ponyBase = new THREE.Mesh(new THREE.SphereGeometry(0.2, 18, 18), hairHighlightMaterial);
  ponyBase.position.set(0.88, 0.8, -0.35);
  headPivot.add(ponyBase);

  const ponyTail = new THREE.Group();
  ponyTail.position.copy(ponyBase.position);
  headPivot.add(ponyTail);

  const ponySegments = [];
  for (let index = 0; index < 4; index += 1) {
    const segment = new THREE.Mesh(new THREE.SphereGeometry(0.22 - index * 0.03, 18, 18), hairMaterial);
    segment.position.set(0.22 * index, -0.18 * index, -0.08 * index);
    ponyTail.add(segment);
    ponySegments.push(segment);
  }

  const headphoneBand = new THREE.Mesh(new THREE.TorusGeometry(1.28, 0.08, 14, 64, Math.PI), headphoneDarkMaterial);
  headphoneBand.rotation.z = Math.PI;
  headphoneBand.rotation.y = Math.PI * 0.04;
  headphoneBand.position.set(0, 0.08, 0.06);
  headPivot.add(headphoneBand);

  const leftPadOuter = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.08, 16, 40), headphoneGoldMaterial);
  leftPadOuter.position.set(-1.02, 0.06, 0.28);
  leftPadOuter.rotation.y = Math.PI * 0.45;
  headPivot.add(leftPadOuter);

  const rightPadOuter = leftPadOuter.clone();
  rightPadOuter.position.x *= -1;
  rightPadOuter.rotation.y *= -1;
  headPivot.add(rightPadOuter);

  const leftPadInner = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.09, 14, 32), headphoneDarkMaterial);
  leftPadInner.position.copy(leftPadOuter.position);
  leftPadInner.rotation.copy(leftPadOuter.rotation);
  headPivot.add(leftPadInner);

  const rightPadInner = leftPadInner.clone();
  rightPadInner.position.x *= -1;
  rightPadInner.rotation.y *= -1;
  headPivot.add(rightPadInner);

  const leftEyeGroup = new THREE.Group();
  leftEyeGroup.position.set(-0.5, 0.2, 1.02);
  headPivot.add(leftEyeGroup);

  const rightEyeGroup = leftEyeGroup.clone();
  rightEyeGroup.position.x *= -1;
  headPivot.add(rightEyeGroup);

  function buildEye(group) {
    const eyeWhite = new THREE.Mesh(new THREE.SphereGeometry(0.32, 24, 24), eyeWhiteMaterial);
    eyeWhite.scale.set(1.42, 0.92, 0.42);
    group.add(eyeWhite);

    const iris = new THREE.Mesh(new THREE.SphereGeometry(0.18, 20, 20), irisMaterial);
    iris.position.set(0, -0.01, 0.19);
    iris.scale.z = 0.4;
    group.add(iris);

    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.08, 18, 18), pupilMaterial);
    pupil.position.set(0, -0.01, 0.28);
    pupil.scale.z = 0.28;
    group.add(pupil);

    const topLid = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 0.12), skinMaterial);
    topLid.position.set(0, 0.22, 0.16);
    group.add(topLid);

    const bottomLid = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.06, 0.12), skinMaterial);
    bottomLid.position.set(0, -0.15, 0.16);
    group.add(bottomLid);

    const lash = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.02, 8, 24, Math.PI), headphoneDarkMaterial);
    lash.rotation.z = Math.PI;
    lash.position.set(0, 0.22, 0.28);
    lash.scale.set(1.05, 0.92, 0.9);
    group.add(lash);

    return { group, eyeWhite, iris, pupil, topLid, bottomLid };
  }

  const leftEye = buildEye(leftEyeGroup);
  const rightEye = buildEye(rightEyeGroup);

  const leftBrow = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.46, 4, 10), headphoneDarkMaterial);
  leftBrow.position.set(-0.49, 0.6, 1.02);
  leftBrow.rotation.z = -0.12;
  leftBrow.rotation.x = Math.PI * 0.5;
  headPivot.add(leftBrow);

  const rightBrow = leftBrow.clone();
  rightBrow.position.x *= -1;
  rightBrow.rotation.z *= -1;
  headPivot.add(rightBrow);

  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 16), createMaterial(0xf5c3b2));
  nose.position.set(0.02, -0.16, 1.12);
  nose.scale.set(0.78, 0.56, 0.72);
  headPivot.add(nose);

  const mouthGroup = new THREE.Group();
  mouthGroup.position.set(0, -0.7, 1.08);
  headPivot.add(mouthGroup);

  const mouthFrame = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.03, 8, 30), lipMaterial);
  mouthFrame.rotation.x = Math.PI * 0.08;
  mouthFrame.scale.y = 0.45;
  mouthGroup.add(mouthFrame);

  const mouthInner = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.08, 20), mouthInnerMaterial);
  mouthInner.rotation.x = Math.PI * 0.5;
  mouthInner.scale.y = 0.2;
  mouthGroup.add(mouthInner);

  const lipHighlight = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 14, 14),
    createMaterial(0xffffff, { transparent: true, opacity: 0.36, depthWrite: false })
  );
  lipHighlight.position.set(0, 0.06, 0.06);
  lipHighlight.scale.set(1.8, 0.7, 0.3);
  mouthGroup.add(lipHighlight);

  const sparkles = [];
  for (const config of [
    { x: -2.4, y: 2.1, z: -1.4, scale: 0.18, color: 0x87d8ff },
    { x: 2.2, y: 1.7, z: -1.8, scale: 0.2, color: 0xffa7df },
    { x: 2.8, y: -1.1, z: -2.1, scale: 0.12, color: 0x6df7d2 },
  ]) {
    const star = new THREE.Mesh(
      new THREE.OctahedronGeometry(config.scale, 0),
      createMaterial(config.color, { emissive: config.color, emissiveIntensity: 0.22 })
    );
    star.position.set(config.x, config.y, config.z);
    scene.add(star);
    sparkles.push(star);
  }

  return {
    renderer,
    scene,
    camera,
    avatarRoot,
    externalModelRoot,
    torso,
    headPivot,
    hairCap,
    bangs,
    sideLockLeft,
    sideLockRight,
    ponyTail,
    ponySegments,
    leftEye,
    rightEye,
    leftBrow,
    rightBrow,
    mouthFrame,
    mouthInner,
    leftHandRig,
    rightHandRig,
    sparkles,
  };
}

function disposeLoadedModel() {
  const scene3d = appState.scene3d;
  if (!scene3d || !appState.loadedModel) {
    return;
  }

  scene3d.externalModelRoot.remove(appState.loadedModel.root);
  cleanupObject3D(appState.loadedModel.root);
  appState.loadedModel = null;
  scene3d.externalModelRoot.visible = false;
  scene3d.avatarRoot.visible = true;

  if (appState.activeModelUrl) {
    URL.revokeObjectURL(appState.activeModelUrl);
    appState.activeModelUrl = null;
  }

  setModelNote("頭の向き、目、口、手の位置を 3D で反映");
}

function prepareLoadedScene(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxSize = Math.max(size.x, size.y, size.z, 0.001);
  const scale = 9.15 / maxSize;
  root.position.sub(center);
  root.scale.setScalar(scale);
  root.position.x = 0;
  root.position.y = -5.9;
}

function buildLoadedModelRig(root, vrm) {
  const rig = {
    type: vrm ? "vrm" : "gltf",
    root,
    vrm,
    head: null,
    neck: null,
    spine: null,
    leftUpperArm: null,
    leftLowerArm: null,
    leftHand: null,
    rightUpperArm: null,
    rightLowerArm: null,
    rightHand: null,
    blinkLeft: [],
    blinkRight: [],
    mouthA: [],
    mouthO: [],
    mouthSmile: [],
    defaults: {},
  };

  if (vrm?.humanoid) {
    rig.head = vrm.humanoid.getNormalizedBoneNode("head");
    rig.neck = vrm.humanoid.getNormalizedBoneNode("neck");
    rig.spine = vrm.humanoid.getNormalizedBoneNode("spine");
    rig.leftUpperArm = vrm.humanoid.getNormalizedBoneNode("leftUpperArm");
    rig.leftLowerArm = vrm.humanoid.getNormalizedBoneNode("leftLowerArm");
    rig.leftHand = vrm.humanoid.getNormalizedBoneNode("leftHand");
    rig.rightUpperArm = vrm.humanoid.getNormalizedBoneNode("rightUpperArm");
    rig.rightLowerArm = vrm.humanoid.getNormalizedBoneNode("rightLowerArm");
    rig.rightHand = vrm.humanoid.getNormalizedBoneNode("rightHand");
    for (const side of ['left', 'right']) {
      for (const [f, joints] of [
        ['Thumb', ['Metacarpal', 'Proximal', 'Distal']],
        ['Index', ['Proximal', 'Intermediate', 'Distal']],
        ['Middle', ['Proximal', 'Intermediate', 'Distal']],
        ['Ring', ['Proximal', 'Intermediate', 'Distal']],
        ['Little', ['Proximal', 'Intermediate', 'Distal']],
      ]) {
        for (const j of joints) {
          const key = `${side}${f}${j}`;
          rig[key] = vrm.humanoid.getNormalizedBoneNode(key);
        }
      }
    }
  } else {
    rig.head = findBoneByPatterns(root, ["head"]);
    rig.neck = findBoneByPatterns(root, ["neck"]);
    rig.spine = findBoneByPatterns(root, ["spine", "chest", "upperchest"]);
    rig.leftUpperArm = findBoneByPatterns(root, ["leftupperarm", "leftarm", "lupperarm"]);
    rig.leftLowerArm = findBoneByPatterns(root, ["leftlowerarm", "leftforearm", "lforearm"]);
    rig.leftHand = findBoneByPatterns(root, ["lefthand", "lhand"]);
    rig.rightUpperArm = findBoneByPatterns(root, ["rightupperarm", "rightarm", "rupperarm"]);
    rig.rightLowerArm = findBoneByPatterns(root, ["rightlowerarm", "rightforearm", "rforearm"]);
    rig.rightHand = findBoneByPatterns(root, ["righthand", "rhand"]);
  }

  rig.blinkLeft = findMorphTargets(root, ["blinkleft", "eyeblinkleft", "leftblink", "eyecloseleft"]);
  rig.blinkRight = findMorphTargets(root, ["blinkright", "eyeblinkright", "rightblink", "eyecloseright"]);
  rig.mouthA = findMorphTargets(root, ["moutha", "aa", "ah", "vrcv_aa", "a_"]);
  rig.mouthO = findMorphTargets(root, ["moutho", "oh", "ou", "vrcv_oh", "o_"]);
  rig.mouthSmile = findMorphTargets(root, ["smile", "happy", "joy"]);
  rig.defaults = {
    leftUpperArm: captureBoneTransform(rig.leftUpperArm),
    leftLowerArm: captureBoneTransform(rig.leftLowerArm),
    leftHand: captureBoneTransform(rig.leftHand),
    rightUpperArm: captureBoneTransform(rig.rightUpperArm),
    rightLowerArm: captureBoneTransform(rig.rightLowerArm),
    rightHand: captureBoneTransform(rig.rightHand),
  };

  // Capture each arm bone's "to-child" direction in its OWN local frame.
  // This is the empirical rest axis used as the `from` argument of
  // setFromUnitVectors during IK aim — robust against any normalized-bone
  // axis convention quirks (we don't assume +X / +Y / +Z).
  function dirToChild(child, fallback) {
    if (!child) return fallback.clone();
    const d = child.position.clone();
    if (d.lengthSq() < 1e-10) return fallback.clone();
    return d.normalize();
  }
  const FX = new THREE.Vector3(1, 0, 0);
  const NX = new THREE.Vector3(-1, 0, 0);
  rig.boneAxis = {
    leftUpperArm:  dirToChild(rig.leftLowerArm,  FX),
    rightUpperArm: dirToChild(rig.rightLowerArm, NX),
    leftLowerArm:  dirToChild(rig.leftHand,      FX),
    rightLowerArm: dirToChild(rig.rightHand,     NX),
  };

  for (const side of ['left', 'right']) {
    for (const [f, joints] of [
      ['Thumb', ['Metacarpal', 'Proximal', 'Distal']],
      ['Index', ['Proximal', 'Intermediate', 'Distal']],
      ['Middle', ['Proximal', 'Intermediate', 'Distal']],
      ['Ring', ['Proximal', 'Intermediate', 'Distal']],
      ['Little', ['Proximal', 'Intermediate', 'Distal']],
    ]) {
      for (const j of joints) {
        const key = `${side}${f}${j}`;
        rig.defaults[key] = captureBoneTransform(rig[key]);
      }
    }
  }

  return rig;
}

function applyMorphTargets(targets, value) {
  targets.forEach(({ node, index }) => {
    node.morphTargetInfluences[index] = value;
  });
}

function setVRMExpressionSafe(vrm, names, value) {
  if (!vrm?.expressionManager) {
    return;
  }
  for (const name of names) {
    try {
      vrm.expressionManager.setValue(name, value);
    } catch (error) {
    }
  }
}

async function loadExternalAvatarModel(file) {
  const scene3d = appState.scene3d;
  if (!scene3d || !file) {
    return;
  }

  setModelNote(`モデル読込中: ${file.name}`);
  disposeLoadedModel();

  const objectUrl = URL.createObjectURL(file);
  appState.activeModelUrl = objectUrl;

  try {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(objectUrl);
    const vrm = gltf.userData.vrm ?? null;
    const root = vrm?.scene ?? gltf.scene;
    prepareLoadedScene(root);
    scene3d.externalModelRoot.add(root);
    scene3d.externalModelRoot.visible = true;
    scene3d.avatarRoot.visible = false;

    appState.loadedModel = buildLoadedModelRig(root, vrm);
    setModelNote(vrm ? `VRM 読込中: ${file.name}` : `GLB 読込中: ${file.name}`);
  } catch (error) {
    console.error(error);
    if (appState.activeModelUrl) {
      URL.revokeObjectURL(appState.activeModelUrl);
      appState.activeModelUrl = null;
    }
    scene3d.externalModelRoot.clear();
    scene3d.externalModelRoot.visible = false;
    scene3d.avatarRoot.visible = true;
    setModelNote("モデル読込に失敗したため、内蔵アバターを表示中");
    setStatus("モデル読込に失敗しました", false, true);
  }
}

async function loadDefaultAvatar() {
  try {
    const response = await fetch(DEFAULT_AVATAR_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`default avatar fetch failed: ${response.status}`);
    }
    const blob = await response.blob();
    const file = new File([blob], DEFAULT_AVATAR_NAME, { type: blob.type || "model/vrm-binary" });
    await loadExternalAvatarModel(file);
  } catch (error) {
    console.error(error);
  }
}

function bindModelInput() {
  loadModelButton.addEventListener("click", () => {
    modelInput.click();
  });

  modelInput.addEventListener("change", async (event) => {
    const [file] = event.currentTarget.files || [];
    if (!file) {
      return;
    }
    await loadExternalAvatarModel(file);
    event.currentTarget.value = "";
  });

  if (debugDumpButton) {
    debugDumpButton.addEventListener("click", () => {
      try {
        const dump = collectDebugDump();
        const text = JSON.stringify(dump, null, 2);
        console.group("[live-avatar debug dump]");
        console.log(text);
        console.groupEnd();
        // Try clipboard
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).catch(() => {});
        }
        // Trigger file download
        const blob = new Blob([text], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `live-avatar-debug-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } catch (e) {
        console.error("debug dump failed", e);
      }
    });
  }
}

// Snapshot the current state of the IK pipeline so we can diagnose
// arm-direction problems without guessing. Returns plain JSON.
function collectDebugDump() {
  const lm = appState.loadedModel;
  function vec3(v) {
    if (!v) return null;
    return { x: +v.x.toFixed(4), y: +v.y.toFixed(4), z: +v.z.toFixed(4) };
  }
  function quat(q) {
    if (!q) return null;
    return { x: +q.x.toFixed(4), y: +q.y.toFixed(4), z: +q.z.toFixed(4), w: +q.w.toFixed(4) };
  }
  function boneSnapshot(bone) {
    if (!bone) return null;
    bone.updateWorldMatrix(true, false);
    const wp = bone.getWorldPosition(new THREE.Vector3());
    const wq = bone.getWorldQuaternion(new THREE.Quaternion());
    return {
      name: bone.name || null,
      localPosition: vec3(bone.position),
      localQuaternion: quat(bone.quaternion),
      worldPosition: vec3(wp),
      worldQuaternion: quat(wq),
    };
  }
  function childWorldDir(bone, child) {
    if (!bone || !child) return null;
    bone.updateWorldMatrix(true, false);
    child.updateWorldMatrix(true, false);
    const a = bone.getWorldPosition(new THREE.Vector3());
    const b = child.getWorldPosition(new THREE.Vector3());
    const d = b.sub(a);
    const len = d.length();
    if (len < 1e-9) return { length: 0, dir: null };
    return { length: +len.toFixed(4), dir: vec3(d.divideScalar(len)) };
  }

  // Compute what shapeWorldDir() would produce for the LATEST pose data.
  function targetDirsFor(armPose) {
    if (!armPose?.active) return { active: false };
    const shoulder = { x: armPose.shoulderX, y: armPose.shoulderY, z: armPose.shoulderZ };
    const elbow    = { x: armPose.elbowX,    y: armPose.elbowY,    z: armPose.elbowZ };
    const wrist    = { x: armPose.wristX,    y: armPose.wristY,    z: armPose.wristZ };
    const upRaw = poseDirToWorld(shoulder, elbow, new THREE.Vector3());
    const loRaw = poseDirToWorld(elbow,    wrist, new THREE.Vector3());
    const upShaped = shapeWorldDir(upRaw.clone());
    const loShaped = shapeWorldDir(loRaw.clone());
    return {
      active: true,
      shoulder, elbow, wrist,
      upperArmRawWorldDir: vec3(upRaw),
      upperArmShapedWorldDir: vec3(upShaped.normalize()),
      lowerArmRawWorldDir: vec3(loRaw),
      lowerArmShapedWorldDir: vec3(loShaped.normalize()),
    };
  }

  return {
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    vrm: lm?.vrm ? {
      hasHumanoid: !!lm.vrm.humanoid,
      meta: lm.vrm.meta || null,
    } : null,
    boneAxis: lm?.boneAxis ? {
      leftUpperArm:  vec3(lm.boneAxis.leftUpperArm),
      rightUpperArm: vec3(lm.boneAxis.rightUpperArm),
      leftLowerArm:  vec3(lm.boneAxis.leftLowerArm),
      rightLowerArm: vec3(lm.boneAxis.rightLowerArm),
    } : null,
    bones: lm ? {
      leftUpperArm:  boneSnapshot(lm.leftUpperArm),
      leftLowerArm:  boneSnapshot(lm.leftLowerArm),
      leftHand:      boneSnapshot(lm.leftHand),
      rightUpperArm: boneSnapshot(lm.rightUpperArm),
      rightLowerArm: boneSnapshot(lm.rightLowerArm),
      rightHand:     boneSnapshot(lm.rightHand),
    } : null,
    actualWorldDirsFromBones: lm ? {
      leftUpperArmActual: childWorldDir(lm.leftUpperArm, lm.leftLowerArm),
      leftLowerArmActual: childWorldDir(lm.leftLowerArm, lm.leftHand),
      rightUpperArmActual: childWorldDir(lm.rightUpperArm, lm.rightLowerArm),
      rightLowerArmActual: childWorldDir(lm.rightLowerArm, lm.rightHand),
    } : null,
    poseArms: appState.poseArms?.map(arm => arm?.active ? {
      active: true,
      shoulderX: +arm.shoulderX?.toFixed(4),
      shoulderY: +arm.shoulderY?.toFixed(4),
      shoulderZ: +arm.shoulderZ?.toFixed(4),
      elbowX: +arm.elbowX?.toFixed(4),
      elbowY: +arm.elbowY?.toFixed(4),
      elbowZ: +arm.elbowZ?.toFixed(4),
      wristX: +arm.wristX?.toFixed(4),
      wristY: +arm.wristY?.toFixed(4),
      wristZ: +arm.wristZ?.toFixed(4),
    } : { active: false }),
    // Mirror mapping currently in use:
    //   modelLeftHand   = screenRightHand   = avatar.hands[1]   = handsDetected[1]
    //   modelRightHand  = screenLeftHand    = avatar.hands[0]   = handsDetected[0]
    //   modelLeftArmPose = poseArms[1] (rightmost on mirror screen)
    //   modelRightArmPose = poseArms[0] (leftmost on mirror screen)
    targetDirs: {
      modelLeftArm: targetDirsFor(appState.poseArms?.[1]),
      modelRightArm: targetDirsFor(appState.poseArms?.[0]),
    },
    constants: {
      POSE_Z_FORWARD_GAIN,
      ARM_SLERP_AMOUNT: 0.12,
      FINGER_EMA_ALPHA: 0.06,
    },
    fingerStates: lm?._fs ? {
      l: lm._fs.l ? Object.fromEntries(Object.entries(lm._fs.l).map(([k,v]) => [k, +(+v).toFixed(3)])) : null,
      r: lm._fs.r ? Object.fromEntries(Object.entries(lm._fs.r).map(([k,v]) => [k, +(+v).toFixed(3)])) : null,
      lLost: lm._fs.lLost || 0,
      rLost: lm._fs.rLost || 0,
    } : null,
    rawFingerComputed: {
      l: appState.handsDetected[1] ? computeFingerState(appState.handsDetected[1]) : null,
      r: appState.handsDetected[0] ? computeFingerState(appState.handsDetected[0]) : null,
    },
    sampleFingerBoneRotation: lm ? {
      leftIndexProximal: lm.leftIndexProximal ? {
        x: +lm.leftIndexProximal.rotation.x.toFixed(3),
        y: +lm.leftIndexProximal.rotation.y.toFixed(3),
        z: +lm.leftIndexProximal.rotation.z.toFixed(3),
      } : null,
      rightIndexProximal: lm.rightIndexProximal ? {
        x: +lm.rightIndexProximal.rotation.x.toFixed(3),
        y: +lm.rightIndexProximal.rotation.y.toFixed(3),
        z: +lm.rightIndexProximal.rotation.z.toFixed(3),
      } : null,
      leftThumbProximal: lm.leftThumbProximal ? {
        x: +lm.leftThumbProximal.rotation.x.toFixed(3),
        y: +lm.leftThumbProximal.rotation.y.toFixed(3),
        z: +lm.leftThumbProximal.rotation.z.toFixed(3),
      } : null,
      rightThumbProximal: lm.rightThumbProximal ? {
        x: +lm.rightThumbProximal.rotation.x.toFixed(3),
        y: +lm.rightThumbProximal.rotation.y.toFixed(3),
        z: +lm.rightThumbProximal.rotation.z.toFixed(3),
      } : null,
    } : null,
    avatar: appState.avatar ? {
      yaw: +appState.avatar.yaw.toFixed(4),
      pitch: +appState.avatar.pitch.toFixed(4),
      centerX: +appState.avatar.centerX.toFixed(4),
      centerY: +appState.avatar.centerY.toFixed(4),
    } : null,
  };
}

function bindTuneControls() {
  const tune = appState.tune;

  function wireRange(inputId, valueId, key, format = (v) => v.toFixed(2)) {
    const input = document.getElementById(inputId);
    const valueEl = document.getElementById(valueId);
    if (!input || !valueEl) return;
    input.value = String(tune[key]);
    valueEl.textContent = format(tune[key]);
    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) {
        tune[key] = v;
        valueEl.textContent = format(v);
        saveTune();
      }
    });
  }

  function wireSelect(selectId, key) {
    const el = document.getElementById(selectId);
    if (!el) return;
    el.value = String(tune[key]);
    el.addEventListener("change", () => {
      tune[key] = el.value;
      saveTune();
    });
  }

  function wireSignButton(btnId, key) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const refresh = () => { btn.textContent = tune[key] > 0 ? "+" : "−"; };
    refresh();
    btn.addEventListener("click", () => {
      tune[key] = tune[key] > 0 ? -1 : 1;
      refresh();
      saveTune();
    });
  }

  wireRange("tunePalmL", "tuneValPalmL", "palmTwistL");
  wireRange("tunePalmR", "tuneValPalmR", "palmTwistR");
  wireRange("tunePalmFollow", "tuneValPalmFollow", "palmFollowHands");
  wireRange("tuneFingerGain", "tuneValFingerGain", "fingerGain");
  wireSelect("tuneFingerAxis", "fingerAxis");
  wireSignButton("tuneFingerSignL", "fingerSignL");
  wireSignButton("tuneFingerSignR", "fingerSignR");

  const resetBtn = document.getElementById("tuneReset");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      Object.assign(appState.tune, TUNE_DEFAULTS);
      saveTune();
      // Refresh UI values.
      for (const [inputId, valueId, key] of [
        ["tunePalmL", "tuneValPalmL", "palmTwistL"],
        ["tunePalmR", "tuneValPalmR", "palmTwistR"],
        ["tunePalmFollow", "tuneValPalmFollow", "palmFollowHands"],
        ["tuneFingerGain", "tuneValFingerGain", "fingerGain"],
      ]) {
        const input = document.getElementById(inputId);
        const valueEl = document.getElementById(valueId);
        if (input) input.value = String(appState.tune[key]);
        if (valueEl) valueEl.textContent = appState.tune[key].toFixed(2);
      }
      const axisSel = document.getElementById("tuneFingerAxis");
      if (axisSel) axisSel.value = appState.tune.fingerAxis;
      const lBtn = document.getElementById("tuneFingerSignL");
      const rBtn = document.getElementById("tuneFingerSignR");
      if (lBtn) lBtn.textContent = appState.tune.fingerSignL > 0 ? "+" : "−";
      if (rBtn) rBtn.textContent = appState.tune.fingerSignR > 0 ? "+" : "−";
    });
  }
}

function resizeThreeScene() {
  const scene3d = appState.scene3d;
  if (!scene3d) {
    return;
  }
  const rect = avatarViewport.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  scene3d.renderer.setSize(width, height, false);
  scene3d.camera.aspect = width / height;
  scene3d.camera.updateProjectionMatrix();
}

function updateHandRig(handRig, handState) {
  const side = handRig.side;
  const active = handState.active;
  const reach = side < 0 ? 0.5 - handState.x : handState.x - 0.5;

  handRig.rig.position.x = side * (1.22 + reach * 1.02);
  handRig.rig.position.y = -0.98 + (0.8 - handState.y) * 2.26;
  handRig.rig.position.z = 0.42 + active * 0.42;

  handRig.armPivot.rotation.z = side * (0.2 - handState.raise * 0.72) + handState.angle * 0.28;
  handRig.armPivot.rotation.x = -0.1 + handState.raise * 0.22;
  handRig.elbowPivot.rotation.z = side * (0.34 + handState.raise * 0.28);
  handRig.wristPivot.rotation.z = handState.angle * 0.56 + side * 0.12;
  handRig.wristPivot.rotation.y = side * (0.22 + active * 0.32);
  handRig.palm.scale.setScalar(0.94 + active * 0.05);
  handRig.thumb.rotation.z = side * (-0.8 + handState.pinch * 0.74);

  const spread = 0.12 + handState.openness * 0.28;
  const curl = 0.18 + (1 - handState.openness) * 0.56 + handState.pinch * 0.18;
  const fingerOffsets = [-0.18, -0.06, 0.06, 0.18];

  handRig.fingers.forEach((finger, index) => {
    finger.group.position.y = fingerOffsets[index] * (0.5 + spread);
    finger.group.rotation.z = side * (-0.1 + (index - 1.5) * 0.08) + curl * side * 0.34;
    finger.group.rotation.x = -curl * 0.38;
    finger.base.scale.y = 1 + handState.openness * 0.12;
  });
}

function rotateBoneIfPresent(bone, x, y, z, amount = 0.18) {
  if (!bone) {
    return;
  }
  bone.rotation.x = lerp(bone.rotation.x, x, amount);
  bone.rotation.y = lerp(bone.rotation.y, y, amount);
  bone.rotation.z = lerp(bone.rotation.z, z, amount);
}

function computeFingerState(hand) {
  if (!hand?.points || hand.points.length < 21) return null;
  const pts = hand.points;
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function curl(mcpI, pipI, dipI, tipI) {
    const extended = d(pts[mcpI], pts[pipI]) + d(pts[pipI], pts[dipI]) + d(pts[dipI], pts[tipI]);
    // Reach 1.0 (full grip) when tip is at ~53% of extended distance from MCP.
    // Threshold 0.8 + 3.0x amplification: 1 - 0.53/0.8 = 0.34, * 3.0 = 1.02 → clamp to 1.
    // Earlier values (0.7 / 2.4) required tip < 41% which a real fist often
    // doesn't reach due to knuckle thickness, leaving fingers half-curled.
    return clamp((1 - d(pts[mcpI], pts[tipI]) / Math.max(extended * 0.8, 0.001)) * 3.0, 0, 1);
  }
  const palmW = Math.max(0.001, d(pts[5], pts[17]));
  return {
    // Thumb is detected by tip-to-mid-of-palm distance; raise the gain too.
    thumb:  clamp((1 - d(pts[4], pts[9]) / Math.max(palmW * 1.4, 0.001)) * 1.6, 0, 1),
    index:  curl(5, 6, 7, 8),
    middle: curl(9, 10, 11, 12),
    ring:   curl(13, 14, 15, 16),
    little: curl(17, 18, 19, 20),
  };
}

// Estimate palm roll (forearm pronation/supination) from the depth difference
// between index-base (pt[5]) and pinky-base (pt[17]).
// Positive return = palm rolling toward camera-facing side.
function computePalmRoll(hand) {
  if (!hand?.points || hand.points.length < 21) return 0;
  const pts = hand.points;
  const dx = pts[5].x - pts[17].x;
  const dy = pts[5].y - pts[17].y;
  const dz = pts[5].z - pts[17].z;
  return clamp(Math.atan2(dz, Math.max(0.001, Math.hypot(dx, dy))) * 1.8, -1.4, 1.4);
}

function applyFingerCurl(model, side, state, sign, axis, gain) {
  // Per-joint curl angles (radians) at full curl. Tuned so that curlVal=1
  // produces a tight grip (~270° total per finger) without over-driving any
  // single joint past its natural anatomical limit.
  //
  // Each spec: [name, joints, weights, curlValue, axisOverride, signOverride]
  // axisOverride / signOverride let the thumb behave anatomically — its rest
  // pose is angled ~45° forward of palm, so applying the same Z-axis rotation
  // as the other fingers makes it twist sideways instead of curling toward
  // the palm. Empirically using the Y axis with opposite sign curls the
  // thumb toward the index finger (= natural fist).
  const specs = [
    ['Thumb',  ['Metacarpal', 'Proximal', 'Distal'],      [0.9, 1.0, 0.9], state?.thumb  ?? 0, 'y', -1],
    ['Index',  ['Proximal', 'Intermediate', 'Distal'],    [1.7, 1.7, 1.3], state?.index  ?? 0, null, 1],
    ['Middle', ['Proximal', 'Intermediate', 'Distal'],    [1.7, 1.7, 1.3], state?.middle ?? 0, null, 1],
    ['Ring',   ['Proximal', 'Intermediate', 'Distal'],    [1.7, 1.7, 1.3], state?.ring   ?? 0, null, 1],
    ['Little', ['Proximal', 'Intermediate', 'Distal'],    [1.6, 1.6, 1.2], state?.little ?? 0, null, 1],
  ];
  const defaultAxisKey = axis === "x" ? "x" : "z";
  for (const [finger, joints, weights, curlVal, axisOverride, fingerSign] of specs) {
    const axisKey = axisOverride ?? defaultAxisKey;
    const otherKeys = axisKey === "x" ? ["y", "z"] : axisKey === "y" ? ["x", "z"] : ["x", "y"];
    joints.forEach((joint, ji) => {
      const key = `${side}${finger}${joint}`;
      const bone = model[key];
      const def = model.defaults[key];
      if (!bone || !def) return;
      const target = def.rotation[axisKey] + sign * fingerSign * curlVal * weights[ji] * gain;
      bone.rotation[axisKey] = lerp(bone.rotation[axisKey], target, 0.15);
      for (const k of otherKeys) {
        bone.rotation[k] = lerp(bone.rotation[k], def.rotation[k], 0.15);
      }
    });
  }
}

function rotateBoneFromDefault(bone, defaults, x, y, z, amount = 0.18) {
  if (!bone || !defaults?.rotation) {
    return;
  }
  bone.rotation.x = lerp(bone.rotation.x, defaults.rotation.x + x, amount);
  bone.rotation.y = lerp(bone.rotation.y, defaults.rotation.y + y, amount);
  bone.rotation.z = lerp(bone.rotation.z, defaults.rotation.z + z, amount);
}

// Convert a (from → to) direction expressed in MediaPipe-mirror image space
// (x rightward, y downward, z negative-toward-camera) into VRM world direction
// (x = avatar's anatomical left, y up, z toward viewer).
const _vec3a = new THREE.Vector3();
const _vec3b = new THREE.Vector3();
const _quatA = new THREE.Quaternion();
const _quatB = new THREE.Quaternion();
function poseDirToWorld(from, to, out) {
  out.set(to.x - from.x, -(to.y - from.y), -(to.z - from.z));
  return out;
}

// Aim a bone so that its default-direction axis (in PARENT's local frame)
// points in the given world-space direction. Slerps toward the target.
function aimBoneAtWorldDir(bone, defaultDirParentLocal, worldDir, smooth) {
  if (!bone || !bone.parent) return;
  const len = worldDir.length();
  if (len < 1e-5) return;
  // Convert world dir → parent local frame (direction only).
  bone.parent.updateWorldMatrix(true, false);
  bone.parent.getWorldQuaternion(_quatA);
  _quatA.invert();
  _vec3b.copy(worldDir).divideScalar(len).applyQuaternion(_quatA);
  _quatB.setFromUnitVectors(defaultDirParentLocal, _vec3b);
  bone.quaternion.slerp(_quatB, smooth);
}

// Default arm-direction axes are NOT hard-coded. Instead each rig captures
// the bone-to-child position vector at load time (`rig.boneAxis`) and that
// is used as the empirical "rest direction" for IK aim — robust to any
// normalized-bone axis convention quirks per VRM file.

// Resting world direction when no pose tracking is available — arms hang straight down.
const ARM_REST_DIR = new THREE.Vector3(0, -1, 0);

// Asymmetric z handling:
//   * Forward (+world.z, toward viewer): pass through ~1:1, then soft-cap
//     so extreme depth (e.g. hand close to camera) doesn't drag the
//     shoulder visibly forward of the torso. Above POSE_Z_FORWARD_KNEE the
//     contribution saturates toward POSE_Z_FORWARD_CAP.
//   * Backward (-world.z): hard-clamp to 0. Pose z is noisy and oscillates
//     around 0 at rest, which previously made the arm wobble behind the body.
const POSE_Z_FORWARD_GAIN = 1.0;
const POSE_Z_FORWARD_CAP = 0.40;  // hard ceiling on world +z direction
const POSE_Z_FORWARD_KNEE = 0.25; // start saturating above this

function shapeWorldDir(v) {
  if (v.z < 0) {
    v.z = 0;
    return v;
  }
  let z = v.z * POSE_Z_FORWARD_GAIN;
  if (z > POSE_Z_FORWARD_KNEE) {
    // Soft saturating curve: blend linear (below knee) and asymptote (cap).
    const over = z - POSE_Z_FORWARD_KNEE;
    const range = POSE_Z_FORWARD_CAP - POSE_Z_FORWARD_KNEE;
    // 1 - 1/(1+x) shape — at x=0 returns 0, at x→∞ returns range.
    z = POSE_Z_FORWARD_KNEE + range * (1 - 1 / (1 + over / range));
  }
  v.z = z;
  return v;
}

function aimArm(rig, side, armPose) {
  const upperArm = rig[side + "UpperArm"];
  const lowerArm = rig[side + "LowerArm"];
  if (!upperArm || !lowerArm) return;
  const upperAxis = rig.boneAxis?.[side + "UpperArm"];
  const lowerAxis = rig.boneAxis?.[side + "LowerArm"];
  if (!upperAxis || !lowerAxis) return;

  let upperWorldDir;
  let lowerWorldDir;
  if (armPose?.active) {
    const shoulder = { x: armPose.shoulderX, y: armPose.shoulderY, z: armPose.shoulderZ };
    const elbow    = { x: armPose.elbowX,    y: armPose.elbowY,    z: armPose.elbowZ };
    const wrist    = { x: armPose.wristX,    y: armPose.wristY,    z: armPose.wristZ };
    upperWorldDir = shapeWorldDir(poseDirToWorld(shoulder, elbow, new THREE.Vector3()));
    lowerWorldDir = shapeWorldDir(poseDirToWorld(elbow,    wrist, new THREE.Vector3()));
  } else {
    upperWorldDir = ARM_REST_DIR.clone();
    lowerWorldDir = ARM_REST_DIR.clone();
  }

  // Slower slerp (~9 frame half-life @60fps) for a calmer, less twitchy feel.
  aimBoneAtWorldDir(upperArm, upperAxis, upperWorldDir, 0.12);
  // After upper arm rotation, parent of forearm (= upperArm) has new world
  // orientation; updateWorldMatrix inside aimBoneAtWorldDir handles that.
  aimBoneAtWorldDir(lowerArm, lowerAxis, lowerWorldDir, 0.12);
}

// Apply forearm twist (palm rotation) around the bone's own length axis,
// as captured in rig.boneAxis. Composed AFTER aimArm to set palm orientation.
function applyPalmTwist(rig, side, handData, tune) {
  const forearm = rig[side + "LowerArm"];
  if (!forearm) return;
  const axis = rig.boneAxis?.[side + "LowerArm"];
  if (!axis) return;
  const palmSignal = handData ? computePalmRoll(handData) : 0;
  const baseTwist = side === "left" ? tune.palmTwistL : tune.palmTwistR;
  // Mirror convention: when the user's palm faces themselves, the avatar's
  // palm should face the avatar (toward viewer). Previous sign was inverted —
  // the avatar's thumb pointed outward when the user's pointed inward.
  const followSign = side === "left" ? -1 : 1;
  const angle = baseTwist + followSign * palmSignal * tune.palmFollowHands;
  if (Math.abs(angle) < 1e-6) return;
  _quatA.setFromAxisAngle(axis, angle);
  _quatB.copy(forearm.quaternion).multiply(_quatA);
  forearm.quaternion.slerp(_quatB, 0.5);
}

function moveBoneIfPresent(bone, defaults, x, y, z, amount = 0.18) {
  if (!bone || !defaults?.position) {
    return;
  }
  bone.position.x = lerp(bone.position.x, defaults.position.x + x, amount);
  bone.position.y = lerp(bone.position.y, defaults.position.y + y, amount);
  bone.position.z = lerp(bone.position.z, defaults.position.z + z, amount);
}

function updateLoadedModelPose(loadedModel, avatar) {
  const root = loadedModel.root;
  root.position.x = lerp(root.position.x, -avatar.centerX * 0.92, 0.12);
  root.position.y = lerp(root.position.y, -8.22 - avatar.centerY * 0.1, 0.12);
  root.rotation.y = lerp(root.rotation.y, avatar.yaw * 0.34, 0.12);

  rotateBoneIfPresent(loadedModel.spine, avatar.pitch * 0.08, avatar.yaw * 0.08, -avatar.roll * 0.04);
  rotateBoneIfPresent(loadedModel.neck, avatar.pitch * 0.08 - 0.03, avatar.yaw * 0.18, -avatar.roll * 0.06);
  rotateBoneIfPresent(loadedModel.head, avatar.pitch * 0.15 - 0.05, avatar.yaw * 0.32, -avatar.roll * 0.08);

  const screenLeftHand = avatar.hands[0];
  const screenRightHand = avatar.hands[1];
  const screenLeftArmPose = appState.poseArms[0];
  const screenRightArmPose = appState.poseArms[1];

  // Mirror mapping: person's right → model's left (like a mirror), person's left → model's right
  const modelLeftHand = screenRightHand;
  const modelRightHand = screenLeftHand;
  const modelLeftArmPose = screenRightArmPose;
  const modelRightArmPose = screenLeftArmPose;

  const tune = appState.tune;

  // MediaPipe Hands data for avatar left/right (handsDetected already sorted by screen X).
  const leftHandData = appState.handsDetected[1] ?? null;
  const rightHandData = appState.handsDetected[0] ?? null;

  // 3D arm IK using MediaPipe Pose landmarks (x, y, z). Coordinate conversion
  // from MediaPipe-mirror-image space to VRM world space:
  //   * mirror_x grows rightward on the selfie-mirror view  → same sign as VRM +X
  //     (VRM +X = character's anatomical left = viewer's right when facing the avatar)
  //   * mirror_y grows downward                             → flip to get VRM +Y (up)
  //   * mediapipe_z is negative for closer-to-camera        → flip to get VRM +Z (forward toward viewer)
  // So: worldDir = (dx, -dy, -dz)
  aimArm(loadedModel, "left",  modelLeftArmPose);
  aimArm(loadedModel, "right", modelRightArmPose);

  // Forearm pronation/supination (palm orientation), applied as a twist around
  // the bone's length axis AFTER the aim. Uses MediaPipe Hands data when available.
  applyPalmTwist(loadedModel, "left",  leftHandData,  tune);
  applyPalmTwist(loadedModel, "right", rightHandData, tune);

  // Reset hand bones to defaults (no independent rotation); palm direction is
  // inherited from the forearm aim + twist.
  rotateBoneFromDefault(loadedModel.leftHand,  loadedModel.defaults.leftHand,  0, 0, 0, 0.2);
  rotateBoneFromDefault(loadedModel.rightHand, loadedModel.defaults.rightHand, 0, 0, 0, 0.2);

  // Finger tracking with EMA smoothing. Drive purely from MediaPipe Hands
  // (independent of pose) so fingers curl whenever a hand is visible.
  if (!loadedModel._fs) loadedModel._fs = { l: null, r: null, lLost: 0, rLost: 0 };
  function easeFs(prev, curr) {
    if (!curr) return prev;
    if (!prev) return curr;
    // Slower smoothing (~23 frame half-life) for a calm finger feel.
    const a = 0.06;
    return {
      thumb:  lerp(prev.thumb,  curr.thumb,  a),
      index:  lerp(prev.index,  curr.index,  a),
      middle: lerp(prev.middle, curr.middle, a),
      ring:   lerp(prev.ring,   curr.ring,   a),
      little: lerp(prev.little, curr.little, a),
    };
  }
  // leftHandData / rightHandData defined above.
  // Detection grace period: MediaPipe Hands tends to lose tracking on tightly
  // closed fists for a few frames at a time. If we relaxed the fingers
  // immediately the avatar would un-curl mid-pose. Hold the last good state
  // for FINGER_LOST_GRACE frames before fading back to rest.
  const FINGER_LOST_GRACE = 24;     // ~0.4s @60fps
  const FINGER_RELAX_RATE = 0.025;  // very slow fade once grace expires

  if (leftHandData) {
    loadedModel._fs.l = easeFs(loadedModel._fs.l, computeFingerState(leftHandData));
    loadedModel._fs.lLost = 0;
  } else if (loadedModel._fs.l) {
    loadedModel._fs.lLost = (loadedModel._fs.lLost || 0) + 1;
    if (loadedModel._fs.lLost > FINGER_LOST_GRACE) {
      const relax = (k) => lerp(loadedModel._fs.l[k], 0, FINGER_RELAX_RATE);
      loadedModel._fs.l = { thumb: relax("thumb"), index: relax("index"), middle: relax("middle"), ring: relax("ring"), little: relax("little") };
    }
  }
  if (rightHandData) {
    loadedModel._fs.r = easeFs(loadedModel._fs.r, computeFingerState(rightHandData));
    loadedModel._fs.rLost = 0;
  } else if (loadedModel._fs.r) {
    loadedModel._fs.rLost = (loadedModel._fs.rLost || 0) + 1;
    if (loadedModel._fs.rLost > FINGER_LOST_GRACE) {
      const relax = (k) => lerp(loadedModel._fs.r[k], 0, FINGER_RELAX_RATE);
      loadedModel._fs.r = { thumb: relax("thumb"), index: relax("index"), middle: relax("middle"), ring: relax("ring"), little: relax("little") };
    }
  }
  // Apply finger curl BEFORE vrm.update so normalized->raw propagation picks it up.
  applyFingerCurl(loadedModel, "left",  loadedModel._fs.l, tune.fingerSignL, tune.fingerAxis, tune.fingerGain);
  applyFingerCurl(loadedModel, "right", loadedModel._fs.r, tune.fingerSignR, tune.fingerAxis, tune.fingerGain);

  const blinkLeft = clamp(1 - avatar.leftEye * 1.35, 0, 1);
  const blinkRight = clamp(1 - avatar.rightEye * 1.35, 0, 1);
  const mouthA = clamp(avatar.mouth * 1.1, 0, 1);
  const mouthO = clamp(avatar.mouth * 0.65, 0, 1);
  const smile = clamp((avatar.leftEye + avatar.rightEye) * 0.12, 0, 0.16);

  if (loadedModel.vrm) {
    setVRMExpressionSafe(loadedModel.vrm, [VRMExpressionPresetName.Blink, "blink"], (blinkLeft + blinkRight) * 0.5);
    setVRMExpressionSafe(loadedModel.vrm, [VRMExpressionPresetName.BlinkLeft, "blinkLeft"], blinkLeft);
    setVRMExpressionSafe(loadedModel.vrm, [VRMExpressionPresetName.BlinkRight, "blinkRight"], blinkRight);
    setVRMExpressionSafe(loadedModel.vrm, [VRMExpressionPresetName.Aa, "aa"], mouthA);
    setVRMExpressionSafe(loadedModel.vrm, [VRMExpressionPresetName.Oh, "oh"], mouthO);
    setVRMExpressionSafe(loadedModel.vrm, [VRMExpressionPresetName.Happy, "happy"], smile);
    loadedModel.vrm.update(1 / 60);
  }

  applyMorphTargets(loadedModel.blinkLeft, blinkLeft);
  applyMorphTargets(loadedModel.blinkRight, blinkRight);
  applyMorphTargets(loadedModel.mouthA, mouthA);
  applyMorphTargets(loadedModel.mouthO, mouthO);
  applyMorphTargets(loadedModel.mouthSmile, smile);
}

function renderAvatar3d() {
  const avatar = appState.avatar;
  const scene3d = appState.scene3d;
  if (!scene3d) {
    return;
  }

  const floatY = Math.sin(avatar.time * 1.6) * 0.05;
  scene3d.avatarRoot.position.x = avatar.centerX * 0.9;
  scene3d.avatarRoot.position.y = -0.08 + avatar.centerY * 0.42 + floatY;
  scene3d.avatarRoot.rotation.z = avatar.roll * 0.08;

  scene3d.torso.rotation.z = -avatar.yaw * 0.06;
  scene3d.torso.rotation.x = -avatar.pitch * 0.03;

  scene3d.headPivot.rotation.y = avatar.yaw * 0.66;
  scene3d.headPivot.rotation.x = -avatar.pitch * 0.34 + 0.08;
  scene3d.headPivot.rotation.z = avatar.roll * 0.16;

  scene3d.hairCap.rotation.y = avatar.yaw * 0.08;
  scene3d.sideLockLeft.rotation.z = -0.24 - avatar.yaw * 0.12;
  scene3d.sideLockRight.rotation.z = 0.24 - avatar.yaw * 0.12;

  scene3d.bangs.forEach((bang, index) => {
    bang.rotation.z = [-0.2, -0.08, 0.08, 0.2][index] - avatar.yaw * 0.05;
    bang.position.z = 0.92 + Math.abs(avatar.yaw) * 0.06;
  });

  scene3d.ponyTail.rotation.z = 0.28 + Math.sin(avatar.time * 2.4) * 0.08 - avatar.roll * 0.28;
  scene3d.ponyTail.rotation.y = -0.54 - avatar.yaw * 0.34;
  scene3d.ponySegments.forEach((segment, index) => {
    segment.position.y = -0.18 * index - Math.abs(avatar.yaw) * 0.04 * index;
    segment.position.z = -0.08 * index + Math.abs(avatar.pitch) * 0.03 * index;
  });

  const gazeX = avatar.gazeX * 0.11 + avatar.yaw * 0.028;
  const gazeY = avatar.gazeY * 0.08 + avatar.pitch * 0.014;
  scene3d.leftEye.iris.position.set(gazeX, gazeY - 0.01, 0.19);
  scene3d.leftEye.pupil.position.set(gazeX, gazeY - 0.01, 0.28);
  scene3d.rightEye.iris.position.set(gazeX, gazeY - 0.01, 0.19);
  scene3d.rightEye.pupil.position.set(gazeX, gazeY - 0.01, 0.28);

  const leftOpen = clamp(avatar.leftEye, 0.02, 1);
  const rightOpen = clamp(avatar.rightEye, 0.02, 1);
  scene3d.leftEye.group.scale.y = lerp(0.16, 1, leftOpen);
  scene3d.rightEye.group.scale.y = lerp(0.16, 1, rightOpen);
  scene3d.leftEye.topLid.position.y = lerp(0.06, 0.22, leftOpen);
  scene3d.leftEye.bottomLid.position.y = lerp(-0.04, -0.15, leftOpen);
  scene3d.rightEye.topLid.position.y = lerp(0.06, 0.22, rightOpen);
  scene3d.rightEye.bottomLid.position.y = lerp(-0.04, -0.15, rightOpen);

  scene3d.leftBrow.rotation.z = -0.08 - avatar.yaw * 0.1 - (1 - leftOpen) * 0.12;
  scene3d.rightBrow.rotation.z = 0.08 - avatar.yaw * 0.1 + (1 - rightOpen) * 0.12;

  const mouthOpen = clamp(avatar.mouth, 0.02, 1);
  scene3d.mouthFrame.scale.set(1 + mouthOpen * 0.15, 0.45 + mouthOpen * 0.95, 1);
  scene3d.mouthInner.scale.set(1, 0.18 + mouthOpen * 1.9, 1 + mouthOpen * 0.24);
  scene3d.mouthInner.position.y = -mouthOpen * 0.02;

  updateHandRig(scene3d.leftHandRig, avatar.hands[0]);
  updateHandRig(scene3d.rightHandRig, avatar.hands[1]);

  scene3d.sparkles.forEach((star, index) => {
    star.rotation.x += 0.004 + index * 0.001;
    star.rotation.y += 0.008 + index * 0.001;
  });

  if (appState.loadedModel) {
    updateLoadedModelPose(appState.loadedModel, avatar);
  }

  scene3d.renderer.render(scene3d.scene, scene3d.camera);
}

function animationLoop(previousTime = performance.now()) {
  if (appState.destroyed) {
    return;
  }
  const now = performance.now();
  updateAvatarState(now - previousTime);
  renderAvatar3d();
  requestAnimationFrame(() => animationLoop(now));
}

function updateStatusFromTracking() {
  if (appState.face.detected) {
    const handLabel = appState.handsDetected.length ? " 手の動きも反映中" : "";
    setStatus(`顔を読み取り中${handLabel}`, true);
    setOverlayMessage("左のポイントに合わせて、右の 3D アバターが表情と手の動きを連動しています。");
  } else {
    setStatus("顔を探しています", false);
    setOverlayMessage("カメラ中央に顔を合わせると、右の 3D アバターが動き始めます。");
  }
}

async function processFrame() {
  if (appState.destroyed) {
    return;
  }

  if (!appState.processing && video.readyState >= 2 && appState.faceMesh && appState.hands && appState.pose) {
    appState.processing = true;
    try {
      await appState.faceMesh.send({ image: video });
      await appState.hands.send({ image: video });
      await appState.pose.send({ image: video });
    } catch (error) {
      console.error(error);
    } finally {
      appState.processing = false;
    }
  }

  requestAnimationFrame(processFrame);
}

async function startCamera() {
  setStatus("カメラを起動しています", false);
  setOverlayMessage("カメラの許可を待っています。");
  try {
    appState.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    video.srcObject = appState.stream;
    await video.play();
    setStatus("顔を探しています", false);
    setOverlayMessage("顔と手を画面に入れてみてください。");
  } catch (error) {
    console.error(error);
    setStatus("カメラを起動できません", false, true);
    setOverlayMessage("カメラを許可すると、このアプリを使えます。", true);
  }
}

async function setupTrackers() {
  appState.faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
  });
  appState.faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.58,
    minTrackingConfidence: 0.58,
  });
  appState.faceMesh.onResults((results) => {
    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length) {
      appState.face = computeFaceData(results.multiFaceLandmarks[0]);
    } else {
      appState.face = {
        ...appState.face,
        detected: false,
        mouth: 0,
        blink: 0,
        points: [],
      };
    }
    drawOverlay();
    updateStats();
    updateStatusFromTracking();
  });

  function smoothPoseArms(prev, next) {
    if (!prev || prev.length !== next.length) return next;
    // Generic XY/angle smoothing — lighter for direct positional response.
    const alpha = 0.22;
    // Z (depth) is much noisier and less reliable in MediaPipe Pose; smooth
    // it more (but not so heavily that forward motion takes seconds to ramp).
    const alphaZ = 0.10;
    return next.map((arm, i) => {
      const p = prev[i];
      if (!arm?.active || !p?.active) return arm;
      return {
        ...arm,
        upperAngle: lerp(p.upperAngle, arm.upperAngle, alpha),
        lowerAngle: lerp(p.lowerAngle, arm.lowerAngle, alpha),
        shoulderX: lerp(p.shoulderX, arm.shoulderX, alpha),
        shoulderY: lerp(p.shoulderY, arm.shoulderY, alpha),
        shoulderZ: lerp(p.shoulderZ ?? 0, arm.shoulderZ ?? 0, alphaZ),
        elbowX: lerp(p.elbowX, arm.elbowX, alpha),
        elbowY: lerp(p.elbowY, arm.elbowY, alpha),
        elbowZ: lerp(p.elbowZ ?? 0, arm.elbowZ ?? 0, alphaZ),
        wristX: lerp(p.wristX, arm.wristX, alpha),
        wristY: lerp(p.wristY, arm.wristY, alpha),
        wristZ: lerp(p.wristZ ?? 0, arm.wristZ ?? 0, alphaZ),
      };
    });
  }

  appState.hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });
  appState.hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    // Lowered from 0.55 / 0.55 — at the higher threshold, MediaPipe Hands
    // intermittently failed to detect the user's right hand (returning only
    // one of two visible hands), causing the avatar's left fingers to never
    // animate. 0.4 still rejects clear non-hand backgrounds.
    minDetectionConfidence: 0.4,
    minTrackingConfidence: 0.4,
  });
  appState.hands.onResults((results) => {
    appState.handsDetected = computeHandData(results.multiHandLandmarks);
    appState.poseArms = smoothPoseArms(appState.poseArms, computePoseArmData(appState.poseDetections));
    drawOverlay();
    updateStatusFromTracking();
  });

  appState.pose = new Pose({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
  });
  appState.pose.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  appState.pose.onResults((results) => {
    appState.poseDetections = results.poseLandmarks ? [results] : [];
    appState.poseArms = smoothPoseArms(appState.poseArms, computePoseArmData(appState.poseDetections));
    drawOverlay();
  });
}

function cleanup() {
  appState.destroyed = true;
  disposeLoadedModel();
  if (appState.stream) {
    appState.stream.getTracks().forEach((track) => track.stop());
  }
  if (appState.scene3d) {
    appState.scene3d.renderer.dispose();
  }
}

// Reveal hidden dev/tuning UI when the page is opened with ?debug=1
// (e.g. /tools/live-avatar?debug=1). Default visitors don't see it.
function applyDevModeFromUrl() {
  try {
    const isDev = new URLSearchParams(location.search).get("debug") === "1";
    if (!isDev) return;
    document.querySelectorAll(".dev-only").forEach((el) => {
      el.classList.add("dev-on");
    });
  } catch {
    // ignore — feature is non-critical
  }
}

async function init() {
  if (!window.FaceMesh || !window.Hands || !window.Pose) {
    setStatus("トラッカーを読み込めません", false, true);
    setOverlayMessage("必要なライブラリの読み込みに失敗しました。", true);
    return;
  }

  applyDevModeFromUrl();
  appState.scene3d = createAvatarScene();
  resizeThreeScene();
  bindModelInput();
  bindTuneControls();
  await loadDefaultAvatar();
  setModelNote("頭の向き、目、口、手の位置を 3D で反映");
  updateStats();
  await startCamera();
  await setupTrackers();
  animationLoop();
  processFrame();
}

window.addEventListener("resize", resizeThreeScene);
window.addEventListener("beforeunload", cleanup, { once: true });

init();
