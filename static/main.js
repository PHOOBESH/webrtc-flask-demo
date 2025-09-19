// static/main.js
// Resilient WebRTC client with deterministic join/leave behavior

const socket = io({ transports: ['websocket'], reconnectionAttempts: 5, reconnectionDelay: 1000 });

let pc = null;
let localStream = null;
let room = null;
let isInitiator = false;
let statsInterval = null;
let prevPacketsReceived = 0;
let prevPacketsLost = 0;
let remotePresent = false;
let remoteSid = null;
let joined = false; // whether user intentionally joined

const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const roomInput = document.getElementById('roomInput');
const debugEl = document.getElementById('debug');

/////////////////////
// UI Handlers
/////////////////////
joinBtn.onclick = async () => {
  // Close any existing peer connection to avoid duplicate negotiation
  if (pc) {
    console.log('[UI] closing existing peer before re-join');
    pc.close();
    pc = null;
  }

  room = (roomInput.value || 'default').trim();
  console.log('[UI] Join clicked -> room=', room);
  socket.emit('join', { room });
  joinBtn.disabled = true;   // re-enabled on leave or error
  // mark intent; server will confirm with 'created' or 'ready'
  joined = true;
};

leaveBtn.onclick = () => {
  if (!joined) return;
  if (room) {
    console.log('[UI] Leave clicked -> notifying server');
    socket.emit('leave', { room });
  }
  // clear joined state and room
  joined = false;
  room = null;
  // stop only local resources for the leaver
  stopCall();
  joinBtn.disabled = false;
};

/////////////////////
// Socket handlers
/////////////////////
socket.on('connect', () => {
  console.log('[SOCKET] connected', socket.id);
  console.log('[SOCKET] joined flag=', joined, '(no auto-join will happen)');
});

// do NOT auto re-join on reconnect; user must click Join
socket.on('disconnect', (reason) => {
  console.log('[SOCKET] disconnected', reason);
});

socket.on('created', async () => {
  console.log('[SIGNAL] created -> you are initiator');
  isInitiator = true;
  joined = true; // server confirmed
  if (!localStream) await startLocalStream();
});

socket.on('ready', async () => {
  console.log('[SIGNAL] ready -> peers present');
  joined = true;
  if (!localStream) await startLocalStream();
  if (isInitiator) {
    createPeerConnection();
    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log('[SIGNAL] sending offer');
      socket.emit('offer', { sdp: pc.localDescription, room });
    } catch (e) { console.error('[ERROR] Offer creation', e); }
  }
});

socket.on('offer', async (data) => {
  console.log('[SIGNAL] received offer');
  // Only answer offers if user intentionally joined
  if (!joined) {
    console.warn('[SIGNAL] offer received but user not joined; ignoring');
    return;
  }
  if (!localStream) await startLocalStream();
  if (!pc) createPeerConnection();
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    console.log('[SIGNAL] sending answer');
    socket.emit('answer', { sdp: pc.localDescription, room });
  } catch (e) { console.error('[ERROR] Answer creation', e); }
});

socket.on('answer', async (data) => {
  console.log('[SIGNAL] received answer');
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } catch (e) { console.error('[ERROR] Set remote desc', e); }
});

socket.on('ice-candidate', async (data) => {
  console.log('[SIGNAL] received ICE', data && data.candidate ? 'true' : 'false');
  if (!pc) {
    console.warn('[SIGNAL] No RTCPeerConnection yet to add ICE');
    return;
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
  } catch (err) {
    console.warn('[ERROR] Adding ICE candidate', err);
  }
});

// When a peer leaves, only clear remote video and mark remote absent.
// Do NOT stop local camera/pc — keep page live for rejoin.
socket.on('peer-left', (data) => {
  console.log('[SIGNAL] peer-left', data);
  remotePresent = false;
  remoteSid = null;
  document.getElementById('remoteVideo').srcObject = null;
  appendDebug(`Peer left: ${data && data.sid ? data.sid : 'unknown'}`);
});

/////////////////////
// Media & Peer
/////////////////////
async function startLocalStream() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById('localVideo').srcObject = localStream;
    leaveBtn.disabled = false;
    console.log('[MEDIA] local stream started');
  } catch (err) {
    alert('Could not get camera/mic: ' + err.message);
    console.error(err);
  }
}

function createPeerConnection() {
  console.log('[PC] creating RTCPeerConnection');
  pc = new RTCPeerConnection(config);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      console.log('[PC] sending ICE');
      socket.emit('ice-candidate', { candidate: event.candidate, room });
    }
  };

  pc.ontrack = event => {
    console.log('[PC] ontrack event', event);
    remotePresent = true;
    try { remoteSid = event.streams && event.streams[0] && event.streams[0].id; } catch (e) {}
    document.getElementById('remoteVideo').srcObject = event.streams[0];
  };

  pc.onconnectionstatechange = () => {
  console.log('[PC] connectionState', pc.connectionState);
  if (pc.connectionState === 'connected') {
    startStats();
    return;
  }

  // If the PC becomes 'failed' or 'closed' *and* a remote participant is present,
  // that indicates a real session failure and we should stop the call.
  // But if remotePresent is false (peer already left), don't fully stop:
  // keep local camera on so the user can wait/rejoin without reloading.
  if ((pc.connectionState === 'failed' || pc.connectionState === 'closed')) {
    if (remotePresent) {
      appendDebug(`PC state is ${pc.connectionState} with remote present -> stopping call`);
      stopCall();
    } else {
      appendDebug(`PC state is ${pc.connectionState} but no remote present -> keeping local stream alive`);
      // do not call stopCall() here; keep pc/null? we will close pc later on explicit leave
      // Optionally: you could close pc but keep localStream; here we keep pc open so
      // reconnection/renegotiation is possible without re-getUserMedia.
    }
  }
};


  pc.oniceconnectionstatechange = () => {
    console.log('[PC] iceConnectionState', pc.iceConnectionState);
    if (pc.iceConnectionState === 'disconnected') {
      if (remotePresent) {
        appendDebug('ICE disconnected (remote was present). Waiting for reconnection...');
        setTimeout(() => {
          if (pc && pc.iceConnectionState === 'disconnected') {
            appendDebug('ICE still disconnected after timeout.');
            // do not auto-stop here; rely on onconnectionstatechange for final action.
          }
        }, 5000);
      } else {
        appendDebug('ICE disconnected but no remote present (peer likely left).');
        // keep pc open so user can re-invite or wait
      }
    }
  };
}

/////////////////////
// Stats
/////////////////////
function startStats() {
  if (statsInterval) clearInterval(statsInterval);
  statsInterval = setInterval(async () => {
    if (!pc || pc.connectionState !== 'connected') return;
    const stats = await pc.getStats();
    parseAndShowStats(stats);
  }, 1000);
}

function parseAndShowStats(stats) {
  let rttMs = null;
  let packetsReceived = 0;
  let packetsLost = 0;

  stats.forEach(report => {
    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
      if (report.currentRoundTripTime) rttMs = report.currentRoundTripTime * 1000;
      if (report.roundTripTime) rttMs = report.roundTripTime * 1000;
    }
    if (report.type === 'inbound-rtp' && (report.kind === 'video' || !report.kind)) {
      packetsReceived = report.packetsReceived || packetsReceived;
      packetsLost = report.packetsLost || packetsLost;
    }
  });

  let plPercent = '—';
  if (prevPacketsReceived || prevPacketsLost) {
    const dRecv = Math.max(0, (packetsReceived - prevPacketsReceived) || 0);
    const dLost = Math.max(0, (packetsLost - prevPacketsLost) || 0);
    const total = dRecv + dLost;
    plPercent = total > 0 ? ((dLost / total) * 100).toFixed(1) + '%' : '0.0%';
  }
  prevPacketsReceived = packetsReceived;
  prevPacketsLost = packetsLost;

  document.getElementById('rtt').innerText = rttMs ? Math.round(rttMs) : '—';
  document.getElementById('pl').innerText = plPercent;
  document.getElementById('debug').innerText = `inbound packets: ${packetsReceived}, lost: ${packetsLost}\npc.connState: ${pc ? pc.connectionState : 'no-pc'}`;
}

/////////////////////
// Stop / cleanup
/////////////////////
function stopCall(soft = false) {
  console.log('[PC] stopping call, soft=', soft);
  if (pc) { pc.close(); pc = null; }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    document.getElementById('localVideo').srcObject = null;
  }
  document.getElementById('remoteVideo').srcObject = null;
  if (statsInterval) clearInterval(statsInterval);
  prevPacketsReceived = prevPacketsLost = 0;
  joinBtn.disabled = false;
  leaveBtn.disabled = true;
  remotePresent = false;
  remoteSid = null;
  if (!soft) appendDebug('[PC] call fully stopped');
}

/////////////////////
// Helpers
/////////////////////
function appendDebug(text) {
  const d = debugEl;
  const now = new Date().toLocaleTimeString();
  d.innerText = (d.innerText || '') + `\n[${now}] ${text}`;
}

// clean leave when closing tab
window.addEventListener('beforeunload', (e) => {
  try {
    if (joined && room) {
      socket.emit('leave', { room });
      joined = false;
      room = null;
    }
  } catch (err) { /* ignore */ }
});
