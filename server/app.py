import sys
from pathlib import Path
import uuid
import shutil

# Dynamic base resolution
SERVER_DIR = Path(__file__).resolve().parent
REPO_ROOT = SERVER_DIR.parent

if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from fastapi import FastAPI, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from faster_whisper import WhisperModel
from process.llm_funcs.llm_scr import llm_response
from process.tts_func.sovits_ping import sovits_gen, get_available_voices, set_active_voice

app = FastAPI(title="Riko 3D Companion Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Audio storage directory
AUDIO_DIR = REPO_ROOT / "audio"
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

# Lazy initialization of Whisper model
_whisper_model = None

def get_whisper():
    global _whisper_model
    if _whisper_model is None:
        print("[Backend] Initializing Faster-Whisper model on CPU (int8)...")
        _whisper_model = WhisperModel("base.en", device="cpu", compute_type="int8", cpu_threads=6)
        print("[Backend] Faster-Whisper initialized successfully!")
    return _whisper_model


class TextChatRequest(BaseModel):
    message: str
    voice_id: str | None = None


class SetVoiceRequest(BaseModel):
    voice_id: str


@app.get("/api/voices")
async def list_voices():
    return get_available_voices()


@app.post("/api/debug")
async def debug_endpoint(data: dict):
    print("\n[BROWSER DEBUG]:", data, flush=True)
    return {"status": "ok"}


@app.post("/api/set_voice")
async def change_voice(req: SetVoiceRequest):
    success = set_active_voice(req.voice_id)
    return {"success": success, "active": req.voice_id}


@app.post("/api/text_chat")
async def text_chat(req: TextChatRequest):
    user_text = req.message.strip()
    if not user_text:
        return {"error": "Empty message"}

    print(f"[User Text]: {user_text}")
    reply = llm_response(user_text)
    print(f"[Riko Reply]: {reply}")

    # Generate audio
    uid = uuid.uuid4().hex
    audio_filename = f"output_{uid}.wav"
    output_path = AUDIO_DIR / audio_filename

    gen_path = sovits_gen(reply, str(output_path), voice_id=req.voice_id)
    audio_url = f"/audio/{audio_filename}" if gen_path and Path(gen_path).exists() else None

    return {
        "user_text": user_text,
        "reply": reply,
        "audio_url": audio_url
    }


@app.post("/api/chat")
async def voice_chat(audio_file: UploadFile = File(...), voice_id: str = None):
    # Save incoming audio
    temp_input = AUDIO_DIR / f"temp_input_{uuid.uuid4().hex}.wav"
    with open(temp_input, "wb") as buffer:
        shutil.copyfileobj(audio_file.file, buffer)

    # Transcribe audio with Whisper
    segments, _ = get_whisper().transcribe(str(temp_input))
    user_text = " ".join([seg.text for seg in segments]).strip()

    if temp_input.exists():
        temp_input.unlink()

    if not user_text:
        return {"user_text": "", "reply": "I couldn't hear you clearly, genius!", "audio_url": None}

    print(f"[Transcribed Speech]: {user_text}")
    reply = llm_response(user_text)
    print(f"[Riko Reply]: {reply}")

    # Generate audio
    uid = uuid.uuid4().hex
    audio_filename = f"output_{uid}.wav"
    output_path = AUDIO_DIR / audio_filename

    gen_path = sovits_gen(reply, str(output_path), voice_id=voice_id)
    audio_url = f"/audio/{audio_filename}" if gen_path and Path(gen_path).exists() else None

    return {
        "user_text": user_text,
        "reply": reply,
        "audio_url": audio_url
    }


# Mount audio files
app.mount("/audio", StaticFiles(directory=str(AUDIO_DIR)), name="audio")

# Mount client files
CLIENT_DIR = REPO_ROOT / "client"
app.mount("/", StaticFiles(directory=str(CLIENT_DIR), html=True), name="client")


if __name__ == "__main__":
    import uvicorn
    print("\n[Riko 3D] Web Companion is running at: http://localhost:8000\n")
    uvicorn.run(app, host="127.0.0.1", port=8000)


