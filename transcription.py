# transcription.py
import os, time, queue, uuid, threading
from collections import defaultdict
import base64

rooms = defaultdict(lambda: {"transcript": [], "chunk_queue": queue.Queue()})
audio_workers = {}
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")

def handle_audio_chunk(room, b64, ts=None, seq=None):
    """Add base64 audio chunk into the queue for transcription"""
    if not b64:
        return
    raw = base64.b64decode(b64)
    rooms[room]["chunk_queue"].put((ts or time.time(), seq or 0, raw))

def audio_worker_for_room(room, socketio):
    """Background worker for transcription"""
    q = rooms[room]["chunk_queue"]
    buffer, last_flush = [], time.time()
    FLUSH_SECONDS = 3

    while True:
        try:
            try:
                item = q.get(timeout=FLUSH_SECONDS)
                buffer.append(item)
            except queue.Empty:
                pass

            now = time.time()
            if buffer and (now - last_flush >= FLUSH_SECONDS):
                buffer.sort(key=lambda x: (x[0], x[1]))
                combined = b''.join([b for (_, _, b) in buffer])
                buffer, last_flush = [], now

                uid = uuid.uuid4().hex
                tmp_path = f"/tmp/audio_{room}_{uid}.raw"
                with open(tmp_path, "wb") as f:
                    f.write(combined)

                text = transcribe_audio_file(tmp_path)
                entry = {"ts": int(now), "text": text}
                rooms[room]["transcript"].append(entry)
                socketio.emit('transcript-update', {"room": room, "entry": entry}, room=room)

                try: os.remove(tmp_path)
                except: pass
        except Exception as e:
            print("worker error", e)
            time.sleep(1)

def transcribe_audio_file(path):
    """Mock transcription (replace with Whisper/OpenAI if API key available)."""
    return "[speech detected]"
