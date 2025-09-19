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
import json

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("webrtc-signaling")

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='eventlet', logger=False, engineio_logger=False)

# ---------- signaling state ----------
rooms = defaultdict(set)             # mapping room -> set(sid)

# ---------- optional feature modules (import safely) ----------
try:
    from transcription import handle_audio_chunk, audio_worker_for_room, rooms as trans_rooms, audio_workers
    log.info("Transcription module loaded successfully")
except Exception as e:
    log.warning("transcription module not available: %s", e)
    handle_audio_chunk = None
    audio_worker_for_room = None
    trans_rooms = None
    audio_workers = {}

try:
    from summarizer import summarize_and_extract
    log.info("Summarizer module loaded successfully")
except Exception as e:
    log.warning("summarizer module not available: %s", e)
    summarize_and_extract = None

try:
    from network_adaptation import evaluate_network
    log.info("Network adaptation module loaded successfully")
except Exception as e:
    log.warning("network_adaptation module not available: %s", e)
    evaluate_network = None

# ---------------- HTTP routes ----------------
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/health')
def health():
    return jsonify({"status": "healthy", "timestamp": time.time()})

# Summarize endpoint – POST {"room": "..."}
@app.route('/summarize', methods=['POST'])
def summarize():
    if summarize_and_extract is None:
        return jsonify({"error": "summarizer not available"}), 500
    
    data = request.get_json(force=True)
    room = data.get("room", "default")
    
    # Get transcript from transcription module
    transcript_text = ""
    if trans_rooms and room in trans_rooms:
        transcript_entries = trans_rooms[room].get("transcript", [])
        transcript_text = " ".join([entry.get("text", "") for entry in transcript_entries])
    
    if not transcript_text.strip():
        return jsonify({
            "room": room, 
            "result": "No transcript available yet. Start speaking in the call first.", 
            "transcript": ""
        })
    
    try:
        result = summarize_and_extract(transcript_text)
        return jsonify({"room": room, "result": result, "transcript": transcript_text})
    except Exception as e:
        log.error("Summarization failed: %s", e)
        return jsonify({"error": "Summarization failed", "details": str(e)}), 500

# Network adaptation endpoint – POST { rtt, packetLoss, bandwidth }
@app.route('/adapt', methods=['POST'])
def adapt():
    if evaluate_network is None:
        return jsonify({"error": "network_adaptation not available", "mode": "normal"}), 200
    
    try:
        stats = request.get_json(force=True) or {}
        mode = evaluate_network(stats)
        return jsonify({"mode": mode, "stats": stats})
    except Exception as e:
        log.error("Network adaptation failed: %s", e)
        return jsonify({"mode": "normal", "error": str(e)})

# Attention endpoint – GET /attention/<user_id>
@app.route('/attention/<user_id>', methods=['GET'])
def attention_endpoint(user_id):
    # Mock attention score for demo
    import random
    score = random.uniform(0.3, 0.9)
    return jsonify({
        "user": user_id, 
        "attention": {
            "score": score, 
            "note": "demo implementation"
        }
    })

# ---------------- Socket.IO signaling ----------------
@socketio.on('connect')
def on_connect():
    log.info(f"[CONNECT] sid={request.sid}")
    emit('connected', {'sid': request.sid})

@socketio.on('join')
def handle_join(data):
    room = data.get('room', 'default')
    sid = request.sid
    existing = list(rooms[room])
    
    join_room(room)
    rooms[room].add(sid)
    log.info(f"[JOIN] {sid} -> {room} (count={len(rooms[room])})")

    # Tell joining client who is already in the room
    emit('existing-peers', {'peers': existing})

    # Notify existing peers of new peer
    for other in existing:
        socketio.emit('new-peer', {'peer': sid}, room=other)

    # Start transcription worker for this room if module present and not already started
    if audio_worker_for_room and handle_audio_chunk:
        if room not in audio_workers:
            log.info(f"Starting transcription worker for room {room}")
            try:
                t = threading.Thread(target=audio_worker_for_room, args=(room, socketio), daemon=True)
                audio_workers[room] = t
                t.start()
            except Exception as e:
                log.error(f"Failed to start transcription worker: {e}")

@socketio.on('transcript-text')
def handle_transcript_text(data):
    room = data.get('room', 'default')
    text = data.get('text', '').strip()
    ts = int(data.get('ts', time.time()))
    
    if not text:
        return
    
    try:
        if trans_rooms is not None:
            if room not in trans_rooms:
                trans_rooms[room] = {"transcript": [], "chunk_queue": None}
            trans_rooms[room]["transcript"].append({"ts": ts, "text": text})
            
        # Broadcast to all users in room
        socketio.emit('transcript-update', {
            "room": room, 
            "entry": {"ts": ts, "text": text}
        }, room=room)
        
    except Exception as e:
        log.error(f"Error handling transcript text: {e}")

@socketio.on('attention')
def handle_attention(data):
    room = data.get('room', 'default')
    sid = request.sid
    score = float(data.get('score', 0.0))
    
    # Broadcast attention update to room
    socketio.emit('attention-update', {
        "sid": sid, 
        "score": score,
        "room": room
    }, room=room)

@socketio.on('offer')
def handle_offer(data):
    target = data.get('to')
    sdp = data.get('sdp')
    log.info(f"[SIGNAL] offer from {request.sid} -> to={target}")
    
    if target:
        socketio.emit('offer', {'sdp': sdp, 'from': request.sid}, room=target)

@socketio.on('answer')
def handle_answer(data):
    target = data.get('to')
    sdp = data.get('sdp')
    log.info(f"[SIGNAL] answer from {request.sid} -> to={target}")
    
    if target:
        socketio.emit('answer', {'sdp': sdp, 'from': request.sid}, room=target)

@socketio.on('ice-candidate')
def handle_ice(data):
    target = data.get('to')
    candidate = data.get('candidate')
    log.info(f"[SIGNAL] ice-candidate from {request.sid} -> to={target}")
    
    if target and candidate:
        socketio.emit('ice-candidate', {'candidate': candidate, 'from': request.sid}, room=target)

@socketio.on('leave')
def handle_leave(data):
    room = data.get('room')
    sid = request.sid
    
    if room and sid in rooms[room]:
        leave_room(room)
        rooms[room].discard(sid)
        socketio.emit('peer-left', {'sid': sid}, room=room)
        log.info(f"[LEAVE] {sid} left {room} (count={len(rooms[room])})")
        
        if not rooms[room]:
            del rooms[room]
            # Clean up transcription worker
            if audio_workers and room in audio_workers:
                try:
                    del audio_workers[room]
                    log.info(f"Cleaned up transcription worker for room {room}")
                except Exception as e:
                    log.error(f"Error cleaning up worker: {e}")

@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    log.info(f"[DISCONNECT] {sid}")
    
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
    """
    if handle_audio_chunk is None:
        log.debug("Received audio-chunk but transcription module not available")
        return

    room = data.get("room", "default")
    b64 = data.get("b64")
    ts = data.get("ts")
    seq = data.get("seq")
    
    if not b64:
        return
        
    try:
        handle_audio_chunk(room, b64, ts, seq)
    except Exception as e:
        log.warning("handle_audio_chunk error: %s", e)

# Error handlers
@app.errorhandler(404)
def not_found(error):
    return jsonify({"error": "Not found"}), 404

@app.errorhandler(500)
def internal_error(error):
    return jsonify({"error": "Internal server error"}), 500

# -----------------------------------------------------------------
if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    log.info(f"Starting signaling server on http://0.0.0.0:{port}")
    socketio.run(
        app, 
        host='0.0.0.0', 
        port=port, 
        debug=os.environ.get('FLASK_ENV') == 'development',
        use_reloader=False
    )