// static/main.js
// WebRTC + SocketIO client for 2-participant demo
// Replace or adapt selectors to your HTML if needed.

const socket = io(); // assumes socket.io client script is loaded
let pc = null;
let localStream = null;
let roomName = null;
let statsInterval = null;

// UI elements
const joinBtn = document.querySelector('#joinBtn') || document.querySelector('button:contains("Join")');
const leaveBtn = document.querySelector('#leaveBtn') || document.querySelector('button:contains("Leave")');
const roomInput = document.querySelector('#roomInput') || document.querySelector('input[placeholder="room name"]');
const localVideo = document.querySelector('#localVideo') || document.querySelector('video#local');
const remoteVideo = document.querySelector('#remoteVideo') || document.querySelector('video#remote');
const rttEl = document.querySelector('#rtt') || document.querySelector('#rtt') || document.createElement('div');
const lossEl = document.querySelector('#loss') || document.createElement('div');
const logEl = document.querySelector('#log') || document.createElement('pre');

function log(...args) {
  console.log(...args);
  try {
    logEl.textContent += args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') + '\n';
  } catch (e) {}
}

// ---- ICE config ----
// Try to fetch TURN credentials from server; fallback to public test TURN
async function getIceConfig() {
  // default STUN
  const base = [{ urls: 'stun:stun.l.google.com:19302' }];

  try {
    const res = await fetch('/turn-credentials');
    if (res.ok) {
      const data = await res.json();
      log('[TURN] got credentials', data);
      const turnServers = data.uris.map(uri => ({
        urls: uri,
        username: data.username,
        credential: data.credential
      }));
      return { iceServers: [...base, ...turnServers] };
    } else {
      log('[TURN] /turn-credentials not available, using fallback TURN', res.status);
    }
  } catch (e) {
    log('[TURN] fetch error (ok if not configured):', e);
  }

  // Fallback public test TURN (limited reliability) — only for quick testing, replace with your own for production
  const fallbackTurn = [
    { urls: 'turn:relay.metered.ca:80', username: 'openai', credential: 'openai123' },
    { urls: 'turn:relay.metered.ca:443', username: 'openai', credential: 'openai123' }
  ];
  return { iceServers: [...base, ...fallbackTurn] };
}

// ---- Media / PeerConnection helpers ----
async function startLocalStream() {
  if (localStream) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (localVideo) localVideo.srcObject = localStream;
    log('[MEDIA] Local stream started');
  } catch (err) {
    log('[MEDIA] getUserMedia error:', err);
    alert('Camera / mic access required. Check permissions.');
    throw err;
  }
}

async function createPeerConnection() {
  if (pc) {
    log('[PC] existing pc exists - closing it first');
    stopPeerConnection();
  }

  const cfg = await getIceConfig();
  log('[PC] creating RTCPeerConnection with config', cfg);
  pc = new RTCPeerConnection(cfg);

  // add local tracks
  if (localStream) {
    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }
  }

  // event handlers
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      log('[PC] onicecandidate -> sending candidate', e.candidate);
      socket.emit('ice-candidate', { candidate: e.candidate, room: roomName });
    } else {
      log('[PC] onicecandidate: null (all candidates sent)');
    }
  };

  pc.ontrack = (e) => {
    log('[PC] ontrack', e);
    // put remote stream into video element
    if (remoteVideo) {
      // prefer using e.streams[0] if available
      if (e.streams && e.streams[0]) {
        remoteVideo.srcObject = e.streams[0];
      } else {
        // fallback: build stream from tracks
        const inboundStream = new MediaStream();
        inboundStream.addTrack(e.track);
        remoteVideo.srcObject = inboundStream;
      }
    }
  };

  pc.onconnectionstatechange = () => {
    log('[PC] connectionState:', pc.connectionState);
    if (pc.connectionState === 'failed') {
      log('[PC] connection failed, trying to restart ICE');
      pc.restartIce && pc.restartIce();
    }
  };

  pc.oniceconnectionstatechange = () => {
    log('[PC] iceConnectionState:', pc.iceConnectionState);
    if (pc.iceConnectionState === 'disconnected') {
      // might indicate remote left or network hiccup
      log('[PC] ICE disconnected');
    }
  };

  // stats polling
  if (statsInterval) clearInterval(statsInterval);
  statsInterval = setInterval(async () => {
    if (!pc) return;
    try {
      const stats = await pc.getStats(null);
      parseAndShowStats(stats);
    } catch (e) {
      // ignore
    }
  }, 2000);

  return pc;
}

function stopPeerConnection() {
  if (!pc) return;
  try {
    pc.getSenders().forEach(s => {
      if (s.track) s.track.stop();
    });
  } catch (e) {}

  try {
    pc.close();
  } catch (e) {}
  pc = null;
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
  if (remoteVideo) remoteVideo.srcObject = null;
}

// parse basic stats (RTT, packet loss)
function parseAndShowStats(stats) {
  let rtt = null;
  let inboundPackets = 0, inboundLost = 0;
  stats.forEach(report => {
    if (report.type === 'candidate-pair' && report.currentRoundTripTime !== undefined) {
      rtt = Math.round(report.currentRoundTripTime * 1000);
    }
    if (report.type === 'inbound-rtp' && report.kind === 'video') {
      inboundPackets = report.packetsReceived || 0;
      inboundLost = report.packetsLost || 0;
    }
  });
  if (rttEl) rttEl.textContent = `RTT: ${rtt !== null ? rtt + ' ms' : '— ms'}`;
  if (lossEl) lossEl.textContent = `Packet loss: ${inboundPackets ? ((inboundLost / (inboundPackets + inboundLost)) * 100).toFixed(1) + '%' : '— %'}`;
  log(`[STATS] rtt=${rtt} inbound_packets=${inboundPackets}, lost=${inboundLost}`);
}

// ---- Signaling flow ----
async function joinRoom() {
  roomName = (roomInput && roomInput.value) ? roomInput.value : 'default';
  if (!roomName) {
    alert('Enter a room name');
    return;
  }
  log('[SIGNAL] joining', roomName);
  await startLocalStream();
  socket.emit('join', { room: roomName });
  // disable join button
  if (joinBtn) joinBtn.disabled = true;
}

async function leaveRoom() {
  log('[SIGNAL] leaving', roomName);
  try {
    socket.emit('leave', { room: roomName });
  } catch (e) {}
  stopPeerConnection();
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (joinBtn) joinBtn.disabled = false;
  if (leaveBtn) leaveBtn.disabled = true;
  roomName = null;
}

socket.on('connect', () => {
  log('[SOCKET] connected', socket.id);
});

socket.on('peer-joined', async (data) => {
  log('[SOCKET] peer-joined', data);
  // When a peer joins, this client should create an offer (if we have started local stream)
  try {
    await createPeerConnection();
    // create offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    log('[SOCKET] sending offer', offer);
    socket.emit('offer', { sdp: offer, room: roomName });
  } catch (e) {
    log('[ERROR] peer-joined flow', e);
  }
});

socket.on('offer', async (data) => {
  log('[SOCKET] received offer', data);
  try {
    await createPeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    log('[SOCKET] sending answer', answer);
    socket.emit('answer', { sdp: answer, room: roomName });
  } catch (e) {
    log('[ERROR] handling offer', e);
  }
});

socket.on('answer', async (data) => {
  log('[SOCKET] received answer', data);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } catch (e) {
    log('[ERROR] setRemoteDescription(answer)', e);
  }
});

socket.on('ice-candidate', async (data) => {
  log('[SOCKET] received ice-candidate', data);
  try {
    if (data.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      log('[PC] addIceCandidate success');
    }
  } catch (e) {
    log('[ERROR] addIceCandidate', e);
  }
});

socket.on('peer-left', (data) => {
  log('[SOCKET] peer-left', data);
  // tear down peer connection
  stopPeerConnection();
});

// ---- UI bindings ----
if (joinBtn) joinBtn.addEventListener('click', async (e) => {
  joinBtn.disabled = true;
  leaveBtn.disabled = false;
  await joinRoom();
});

if (leaveBtn) leaveBtn.addEventListener('click', async (e) => {
  leaveBtn.disabled = true;
  joinBtn.disabled = false;
  await leaveRoom();
});

// auto-attach video autoplay
if (localVideo) { localVideo.autoplay = true; localVideo.muted = true; localVideo.playsInline = true; }
if (remoteVideo) { remoteVideo.autoplay = true; remoteVideo.playsInline = true; remoteVideo.muted = false; }

// Safety: handle page unload to leave gracefully
window.addEventListener('beforeunload', () => {
  try { socket.emit('leave', { room: roomName }); } catch (e) {}
  stopPeerConnection();
});

// debug helper to show logs on page if #log exists
log('[INIT] main.js loaded');
