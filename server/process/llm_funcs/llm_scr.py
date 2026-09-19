from pathlib import Path
import json
import os
import yaml
from dotenv import load_dotenv
from openai import OpenAI

# Dynamic base path resolution (riko_project root)
BASE_DIR = Path(__file__).resolve().parents[3]
load_dotenv(BASE_DIR / ".env")

config_path = BASE_DIR / "character_config.yaml"
with open(config_path, "r", encoding="utf-8") as f:
    char_config = yaml.safe_load(f)

def get_model_name():
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
            return os.getenv("OPENROUTER_MODEL", cfg.get("model", "meta-llama/llama-3.3-70b-instruct"))
    except Exception:
        return "meta-llama/llama-3.3-70b-instruct"

# OpenRouter configuration
api_key = os.getenv("OPENROUTER_API_KEY", char_config.get("OPENAI_API_KEY"))

client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=api_key,
)

# Constants
HISTORY_FILE = BASE_DIR / char_config.get("history_file", "chat_history.json")
DEFAULT_SYSTEM_PROMPT = char_config["presets"]["default"]["system_prompt"]


import re

def get_current_system_prompt():
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
            return cfg["presets"]["default"]["system_prompt"]
    except Exception:
        return DEFAULT_SYSTEM_PROMPT


def load_history():
    sys_prompt = get_current_system_prompt()
    if HISTORY_FILE.exists():
        try:
            with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                hist = json.load(f)
                if hist and isinstance(hist, list):
                    # Always ensure the latest system prompt is active
                    hist[0] = {"role": "system", "content": sys_prompt}
                    return hist
        except Exception:
            pass
    return [{"role": "system", "content": sys_prompt}]


def save_history(history):
    with open(HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump(history, f, indent=2, ensure_ascii=False)


def llm_response(user_input):
    messages = load_history()

    # Append user message
    messages.append({"role": "user", "content": user_input})

    # Call OpenRouter
    active_model = get_model_name()
    response = client.chat.completions.create(
        model=active_model,
        messages=messages,
        temperature=0.8,
        max_tokens=250,
    )

    msg = response.choices[0].message
    content = msg.content or ""
    
    # Strip any <think>...</think> reasoning blocks from thinking models
    content = re.sub(r'<think>.*?</think>', '', content, flags=re.DOTALL).strip()
    if not content:
        content = getattr(msg, "reasoning", "") or getattr(msg, "reasoning_content", "") or ""
        content = re.sub(r'<think>.*?</think>', '', content, flags=re.DOTALL).strip()
    
    # Strip any roleplay actions inside asterisks like *snorts* or *sighs*
    cleaned = re.sub(r'\*.*?\*', '', content).strip()
    assistant_message = cleaned if cleaned else content.strip()
    assistant_message = assistant_message.strip('"\'')
    if not assistant_message:
        assistant_message = "Oh please, don't strain yourself trying to impress me."

    # Append assistant response
    messages.append({"role": "assistant", "content": assistant_message})

    # Save conversation (keep last 12 turns to prevent context blowup)
    if len(messages) > 13:
        messages = [messages[0]] + messages[-12:]

    save_history(messages)
    return assistant_message


if __name__ == "__main__":
    print("Testing OpenRouter LLM connection...")
    reply = llm_response("Hey Riko, are you ready?")
    print(f"Riko: {reply}")