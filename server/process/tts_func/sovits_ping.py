import asyncio
from pathlib import Path
import os
import requests
import sounddevice as sd
import soundfile as sf
import yaml
import concurrent.futures

# Base directory
BASE_DIR = Path(__file__).resolve().parents[3]
config_path = BASE_DIR / "character_config.yaml"

with open(config_path, "r", encoding="utf-8") as f:
    char_config = yaml.safe_load(f)

SOVITS_URL = os.getenv("SOVITS_URL", "http://127.0.0.1:9880/tts")


def play_audio(path):
    if not path or not Path(path).exists():
        print(f"[Warning] Audio file does not exist: {path}")
        return
    data, samplerate = sf.read(path)
    sd.play(data, samplerate)
    sd.wait()


async def _edge_tts_fallback(text, output_path):
    import edge_tts

    # Natural, expressive sassy female voice (not high-pitched cartoon baby)
    voice = "en-US-AriaNeural"
    communicate = edge_tts.Communicate(text, voice, pitch="+2Hz", rate="+5%")
    temp_mp3 = Path(output_path).with_suffix(".mp3")
    await communicate.save(str(temp_mp3))

    # Convert mp3 to wav
    data, sr = sf.read(temp_mp3)
    sf.write(output_path, data, sr)
    if temp_mp3.exists():
        temp_mp3.unlink()


def get_char_config():
    with open(config_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)

current_voice_id = char_config.get("default_voice", "riko")

def get_available_voices():
    cfg = get_char_config()
    voices = cfg.get("voices", {})
    return {
        "active": current_voice_id,
        "voices": [
            {"id": k, "name": v.get("name", k)}
            for k, v in voices.items()
        ]
    }

def set_active_voice(voice_id: str):
    global current_voice_id
    cfg = get_char_config()
    if voice_id in cfg.get("voices", {}):
        current_voice_id = voice_id
        return True
    return False


async def async_sovits_gen(in_text, output_wav_pth="output.wav", voice_id=None):
    if not in_text or not in_text.strip():
        return None

    cfg = get_char_config()
    target_voice_id = voice_id or current_voice_id
    voices = cfg.get("voices", {})
    
    if target_voice_id in voices:
        v_conf = voices[target_voice_id]
        ref_audio_rel = v_conf["ref_audio_path"]
        prompt_text = v_conf.get("prompt_text", "")
        text_lang = v_conf.get("text_lang", "en")
        prompt_lang = v_conf.get("prompt_lang", "en")
    else:
        ref_audio_rel = cfg["sovits_ping_config"]["ref_audio_path"]
        prompt_text = cfg["sovits_ping_config"].get("prompt_text", "")
        text_lang = cfg["sovits_ping_config"].get("text_lang", "en")
        prompt_lang = cfg["sovits_ping_config"].get("prompt_lang", "en")

    ref_audio_abs = BASE_DIR / ref_audio_rel

    payload = {
        "text": in_text,
        "text_lang": text_lang,
        "ref_audio_path": str(ref_audio_abs),
        "prompt_text": prompt_text,
        "prompt_lang": prompt_lang,
    }

    # 1. Try local GPT-SoVITS if running
    try:
        response = requests.post(SOVITS_URL, json=payload, timeout=60)
        if response.status_code == 200:
            with open(output_wav_pth, "wb") as f:
                f.write(response.content)
            print(f"[TTS] Generated audio via local GPT-SoVITS using voice '{target_voice_id}'! ({len(response.content)} bytes)")
            return output_wav_pth
        else:
            print(f"[TTS] GPT-SoVITS returned status {response.status_code}: {response.text[:100]}")
    except Exception as e:
        print(f"[TTS] GPT-SoVITS ping error: {e}")

    # 2. Fallback to fast Neural TTS
    try:
        await _edge_tts_fallback(in_text, output_wav_pth)
        return output_wav_pth
    except Exception as e:
        print(f"[TTS Error] Fallback failed: {e}")
        return None


def sovits_gen(in_text, output_wav_pth="output.wav", voice_id=None):
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        # Running inside an existing event loop (e.g. FastAPI / Uvicorn)
        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(lambda: asyncio.run(async_sovits_gen(in_text, output_wav_pth, voice_id)))
            return future.result()
    else:
        return asyncio.run(async_sovits_gen(in_text, output_wav_pth, voice_id))


if __name__ == "__main__":
    out = sovits_gen("Hello senpai! Testing my voice synthesis.")
    print(f"Generated: {out}")
    if out:
        play_audio(out)
