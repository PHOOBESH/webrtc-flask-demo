# server.py
from flask import Flask, render_template, request
from flask_socketio import SocketIO, join_room, leave_room, emit
from collections import defaultdict

app = Flask(__name__, template_folder="templates")
socketio = SocketIO(app, cors_allowed_origins='*', logger=False, engineio_logger=False)

rooms = defaultdict(set)

@app.route('/')
def index():
    return render_template('index.html')

@socketio.on('join')
def handle_join(data):
    room = data.get('room')
    sid = request.sid
    join_room(room)
    rooms[room].add(sid)
    print(f"[JOIN] {sid} -> {room} (count={len(rooms[room])})")

    if len(rooms[room]) == 1:
        emit('created')    # notify the first client
    elif len(rooms[room]) == 2:
        emit('ready', room=room)
    else:
        emit('full')

@socketio.on('offer')
def handle_offer(data):
    room = data.get('room')
    sdp = data.get('sdp')
    print(f"[OFFER] from {request.sid} -> room {room}")
    emit('offer', {'sdp': sdp}, room=room, include_self=False)

@socketio.on('answer')
def handle_answer(data):
    room = data.get('room')
    sdp = data.get('sdp')
    print(f"[ANSWER] from {request.sid} -> room {room}")
    emit('answer', {'sdp': sdp}, room=room, include_self=False)

@socketio.on('ice-candidate')
def handle_ice(data):
    room = data.get('room')
    candidate = data.get('candidate')
    print(f"[ICE] from {request.sid} -> room {room} candidate: {bool(candidate)}")
    emit('ice-candidate', {'candidate': candidate}, room=room, include_self=False)

@socketio.on('leave')
def handle_leave(data):
    # Leaver notifies server; server notifies others (not the leaver)
    room = data.get('room')
    sid = request.sid
    leave_room(room)
    rooms[room].discard(sid)
    print(f"[LEAVE] {sid} left {room} (remaining={len(rooms[room])})")
    # notify others only
    emit('peer-left', {'sid': sid}, room=room, include_self=False)
    # cleanup empty rooms
    if not rooms[room]:
        del rooms[room]

@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    # remove from any room and notify others (but not self)
    for room, sids in list(rooms.items()):
        if sid in sids:
            sids.remove(sid)
            emit('peer-left', {'sid': sid}, room=room, include_self=False)
            if not sids:
                del rooms[room]
            print(f"[DISCONNECT] {sid} removed from {room}")
@socketio.on('ping')
def handle_ping(data):
    # simple ping-pong for debugging / keepalive
    emit('pong', {'time': data.get('time')})


if __name__ == '__main__':
    print("Starting server on http://0.0.0.0:5000")
    socketio.run(app, host='0.0.0.0', port=5000, debug=True)
