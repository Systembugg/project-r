// Riko AI Voice & Chat Client
let audioContext = null;
let currentAudio = null;
let isAudioPlaying = false;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

const chatStream = document.getElementById('chat-stream');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const micBtn = document.getElementById('mic-btn');
const voiceOrb = document.getElementById('voice-orb');
const orbStatus = document.getElementById('orb-status');

function setOrbState(state, text) {
  voiceOrb.className = 'voice-orb ' + (state || '');
  if (text) orbStatus.textContent = text;
}

function appendMessage(sender, text, isUser = false) {
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble ' + (isUser ? 'msg-user' : 'msg-bot');

  const senderDiv = document.createElement('div');
  senderDiv.className = 'msg-sender';
  senderDiv.textContent = sender;

  const textDiv = document.createElement('div');
  textDiv.className = 'msg-text';
  textDiv.textContent = text;

  bubble.appendChild(senderDiv);
  bubble.appendChild(textDiv);
  chatStream.appendChild(bubble);

  chatStream.scrollTop = chatStream.scrollHeight;
}

function playVoice(audioUrl) {
  if (!audioUrl) return;

  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === 'suspended') audioContext.resume();

  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }

  const audio = new Audio(audioUrl);
  currentAudio = audio;

  setOrbState('speaking', 'Riko is speaking...');

  audio.onended = () => {
    setOrbState('', 'Idle');
    isAudioPlaying = false;
  };

  audio.onerror = () => {
    setOrbState('', 'Idle');
    isAudioPlaying = false;
  };

  audio.play().catch(() => {
    setOrbState('', 'Idle');
    isAudioPlaying = false;
  });
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  appendMessage('You', text, true);
  chatInput.value = '';
  setOrbState('speaking', 'Riko is thinking...');

  try {
    const res = await fetch('/api/text_chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });
    const data = await res.json();

    if (data.reply) {
      appendMessage('Riko', data.reply, false);
      if (data.audio_url) {
        playVoice(data.audio_url);
      } else {
        setOrbState('', 'Idle');
      }
    }
  } catch (err) {
    appendMessage('System', 'Failed to connect to backend.', false);
    setOrbState('', 'Idle');
  }
}

sendBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

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
        setOrbState('speaking', 'Processing voice...');

        const blob = new Blob(audioChunks, { type: 'audio/wav' });
        const form = new FormData();
        form.append('audio_file', blob, 'mic.wav');

        try {
          const res = await fetch('/api/chat', { method: 'POST', body: form });
          const data = await res.json();

          if (data.user_text) {
            appendMessage('You', data.user_text, true);
          }
          if (data.reply) {
            appendMessage('Riko', data.reply, false);
            if (data.audio_url) {
              playVoice(data.audio_url);
            } else {
              setOrbState('', 'Idle');
            }
          }
        } catch (err) {
          appendMessage('System', 'Voice processing failed.', false);
          setOrbState('', 'Idle');
        }
        stream.getTracks().forEach((t) => t.stop());
      };

      mediaRecorder.start();
      isRecording = true;
      micBtn.classList.add('active');
      setOrbState('recording', 'Listening...');
    } catch (err) {
      alert('Please allow microphone access.');
    }
  } else {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }
});
