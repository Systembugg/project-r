import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import VRMCompanionController from './VRMCompanionController.js?v=6';

// DOM Elements
const canvasContainer = document.getElementById('canvas-container');
const speechSubtitle = document.getElementById('speech-subtitle');
const chatInput = document.getElementById('chat-input');
const micBtn = document.getElementById('mic-btn');
const btnRiko = document.getElementById('btn-riko');
const btnFurina = document.getElementById('btn-furina');
const loadingChip = document.getElementById('loading-chip');
const loadingChipText = document.getElementById('loading-chip-text');

// State
let currentVRM = null;
let companion = null;
let currentAudio = null;
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let activeModelKey = 'riko';
let subtitleFadeTimer = null;
let subtitleAnimFrame = null;

const MODELS = {
  riko: {
    name: 'Riko',
    url: './models/riko.vrm',
    voiceId: 'riko',
    cameraY: 1.26,
    cameraZ: 1.45,
    lookAtY: 1.20,
  },
  furina: {
    name: 'Furina',
    url: './models/furina.vrm',
    voiceId: 'riko',
    cameraY: 1.24,
    cameraZ: 1.45,
    lookAtY: 1.18,
  },
};

// ---------------------------------------------------------------------------
// 1. Three.js Scene Setup (Crisp Anime Cel-Shaded Studio Aesthetic)
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  30,
  window.innerWidth / window.innerHeight,
  0.1,
  20.0
);
camera.position.set(0.0, 1.26, 1.45);
camera.lookAt(0.0, 1.20, 0.0);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0xffffff, 1.0); // Clean White Background
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping; // Crucial: MToon cel-shaders must NOT use ACES Filmic!
canvasContainer.appendChild(renderer.domElement);

// Flattering, Crisp Anime Cel-Shaded Lighting
// Soft ambient light preserves delicate face shading, blush, and rich black hair
const ambientLight = new THREE.AmbientLight(0xffffff, 0.40);
scene.add(ambientLight);

// Key directional light: crisp chin and neck cel-shading shadows
const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
keyLight.position.set(0.8, 1.4, 1.2).normalize();
scene.add(keyLight);

// Soft fill light: balances deep shadows gently without washing out
const fillLight = new THREE.DirectionalLight(0xfff5f8, 0.25);
fillLight.position.set(-0.8, 0.9, 1.0).normalize();
scene.add(fillLight);

// Handle window resize
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// 2. VRM Loader & Model Management
// ---------------------------------------------------------------------------
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

function setLoading(show, text = 'Loading Riko...') {
  if (!loadingChip) return;
  if (show) {
    loadingChip.style.display = 'flex';
    loadingChip.style.opacity = '1';
    if (loadingChipText) loadingChipText.textContent = text;
  } else {
    loadingChip.style.opacity = '0';
    setTimeout(() => {
      if (loadingChip.style.opacity === '0') loadingChip.style.display = 'none';
    }, 350);
  }
}

async function loadModel(modelKey) {
  const modelInfo = MODELS[modelKey];
  if (!modelInfo) return;

  setLoading(true, `Loading ${modelInfo.name}...`);

  try {
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
    if (!vrm) throw new Error('Loaded model has no VRM data.');

    // In VRM 0.0, models face -Z; rotating 180 deg (PI) faces the camera (+Z)
    vrm.scene.rotation.y = Math.PI;

    scene.add(vrm.scene);
    currentVRM = vrm;

    // Frame avatar nicely waist-up
    camera.position.set(0.0, modelInfo.cameraY, modelInfo.cameraZ);
    camera.lookAt(0.0, modelInfo.lookAtY, 0.0);

    // Initialize companion controller with organic idle, gaze & natural arms
    companion = new VRMCompanionController(vrm, {
      lipSyncGain: 1.8,
      armRelaxation: true,
      breathIntensity: 1.0,
      swayIntensity: 0.85,
    });
    companion.trackCursor(window);

    activeModelKey = modelKey;
    btnRiko?.classList.toggle('active', modelKey === 'riko');
    btnFurina?.classList.toggle('active', modelKey === 'furina');
  } catch (err) {
    console.error(`Failed to load ${modelInfo.name}:`, err);
    if (loadingChipText) loadingChipText.textContent = `Failed to load ${modelInfo.name}`;
  } finally {
    setLoading(false);
  }
}

// ---------------------------------------------------------------------------
// 3. Render Loop
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
// 4. Real-Time Speech Subtitle Streaming (Typewriter / Voice Synced)
// ---------------------------------------------------------------------------
function streamSubtitles(fullText, audio) {
  if (subtitleFadeTimer) clearTimeout(subtitleFadeTimer);
  if (subtitleAnimFrame) cancelAnimationFrame(subtitleAnimFrame);

  speechSubtitle.innerHTML = '';
  speechSubtitle.style.opacity = '1';

  const words = fullText.trim().split(/\s+/);
  const spans = words.map((word) => {
    const span = document.createElement('span');
    span.className = 'sub-word';
    span.textContent = word;
    speechSubtitle.appendChild(span);
    return span;
  });

  const startTime = performance.now();

  function update() {
    if (!audio || audio.paused || audio.ended) {
      spans.forEach((s) => s.classList.add('visible'));
      return;
    }

    const duration =
      audio.duration && !isNaN(audio.duration) && audio.duration > 0
        ? audio.duration
        : words.length * 0.32;

    const current = audio.currentTime || (performance.now() - startTime) / 1000;
    const progress = Math.min(1.0, current / duration);

    // Reveal words progressively matching voice timing
    const wordsToShow = Math.min(words.length, Math.ceil(progress * words.length));
    for (let i = 0; i < words.length; i++) {
      if (i < wordsToShow) {
        spans[i].classList.add('visible');
      }
    }

    if (current < duration && !audio.ended) {
      subtitleAnimFrame = requestAnimationFrame(update);
    } else {
      spans.forEach((s) => s.classList.add('visible'));
    }
  }

  subtitleAnimFrame = requestAnimationFrame(update);

  if (audio) {
    audio.addEventListener(
      'ended',
      () => {
        if (subtitleAnimFrame) cancelAnimationFrame(subtitleAnimFrame);
        spans.forEach((s) => s.classList.add('visible'));

        // Keep subtitle visible for 2.8s after speech, then smoothly fade out
        subtitleFadeTimer = setTimeout(() => {
          speechSubtitle.style.opacity = '0';
        }, 2800);
      },
      { once: true }
    );
  }
}

// ---------------------------------------------------------------------------
// 5. Audio Playback & Viseme Lip-Sync Hookup
// ---------------------------------------------------------------------------
function playVoiceReply(replyText, audioUrl) {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }

  if (!audioUrl) {
    // If no audio (text only), stream subtitle smoothly at reading speed
    speechSubtitle.innerHTML = '';
    speechSubtitle.style.opacity = '1';
    const words = replyText.trim().split(/\s+/);
    words.forEach((w, i) => {
      const span = document.createElement('span');
      span.className = 'sub-word';
      span.textContent = w;
      speechSubtitle.appendChild(span);
      setTimeout(() => span.classList.add('visible'), i * 80);
    });
    subtitleFadeTimer = setTimeout(() => {
      speechSubtitle.style.opacity = '0';
    }, words.length * 80 + 3000);
    return;
  }

  const audio = new Audio(audioUrl);
  currentAudio = audio;

  if (companion) {
    try {
      companion.attachAudioElement(audio);
      companion.setEmotion('joy');
    } catch (e) {
      console.warn('Audio element attach error:', e);
    }
  }

  audio.onended = () => {
    if (companion) companion.setEmotion('neutral');
  };

  audio.onerror = () => {
    if (companion) companion.setEmotion('neutral');
  };

  audio
    .play()
    .then(() => {
      streamSubtitles(replyText, audio);
    })
    .catch((err) => {
      console.warn('Autoplay error:', err);
      streamSubtitles(replyText, null);
      if (companion) companion.setEmotion('neutral');
    });
}

// ---------------------------------------------------------------------------
// 6. Dialogue Interaction (Send Message)
// ---------------------------------------------------------------------------
async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = '';

  // Temporary thinking dots
  speechSubtitle.innerHTML = '<span class="sub-word visible" style="opacity: 0.6;">...</span>';
  speechSubtitle.style.opacity = '1';

  try {
    const res = await fetch('/api/text_chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, voice_id: MODELS[activeModelKey].voiceId }),
    });

    const data = await res.json();
    if (data.reply) {
      playVoiceReply(data.reply, data.audio_url);
    } else {
      speechSubtitle.style.opacity = '0';
    }
  } catch (err) {
    console.error('Chat request error:', err);
    speechSubtitle.innerHTML = '<span class="sub-word visible">Connection error...</span>';
    setTimeout(() => {
      speechSubtitle.style.opacity = '0';
    }, 2500);
  }
}

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

// ---------------------------------------------------------------------------
// 7. Voice Recording (Microphone Capsule)
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
        micBtn.classList.remove('recording');
        isRecording = false;

        speechSubtitle.innerHTML = '<span class="sub-word visible" style="opacity: 0.6;">...</span>';
        speechSubtitle.style.opacity = '1';

        const blob = new Blob(audioChunks, { type: 'audio/wav' });
        const form = new FormData();
        form.append('audio_file', blob, 'mic.wav');
        form.append('voice_id', MODELS[activeModelKey].voiceId);

        try {
          const res = await fetch('/api/chat', { method: 'POST', body: form });
          const data = await res.json();

          if (data.reply) {
            playVoiceReply(data.reply, data.audio_url);
          } else {
            speechSubtitle.style.opacity = '0';
          }
        } catch (err) {
          console.error('Voice processing error:', err);
          speechSubtitle.innerHTML = '<span class="sub-word visible">Voice processing error...</span>';
          setTimeout(() => {
            speechSubtitle.style.opacity = '0';
          }, 2500);
        }

        stream.getTracks().forEach((t) => t.stop());
      };

      mediaRecorder.start();
      isRecording = true;
      micBtn.classList.add('recording');
    } catch (err) {
      console.error('Mic access error:', err);
      alert('Microphone permission required.');
    }
  } else {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }
});

// ---------------------------------------------------------------------------
// 8. Model Switcher Handlers
// ---------------------------------------------------------------------------
btnRiko?.addEventListener('click', () => {
  if (activeModelKey !== 'riko') loadModel('riko');
});

btnFurina?.addEventListener('click', () => {
  if (activeModelKey !== 'furina') loadModel('furina');
});

// ---------------------------------------------------------------------------
// 9. Initial Load
// ---------------------------------------------------------------------------
loadModel('riko');
