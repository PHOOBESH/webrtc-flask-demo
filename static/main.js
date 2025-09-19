// static/main.js — robust, with TURN server (Metered.ca free relay)
document.addEventListener('DOMContentLoaded', () => {
  // state
  let joined = false;
  const socket = io();
  let pc = null;
  let localStream = null;
  let room = null;
  let isInitiator = false;
  let statsInterval = null;
  let prevPacketsReceived = 0;
  let prevPacketsLost = 0;

  // ✅ STUN + TURN servers
  const config = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ]
};
  // helpers
  function clog(...args) { console.log('[APP]', ...args); }
  function sLog(...args) { console.log('[SOCKET]', ...args); }

  // DOM refs
  const joinBtn = document.getElementById('joinBtn');
  const leaveBtn = document.getElementById('leaveBtn');
  const roomInput = document.getElementById('roomInput');

  // socket events
  socket.on('connect', () => {
    clog('Socket connected:', socket.id);
    if (!joined) joinBtn.disabled = false;
  });
  socket.on('disconnect', (reason) => clog('Socket disconnected:', reason));
  socket.on('connect_error', (err) => clog('Socket connect_error', err));

  // server signals
  socket.on('created', async () => {
    clog('Server -> created (you are first in room)');
    isInitiator = true;
    await ensureLocalStream();
  });

  socket.on('ready', async () => {
    clog('Server -> ready (2 peers)');
    if (!localStream) await ensureLocalStream();

    if (!pc) createPeerConnection();

    // add tracks safely (avoid duplicates)
    if (localStream && pc) {
      const existingTracks = pc.getSenders().map(s => s.track).filter(Boolean);
      localStream.getTracks().forEach(t => { if (!existingTracks.includes(t)) pc.addTrack(t, localStream); });
    }

    // only initiator creates offer
    if (isInitiator && pc) {
      try {
        clog('Initiator -> createOffer');
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sLog('emit offer');
        socket.emit('offer', { sdp: pc.localDescription, room });
      } catch (e) { console.error('Offer error', e); }
    }
  });

  socket.on('offer', async (data) => {
    clog('Socket -> offer received');
    if (!pc) createPeerConnection();
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (!localStream) await ensureLocalStream();
      // add tracks before answering
      localStream.getTracks().forEach(t => { try { pc.addTrack(t, localStream); } catch(e){} });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sLog('emit answer');
      socket.emit('answer', { sdp: pc.localDescription, room });
    } catch (err) { console.error('Handle offer error', err); }
  });

  socket.on('answer', async (data) => {
    clog('Socket -> answer received');
    try { await pc.setRemoteDescription(new RTCSessionDescription(data.sdp)); }
    catch (err) { console.error('Set remote answer error', err); }
  });

  socket.on('ice-candidate', async (data) => {
    clog('Socket -> ice-candidate received');
    try { if (pc && data.candidate) await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); }
    catch (err) { console.warn('Add ICE candidate failed', err); }
  });

  // When another peer leaves, we clear the remote video and close the PC.
  socket.on('peer-left', (payload) => {
    clog('Socket -> peer-left', payload);
    // clear remote view but keep local camera running so user can continue
    document.getElementById('remoteVideo').srcObject = null;
    if (pc) { try { pc.close(); } catch(e){} pc = null; }
    if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
    prevPacketsReceived = prevPacketsLost = 0;
    // Leave DOES NOT modify `joined` here — user can re-join or leave locally.
  });

  // UI handlers
  joinBtn.onclick = async () => {
    if (joined) { clog('Already joined — ignoring'); return; }
    room = (roomInput.value || 'default').trim();

    // wait for socket
    if (!socket.connected) {
      clog('Waiting for socket connection...');
      await new Promise(res => {
        const t = setInterval(() => { if (socket.connected) { clearInterval(t); res(); } }, 50);
        // fallback timeout
        setTimeout(() => { clearInterval(t); res(); }, 3000);
      });
    }

    sLog('emit join', room);
    socket.emit('join', { room });
    joined = true;
    joinBtn.disabled = true;
  };

  // user clicks leave -> stop local only (server notifies others)
  leaveBtn.onclick = () => {
    if (room) {
      sLog('emit leave', room);
      socket.emit('leave', { room });
    }
    stopLocalAndReset();
  };

  // media & PC helpers
  async function ensureLocalStream() {
    if (localStream) return;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      document.getElementById('localVideo').srcObject = localStream;
      leaveBtn.disabled = false;
      clog('Local stream started');
    } catch (err) {
      alert('Camera/microphone error: ' + err.message);
      clog('getUserMedia failed', err);
      joinBtn.disabled = false;
      joined = false;
    }
  }

  function createPeerConnection() {
    clog('Creating RTCPeerConnection');
    pc = new RTCPeerConnection(config);

    pc.onicecandidate = (event) => {
      if (event.candidate) { sLog('emit ice-candidate'); socket.emit('ice-candidate', { candidate: event.candidate, room }); }
    };

    pc.ontrack = (ev) => {
      clog('ontrack -> set remote');
      document.getElementById('remoteVideo').srcObject = ev.streams[0];
    };

    pc.onconnectionstatechange = () => {
      clog('PC connectionState', pc.connectionState);
      if (pc.connectionState === 'connected') startStats();
      if (['disconnected','failed','closed'].includes(pc.connectionState)) stopCallAndKeepLocal();
    };

    pc.oniceconnectionstatechange = () => clog('PC iceConnectionState', pc.iceConnectionState);
  }

  function startStats() {
    if (statsInterval) clearInterval(statsInterval);
    statsInterval = setInterval(async () => {
      if (!pc || pc.connectionState !== 'connected') return;
      const stats = await pc.getStats();
      parseAndShowStats(stats);
    }, 1000);
  }

  function parseAndShowStats(stats) {
    let rttMs = null, packetsReceived = 0, packetsLost = 0;
    stats.forEach(report => {
      if (report.type === 'candidate-pair' && (report.state === 'succeeded' || report.selected)) {
        if (report.currentRoundTripTime) rttMs = report.currentRoundTripTime * 1000;
        else if (report.roundTripTime) rttMs = report.roundTripTime * 1000;
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
      plPercent = (total > 0) ? ((dLost / total) * 100).toFixed(1) : '0.0';
    }
    prevPacketsReceived = packetsReceived; prevPacketsLost = packetsLost;

    document.getElementById('rtt').innerText = rttMs ? Math.round(rttMs) : '—';
    document.getElementById('pl').innerText = (plPercent !== '—') ? (plPercent + '%') : '—';
    try { document.getElementById('debug').innerText = `inbound packets: ${packetsReceived}, lost: ${packetsLost}`; } catch(e){}
  }

  // stop both PC and local stream (user leaves completely)
  function stopLocalAndReset() {
    clog('stopLocalAndReset');
    if (pc) { try { pc.close(); } catch(e){} pc = null; }
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
      document.getElementById('localVideo').srcObject = null;
    }
    document.getElementById('remoteVideo').srcObject = null;
    if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
    prevPacketsReceived = prevPacketsLost = 0;
    joinBtn.disabled = false; leaveBtn.disabled = true;
    joined = false; room = null; isInitiator = false;
  }

  // stop call but keep local stream running (peer disconnected or PC failed)
  function stopCallAndKeepLocal() {
    clog('stopCallAndKeepLocal');
    if (pc) { try { pc.close(); } catch(e){} pc = null; }
    document.getElementById('remoteVideo').srcObject = null;
    if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
    prevPacketsReceived = prevPacketsLost = 0;
    // do NOT change `joined` or localStream so user can attempt re-negotiate or re-join
  }
});
