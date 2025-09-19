# server.py
import eventlet
eventlet.monkey_patch()

from flask import Flask, render_template, request
from flask_socketio import SocketIO, join_room, leave_room, emit
from collections import defaultdict
import logging

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("webrtc-signaling")

app = Flask(__name__, template_folder="templates")
# explicitly use eventlet + disable reloader when running
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='eventlet', logger=False, engineio_logger=False)

# track room membership (simple demo: max 2)
rooms = defaultdict(set)

@app.route('/')
def index():
    return render_template('index.html')

@socketio.on('connect')
def on_connect():
    log.info(f"[CONNECT] sid={request.sid}")

@socketio.on('join')
def handle_join(data):
    room = data.get('room')
    sid = request.sid
    join_room(room)
    rooms[room].add(sid)
    log.info(f"[JOIN] {sid} -> {room} (count={len(rooms[room])})")
    if len(rooms[room]) == 1:
        emit('created')  # only to the joining client
    elif len(rooms[room]) == 2:
        # room ready: notify both peers
        socketio.emit('ready', room=room)
    else:
        # too many clients for this demo
        emit('full')

@socketio.on('offer')
def handle_offer(data):
    room = data.get('room')
    log.info(f"[SIGNAL] offer from {request.sid} -> room={room}")
    # optionally log sdp size
    sdp = data.get('sdp')
    if sdp and isinstance(sdp, dict) and 'sdp' in sdp:
        log.info(f"  offer sdp length {len(sdp.get('sdp') or '')}")
    emit('offer', {'sdp': sdp}, room=room, include_self=False)

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
    rooms[room].discard(sid)
    # notify other peers only (do not include the sender)
    socketio.emit('peer-left', {'sid': sid}, room=room, include_self=False)
    log.info(f"[LEAVE] {sid} left {room} (count={len(rooms[room])})")
    if not rooms[room]:
        del rooms[room]


@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    for room, sids in list(rooms.items()):
        if sid in sids:
            sids.remove(sid)
            # notify other peers only
            socketio.emit('peer-left', {'sid': sid}, room=room, include_self=False)
            log.info(f"[DISCONNECT] {sid} removed from {room} (count={len(sids)})")
            if not sids:
                del rooms[room]

if __name__ == '__main__':
    # IMPORTANT: disable reloader to avoid duplicate processes
    log.info("Starting signaling server on http://0.0.0.0:5000 (reloader disabled)")
    socketio.run(app, host='0.0.0.0', port=5000, debug=False, use_reloader=False)
