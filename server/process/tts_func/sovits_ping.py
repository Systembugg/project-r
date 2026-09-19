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

# Kokoro-82M ONNX Singleton
_kokoro_instance = None

def get_kokoro():
    global _kokoro_instance
    if _kokoro_instance is None:
        onnx_path = BASE_DIR / "models" / "kokoro" / "kokoro-v1.0.onnx"
        voices_path = BASE_DIR / "models" / "kokoro" / "voices-v1.0.bin"
        if onnx_path.exists() and voices_path.exists():
            try:
                from kokoro_onnx import Kokoro
                print(f"[Kokoro TTS] Loading model from {onnx_path}...")
                _kokoro_instance = Kokoro(str(onnx_path), str(voices_path))
                print("[Kokoro TTS] Kokoro-82M ONNX initialized successfully!")
            except Exception as e:
                print(f"[Kokoro TTS Error] Could not load Kokoro: {e}")
    return _kokoro_instance

VOICE_CATALOG = {
    # Authentic clones
    "riko": {"name": "Riko (Authentic Clone - GPT-SoVITS)", "category": "Original Clones", "gender": "female"},
    
    # American Female (Anime & Expressive)
    "af_sky": {"name": "Sky (High-Energy Anime)", "category": "American Female", "gender": "female"},
    "af_bella": {"name": "Bella (Sassy Tsundere)", "category": "American Female", "gender": "female"},
    "af_heart": {"name": "Heart (Warm & Sweet)", "category": "American Female", "gender": "female"},
    "af_sarah": {"name": "Sarah (Crisp & Playful)", "category": "American Female", "gender": "female"},
    "af_nicole": {"name": "Nicole (Whisper & Soft)", "category": "American Female", "gender": "female"},
    "af_nova": {"name": "Nova (Heroine / Dynamic)", "category": "American Female", "gender": "female"},
    "af_alloy": {"name": "Alloy (Modern / Confident)", "category": "American Female", "gender": "female"},
    "af_aoede": {"name": "Aoede (Melodic / Soft)", "category": "American Female", "gender": "female"},
    "af_jessica": {"name": "Jessica (Bright / Studio)", "category": "American Female", "gender": "female"},
    "af_kore": {"name": "Kore (Calm / Gentle)", "category": "American Female", "gender": "female"},
    "af_river": {"name": "River (Chill / Casual)", "category": "American Female", "gender": "female"},
    
    # British Female
    "bf_emma": {"name": "Emma (British Crisp)", "category": "British Female", "gender": "female"},
    "bf_isabella": {"name": "Isabella (British Posh)", "category": "British Female", "gender": "female"},
    "bf_alice": {"name": "Alice (British Classic)", "category": "British Female", "gender": "female"},
    "bf_lily": {"name": "Lily (British Sweet)", "category": "British Female", "gender": "female"},
    
    # Japanese (Anime Native)
    "jf_alpha": {"name": "Alpha (Japanese Anime)", "category": "Japanese", "gender": "female"},
    "jf_gongitsune": {"name": "Gongitsune (Japanese Story)", "category": "Japanese", "gender": "female"},
    "jf_nezumi": {"name": "Nezumi (Japanese High Pitch)", "category": "Japanese", "gender": "female"},
    "jf_tebukuro": {"name": "Tebukuro (Japanese Soft)", "category": "Japanese", "gender": "female"},
    "jm_kumo": {"name": "Kumo (Japanese Male)", "category": "Japanese", "gender": "male"},
    
    # Hindi (Bilingual / Desi)
    "hf_alpha": {"name": "Alpha (Hindi Female)", "category": "Hindi", "gender": "female"},
    "hf_beta": {"name": "Beta (Hindi Female)", "category": "Hindi", "gender": "female"},
    "hm_omega": {"name": "Omega (Hindi Male)", "category": "Hindi", "gender": "male"},
    "hm_psi": {"name": "Psi (Hindi Male)", "category": "Hindi", "gender": "male"},
    
    # American Male
    "am_adam": {"name": "Adam (Deep Narrator)", "category": "American Male", "gender": "male"},
    "am_echo": {"name": "Echo (Confident / Cool)", "category": "American Male", "gender": "male"},
    "am_eric": {"name": "Eric (Conversational)", "category": "American Male", "gender": "male"},
    "am_fenrir": {"name": "Fenrir (Anime Hero)", "category": "American Male", "gender": "male"},
    "am_liam": {"name": "Liam (Warm & Friendly)", "category": "American Male", "gender": "male"},
    "am_michael": {"name": "Michael (Professional)", "category": "American Male", "gender": "male"},
    "am_onyx": {"name": "Onyx (Deep Bass)", "category": "American Male", "gender": "male"},
    "am_puck": {"name": "Puck (Lively / Animated)", "category": "American Male", "gender": "male"},
    "am_santa": {"name": "Santa (Jovial / Warm)", "category": "American Male", "gender": "male"},
    
    # British Male
    "bm_daniel": {"name": "Daniel (British Studio)", "category": "British Male", "gender": "male"},
    "bm_fable": {"name": "Fable (British Storyteller)", "category": "British Male", "gender": "male"},
    "bm_george": {"name": "George (British Gentleman)", "category": "British Male", "gender": "male"},
    "bm_lewis": {"name": "Lewis (British Casual)", "category": "British Male", "gender": "male"},
    
    # International (Spanish, French, Italian, Chinese)
    "ef_dora": {"name": "Dora (Spanish Female)", "category": "International", "gender": "female"},
    "em_alex": {"name": "Alex (Spanish Male)", "category": "International", "gender": "male"},
    "em_santa": {"name": "Santa (Spanish Male)", "category": "International", "gender": "male"},
    "ff_siwis": {"name": "Siwis (French Female)", "category": "International", "gender": "female"},
    "if_sara": {"name": "Sara (Italian Female)", "category": "International", "gender": "female"},
    "im_nicola": {"name": "Nicola (Italian Male)", "category": "International", "gender": "male"},
    "pf_dora": {"name": "Dora (Portuguese Female)", "category": "International", "gender": "female"},
    "pm_alex": {"name": "Alex (Portuguese Male)", "category": "International", "gender": "male"},
    "pm_santa": {"name": "Santa (Portuguese Male)", "category": "International", "gender": "male"},
    "zf_xiaobei": {"name": "Xiaobei (Chinese Female)", "category": "International", "gender": "female"},
    "zf_xiaoni": {"name": "Xiaoni (Chinese Female)", "category": "International", "gender": "female"},
    "zf_xiaoxiao": {"name": "Xiaoxiao (Chinese Female)", "category": "International", "gender": "female"},
    "zf_xiaoyi": {"name": "Xiaoyi (Chinese Female)", "category": "International", "gender": "female"},
    "zm_yunjian": {"name": "Yunjian (Chinese Male)", "category": "International", "gender": "male"},
    "zm_yunxi": {"name": "Yunxi (Chinese Male)", "category": "International", "gender": "male"},
    "zm_yunxia": {"name": "Yunxia (Chinese Male)", "category": "International", "gender": "male"},
    "zm_yunyang": {"name": "Yunyang (Chinese Male)", "category": "International", "gender": "male"},
}

def play_audio(path):
    if not path or not Path(path).exists():
        print(f"[Warning] Audio file does not exist: {path}")
        return
    data, samplerate = sf.read(path)
    sd.play(data, samplerate)
    sd.wait()

def get_char_config():
    with open(config_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)

current_voice_id = "af_sky"

def get_voice_lang(voice_id: str) -> str:
    v = voice_id.lower()
    if v.startswith("bf_") or v.startswith("bm_"):
        return "en-gb"
    elif v.startswith("jf_") or v.startswith("jm_"):
        return "ja"
    elif v.startswith("hf_") or v.startswith("hm_"):
        return "hi"
    elif v.startswith("ef_") or v.startswith("em_") or v.startswith("pf_") or v.startswith("pm_"):
        return "es"
    elif v.startswith("ff_"):
        return "fr-fr"
    elif v.startswith("if_") or v.startswith("im_"):
        return "it"
    elif v.startswith("zf_") or v.startswith("zm_"):
        return "cmn"
    return "en-us"

def get_available_voices():
    # Build complete list including all Kokoro voices
    kokoro = get_kokoro()
    available_keys = list(VOICE_CATALOG.keys())
    if kokoro:
        try:
            for k_voice in kokoro.get_voices():
                if k_voice not in VOICE_CATALOG:
                    available_keys.append(k_voice)
        except Exception:
            pass

    voices_list = []
    for vid in available_keys:
        meta = VOICE_CATALOG.get(vid, {})
        name = meta.get("name", vid)
        category = meta.get("category", "Other")
        voices_list.append({
            "id": vid,
            "name": name,
            "category": category,
            "gender": meta.get("gender", "unknown")
        })

    return {
        "active": current_voice_id,
        "voices": voices_list
    }

def set_active_voice(voice_id: str):
    global current_voice_id
    current_voice_id = voice_id
    print(f"[TTS] Switched active voice to: {current_voice_id}")
    return True

async def async_sovits_gen(in_text, output_wav_pth="output.wav", voice_id=None):
    if not in_text or not in_text.strip():
        return None

    target_voice_id = (voice_id or current_voice_id or "af_sky").strip()

    # 1. If voice is local GPT-SoVITS riko clone
    if target_voice_id.lower() in ("riko", "riko_clone"):
        cfg = get_char_config()
        ref_audio_rel = cfg.get("sovits_ping_config", {}).get("ref_audio_path", "character_files/slices/riko_clean_vocal.wav")
        prompt_text = cfg.get("sovits_ping_config", {}).get("prompt_text", "Just finally, I was starting to worry my flamethrower would get cold.")
        text_lang = cfg.get("sovits_ping_config", {}).get("text_lang", "en")
        prompt_lang = cfg.get("sovits_ping_config", {}).get("prompt_lang", "en")
        ref_audio_abs = BASE_DIR / ref_audio_rel

        payload = {
            "text": in_text,
            "text_lang": text_lang,
            "ref_audio_path": str(ref_audio_abs),
            "prompt_text": prompt_text,
            "prompt_lang": prompt_lang,
        }

        try:
            response = requests.post(SOVITS_URL, json=payload, timeout=25)
            if response.status_code == 200:
                with open(output_wav_pth, "wb") as f:
                    f.write(response.content)
                print(f"[TTS] Generated audio via GPT-SoVITS (voice '{target_voice_id}')! ({len(response.content)} bytes)")
                return output_wav_pth
            else:
                print(f"[TTS] GPT-SoVITS returned status {response.status_code}, falling back to Kokoro...")
        except Exception as e:
            print(f"[TTS] GPT-SoVITS ping error: {e}, falling back to Kokoro...")

        # Fallback to Kokoro af_sky if SoVITS fails
        target_voice_id = "af_sky"

    # 2. Kokoro ONNX Synthesis (Blazing fast local inference ~150ms)
    kokoro = get_kokoro()
    if kokoro:
        try:
            lang = get_voice_lang(target_voice_id)
            speed = 1.05
            print(f"[Kokoro TTS] Synthesizing with voice='{target_voice_id}', lang='{lang}', speed={speed}...")
            samples, sample_rate = kokoro.create(in_text, voice=target_voice_id, speed=speed, lang=lang)
            sf.write(output_wav_pth, samples, sample_rate)
            print(f"[Kokoro TTS] Success! Saved to {output_wav_pth} ({len(samples)} samples @ {sample_rate}Hz)")
            return output_wav_pth
        except Exception as ke:
            print(f"[Kokoro TTS Error]: {ke}")

    # 3. Final Edge TTS fallback if both fail
    try:
        import edge_tts
        voice = "en-US-AriaNeural"
        communicate = edge_tts.Communicate(in_text, voice, pitch="+2Hz", rate="+5%")
        temp_mp3 = Path(output_wav_pth).with_suffix(".mp3")
        await communicate.save(str(temp_mp3))
        data, sr = sf.read(temp_mp3)
        sf.write(output_wav_pth, data, sr)
        if temp_mp3.exists():
            temp_mp3.unlink()
        print(f"[TTS] Generated audio via Edge TTS fallback")
        return output_wav_pth
    except Exception as e:
        print(f"[TTS Fallback Error]: {e}")
        return None

def sovits_gen(in_text, output_wav_pth="output.wav", voice_id=None):
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(lambda: asyncio.run(async_sovits_gen(in_text, output_wav_pth, voice_id)))
            return future.result()
    else:
        return asyncio.run(async_sovits_gen(in_text, output_wav_pth, voice_id))

if __name__ == "__main__":
    out = sovits_gen("Hey there, this is a test of the ultra fast Kokoro speech system!", "test_run.wav", "af_sky")
    print(f"Generated: {out}")
