// static/main.js — final integrated: transcription, summarizer, adaptation, attention
document.addEventListener('DOMContentLoaded', () => {
  const socket = io();
  const pcs = {};
  let localStream = null;
  let joined = false;
  let room = null;
  const statsIntervals = {};
  let recorder = null;
  let attentionInterval = null;

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

  // DOM refs
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
  const attScoreEl = document.getElementById('attScore');
  const localBadge = document.getElementById('localBadge');

  function clog(...a) {
    console.log('[APP]', ...a);
    debugEl.innerText += a.join(' ') + '\n';
  }

  // ---------- Socket Handlers ----------
  socket.on('connect', () => {
    clog('socket connected', socket.id);
    joinBtn.disabled = false;
  });

  socket.on('existing-peers', (data) => {
    if (Array.isArray(data.peers)) {
      data.peers.forEach(p => addParticipant(p));
    }
  });

  socket.on('new-peer', async (data) => {
    const newSid = data.peer;
    addParticipant(newSid);
    await createPeerAndOffer(newSid);
  });

  socket.on('offer', async (data) => {
    const from = data.from;
    const sdp = data.sdp;
    if (!pcs[from]) createPeerConnectionFor(from);
    const pc = pcs[from];
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      if (!localStream) {
        localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
        localVideo.srcObject = localStream;
      }
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { to: from, sdp: pc.localDescription });
    } catch (e) { clog('offer handling failed', e); }
  });

  socket.on('answer', async (data) => {
    const pc = pcs[data.from];
    if (pc) {
      try { await pc.setRemoteDescription(new RTCSessionDescription(data.sdp)); }
      catch (e) { clog('answer setRemoteDescription failed', e); }
    }
  });

  socket.on('ice-candidate', async (data) => {
    const pc = pcs[data.from];
    if (pc && data.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); }
      catch (e) { clog('addIceCandidate failed', e); }
    }
  });

  socket.on('peer-left', (data) => {
    removePeer(data.sid);
    removeParticipant(data.sid);
  });

  socket.on('transcript-update', (data) => {
    appendTranscript(data.entry);
  });

  socket.on('attention-update', (data) => {
    clog(`Attention from ${data.sid}: ${Math.round(data.score * 100)}%`);
  });

  // ---------- Join / Leave ----------
  joinBtn.onclick = async () => {
    if (joined) return;
    room = (roomInput.value || 'default').trim();
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
      localVideo.srcObject = localStream;
      localBadge.innerText = 'Live';
    } catch (e) { return alert('Camera/mic required: ' + e.message); }

    socket.emit('join', { room });
    joined = true;
    joinBtn.disabled = true;
    leaveBtn.disabled = false;
    addParticipant('you', { label: 'You', self: true });
    startAudioStreaming();
    startClientSpeechRecognition();
    startAttentionMeter();
  };

  leaveBtn.onclick = () => {
    if (!joined) return;
    socket.emit('leave', { room });
    Object.keys(pcs).forEach(removePeer);
    if (localStream) localStream.getTracks().forEach(t => t.stop());
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
  };

  // ---------- Peer Helpers ----------
  function createPeerConnectionFor(remoteSid) {
    const pc = new RTCPeerConnection(config);
    pcs[remoteSid] = pc;
    pc.onicecandidate = (ev) => {
      if (ev.candidate) socket.emit('ice-candidate', { to: remoteSid, candidate: ev.candidate });
    };
    pc.ontrack = (ev) => attachRemoteStream(remoteSid, ev.streams[0]);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') startStatsFor(remoteSid);
      if (['disconnected','failed','closed'].includes(pc.connectionState)) {
        removePeer(remoteSid);
        removeParticipant(remoteSid);
      }
    };
    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    return pc;
  }

  async function createPeerAndOffer(targetSid) {
    const pc = createPeerConnectionFor(targetSid);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: targetSid, sdp: pc.localDescription });
    } catch (e) { clog('Offer error', e); }
  }

  function attachRemoteStream(remoteSid, stream) {
    let vid = document.getElementById('remote_' + remoteSid);
    if (!vid) {
      const wrapper = document.createElement('div');
      wrapper.id = 'wrap_' + remoteSid;
      wrapper.className = 'video-tile';
      vid = document.createElement('video');
      vid.id = 'remote_' + remoteSid;
      vid.autoplay = true; vid.playsInline = true;
      wrapper.appendChild(vid);
      remotesGrid.appendChild(wrapper);
      addParticipant(remoteSid);
    }
    vid.srcObject = stream;
  }

  function removePeer(remoteSid) {
    if (pcs[remoteSid]) { try { pcs[remoteSid].close(); } catch(e){} delete pcs[remoteSid]; }
    if (statsIntervals[remoteSid]) { clearInterval(statsIntervals[remoteSid]); delete statsIntervals[remoteSid]; }
    const wrapper = document.getElementById('wrap_' + remoteSid);
    if (wrapper) wrapper.remove();
  }

  // ---------- Transcript & Summary ----------
  function appendTranscript(entry) {
    const p = document.createElement('p');
    const ts = entry.ts ? new Date(entry.ts * 1000) : new Date();
    p.innerText = `[${ts.toLocaleTimeString()}] ${entry.text}`;
    transcriptBox.appendChild(p);
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
  }

  summarizeBtn.onclick = async () => {
    if (!room) return alert('Join a room first');
    summaryBox.innerText = 'Generating summary...';
    try {
      const res = await fetch('/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room })
      });
      const data = await res.json();
      summaryBox.innerText = data.result?.summary || data.result || 'No summary';
    } catch (e) { summaryBox.innerText = 'Summary error: ' + e.message; }
  };

  // ---------- Attention ----------
  function startAttentionMeter() {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(localStream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      attentionInterval = setInterval(() => {
        analyser.getByteTimeDomainData(dataArray);
        let sum = 0; for (let i=0;i<dataArray.length;i++){ const v=(dataArray[i]-128)/128; sum+=v*v; }
        const rms = Math.sqrt(sum / dataArray.length);
        const score = Math.min(1, Math.max(0, (rms-0.02)*2));
        attScoreEl.innerText = Math.round(score*100) + '%';
        socket.emit('attention', { room, score });
      }, 3000);
    } catch(e){ clog('Attention meter failed', e); }
  }
  function stopAttentionMeter(){ if(attentionInterval) clearInterval(attentionInterval); }

  // ---------- Network Adaptation ----------
  function startStatsFor(remoteSid) {
    if (statsIntervals[remoteSid]) return;
    const pc = pcs[remoteSid];
    statsIntervals[remoteSid] = setInterval(async () => {
      if (!pc || pc.connectionState !== 'connected') return;
      const stats = await pc.getStats();
      let rttMs=0, rec=0, lost=0;
      stats.forEach(r => {
        if (r.type==='candidate-pair' && (r.state==='succeeded'||r.selected)) {
          if (r.currentRoundTripTime) rttMs = r.currentRoundTripTime*1000;
        }
        if (r.type==='inbound-rtp' && r.kind==='video') {
          rec += r.packetsReceived||0; lost += r.packetsLost||0;
        }
      });
      rttEl.innerText = rttMs?Math.round(rttMs):'—';
      const loss = rec+lost? lost/(rec+lost):0;
      plEl.innerText = loss? Math.round(loss*100)+'%':'—';
      checkNetworkAdaptation(rttMs, loss);
    }, 5000);
  }

  async function checkNetworkAdaptation(rtt, packetLoss, bandwidth=600) {
    try {
      const res = await fetch('/adapt', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ rtt, packetLoss, bandwidth })
      });
      const data = await res.json();
      netModeEl.innerText = data.mode || 'normal';
      if (!localStream) return;
      if (data.mode==='degrade-video') {
        localStream.getVideoTracks().forEach(t => t.applyConstraints({frameRate:10,height:240}));
      } else if (data.mode==='audio-only') {
        localStream.getVideoTracks().forEach(t => t.enabled=false);
      } else if (data.mode==='captions-only') {
        localStream.getTracks().forEach(t => t.stop());
      } else {
        localStream.getVideoTracks().forEach(t => t.enabled=true);
      }
    } catch(e){ clog('adaptation error', e); }
  }

  // ---------- Audio Streaming ----------
  function startAudioStreaming() {
    if (!localStream) return;
    try {
      const audioStream = new MediaStream(localStream.getAudioTracks());
      recorder = new MediaRecorder(audioStream, { mimeType:'audio/webm' });
    } catch(e){ return clog('MediaRecorder init failed', e); }
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size>0) {
        const reader = new FileReader();
        reader.onload = () => {
          const b64 = reader.result.split(',')[1];
          socket.emit('audio-chunk', { room, b64, ts: Math.floor(Date.now()/1000) });
        };
        reader.readAsDataURL(e.data);
      }
    };
    recorder.start(3000);
  }
  function stopAudioStreaming(){ if(recorder&&recorder.state!=='inactive') recorder.stop(); }

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
          appendTranscript(payload);
        }
      }
    };
    recog.onerror=(e)=>clog('SpeechRecog err', e);
    recog.onend=()=>{ try{recog.start();}catch(e){} };
    try{ recog.start(); }catch(e){ clog('SpeechRecog start failed', e); }
  }

  // ---------- Participants UI ----------
  function addParticipant(id, opts={}) {
    if (!participantsList) return;
    if (document.getElementById('part_'+id)) return;
    const li=document.createElement('li'); li.id='part_'+id;
    li.innerText=opts.label|| (id==='you'?'You':shortId(id));
    participantsList.appendChild(li);
  }
  function removeParticipant(id){ const el=document.getElementById('part_'+id); if(el) el.remove(); }
  function clearParticipants(){ participantsList.innerHTML='<li class="placeholder">No participants</li>'; }
  function shortId(id){ return id? id.slice(0,8):''; }

  window._app={pcs, stopAll:()=>{stopAudioStreaming();stopAttentionMeter();}};
});
