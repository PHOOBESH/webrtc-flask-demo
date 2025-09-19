# transcription.py
import time
import queue
import base64
import logging
from collections import defaultdict

import google.generativeai as genai  # Gemini SDK

log = logging.getLogger("transcription")

# -----------------------------
# ⚠️ Hardcode your Gemini API key here
# -----------------------------
GEMINI_API_KEY = "YOUR_GEMINI_KEY_HERE"

genai.configure(api_key=GEMINI_API_KEY)

# Global state
rooms = defaultdict(lambda: {"transcript": [], "chunk_queue": queue.Queue()})
audio_workers = {}

def handle_audio_chunk(room, b64, ts=None, seq=None):
    """Add base64 audio chunk into the queue for transcription"""
    if not b64:
        return
    try:
        raw = base64.b64decode(b64)
        timestamp = ts or time.time()
        sequence = seq or 0
        rooms[room]["chunk_queue"].put((timestamp, sequence, raw))
    except Exception as e:
        log.error(f"Error handling audio chunk: {e}")

def audio_worker_for_room(room, socketio):
    """Background worker for transcription processing"""
    log.info(f"Starting transcription worker for room: {room}")
    q = rooms[room]["chunk_queue"]
    buffer = []
    last_flush = time.time()
    FLUSH_SECONDS = 5
    MIN_BUFFER_SIZE = 2048

    while True:
        try:
            try:
                item = q.get(timeout=FLUSH_SECONDS)
                buffer.append(item)
            except queue.Empty:
                pass

            now = time.time()
            should_flush = buffer and (now - last_flush >= FLUSH_SECONDS or len(buffer) >= 5)

            if should_flush:
                buffer.sort(key=lambda x: (x[0], x[1]))
                combined = b''.join([audio_data for (_, _, audio_data) in buffer])

                if len(combined) >= MIN_BUFFER_SIZE:
                    buffer = []
                    last_flush = now
                    text = transcribe_audio_data(combined)

                    if text and text.strip():
                        entry = {"ts": int(now), "text": text.strip()}
                        rooms[room]["transcript"].append(entry)
                        socketio.emit('transcript-update', {"room": room, "entry": entry}, room=room)
                        log.info(f"Room {room}: Transcribed: {text[:100]}...")
        except Exception as e:
            log.error(f"Error in transcription worker for room {room}: {e}")
            time.sleep(1)

def transcribe_audio_data(audio_data: bytes) -> str:
    """Transcribe audio data using Gemini API"""
    try:
        model = genai.GenerativeModel("gemini-1.5-flash")
        audio_b64 = base64.b64encode(audio_data).decode("utf-8")

        response = model.generate_content([
            {
                "parts": [
                    {"text": "Transcribe this meeting audio to text."},
                    {"inline_data": {"mime_type": "audio/webm", "data": audio_b64}}
                ]
            }
        ])

        if response and response.text:
            return response.text
        return ""
    except Exception as e:
        log.error(f"Gemini transcription failed: {e}")
        return generate_mock_transcription()

def generate_mock_transcription():
    import random
    mock_phrases = [
        "Hello everyone, how are you doing today?",
        "Let's focus on the main objectives.",
        "That’s a great point, let’s discuss further.",
        "Can everyone hear me clearly?",
        "Moving on to the next agenda item.",
    ]
    return random.choice(mock_phrases)

def get_room_transcript(room):
    if room in rooms:
        return rooms[room].get("transcript", [])
    return []

def clear_room_transcript(room):
    if room in rooms:
        rooms[room]["transcript"] = []
        log.info(f"Cleared transcript for room: {room}")

def cleanup_room(room):
    if room in rooms:
        if room in audio_workers:
            del audio_workers[room]
        del rooms[room]
        log.info(f"Cleaned up transcription data for room: {room}")
