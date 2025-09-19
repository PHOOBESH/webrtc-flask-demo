// static/main.js — integrated: transcription, summarizer, adaptation, smoothed attention, simulator
document.addEventListener('DOMContentLoaded', () => {
  const socket = io();
  const pcs = {};              // map: remoteSid -> RTCPeerConnection
  let localStream = null;
  let joined = false;
  let room = null;
  const statsIntervals = {};   // map remoteSid -> interval id
  let recorder = null;

  // ICE config: STUN + TURN (replace with your TURN provider for production)
  const config = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  };

  // DOM
  const joinBtn = document.getElementById('joinBtn');
  const leaveBtn = document.getElementById('leaveBtn');
  const roomInput = document.getElementById('roomInput');
  const localVideo = document.getElementById('localVideo');
  const remotesGrid = document.getElementById('remotesGrid');
  const participantsList = document.getElementById('participantsList');
  const rttEl = document.getElementById('rtt');
  const plEl = document.getElementById('pl');
  const debugEl = document.getElementById('debug');
  const transcriptBox = document.getElementById('transcriptBox');
  const summarizeBtn = document.getElementById('summarizeBtn');
  const summaryBox = document.getElementById('summaryBox');
  const netModeEl = document.getElementById('netMode');
  const attScoreEl = document.getElementById('attScore'); // not used visually now
  const localBadge = document.getElementById('localBadge');

  function clog(...a){ console.log('[APP]', ...a); debugEl.innerText = debugEl.innerText + a.join(' ') + '\n'; }

  // ---------- Network Simulator state ----------
  // netSim.enabled -> client forces mode; netSim.forcedMode (0..3) maps to normal/degrade/audio/captions
  const netSim = { enabled: false, forcedMode: null };

  // ---------- Socket handlers ----------
  socket.on('connect', () => {
    clog('socket connected', socket.id);
    joinBtn.disabled = false;
  });

  socket.on('existing-peers', (data) => {
    clog('existing peers', data.peers);
    if (Array.isArray(data.peers)) {
      data.peers.forEach(p => addParticipant(p));
    }
  });

  socket.on('new-peer', async (data) => {
    const newSid = data.peer;
    clog('new-peer -> create offer to', newSid);
    addParticipant(newSid);
    await createPeerAndOffer(newSid);
  });

  socket.on('offer', async (data) => {
    const from = data.from;
    const sdp = data.sdp;
    clog('offer received from', from);
    if (!pcs[from]) createPeerConnectionFor(from);
    const pc = pcs[from];
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (e) {
      clog('setRemoteDescription failed', e);
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

  socket.on('peer-left', (data) => {
    const sid = data.sid;
    clog('peer-left', sid);
    removePeer(sid);
    removeParticipant(sid);
  });

  // transcript updates from server
  socket.on('transcript-update', (data) => {
    const entry = data.entry;
    const p = document.createElement('p');
    const ts = entry.ts ? new Date(entry.ts * 1000) : new Date();
    p.innerText = `[${ts.toLocaleTimeString()}] ${entry.text}`;
    transcriptBox.appendChild(p);
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
  });

  socket.on('attention-update', (data) => {
    // we no longer spam logs; optionally show aggregated remote attention elsewhere
    // clog(`Attention from ${data.sid}: ${Math.round(data.score * 100)}%`);
  });

  // Join room
  joinBtn.onclick = async () => {
    if (joined) return;
    room = (roomInput.value || 'default').trim();

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
      localVideo.srcObject = localStream;
      leaveBtn.disabled = false;
      localBadge.innerText = 'Live';
      localBadge.classList.remove('muted');
    } catch (e) {
      alert('Camera/mic required: ' + e.message);
      return;
    }

    socket.emit('join', { room });
    joined = true;
    joinBtn.disabled = true;
    clog('joined', room);

    // Add local participant row
    addParticipant('you', { label: 'You', self: true });

    // Start streaming audio chunks for transcription
    startAudioStreaming();

    // Start smoothed attention
    startAttentionMeter();

    // start stats for existing peer connections when they appear (they'll call startStatsFor when connected)
  };

  // Leave room
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
    clearParticipants();
    transcriptBox.innerHTML = '';
    summaryBox.innerText = '';
    stopAudioStreaming();
    stopAttentionMeter();
    localBadge.innerText = 'Muted';
    localBadge.classList.add('muted');
  };

  // Peer connection helpers
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

  // Attach remote stream into a tile
  function attachRemoteStream(remoteSid, stream) {
    let wrapper = document.getElementById('wrap_' + remoteSid);
    let vid;
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = 'wrap_' + remoteSid;
      wrapper.className = 'video-tile';
      vid = document.createElement('video');
      vid.id = 'remote_' + remoteSid;
      vid.autoplay = true;
      vid.playsInline = true;
      wrapper.appendChild(vid);

      const footer = document.createElement('div');
      footer.className = 'tile-footer';
      const nameDiv = document.createElement('div');
      nameDiv.className = 'name';
      nameDiv.innerText = `Peer: ${shortId(remoteSid)}`;
      const metaDiv = document.createElement('div');
      metaDiv.className = 'meta';
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.innerText = 'Remote';
      metaDiv.appendChild(badge);

      footer.appendChild(nameDiv);
      footer.appendChild(metaDiv);
      wrapper.appendChild(footer);

      remotesGrid.appendChild(wrapper);
      addParticipant(remoteSid);
    } else {
      vid = document.getElementById('remote_' + remoteSid);
    }

    try {
      vid.srcObject = stream;
    } catch (e) {
      vid.src = URL.createObjectURL(stream);
    }
  }

  function removePeer(remoteSid) {
    const pc = pcs[remoteSid];
    if (pc) {
      try { pc.close(); } catch(e) {}
      delete pcs[remoteSid];
    }
    if (statsIntervals[remoteSid]) {
      clearInterval(statsIntervals[remoteSid]);
      delete statsIntervals[remoteSid];
    }
    const wrapper = document.getElementById('wrap_' + remoteSid);
    if (wrapper) wrapper.remove();
  }

  // Participants list utils
  function addParticipant(id, opts = {}) {
    if (!participantsList) return;
    const placeholder = participantsList.querySelector('.placeholder');
    if (placeholder) placeholder.remove();
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

  function shortId(id) {
    if (!id) return '';
    return id.length > 8 ? id.slice(0,8) : id;
  }

  // ---------- Stats & adaptation: start per peer (enhanced) ----------
  function startStatsFor(remoteSid) {
    if (statsIntervals[remoteSid]) return;
    const pc = pcs[remoteSid];
    statsIntervals[remoteSid] = setInterval(async () => {
      if (!pc || pc.connectionState !== 'connected') return;

      // If simulation active, skip reading stats and directly apply forced mode
      if (netSim.enabled && typeof netSim.forcedMode === 'number') {
        const modeMap = ['normal','degrade-video','audio-only','captions-only'];
        const mode = modeMap[netSim.forcedMode] || 'normal';
        document.getElementById('netMode').innerText = mode;
        enactLocalMode(mode);
        return;
      }

      try {
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
        const lossPct = packetsReceived + packetsLost ? Math.round((packetsLost / (packetsReceived + packetsLost)) * 10000)/100 : 0;
        plEl.innerText = lossPct ? lossPct + '%' : '—';
        // Call adaptation endpoint
        checkNetworkAdaptation(rttMs || 0, packetsLost / (packetsReceived + packetsLost + 0.001));
      } catch (e) {
        // ignore per-pc errors silently
      }
    }, 5000);
  }

  function enactLocalMode(mode) {
    if (!localStream) return;
    try {
      if (mode === 'degrade-video') {
        localStream.getVideoTracks().forEach(t => {
          try { t.applyConstraints({ frameRate: 10, height: 240 }); } catch(e) {}
        });
      } else if (mode === 'audio-only') {
        localStream.getVideoTracks().forEach(t => t.enabled = false);
      } else if (mode === 'captions-only') {
        localStream.getTracks().forEach(t => t.stop());
      } else {
        localStream.getVideoTracks().forEach(t => t.enabled = true);
      }
    } catch(e) {
      clog('enactLocalMode failed', e);
    }
  }

  // Adaptation backend call: /adapt
  async function checkNetworkAdaptation(rtt, packetLoss, bandwidth = 600) {
    try {
      const res = await fetch('/adapt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rtt, packetLoss, bandwidth })
      });
      if (!res.ok) return;
      const data = await res.json();
      netModeEl.innerText = data.mode || 'normal';
      // apply local policy (same as before)
      enactLocalMode(data.mode || 'normal');
    } catch (e) {
      console.warn('global adapt call failed', e);
    }
  }

  // ---------- Summarizer: POST /summarize ----------
  summarizeBtn.onclick = async () => {
    if (!room) return alert('Join a room first');
    summaryBox.innerText = 'Generating summary...';
    try {
      const res = await fetch('/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room })
      });
      if (!res.ok) {
        summaryBox.innerText = 'Summary failed';
        return;
      }
      const data = await res.json();
      const s = data.result && data.result.summary ? data.result.summary : (data.result || 'No summary');
      summaryBox.innerText = s;
    } catch (e) {
      summaryBox.innerText = 'Summary error: ' + e.message;
    }
  };

  // ---------- Attention (smoothed, low-frequency) ----------
  let attentionInterval = null;
  let audioContextRef = null;
  let analyserRef = null;
  let dataArrayRef = null;
  let emaAttention = 0.0; // exponential moving average
  const ATT_ALPHA = 0.18; // smoothing factor (lower = more stable)

  function startAttentionMeter() {
    try {
      audioContextRef = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioContextRef.createMediaStreamSource(localStream);
      const analyser = audioContextRef.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      analyserRef = analyser;
      const bufLen = analyser.frequencyBinCount;
      dataArrayRef = new Uint8Array(bufLen);

      // sampling loop using requestAnimationFrame to compute accurate RMS
      let sampleAccum = 0;
      let sampleCount = 0;
      const sampleLoop = () => {
        if (!analyserRef) return;
        analyserRef.getByteTimeDomainData(dataArrayRef);
        let sum = 0;
        for (let i = 0; i < dataArrayRef.length; i++){
          const v = (dataArrayRef[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / dataArrayRef.length);
        sampleAccum += rms;
        sampleCount++;
        requestAnimationFrame(sampleLoop);
      };
      sampleLoop();

      attentionInterval = setInterval(() => {
        if (sampleCount === 0) return;
        const avgRms = sampleAccum / sampleCount;
        sampleAccum = 0;
        sampleCount = 0;
        const rawScore = Math.max(0, Math.min(1, (avgRms - 0.01) * 2.4));
        emaAttention = ATT_ALPHA * rawScore + (1 - ATT_ALPHA) * emaAttention;
        const pct = Math.round(emaAttention * 100);
        const fill = document.getElementById('attMeterFill');
        const txt = document.getElementById('attScoreText');
        if (fill) fill.style.width = pct + '%';
        if (txt) txt.innerText = pct + '%';
        // send to server every 4s
        socket.emit('attention', { room, score: emaAttention });
      }, 4000);

      clog('Attention meter started (smoothed)');
    } catch (e) {
      clog('startAttentionMeter failed', e);
    }
  }

  function stopAttentionMeter() {
    if (attentionInterval) {
      clearInterval(attentionInterval);
      attentionInterval = null;
    }
    try { if (audioContextRef) audioContextRef.close(); } catch(e){}
    audioContextRef = analyserRef = dataArrayRef = null;
    emaAttention = 0;
    const fill = document.getElementById('attMeterFill');
    const txt = document.getElementById('attScoreText');
    if (fill) fill.style.width = '0%';
    if (txt) txt.innerText = '—';
    clog('Attention stopped');
  }

  // ---------- Audio streaming for transcription: MediaRecorder to server via socket.io "audio-chunk" ----------
  function startAudioStreaming() {
    if (!localStream) return;
    try {
      const audioStream = new MediaStream(localStream.getAudioTracks());
      recorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm' });
    } catch (e) {
      clog('MediaRecorder init failed', e);
      return;
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        const reader = new FileReader();
        reader.onload = () => {
          const b64 = reader.result.split(',')[1];
          socket.emit('audio-chunk', { room, b64, ts: Math.floor(Date.now()/1000) });
        };
        reader.readAsDataURL(e.data);
      }
    };

    recorder.onerror = (ev) => clog('recorder error', ev);
    recorder.start(3000); // emit every 3s
    clog('audio streaming started');
  }

  function stopAudioStreaming() {
    try {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      recorder = null;
      clog('audio streaming stopped');
    } catch (e) { clog('stopAudioStreaming err', e); }
  }

  // ---------- Client SpeechRecognition ----------
  function startClientSpeechRecognition() {
    if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) return;
    const SR = window.SpeechRecognition||window.webkitSpeechRecognition;
    const recog = new SR();
    recog.lang='en-US'; recog.continuous=true; recog.interimResults=true;
    recog.onresult = (evt) => {
      for (let i=evt.resultIndex;i<evt.results.length;i++){
        const res=evt.results[i];
        if(res.isFinal){
          const text=res[0].transcript.trim();
          const payload={ room, text, ts:Math.floor(Date.now()/1000) };
          socket.emit('transcript-text', payload);
          // append locally
          const p = document.createElement('p');
          const ts = new Date(payload.ts * 1000);
          p.innerText = `[${ts.toLocaleTimeString()}] ${payload.text}`;
          transcriptBox.appendChild(p);
          transcriptBox.scrollTop = transcriptBox.scrollHeight;
        }
      }
    };
    recog.onerror=(e)=>clog('SpeechRecog err', e);
    recog.onend=()=>{ try{recog.start();}catch(e){} };
    try{ recog.start(); }catch(e){ clog('SpeechRecog start failed', e); }
  }

  // ---------- Utility to stop everything & cleanup ----------
  function stopAll() {
    stopAudioStreaming();
    stopAttentionMeter();
    Object.keys(pcs).forEach(removePeer);
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
      localVideo.srcObject = null;
    }
    transcriptBox.innerHTML = '';
    summaryBox.innerText = '';
  }

  // Exported helpers (for debug)
  window._agamai = { pcs, stopAll };

  // ---------- Network Simulator UI wiring ----------
  const netSimRange = document.getElementById('netSimRange');
  const applySimBtn = document.getElementById('applySimBtn');
  const clearSimBtn = document.getElementById('clearSimBtn');

  applySimBtn.onclick = () => {
    const v = parseInt(netSimRange.value || '0', 10);
    netSim.enabled = true;
    netSim.forcedMode = v;
    const modeMap = ['normal','degrade-video','audio-only','captions-only'];
    const mode = modeMap[v] || 'normal';
    document.getElementById('netMode').innerText = mode;
    enactLocalMode(mode);
    clog('Network simulation applied mode=', mode);
  };

  clearSimBtn.onclick = () => {
    netSim.enabled = false;
    netSim.forcedMode = null;
    document.getElementById('netMode').innerText = 'auto';
    clog('Network simulation cleared (back to auto)');
  };

});
