# server.py (multi-peer signaling + modular feature hooks)
import eventlet
eventlet.monkey_patch()

from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, join_room, leave_room, emit
from collections import defaultdict
import logging
import threading
import os
import time

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("webrtc-signaling")

app = Flask(__name__, template_folder="templates")
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='eventlet', logger=False, engineio_logger=False)

# ---------- signaling state ----------
rooms = defaultdict(set)             # mapping room -> set(sid)

# ---------- optional feature modules (import safely) ----------
# transcription.py should export: handle_audio_chunk(room, b64, ts=None, seq=None),
# audio_worker_for_room(room, socketio), rooms (per-transcription), audio_workers (dict)
try:
    from transcription import handle_audio_chunk, audio_worker_for_room, rooms as trans_rooms, audio_workers
except Exception as e:
    log.warning("transcription module not available or failed to import: %s", e)
    handle_audio_chunk = None
    audio_worker_for_room = None
    trans_rooms = None
    audio_workers = {}

# summarizer: should export summarize_and_extract(transcript_text)
try:
    from summarizer import summarize_and_extract
except Exception as e:
    log.warning("summarizer module not available or failed to import: %s", e)
    summarize_and_extract = None

# network adaptation: should export evaluate_network(stats_dict)
try:
    from network_adaptation import evaluate_network
except Exception as e:
    log.warning("network_adaptation module not available or failed to import: %s", e)
    evaluate_network = None

# attention (optional). The uploaded attention.py is a webcam script — we only call a helper if present.
try:
    import attention  # expects functions inside; we'll attempt to call attention.calculate_attention_score if available
except Exception as e:
    log.info("attention module not available or not importable: %s", e)
    attention = None

# ---------------- HTTP routes ----------------
@app.route('/')
def index():
    return render_template('index.html')

# Summarize endpoint — POST {"room": "..."}
@app.route('/summarize', methods=['POST'])
def summarize():
    if summarize_and_extract is None:
        return jsonify({"error": "summarizer not available"}), 500
    data = request.get_json(force=True)
    room = data.get("room", "default")
    # transcription module keeps transcript in trans_rooms[room]["transcript"]
    transcript_text = ""
    if trans_rooms and room in trans_rooms:
        transcript_text = " ".join([e.get("text","") for e in trans_rooms[room].get("transcript", [])])
    # fallback if none
    result = summarize_and_extract(transcript_text)
    return jsonify({"room": room, "result": result, "transcript": transcript_text})

# Network adaptation endpoint — POST { rtt, packetLoss, bandwidth }
@app.route('/adapt', methods=['POST'])
def adapt():
    if evaluate_network is None:
        return jsonify({"error": "network_adaptation not available", "mode": "normal"}), 200
    stats = request.get_json(force=True) or {}
    mode = evaluate_network(stats)
    return jsonify({"mode": mode})

# Attention endpoint — GET /attention/<user_id>
@app.route('/attention/<user_id>', methods=['GET'])
def attention_endpoint(user_id):
    # if the attention module provides a function we call it; otherwise return a mock/placeholder
    if attention is not None and hasattr(attention, "calculate_attention_score"):
        try:
            result = attention.calculate_attention_score(user_id)
            return jsonify({"user": user_id, "attention": result})
        except Exception as e:
            log.warning("attention.calculate_attention_score failed: %s", e)
    # fallback mock
    return jsonify({"user": user_id, "attention": {"score": 0.5, "note": "mock"}})

# ---------------- Socket.IO signaling ----------------
@socketio.on('connect')
def on_connect():
    log.info(f"[CONNECT] sid={request.sid}")

@socketio.on('join')
def handle_join(data):
    room = data.get('room')
    sid = request.sid
    existing = list(rooms[room])
    join_room(room)
    rooms[room].add(sid)
    log.info(f"[JOIN] {sid} -> {room} (count={len(rooms[room])})")

    # Tell joining client who is already in the room
    emit('existing-peers', {'peers': existing})

    # notify existing peers of new peer
    for other in existing:
        socketio.emit('new-peer', {'peer': sid}, room=other)

    # Start transcription worker for this room if module present and not already started
    if audio_worker_for_room and handle_audio_chunk:
        if room not in audio_workers:
            log.info(f"Starting transcription worker for room {room}")
            t = threading.Thread(target=audio_worker_for_room, args=(room, socketio), daemon=True)
            audio_workers[room] = t
            t.start()
@socketio.on('transcript-text')
def handle_transcript_text(data):
    room = data.get('room', 'default')
    text = data.get('text', '').strip()
    ts = int(data.get('ts') or (time.time()))
    if not text:
        return
    try:
        from transcription import rooms as trans_rooms
        if room not in trans_rooms:
            trans_rooms[room] = {"transcript": [], "chunk_queue": None}
        trans_rooms[room]["transcript"].append({"ts": ts, "text": text})
    except Exception:
        pass
    socketio.emit('transcript-update', {"room": room, "entry": {"ts": ts, "text": text}}, room=room)

@socketio.on('attention')
def handle_attention(data):
    room = data.get('room', 'default')
    sid = request.sid
    score = float(data.get('score', 0.0) or 0.0)
    socketio.emit('attention-update', {"sid": sid, "score": score}, room=room)

@socketio.on('offer')
def handle_offer(data):
    # data: { to: target_sid, sdp: {...} }
    target = data.get('to')
    sdp = data.get('sdp')
    log.info(f"[SIGNAL] offer from {request.sid} -> to={target}")
    socketio.emit('offer', {'sdp': sdp, 'from': request.sid}, room=target)

@socketio.on('answer')
def handle_answer(data):
    target = data.get('to')
    sdp = data.get('sdp')
    log.info(f"[SIGNAL] answer from {request.sid} -> to={target}")
    socketio.emit('answer', {'sdp': sdp, 'from': request.sid}, room=target)

@socketio.on('ice-candidate')
def handle_ice(data):
    target = data.get('to')
    candidate = data.get('candidate')
    log.info(f"[SIGNAL] ice-candidate from {request.sid} -> to={target}")
    socketio.emit('ice-candidate', {'candidate': candidate, 'from': request.sid}, room=target)

@socketio.on('leave')
def handle_leave(data):
    room = data.get('room')
    sid = request.sid
    leave_room(room)
    rooms[room].discard(sid)
    socketio.emit('peer-left', {'sid': sid}, room=room)
    log.info(f"[LEAVE] {sid} left {room} (count={len(rooms[room])})")
    if not rooms[room]:
        del rooms[room]
        # optionally stop transcription worker (if exists)
        if audio_workers and room in audio_workers:
            try:
                # we keep workers daemonized; they will exit automatically if queue empty.
                del audio_workers[room]
            except Exception:
                pass

@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    for room, sids in list(rooms.items()):
        if sid in sids:
            sids.remove(sid)
            socketio.emit('peer-left', {'sid': sid}, room=room)
            log.info(f"[DISCONNECT] {sid} removed from {room} (count={len(sids)})")
            if not sids:
                del rooms[room]
                if audio_workers and room in audio_workers:
                    try:
                        del audio_workers[room]
                    except Exception:
                        pass

# ---------------- audio-chunk socket handler (for transcription) ----------------
@socketio.on('audio-chunk')
def on_audio_chunk(data):
    """
    Expecting data: { "room": "room1", "b64": "<base64 audio blob>", "ts": <timestamp>, "seq": <int> }
    This will forward to transcription.handle_audio_chunk() if available.
    """
    if handle_audio_chunk is None:
        log.debug("Received audio-chunk but transcription module not available")
        return

    room = data.get("room", "default")
    b64 = data.get("b64")
    ts = data.get("ts")
    seq = data.get("seq")
    try:
        handle_audio_chunk(room, b64, ts, seq)
    except Exception as e:
        log.warning("handle_audio_chunk error: %s", e)

# -----------------------------------------------------------------
if __name__ == '__main__':
    log.info("Starting signaling server on http://0.0.0.0:5000")
    socketio.run(app, host='0.0.0.0', port=int(os.environ.get("PORT", 5000)), debug=False, use_reloader=False)
