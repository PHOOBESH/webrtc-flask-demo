// static/main.js - Enhanced multi-party WebRTC with all features
document.addEventListener('DOMContentLoaded', () => {
  const socket = io();
  const pcs = {};              // map: remoteSid -> RTCPeerConnection
  let localStream = null;
  let joined = false;
  let room = null;
  const statsIntervals = {};   // map remoteSid -> interval id
  let recorder = null;
  let speechRecognition = null;
  let isRecording = false;

  // ICE config with multiple STUN/TURN servers for better connectivity
  const config = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ],
    iceCandidatePoolSize: 10
  };

  // DOM elements
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
  const localBadge = document.getElementById('localBadge');

  // Enhanced logging with timestamps
  function clog(...args) { 
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}]`, ...args); 
    if (debugEl) {
      debugEl.innerText += `[${timestamp}] ${args.join(' ')}\n`;
      debugEl.scrollTop = debugEl.scrollHeight;
    }
  }

  // Network simulation state
  const netSim = { enabled: false, forcedMode: null };

  // Connection quality tracking
  let connectionQuality = {
    rtt: 0,
    packetLoss: 0,
    bandwidth: 0,
    score: 100
  };

  // ---------- Socket Event Handlers ----------
  socket.on('connect', () => {
    clog('Socket connected:', socket.id);
    joinBtn.disabled = false;
    updateConnectionStatus('connected');
  });

  socket.on('disconnect', () => {
    clog('Socket disconnected');
    updateConnectionStatus('disconnected');
  });

  socket.on('existing-peers', (data) => {
    clog('Existing peers:', data.peers);
    if (Array.isArray(data.peers)) {
      data.peers.forEach(peer => {
        addParticipant(peer);
        clog(`Added existing participant: ${shortId(peer)}`);
      });
    }
  });

  socket.on('new-peer', async (data) => {
    const newSid = data.peer;
    clog('New peer joined:', shortId(newSid));
    addParticipant(newSid);
    await createPeerAndOffer(newSid);
  });

  socket.on('offer', async (data) => {
    const from = data.from;
    const sdp = data.sdp;
    clog('Received offer from:', shortId(from));
    
    if (!pcs[from]) {
      createPeerConnectionFor(from);
    }
    
    const pc = pcs[from];
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      
      // Ensure local stream is ready
      await ensureLocalStream();
      
      // Add local tracks if not already added
      addLocalTracksToConnection(pc);
      
      // Create and send answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { to: from, sdp: pc.localDescription });
      clog('Sent answer to:', shortId(from));
      
    } catch (e) {
      clog('Error handling offer:', e.message);
    }
  });

  socket.on('answer', async (data) => {
    const from = data.from;
    const sdp = data.sdp;
    clog('Received answer from:', shortId(from));
    
    const pc = pcs[from];
    if (pc) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      } catch (e) {
        clog('Error setting remote description (answer):', e.message);
      }
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
        clog('Error adding ICE candidate:', e.message);
      }
    }
  });

  socket.on('peer-left', (data) => {
    const sid = data.sid;
    clog('Peer left:', shortId(sid));
    removePeer(sid);
    removeParticipant(sid);
  });

  socket.on('transcript-update', (data) => {
    const entry = data.entry;
    addTranscriptEntry(entry);
  });

  socket.on('attention-update', (data) => {
    updateParticipantAttention(data.sid, data.score);
  });

  // ---------- Main Functions ----------
  
  async function ensureLocalStream() {
    if (!localStream) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ 
          video: { 
            width: { ideal: 1280 }, 
            height: { ideal: 720 },
            frameRate: { ideal: 30 }
          }, 
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        localVideo.srcObject = localStream;
        localBadge.innerText = 'Live';
        localBadge.classList.remove('muted');
        clog('Local stream acquired successfully');
      } catch (e) {
        clog('Error getting user media:', e.message);
        throw e;
      }
    }
    return localStream;
  }

  // Join room functionality
  joinBtn.onclick = async () => {
    if (joined) return;
    
    room = (roomInput.value || 'default').trim();
    clog(`Attempting to join room: ${room}`);

    try {
      await ensureLocalStream();
      
      socket.emit('join', { room });
      joined = true;
      joinBtn.disabled = true;
      leaveBtn.disabled = false;
      roomInput.disabled = true;
      
      clog('Successfully joined room:', room);

      // Add local participant
      addParticipant('you', { label: 'You', self: true });

      // Start all monitoring services
      startAudioStreaming();
      startAttentionMeter();
      startSpeechRecognition();
      
    } catch (e) {
      clog('Failed to join room:', e.message);
      alert('Camera/microphone access required: ' + e.message);
    }
  };

  // Leave room functionality
  leaveBtn.onclick = () => {
    if (!joined) return;
    
    clog('Leaving room:', room);
    socket.emit('leave', { room });
    
    // Cleanup everything
    cleanup();
    
    joined = false;
    joinBtn.disabled = false;
    leaveBtn.disabled = true;
    roomInput.disabled = false;
  };

  function cleanup() {
    // Stop all peer connections
    Object.keys(pcs).forEach(removePeer);
    
    // Stop local stream
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
      localVideo.srcObject = null;
    }
    
    // Clear UI
    clearParticipants();
    clearTranscript();
    summaryBox.innerText = '';
    
    // Stop services
    stopAudioStreaming();
    stopAttentionMeter();
    stopSpeechRecognition();
    
    // Reset badges
    localBadge.innerText = 'Muted';
    localBadge.classList.add('muted');
    netModeEl.innerText = 'auto';
    
    clog('Cleanup completed');
  }

  // ---------- WebRTC Peer Connection Management ----------
  
  function createPeerConnectionFor(remoteSid) {
    if (pcs[remoteSid]) {
      pcs[remoteSid].close();
    }
    
    const pc = new RTCPeerConnection(config);
    pcs[remoteSid] = pc;
    
    clog('Created peer connection for:', shortId(remoteSid));

    // Set up event handlers
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', { 
          to: remoteSid, 
          candidate: event.candidate 
        });
      }
    };

    pc.ontrack = (event) => {
      clog('Received remote track from:', shortId(remoteSid));
      attachRemoteStream(remoteSid, event.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      clog(`Connection state changed for ${shortId(remoteSid)}: ${state}`);
      
      updateParticipantStatus(remoteSid, state);
      
      if (state === 'connected') {
        startStatsFor(remoteSid);
      } else if (['disconnected', 'failed', 'closed'].includes(state)) {
        removePeer(remoteSid);
        removeParticipant(remoteSid);
      }
    };

    pc.oniceconnectionstatechange = () => {
      clog(`ICE connection state for ${shortId(remoteSid)}: ${pc.iceConnectionState}`);
    };

    // Add local tracks if available
    addLocalTracksToConnection(pc);

    return pc;
  }

  function addLocalTracksToConnection(pc) {
    if (localStream) {
      const existingSenders = pc.getSenders().map(sender => sender.track);
      
      localStream.getTracks().forEach(track => {
        if (!existingSenders.includes(track)) {
          pc.addTrack(track, localStream);
          clog('Added local track:', track.kind);
        }
      });
    }
  }

  async function createPeerAndOffer(targetSid) {
    const pc = createPeerConnectionFor(targetSid);
    
    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: targetSid, sdp: pc.localDescription });
      clog('Sent offer to:', shortId(targetSid));
      
    } catch (e) {
      clog('Error creating/sending offer:', e.message);
    }
  }

  function attachRemoteStream(remoteSid, stream) {
    let wrapper = document.getElementById('wrap_' + remoteSid);
    
    if (!wrapper) {
      wrapper = createVideoTile(remoteSid, stream);
      remotesGrid.appendChild(wrapper);
    }
    
    const video = wrapper.querySelector('video');
    if (video) {
      video.srcObject = stream;
      clog('Attached remote stream for:', shortId(remoteSid));
    }
  }

  function createVideoTile(remoteSid, stream) {
    const wrapper = document.createElement('div');
    wrapper.id = 'wrap_' + remoteSid;
    wrapper.className = 'video-tile';
    
    const video = document.createElement('video');
    video.id = 'remote_' + remoteSid;
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;
    
    const footer = document.createElement('div');
    footer.className = 'tile-footer';
    
    const nameDiv = document.createElement('div');
    nameDiv.className = 'name';
    nameDiv.innerText = `Peer ${shortId(remoteSid)}`;
    
    const metaDiv = document.createElement('div');
    metaDiv.className = 'meta';
    
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.id = `badge_${remoteSid}`;
    badge.innerText = 'Connecting...';
    
    metaDiv.appendChild(badge);
    footer.appendChild(nameDiv);
    footer.appendChild(metaDiv);
    wrapper.appendChild(video);
    wrapper.appendChild(footer);
    
    return wrapper;
  }

  function removePeer(remoteSid) {
    const pc = pcs[remoteSid];
    if (pc) {
      pc.close();
      delete pcs[remoteSid];
    }
    
    // Clear stats interval
    if (statsIntervals[remoteSid]) {
      clearInterval(statsIntervals[remoteSid]);
      delete statsIntervals[remoteSid];
    }
    
    // Remove video tile
    const wrapper = document.getElementById('wrap_' + remoteSid);
    if (wrapper) {
      wrapper.remove();
    }
    
    clog('Removed peer:', shortId(remoteSid));
  }

  // ---------- Statistics and Network Adaptation ----------
  
  function startStatsFor(remoteSid) {
    if (statsIntervals[remoteSid]) return;
    
    const pc = pcs[remoteSid];
    if (!pc) return;
    
    statsIntervals[remoteSid] = setInterval(async () => {
      if (!pc || pc.connectionState !== 'connected') return;

      // Handle network simulation
      if (netSim.enabled && typeof netSim.forcedMode === 'number') {
        const modeMap = ['normal', 'degrade-video', 'audio-only', 'captions-only'];
        const mode = modeMap[netSim.forcedMode] || 'normal';
        netModeEl.innerText = mode;
        enactLocalMode(mode);
        return;
      }

      try {
        const stats = await pc.getStats();
        const metrics = parseWebRTCStats(stats);
        
        // Update UI
        rttEl.innerText = metrics.rtt ? Math.round(metrics.rtt) : '—';
        plEl.innerText = metrics.packetLoss ? (metrics.packetLoss * 100).toFixed(1) + '%' : '—';
        
        // Update connection quality
        connectionQuality = {
          rtt: metrics.rtt || 0,
          packetLoss: metrics.packetLoss || 0,
          bandwidth: metrics.bandwidth || 1000,
          score: calculateQualityScore(metrics)
        };
        
        // Call adaptation service
        await checkNetworkAdaptation(metrics);
        
      } catch (e) {
        clog('Error getting stats for', shortId(remoteSid), ':', e.message);
      }
    }, 5000);
  }

  function parseWebRTCStats(stats) {
    let rtt = null;
    let packetsReceived = 0;
    let packetsLost = 0;
    let bytesReceived = 0;
    let timestamp = 0;
    
    stats.forEach(report => {
      if (report.type === 'candidate-pair' && (report.state === 'succeeded' || report.selected)) {
        if (report.currentRoundTripTime) {
          rtt = report.currentRoundTripTime * 1000;
        }
      }
      
      if (report.type === 'inbound-rtp' && report.kind === 'video') {
        packetsReceived = report.packetsReceived || 0;
        packetsLost = report.packetsLost || 0;
        bytesReceived = report.bytesReceived || 0;
        timestamp = report.timestamp || 0;
      }
    });
    
    const packetLoss = (packetsReceived + packetsLost) > 0 ? 
      packetsLost / (packetsReceived + packetsLost) : 0;
      
    // Estimate bandwidth (rough calculation)
    const bandwidth = timestamp > 0 ? (bytesReceived * 8) / (timestamp / 1000) / 1000 : 1000;
    
    return { rtt, packetLoss, bandwidth };
  }

  function calculateQualityScore(metrics) {
    const rttScore = Math.max(0, 100 - (metrics.rtt || 0) / 5);
    const lossScore = Math.max(0, 100 - (metrics.packetLoss || 0) * 500);
    const bwScore = Math.min(100, (metrics.bandwidth || 0) / 10);
    
    return (rttScore * 0.3 + lossScore * 0.4 + bwScore * 0.3);
  }

  async function checkNetworkAdaptation(metrics) {
    try {
      const response = await fetch('/adapt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rtt: metrics.rtt || 0,
          packetLoss: metrics.packetLoss || 0,
          bandwidth: metrics.bandwidth || 1000
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        netModeEl.innerText = data.mode || 'normal';
        enactLocalMode(data.mode || 'normal');
      }
    } catch (e) {
      clog('Network adaptation request failed:', e.message);
    }
  }

  function enactLocalMode(mode) {
    if (!localStream) return;
    
    try {
      const videoTracks = localStream.getVideoTracks();
      const audioTracks = localStream.getAudioTracks();
      
      switch (mode) {
        case 'degrade-video':
          videoTracks.forEach(track => {
            track.enabled = true;
            track.applyConstraints({ 
              frameRate: 15, 
              width: 640, 
              height: 480 
            }).catch(e => clog('Failed to degrade video:', e.message));
          });
          audioTracks.forEach(track => track.enabled = true);
          break;
          
        case 'audio-only':
          videoTracks.forEach(track => track.enabled = false);
          audioTracks.forEach(track => track.enabled = true);
          break;
          
        case 'captions-only':
          videoTracks.forEach(track => track.enabled = false);
          audioTracks.forEach(track => track.enabled = false);
          break;
          
        default: // 'normal'
          videoTracks.forEach(track => track.enabled = true);
          audioTracks.forEach(track => track.enabled = true);
          break;
      }
    } catch (e) {
      clog('Error applying mode:', mode, e.message);
    }
  }

  // ---------- Audio Streaming for Transcription ----------
  
  function startAudioStreaming() {
    if (!localStream || isRecording) return;
    
    try {
      const audioStream = new MediaStream(localStream.getAudioTracks());
      recorder = new MediaRecorder(audioStream, { 
        mimeType: 'audio/webm;codecs=opus',
        audioBitsPerSecond: 16000
      });
      
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = reader.result.split(',')[1];
            socket.emit('audio-chunk', { 
              room, 
              b64: base64, 
              ts: Math.floor(Date.now() / 1000) 
            });
          };
          reader.readAsDataURL(event.data);
        }
      };
      
      recorder.onerror = (event) => {
        clog('Audio recorder error:', event.error);
      };
      
      recorder.start(3000); // 3-second chunks
      isRecording = true;
      clog('Audio streaming started');
      
    } catch (e) {
      clog('Failed to start audio streaming:', e.message);
    }
  }

  function stopAudioStreaming() {
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
      recorder = null;
      isRecording = false;
      clog('Audio streaming stopped');
    }
  }

  // ---------- Speech Recognition (Client-side) ----------
  
  function startSpeechRecognition() {
    if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
      clog('Speech recognition not supported');
      return;
    }
    
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    speechRecognition = new SpeechRecognition();
    
    speechRecognition.continuous = true;
    speechRecognition.interimResults = true;
    speechRecognition.lang = 'en-US';
    
    speechRecognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          const text = result[0].transcript.trim();
          if (text) {
            const entry = {
              room,
              text,
              ts: Math.floor(Date.now() / 1000)
            };
            socket.emit('transcript-text', entry);
            addTranscriptEntry({ ts: entry.ts, text: entry.text });
          }
        }
      }
    };
    
    speechRecognition.onerror = (event) => {
      clog('Speech recognition error:', event.error);
      if (event.error === 'not-allowed') {
        clog('Microphone permission denied for speech recognition');
      }
    };
    
    speechRecognition.onend = () => {
      if (joined && speechRecognition) {
        try {
          speechRecognition.start();
        } catch (e) {
          clog('Failed to restart speech recognition:', e.message);
        }
      }
    };
    
    try {
      speechRecognition.start();
      clog('Speech recognition started');
    } catch (e) {
      clog('Failed to start speech recognition:', e.message);
    }
  }

  function stopSpeechRecognition() {
    if (speechRecognition) {
      speechRecognition.stop();
      speechRecognition = null;
      clog('Speech recognition stopped');
    }
  }
  let attentionInterval = null;
  let audioContext = null;
  let analyser = null;
  let dataArray = null;
  let emaAttention = 0.5; // exponential moving average

  function startAttentionMeter() {
    if (!localStream) return;

    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(localStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;

      source.connect(analyser);
      dataArray = new Uint8Array(analyser.frequencyBinCount);

      attentionInterval = setInterval(() => {
        analyser.getByteTimeDomainData(dataArray);

        // Root Mean Square energy
        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const normalized = (dataArray[i] - 128) / 128;
          sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / dataArray.length);

        // update EMA for smoother score
        const instant = Math.min(1, rms * 5);
        emaAttention = 0.8 * emaAttention + 0.2 * instant;

        const score = Math.round(emaAttention * 100);

        // Emit to server once every 5s
        socket.emit('attention-score', { room, score });

        // Update UI (local only)
        updateParticipantAttention('you', score);

      }, 5000); // every 5s

      clog('Attention meter started');
    } catch (e) {
      clog('Failed to start attention meter:', e.message);
    }
  }

  function stopAttentionMeter() {
    if (attentionInterval) {
      clearInterval(attentionInterval);
      attentionInterval = null;
    }
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
    analyser = null;
    dataArray = null;
    emaAttention = 0.5;
    clog('Attention meter stopped');
  }

  // ---------- UI Helpers ----------
  function addTranscriptEntry(entry) {
    const p = document.createElement('p');
    const ts = entry.ts ? new Date(entry.ts * 1000) : new Date();
    p.innerText = `[${ts.toLocaleTimeString()}] ${entry.text}`;
    transcriptBox.appendChild(p);
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
  }

  function updateParticipantAttention(sid, score) {
    const el = document.getElementById('part_' + sid);
    if (el) {
      let badge = el.querySelector('.attention-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'attention-badge';
        el.appendChild(badge);
      }
      badge.innerText = `🎤 ${score}%`;
    }
  }

  function updateConnectionStatus(status) {
    const el = document.getElementById('connectionStatus');
    if (el) {
      el.innerText = `Status: ${status}`;
    }
  }

  function clearTranscript() {
    transcriptBox.innerHTML = '';
  }

  // ---------- Network Simulation UI ----------
  const netSimSlider = document.getElementById('netSimSlider');
  if (netSimSlider) {
    netSimSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      if (val >= 0 && val <= 3) {
        netSim.enabled = true;
        netSim.forcedMode = val;
        const modeMap = ['normal', 'degrade-video', 'audio-only', 'captions-only'];
        const mode = modeMap[val] || 'normal';
        netModeEl.innerText = `(Simulated) ${mode}`;
        enactLocalMode(mode);
        clog('Simulating network mode:', mode);
      }
    });
  }
});
