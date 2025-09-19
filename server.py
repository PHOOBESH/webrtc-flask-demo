# server.py
import eventlet
eventlet.monkey_patch()

from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, join_room, leave_room, emit
from collections import defaultdict
import logging
import threading

# ---------------- NEW IMPORTS ----------------
from transcription import handle_audio_chunk, audio_worker_for_room, rooms, audio_workers
from summarizer import summarize_and_extract
# (attention.py is standalone CV; we won’t run it inside Render, but you can expose metrics later)
from network_adaptation import evaluate_network  # you’ll create this small helper file
# --------------------------------------------

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("webrtc-signaling")

app = Flask(__name__, template_folder="templates")
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='eventlet', logger=False, engineio_logger=False)

# track room membership
rooms_peers = defaultdict(set)

@app.route('/')
def index():
    return render_template('index.html')

# ------------------- SIGNALING -------------------
@socketio.on('connect')
def on_connect():
    log.info(f"[CONNECT] sid={request.sid}")

@socketio.on('join')
def handle_join(data):
    room = data.get('room')
    sid = request.sid
    join_room(room)
    rooms_peers[room].add(sid)
    log.info(f"[JOIN] {sid} -> {room} (count={len(rooms_peers[room])})")

    if len(rooms_peers[room]) == 1:
        emit('created')
    elif len(rooms_peers[room]) == 2:
        socketio.emit('ready', room=room)
    else:
        emit('full')

    # ---------------- NEW transcription worker ----------------
    if room not in audio_workers:
        t = threading.Thread(target=audio_worker_for_room, args=(room, socketio), daemon=True)
        audio_workers[room] = t
        t.start()

@socketio.on('offer')
def handle_offer(data):
    room = data.get('room')
    log.info(f"[SIGNAL] offer from {request.sid} -> room={room}")
    emit('offer', {'sdp': data.get('sdp')}, room=room, include_self=False)

@socketio.on('answer')
def handle_answer(data):
    room = data.get('room')
    log.info(f"[SIGNAL] answer from {request.sid} -> room={room}")
    emit('answer', {'sdp': data.get('sdp')}, room=room, include_self=False)

@socketio.on('ice-candidate')
def handle_ice(data):
    room = data.get('room')
    log.info(f"[SIGNAL] ice-candidate from {request.sid} -> room={room}")
    emit('ice-candidate', {'candidate': data.get('candidate')}, room=room, include_self=False)

@socketio.on('leave')
def handle_leave(data):
    room = data.get('room')
    sid = request.sid
    leave_room(room)
    rooms_peers[room].discard(sid)
    socketio.emit('peer-left', {'sid': sid}, room=room, include_self=False)
    log.info(f"[LEAVE] {sid} left {room} (count={len(rooms_peers[room])})")
    if not rooms_peers[room]:
        del rooms_peers[room]

@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    for room, sids in list(rooms_peers.items()):
        if sid in sids:
            sids.remove(sid)
            socketio.emit('peer-left', {'sid': sid}, room=room, include_self=False)
            log.info(f"[DISCONNECT] {sid} removed from {room} (count={len(sids)})")
            if not sids:
                del rooms_peers[room]

# ------------------- NEW AUDIO TRANSCRIPTION -------------------
@socketio.on('audio-chunk')
def on_audio_chunk(data):
    """Receive audio chunk from clients (base64-encoded)."""
    room = data.get("room", "default")
    handle_audio_chunk(room, data.get("b64"), data.get("ts"), data.get("seq"))

# ------------------- NEW SUMMARIZER ENDPOINT -------------------
@app.route("/summarize", methods=["POST"])
def summarize():
    """Summarize transcript of a given room."""
    data = request.get_json(force=True)
    room = data.get("room", "default")
    transcript_text = " ".join([e["text"] for e in rooms[room]["transcript"]])
    result = summarize_and_extract(transcript_text)
    return jsonify({"room": room, "result": result, "transcript": transcript_text})

# ------------------- NEW NETWORK ADAPTATION -------------------
@app.route("/adapt", methods=["POST"])
def adapt():
    """Evaluate network stats sent by client and return adaptation mode."""
    stats = request.get_json(force=True)
    mode = evaluate_network(stats)
    return jsonify({"mode": mode})

# --------------------------------------------------------------
if __name__ == '__main__':
    log.info("Starting signaling server on http://0.0.0.0:5000 (reloader disabled)")
    socketio.run(app, host='0.0.0.0', port=5000, debug=False, use_reloader=False)
