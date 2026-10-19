'use strict';
/* Ζωντανή κλήση με Gemini Live API: ροή ήχου, διακοπή, μεταγραφή.
   Φορτώνεται μετά το app.js και χρησιμοποιεί τις καθολικές μεταβλητές του (DB, $, chat, convo, ...). */

const LIVE_MODEL = 'models/gemini-3.8-live';
const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const LIVE = {
  on:false, ready:false, retries:0,
  ws:null, stream:null, inCtx:null, proc:null,
  outCtx:null, nextAt:0, playing:[],
  userEl:null, aiEl:null, userTxt:'', aiTxt:''
};

function liveToggle(){ if(LIVE.on) liveStop(); else liveStart(); }
$('#btnLive').onclick = liveToggle;

function liveStart(){
  if(!DB.settings.keys.gemini){
    openSettings(); toast('Βάλε πρώτα το Gemini key στις Ρυθμίσεις για τη ζωντανή κλήση'); return;
  }
  // Όλα τα ηχητικά αντικείμενα δημιουργούνται συγχρονα μέσα στο πάτημα, αλλιώς το iOS δεν τα ενεργοποιεί.
  if(call.active) endCall();
  stopSpeech(); abortListen(); setState('idle');
  unlockAudio();
  try{
    LIVE.outCtx = new (window.AudioContext || window.webkitAudioContext)();
    LIVE.outCtx.resume && LIVE.outCtx.resume();
  }catch(e){ toast('Ο browser δεν υποστηρίζει ήχο: ' + e.message); return; }
  if(chat.querySelector('.empty')) chat.innerHTML = '';
  LIVE.on = true; LIVE.ready = false; LIVE.retries = 0; LIVE.nextAt = 0;
  LIVE.userEl = LIVE.aiEl = null; LIVE.userTxt = LIVE.aiTxt = '';
  $('#btnLive').classList.add('on');
  $('#hint').textContent = 'Συνδέομαι…';
  navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}})
    .then(stream => {
      if(!LIVE.on){ stream.getTracks().forEach(t => t.stop()); return; }
      LIVE.stream = stream;
      liveConnect();
      lockScreen();
    })
    .catch(() => { toast('Δεν έχω άδεια μικροφώνου. Έλεγξε Ρυθμίσεις iPhone → Safari → Μικρόφωνο.'); liveStop(); });
}

function liveConnect(){
  const ws = new WebSocket(LIVE_URL + '?key=' + encodeURIComponent(DB.settings.keys.gemini));
  LIVE.ws = ws; LIVE.ready = false;
  ws.onopen = () => {
    ws.send(JSON.stringify({setup:{
      model: LIVE_MODEL,
      generationConfig:{responseModalities:['AUDIO']},
      systemInstruction:{parts:[{text: liveSystem()}]},
      inputAudioTranscription:{},
      outputAudioTranscription:{}
    }}));
  };
  ws.onmessage = e => liveMsg(e.data);
  ws.onclose = ev => liveClosed(ev, ws);
}

function liveSystem(){
  return replyPrompt() + '\n' + [
    'This is a live voice conversation. The learner sees a live transcript of what they say and of what you say.',
    'Turn pattern: react in one short sentence to the learner\'s answer, then ask exactly ONE new question and stop talking. Wait for the answer. Never ask two questions in one turn and never monologue.',
    'Keep every turn under 3 sentences. Do not read out corrections, a separate analysis shows them on screen after each answer.',
    'Keep the questions flowing from one to the next, so the learner always has something to answer.'
  ].join('\n');
}

async function liveMsg(raw){
  let m;
  try{ m = JSON.parse(typeof raw === 'string' ? raw : await raw.text()); }catch(e){ return; }
  if(m.setupComplete){
    LIVE.ready = true; LIVE.retries = 0;
    liveStartMic();
    liveSendText('[START]');
    $('#hint').textContent = 'Μίλα — είμαι εδώ';
    return;
  }
  if(m.error){ toast('Σφάλμα: ' + (m.error.message || 'άγνωστο')); return; }
  const sc = m.serverContent;
  if(!sc) return;
  if(sc.interrupted) liveFlush();
  if(sc.inputTranscription && sc.inputTranscription.text) liveUser(sc.inputTranscription.text);
  if(sc.outputTranscription && sc.outputTranscription.text) liveAI(sc.outputTranscription.text);
  for(const p of (sc.modelTurn && sc.modelTurn.parts) || []){
    if(p.inlineData && p.inlineData.data) livePlay(p.inlineData);
  }
  if(sc.turnComplete) liveTurnDone();
}

/* ---------- μεταγραφή και φυσαλίδες ---------- */
function liveUser(t){
  if(!LIVE.userEl){
    LIVE.userEl = document.createElement('div'); LIVE.userEl.className = 'msg me';
    chat.appendChild(LIVE.userEl);
  }
  LIVE.userTxt += t;
  LIVE.userEl.textContent = LIVE.userTxt;
  scrollDown();
}
function liveAI(t){
  if(!LIVE.aiEl){
    const el = document.createElement('div');
    el.className = 'msg ai' + (DB.settings.hideAI ? ' blur' : '');
    el.innerHTML = '<span class="t"></span><button class="replay" aria-label="Replay">🔊</button>';
    el.onclick = e => {
      const txt = el.dataset.text || '';
      if(e.target.classList.contains('replay')){ speak(txt); return; }
      if(el.classList.contains('blur')){ el.classList.remove('blur'); return; }
      if(e.target.classList.contains('w')) lookup(e.target.textContent, txt);
    };
    chat.appendChild(el);
    LIVE.aiEl = el;
  }
  LIVE.aiTxt += t;
  LIVE.aiEl.querySelector('.t').textContent = LIVE.aiTxt;
  scrollDown();
}

async function liveTurnDone(){
  const u = LIVE.userTxt.trim(), a = LIVE.aiTxt.trim();
  const userEl = LIVE.userEl, aiEl = LIVE.aiEl;
  LIVE.userEl = LIVE.aiEl = null; LIVE.userTxt = LIVE.aiTxt = '';
  if(aiEl && a){
    aiEl.dataset.text = a;
    aiEl.querySelector('.t').innerHTML = wordify(a);
    if(!aiEl.querySelector('.replay')) aiEl.insertAdjacentHTML('beforeend', '<button class="replay">🔊</button>');
  }
  if(!u && !a) return;
  if(u){ convo.push({role:'user', content:u}); }
  if(a){ convo.push({role:'assistant', content:a}); }
  if(u){
    const k = todayKey(), before = DB.days[k] || 0;
    DB.days[k] = before + 1; save(); renderProgress();
    try{
      const out = await liveAnalyze(u, a);
      if(out && userEl) showAnalysis(userEl, aiEl, out);
    }catch(e){ console.warn('live analysis failed', e); }
  }
}

// Διορθώσεις: χρησιμοποιεί τον πάροχο που έχεις επιλέξει, αλλιώς Gemini (που ήδη έχει key).
async function liveAnalyze(userText, reply){
  const p = hasKey() ? DB.settings.provider : 'gemini';
  const content = 'Learner\'s latest message: "' + userText + '"\nCoach\'s reply: "' + reply + '"';
  const raw = await callProv(p, DB.settings.keys[p], modelFor(p, true), analysisPrompt(), [{role:'user', content}], 600);
  return parseAnalysis(raw);
}

/* ---------- είσοδος ήχου (μικρόφωνο → PCM 16 kHz) ---------- */
function liveStartMic(){
  if(!LIVE.stream || LIVE.inCtx) return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  LIVE.inCtx = ctx;
  ctx.resume && ctx.resume();
  const src = ctx.createMediaStreamSource(LIVE.stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const ratio = ctx.sampleRate / 16000;
  proc.onaudioprocess = e => {
    if(!LIVE.ws || LIVE.ws.readyState !== 1 || !LIVE.ready) return;
    const input = e.inputBuffer.getChannelData(0);
    const n = Math.floor(input.length / ratio);
    const pcm = new Int16Array(n);
    for(let i = 0; i < n; i++){
      const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    LIVE.ws.send(JSON.stringify({realtimeInput:{audio:{data: int16ToB64(pcm), mimeType:'audio/pcm;rate=16000'}}}));
  };
  const mute = ctx.createGain(); mute.gain.value = 0;   // να τρέχει ο επεξεργαστής χωρίς ηχώ
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  LIVE.proc = proc;
}
function int16ToB64(arr){
  const u = new Uint8Array(arr.buffer);
  let s = '';
  for(let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
function liveSendText(t){
  if(LIVE.ws && LIVE.ws.readyState === 1)
    LIVE.ws.send(JSON.stringify({clientContent:{turns:[{role:'user', parts:[{text:t}]}], turnComplete:true}}));
}

/* ---------- έξοδος ήχου (PCM 24 kHz, με ουρά) ---------- */
function b64ToInt16(b64){
  const bin = atob(b64), n = bin.length >> 1, out = new Int16Array(n);
  for(let i = 0; i < n; i++) out[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
  return out;
}
function livePlay(inl){
  const ctx = LIVE.outCtx; if(!ctx) return;
  const m = /rate=(\d+)/.exec(inl.mimeType || '');
  const rate = m ? parseInt(m[1], 10) : 24000;
  const pcm = b64ToInt16(inl.data);
  const buf = ctx.createBuffer(1, pcm.length, rate);
  const ch = buf.getChannelData(0);
  for(let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  const src = ctx.createBufferSource();
  src.buffer = buf; src.connect(ctx.destination);
  const now = ctx.currentTime;
  if(LIVE.nextAt < now) LIVE.nextAt = now + 0.05;
  src.start(LIVE.nextAt);
  LIVE.nextAt += buf.duration;
  LIVE.playing.push(src);
  src.onended = () => { LIVE.playing = LIVE.playing.filter(s => s !== src); };
  $('#hint').textContent = 'Μιλάει…';
}
function liveFlush(){
  LIVE.playing.forEach(s => { try{ s.stop(); }catch(e){} });
  LIVE.playing = []; LIVE.nextAt = 0;
}

/* ---------- σύνδεση, διακοπή, τερματισμός ---------- */
function liveClosed(ev, ws){
  if(!LIVE.on || ws !== LIVE.ws) return;
  const reason = ev.reason || ('κωδικός ' + ev.code);
  if(ev.code === 1008 || /api key|permission|unauthent|quota|exhaust|not supported/i.test(reason)){
    toast('Ζωντανή κλήση: ' + reason + hintFor(reason, 'gemini')); liveStop(); return;
  }
  if(LIVE.retries < 3){
    LIVE.retries++;
    toast('Ξανασυνδέομαι…');
    setTimeout(() => { if(LIVE.on){ liveFlush(); liveConnect(); } }, 800);
  }else{
    toast('Η σύνδεση έκλεισε: ' + reason + hintFor(reason, 'gemini')); liveStop();
  }
}

function liveStop(){
  const wasOn = LIVE.on;
  LIVE.on = false; LIVE.ready = false;
  if(LIVE.aiTxt || LIVE.userTxt) liveTurnDone();
  try{ LIVE.proc && LIVE.proc.disconnect(); }catch(e){}
  try{ LIVE.inCtx && LIVE.inCtx.close(); }catch(e){}
  try{ LIVE.ws && LIVE.ws.close(); }catch(e){}
  if(LIVE.stream) LIVE.stream.getTracks().forEach(t => t.stop());
  liveFlush();
  try{ LIVE.outCtx && LIVE.outCtx.close(); }catch(e){}
  LIVE.stream = LIVE.inCtx = LIVE.proc = LIVE.ws = LIVE.outCtx = null;
  $('#btnLive').classList.remove('on');
  unlockScreen();
  setState('idle');
  if(wasOn) $('#hint').textContent = 'Κλήση τερματίστηκε';
}
