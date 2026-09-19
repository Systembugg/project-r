import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import VRMCompanionController from './VRMCompanionController.js';

// DOM Elements
const canvasContainer = document.getElementById('canvas-container');
const dialogueCard = document.getElementById('dialogue-card');
const userQueryEl = document.getElementById('user-query');
const speakerNameEl = document.getElementById('speaker-name');
const statusBadgeEl = document.getElementById('status-badge');
const dialogueTextEl = document.getElementById('dialogue-text');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const micBtn = document.getElementById('mic-btn');
const btnRiko = document.getElementById('btn-riko');
const btnFurina = document.getElementById('btn-furina');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');

// State
let currentVRM = null;
let companion = null;
let currentAudio = null;
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let activeModelKey = 'riko';

const MODELS = {
  riko: {
    name: 'Riko',
    url: './models/riko.vrm',
    voiceId: 'riko',
    cameraY: 1.30,
    cameraZ: 1.15,
  },
  furina: {
    name: 'Furina',
    url: './models/furina.vrm',
    voiceId: 'riko',
    cameraY: 1.25,
    cameraZ: 1.15,
  },
};

// ---------------------------------------------------------------------------
// 1. Three.js Scene Setup
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  32,
  window.innerWidth / window.innerHeight,
  0.1,
  20.0
);
camera.position.set(0.0, 1.30, 1.15);

const renderer = new THREE.WebGLRenderer({
  alpha: true,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
canvasContainer.appendChild(renderer.domElement);

// Lighting setup: soft ambient + key light + subtle rim light
const ambientLight = new THREE.AmbientLight(0xffffff, 1.3);
scene.add(ambientLight);

const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
keyLight.position.set(1.5, 2.5, 2.0);
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0xc084fc, 0.7);
rimLight.position.set(-1.5, 2.0, -1.5);
scene.add(rimLight);

const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.4);
fillLight.position.set(0.0, -1.0, 2.0);
scene.add(fillLight);

// Handle window resize
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// 2. VRM Loader & Companion Controller Initialization
// ---------------------------------------------------------------------------
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

function setLoading(show, text = 'Loading 3D Companion...') {
  if (loadingOverlay) {
    loadingOverlay.style.display = show ? 'flex' : 'none';
    if (loadingText) loadingText.textContent = text;
  }
}

async function loadModel(modelKey) {
  const modelInfo = MODELS[modelKey];
  if (!modelInfo) return;

  setLoading(true, `Loading ${modelInfo.name}...`);
  speakerNameEl.textContent = modelInfo.name;

  try {
    // Clean up previous VRM and companion
    if (companion) {
      companion.dispose();
      companion = null;
    }
    if (currentVRM) {
      scene.remove(currentVRM.scene);
      VRMUtils.deepDispose(currentVRM.scene);
      currentVRM = null;
    }

    const gltf = await loader.loadAsync(modelInfo.url);
    const vrm = gltf.userData.vrm;
    if (!vrm) {
      throw new Error('Loaded model does not contain VRM data.');
    }

    // Standard VRM orientation: rotate VRM0 models 180 deg to face camera (+Z)
    VRMUtils.rotateVRM0(vrm);

    scene.add(vrm.scene);
    currentVRM = vrm;

    // Adjust camera to frame avatar nicely
    camera.position.set(0.0, modelInfo.cameraY, modelInfo.cameraZ);
    camera.lookAt(0.0, modelInfo.cameraY - 0.05, 0.0);

    // Initialize the lifelike companion controller
    companion = new VRMCompanionController(vrm, {
      lipSyncGain: 1.8,
      armRelaxation: true,
      breathIntensity: 1.0,
      swayIntensity: 0.9,
    });
    companion.trackCursor(window);

    // If audio is currently playing, hook it into the new companion
    if (currentAudio && !currentAudio.paused) {
      try {
        companion.attachAudioElement(currentAudio);
      } catch (_) {}
    }

    activeModelKey = modelKey;
    btnRiko.classList.toggle('active', modelKey === 'riko');
    btnFurina.classList.toggle('active', modelKey === 'furina');

    statusBadgeEl.textContent = 'Ready';
  } catch (err) {
    console.error(`Failed to load model ${modelInfo.name}:`, err);
    dialogueTextEl.textContent = `Error loading ${modelInfo.name} 3D model. Check console.`;
    statusBadgeEl.textContent = 'Error';
  } finally {
    setLoading(false);
  }
}

// ---------------------------------------------------------------------------
// 3. Render Animation Loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();

  if (companion) {
    companion.update(delta);
  }

  renderer.render(scene, camera);
}
animate();

// ---------------------------------------------------------------------------
// 4. Model Switcher Handlers
// ---------------------------------------------------------------------------
btnRiko.addEventListener('click', () => {
  if (activeModelKey !== 'riko') loadModel('riko');
});

btnFurina.addEventListener('click', () => {
  if (activeModelKey !== 'furina') loadModel('furina');
});

// ---------------------------------------------------------------------------
// 5. Audio Playback & Real-Time Lip-Sync
// ---------------------------------------------------------------------------
function playVoice(audioUrl) {
  if (!audioUrl) return;

  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }

  const audio = new Audio(audioUrl);
  currentAudio = audio;

  statusBadgeEl.textContent = 'Speaking...';
  if (companion) {
    try {
      companion.attachAudioElement(audio);
      companion.setEmotion('joy');
    } catch (e) {
      console.warn('Could not attach audio element to companion:', e);
    }
  }

  audio.onended = () => {
    statusBadgeEl.textContent = 'Ready';
    if (companion) companion.setEmotion('neutral');
  };

  audio.onerror = () => {
    statusBadgeEl.textContent = 'Ready';
    if (companion) companion.setEmotion('neutral');
  };

  audio.play().catch((err) => {
    console.warn('Audio autoplay blocked or failed:', err);
    statusBadgeEl.textContent = 'Ready';
    if (companion) companion.setEmotion('neutral');
  });
}

// ---------------------------------------------------------------------------
// 6. Dialogue & Chat Handling
// ---------------------------------------------------------------------------
function setDialogue(text, userQuery = null) {
  dialogueTextEl.textContent = text;
  if (userQuery) {
    userQueryEl.textContent = `You: ${userQuery}`;
    userQueryEl.style.display = 'block';
  }
}

async function sendTextMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = '';
  setDialogue('...', text);
  statusBadgeEl.textContent = 'Thinking...';
  if (companion) companion.setEmotion('neutral');

  try {
    const res = await fetch('/api/text_chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, voice_id: MODELS[activeModelKey].voiceId }),
    });

    const data = await res.json();
    if (data.reply) {
      setDialogue(data.reply, text);
      if (data.audio_url) {
        playVoice(data.audio_url);
      } else {
        statusBadgeEl.textContent = 'Ready';
      }
    } else {
      setDialogue('No response received.', text);
      statusBadgeEl.textContent = 'Ready';
    }
  } catch (err) {
    console.error('Chat error:', err);
    setDialogue('Connection error to server backend.', text);
    statusBadgeEl.textContent = 'Offline';
  }
}

sendBtn.addEventListener('click', sendTextMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendTextMessage();
});

// ---------------------------------------------------------------------------
// 7. Voice Recording (Microphone)
// ---------------------------------------------------------------------------
micBtn.addEventListener('click', async () => {
  if (!isRecording) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        micBtn.classList.remove('active');
        isRecording = false;
        statusBadgeEl.textContent = 'Processing Voice...';

        const blob = new Blob(audioChunks, { type: 'audio/wav' });
        const form = new FormData();
        form.append('audio_file', blob, 'mic.wav');
        form.append('voice_id', MODELS[activeModelKey].voiceId);

        try {
          const res = await fetch('/api/chat', { method: 'POST', body: form });
          const data = await res.json();

          if (data.user_text && data.reply) {
            setDialogue(data.reply, data.user_text);
            if (data.audio_url) {
              playVoice(data.audio_url);
            } else {
              statusBadgeEl.textContent = 'Ready';
            }
          }
        } catch (err) {
          console.error('Voice processing failed:', err);
          statusBadgeEl.textContent = 'Voice Error';
        }

        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start();
      isRecording = true;
      micBtn.classList.add('active');
      statusBadgeEl.textContent = 'Listening...';
    } catch (err) {
      console.error('Microphone error:', err);
      alert('Microphone permission required for voice interaction.');
    }
  } else {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }
});

// ---------------------------------------------------------------------------
// 8. Start by loading Riko
// ---------------------------------------------------------------------------
loadModel('riko');
