# Project AP

An autonomous desktop AI companion featuring neural voice synthesis, real-time audio visualization, and interactive personality modeling.

## Architecture
- **Backend:** FastAPI, Python 3.11, WebSocket & HTTP audio streaming.
- **Voice Engine:** Local neural voice synthesis with GPT-SoVITS (CUDA / GTX 1650 accelerated) and UVR5 vocal separation.
- **Brain:** LLM reasoning engine with dynamic persona anchoring and streaming dialogue.
- **Client:** Minimalist responsive voice terminal with Web Audio API reactive orb visualizer.

## Setup & Running

### 1. Install Dependencies
```bash
uv venv
uv pip install -r requirements.txt
```

### 2. Configure Environment
Set your LLM API credentials in `.env`:
```env
OPENROUTER_API_KEY=your_key_here
```

### 3. Launch GPT-SoVITS Engine
```bash
python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

### 4. Launch Project AP
```bash
python server/app.py
```
Open your browser at `http://localhost:8000`.
