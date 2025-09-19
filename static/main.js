// static/main.js — multi-peer mesh client (updated: creates CSS-friendly tiles + participants list)
document.addEventListener('DOMContentLoaded', () => {
  const socket = io();
  const pcs = {};              // map: remoteSid -> RTCPeerConnection
  let localStream = null;
  let joined = false;
  let room = null;
  let statsInterval = null;
  let prevPacketsReceived = 0;
  let prevPacketsLost = 0;

  // ICE config: STUN + TURN (replace with your reliable TURN provider)
  const config = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      // Example public relay (for testing). Replace with Xirsys/coturn creds for reliability.
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  };

  // DOM (note: remotesGrid matches new HTML)
  const joinBtn = document.getElementById('joinBtn');
  const leaveBtn = document.getElementById('leaveBtn');
  const roomInput = document.getElementById('roomInput');
  const localVideo = document.getElementById('localVideo');
  const remotesGrid = document.getElementById('remotesGrid');
  const participantsList = document.getElementById('participantsList');
  const rttEl = document.getElementById('rtt');
  const plEl = document.getElementById('pl');
  const debugEl = document.getElementById('debug');

  // helper logs
  function clog(...a){ console.log('[APP]', ...a); }

  // --- socket handlers ---
  socket.on('connect', () => {
    clog('socket connected', socket.id);
    joinBtn.disabled = false;
  });

  // Receive initial list of existing peers (optional)
  socket.on('existing-peers', (data) => {
    clog('existing peers', data.peers);
    // optionally populate participants list
    if (Array.isArray(data.peers)) {
      data.peers.forEach(p => addParticipant(p));
    }
  });

  // New peer joined -> we should create pc and offer to them
  socket.on('new-peer', async (data) => {
    const newSid = data.peer;
    clog('new-peer -> create offer to', newSid);
    addParticipant(newSid);
    await createPeerAndOffer(newSid);
  });

  // Offer received from another peer
  socket.on('offer', async (data) => {
    const from = data.from;
    const sdp = data.sdp;
    clog('offer received from', from);
    if (!pcs[from]) createPeerConnectionFor(from);
    const pc = pcs[from];
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (e) {
      console.error('setRemoteDescription failed', e);
      return;
    }

    // Ensure local stream is available before answering
    if (!localStream) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
        localVideo.srcObject = localStream;
        leaveBtn.disabled = false;
      } catch(e) {
        alert('Camera/mic permission needed: ' + e.message);
        return;
      }
    }

    // Add local tracks if not already
    const existingTracks = pc.getSenders().map(s => s.track).filter(Boolean);
    localStream.getTracks().forEach(t => {
      if (!existingTracks.includes(t)) pc.addTrack(t, localStream);
    });

    // Create answer
    try {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { to: from, sdp: pc.localDescription });
      clog('sent answer to', from);
    } catch (err) {
      console.error('Error creating/sending answer', err);
    }
  });

  // Answer for an offer we sent
  socket.on('answer', async (data) => {
    const from = data.from;
    const sdp = data.sdp;
    clog('answer received from', from);
    const pc = pcs[from];
    if (pc) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      } catch (e) {
        console.warn('setRemoteDescription (answer) failed', e);
      }
    } else {
      console.warn('No pc for', from);
    }
  });

  // ICE candidate routing
  socket.on('ice-candidate', async (data) => {
    const from = data.from;
    const candidate = data.candidate;
    const pc = pcs[from];
    if (pc && candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('Failed to add ICE', e);
      }
    }
  });

  // Peer left -> remove UI and pc
  socket.on('peer-left', (data) => {
    const sid = data.sid;
    clog('peer-left', sid);
    removePeer(sid);
    removeParticipant(sid);
  });

  // --- UI handlers ---
  joinBtn.onclick = async () => {
    if (joined) return;
    room = (roomInput.value || 'default').trim();

    // get local stream proactively
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
      localVideo.srcObject = localStream;
      leaveBtn.disabled = false;
    } catch (e) {
      alert('Camera/mic required: ' + e.message);
      return;
    }

    socket.emit('join', { room });
    joined = true;
    joinBtn.disabled = true;
    clog('joined', room);

    // mark self in participants list
    addParticipant('you', { label: 'You', self: true });
  };

  leaveBtn.onclick = () => {
    if (!joined) return;
    socket.emit('leave', { room });
    // cleanup all
    Object.keys(pcs).forEach(removePeer);
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    localVideo.srcObject = null;
    joined = false;
    joinBtn.disabled = false;
    leaveBtn.disabled = true;
    // remove participants (except 'you' entry if desired)
    clearParticipants();
  };

  // --- Peer connection helpers ---
  function createPeerConnectionFor(remoteSid) {
    const pc = new RTCPeerConnection(config);
    pcs[remoteSid] = pc;

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        socket.emit('ice-candidate', { to: remoteSid, candidate: ev.candidate });
      }
    };

    pc.ontrack = (ev) => {
      clog('ontrack from', remoteSid);
      attachRemoteStream(remoteSid, ev.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      clog('pc state', remoteSid, pc.connectionState);
      if (pc.connectionState === 'connected') {
        startStatsFor(remoteSid);
      }
      if (['disconnected','failed','closed'].includes(pc.connectionState)) {
        removePeer(remoteSid);
        removeParticipant(remoteSid);
      }
    };

    // add local tracks if available
    if (localStream) {
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }

    return pc;
  }

  async function createPeerAndOffer(targetSid) {
    const pc = createPeerConnectionFor(targetSid);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: targetSid, sdp: pc.localDescription });
      clog('offer sent to', targetSid);
    } catch (e) {
      console.error('Offer error', e);
    }
  }

  // --- UI: create tiles & participants list (matches CSS) ---
  function attachRemoteStream(remoteSid, stream) {
    // ensure wrapper exists and has classes that match style.css
    let wrapper = document.getElementById('wrap_' + remoteSid);
    let vid;
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = 'wrap_' + remoteSid;
      wrapper.className = 'video-tile';
      // create video element
      vid = document.createElement('video');
      vid.id = 'remote_' + remoteSid;
      vid.autoplay = true;
      vid.playsInline = true;
      // append video
      wrapper.appendChild(vid);

      // tile footer
      const footer = document.createElement('div');
      footer.className = 'tile-footer';
      // name
      const nameDiv = document.createElement('div');
      nameDiv.className = 'name';
      nameDiv.innerText = `Peer: ${shortId(remoteSid)}`;
      // meta (badge)
      const metaDiv = document.createElement('div');
      metaDiv.className = 'meta';
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.innerText = 'Remote';
      metaDiv.appendChild(badge);

      footer.appendChild(nameDiv);
      footer.appendChild(metaDiv);
      wrapper.appendChild(footer);

      // append to grid (after local tile)
      remotesGrid.appendChild(wrapper);

      // add participant entry
      addParticipant(remoteSid);
    } else {
      vid = document.getElementById('remote_' + remoteSid);
    }

    // set stream
    try {
      vid.srcObject = stream;
    } catch (e) {
      // fallback: create object URL (older browsers)
      vid.src = URL.createObjectURL(stream);
    }
  }

  function removePeer(remoteSid) {
    const pc = pcs[remoteSid];
    if (pc) {
      try { pc.close(); } catch(e) {}
      delete pcs[remoteSid];
    }
    // clear interval if exists
    if (statsIntervals[remoteSid]) {
      clearInterval(statsIntervals[remoteSid]);
      delete statsIntervals[remoteSid];
    }
    const wrapper = document.getElementById('wrap_' + remoteSid);
    if (wrapper) wrapper.remove();
  }

  // --- Participants list utilities ---
  function addParticipant(id, opts = {}) {
    // opts: { label: string, self: bool }
    if (!participantsList) return;
    // Remove placeholder if present
    const placeholder = participantsList.querySelector('.placeholder');
    if (placeholder) placeholder.remove();

    // Avoid duplicate entry
    if (document.getElementById('part_' + id)) return;

    const li = document.createElement('li');
    li.id = 'part_' + id;
    const dot = document.createElement('span');
    dot.className = 'dot';
    li.appendChild(dot);

    const txt = document.createElement('div');
    txt.style.display = 'flex';
    txt.style.flexDirection = 'column';
    const title = document.createElement('strong');
    title.style.fontSize = '13px';
    title.innerText = opts.label || (id === 'you' ? 'You' : shortId(id));
    const sub = document.createElement('span');
    sub.style.fontSize = '12px';
    sub.style.color = 'rgba(230,238,248,0.6)';
    sub.innerText = opts.self ? 'Local' : 'Remote';
    txt.appendChild(title);
    txt.appendChild(sub);

    li.appendChild(txt);
    participantsList.appendChild(li);
  }

  function removeParticipant(id) {
    const el = document.getElementById('part_' + id);
    if (el) el.remove();
    // if list empty, add placeholder
    if (participantsList.children.length === 0) {
      const p = document.createElement('li');
      p.className = 'placeholder';
      p.innerText = 'No participants yet';
      participantsList.appendChild(p);
    }
  }

  function clearParticipants() {
    participantsList.innerHTML = '';
    const p = document.createElement('li');
    p.className = 'placeholder';
    p.innerText = 'No participants yet';
    participantsList.appendChild(p);
  }

  // --- small helpers ---
  function shortId(id) {
    if (!id) return '';
    return id.length > 8 ? id.slice(0,8) : id;
  }

  // --------- Basic stats per connection (optional) ----------
  const statsIntervals = {}; // map remoteSid -> interval

  function startStatsFor(remoteSid) {
    if (statsIntervals[remoteSid]) return;
    const pc = pcs[remoteSid];
    statsIntervals[remoteSid] = setInterval(async () => {
      if (!pc || pc.connectionState !== 'connected') return;
      const stats = await pc.getStats();
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
      rttEl.innerText = rttMs ? Math.round(rttMs) : '—';
      debugEl.innerText = `peer ${shortId(remoteSid)} inbound:${packetsReceived} lost:${packetsLost}`;
    }, 1000);
  }

});