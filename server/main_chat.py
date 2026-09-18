import sys
from pathlib import Path

# Add server directory to path so process imports work seamlessly
SERVER_DIR = Path(__file__).resolve().parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from faster_whisper import WhisperModel
from process.asr_func.asr_push_to_talk import record_and_transcribe
from process.llm_funcs.llm_scr import llm_response
from process.tts_func.sovits_ping import sovits_gen, play_audio
import os
import time
import uuid
import soundfile as sf


def get_wav_duration(path):
    with sf.SoundFile(path) as f:
        return len(f) / f.samplerate


def main():
    print(" \n ========= Starting Riko Chat... ================ \n")
    # Fast int8 CPU transcription using Ryzen's 6 cores
    whisper_model = WhisperModel("base.en", device="cpu", compute_type="int8", cpu_threads=6)

    while True:
        conversation_recording = Path("audio") / "conversation.wav"
        conversation_recording.parent.mkdir(parents=True, exist_ok=True)

        user_spoken_text = record_and_transcribe(whisper_model, conversation_recording)

        if not user_spoken_text or not user_spoken_text.strip():
            print("No speech detected. Try again.")
            continue

        ### pass to LLM and get a LLM output.
        print("\n🤔 Riko is thinking...")
        llm_output = llm_response(user_spoken_text)
        print(f"\n✨ [Riko]: {llm_output}\n")

        tts_read_text = llm_output

        ### file organization
        uid = uuid.uuid4().hex
        filename = f"output_{uid}.wav"
        output_wav_path = Path("audio") / filename
        output_wav_path.parent.mkdir(parents=True, exist_ok=True)

        # generate audio
        gen_aud_path = sovits_gen(tts_read_text, output_wav_path)

        if gen_aud_path and Path(gen_aud_path).exists():
            play_audio(output_wav_path)

        # clean up audio files
        [fp.unlink() for fp in Path("audio").glob("*.wav") if fp.is_file()]


if __name__ == "__main__":
    main()