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

// Εικονίδια κουμπιού: κυματομορφή όταν περιμένει να μιλήσεις, αεροπλανάκι αποστολής όταν μιλάς.
const ICON_MIC = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const ICON_WAVE = '<svg class="wv" viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><rect x="2" y="8" width="2.6" height="8" rx="1.3"/><rect x="6.7" y="4" width="2.6" height="16" rx="1.3"/><rect x="11.4" y="2" width="2.6" height="20" rx="1.3"/><rect x="16.1" y="5" width="2.6" height="14" rx="1.3"/><rect x="20.8" y="8" width="2.6" height="8" rx="1.3"/></svg>';
const ICON_SEND = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>';

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
  document.body.classList.add('session');
  LIVE.on = true; LIVE.ready = false; LIVE.retries = 0; LIVE.nextAt = 0; LIVE.turnAudio = false; LIVE.gotAnyAudio = false;
  LIVE.userEl = LIVE.aiEl = null; LIVE.userTxt = LIVE.aiTxt = '';
  $('#btnLive').classList.add('on');
  $('#hint').textContent = 'Συνδέομαι…';
  navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}})
    .then(stream => {
      if(!LIVE.on){ stream.getTracks().forEach(t => t.stop()); return; }
      LIVE.stream = stream;
      try{ LIVE.outCtx && LIVE.outCtx.resume().catch(() => {}); }catch(e){}
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
      // Χωρίς αυτόματη ανίχνευση: ο χρήστης πατά το κουμπί για να μιλήσει και ξαναπατά για αποστολή.
      realtimeInputConfig:{automaticActivityDetection:{disabled:true}},
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
    $('#mic').className = 'micbtn'; $('#mic').innerHTML = ICON_MIC;
    liveStartMic();
    liveSendText('[START]');
    $('#hint').textContent = 'Πάτα το 🎙️ για να μιλήσεις';
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
  LIVE.lastIn = Date.now();
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
  if(LIVE.talking) return;
  const u = LIVE.userTxt.trim(), a = LIVE.aiTxt.trim();
  const userEl = LIVE.userEl, aiEl = LIVE.aiEl;
  const gotAudio = LIVE.turnAudio;
  LIVE.userEl = LIVE.aiEl = null; LIVE.userTxt = LIVE.aiTxt = ''; LIVE.turnAudio = false;
  // Αν δεν ήρθε ήχος για αυτή την απάντηση, τη διαβάζει η φωνή της συσκευής, ώστε να μην μένει μόνο γραπτή.
  if(a && !gotAudio && LIVE.on && !(LIVE.outCtx && LIVE.outCtx.state === 'running' && LIVE.gotAnyAudio)){
    toast('Ο ήχος του Gemini δεν ήρθε εδώ, το διαβάζω με τη φωνή της συσκευής');
    speakBrowser(a, () => {}, []);
  }
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
  }
}

// Διορθώσεις μόνο της φράσης σου (τρέχει ενώ απαντά το AI).
async function liveAnalyzeUser(userText){
  const p = hasKey() ? DB.settings.provider : 'gemini';
  const content = 'Learner\'s message: "' + userText + '"';
  const raw = await callProv(p, DB.settings.keys[p], modelFor(p, true), analysisPrompt(), [{role:'user', content}], 600);
  return parseAnalysis(raw);
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
  const ctx = LIVE.outCtx;           // ίδιο context με την έξοδο, ώστε το iOS να μη τα ανταγωνίζεται
  LIVE.inCtx = ctx;
  ctx.resume && ctx.resume().catch(() => {});
  const src = ctx.createMediaStreamSource(LIVE.stream);
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  const ratio = ctx.sampleRate / 16000;
  proc.onaudioprocess = e => {
    if(!LIVE.ws || LIVE.ws.readyState !== 1 || !LIVE.ready || !LIVE.talking) return;
    const input = e.inputBuffer.getChannelData(0);
    const n = Math.floor(input.length / ratio);
    const pcm = new Int16Array(n);
    for(let i = 0; i < n; i++){
      const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    if(LIVE.rec) LIVE.rec.push(pcm);
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
  if(ctx.state !== 'running'){ ctx.resume().catch(() => {}); liveNeedTap(); }
  LIVE.turnAudio = true;
  LIVE.relAt = 0;
  const m = /rate=(\d+)/.exec(inl.mimeType || '');
  const rate = m ? parseInt(m[1], 10) : 24000;
  LIVE.gotAnyAudio = true;
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
function liveNeedTap(){
  if(LIVE.tapOn) return;
  LIVE.tapOn = true;
  $('#hint').textContent = 'Πάτα μία φορά στην οθόνη για να ακούσεις τη φωνή';
  document.addEventListener('click', () => {
    try{ LIVE.outCtx && LIVE.outCtx.resume().catch(() => {}); }catch(e){}
    LIVE.tapOn = false;
    if(LIVE.on) $('#hint').textContent = 'Μίλα — είμαι εδώ';
  }, {once:true});
}
// Κουμπί μικροφώνου στη ζωντανή λειτουργία: πρώτο πάτημα = μιλάς, δεύτερο = αποστολή.
function liveTalk(){
  if(!LIVE.on || !LIVE.ready || LIVE.talking) return;
  const mic = $('#mic');
  {
    liveTurnDone();                 // κλείνει την τρέχουσα απάντηση του AI αν ακόμα γράφεται
    liveFlush();                    // σταματά τη φωνή του AI αν μιλάει
    LIVE.talking = true; LIVE.userEl = null; LIVE.userTxt = ''; LIVE.lastIn = 0; LIVE.rec = [];
    LIVE.ws.send(JSON.stringify({realtimeInput:{activityStart:{}}}));
    mic.className = 'micbtn listening'; mic.innerHTML = ICON_WAVE;
    $('#liveSend').hidden = false; $('#liveSend').innerHTML = ICON_SEND;
    $('#hint').textContent = 'Μιλάς… πάτα ➤ για αποστολή';
  }
}
// Γραπτό μήνυμα μέσα στη ζωντανή λειτουργία: φυσαλίδα, διορθώσεις και απάντηση φωνής.
function liveTyped(text){
  if(!LIVE.on || !LIVE.ready) return;
  liveTurnDone();
  liveFlush();
  const el = document.createElement('div'); el.className = 'msg me'; el.textContent = text;
  chat.appendChild(el); scrollDown();
  LIVE.ws.send(JSON.stringify({clientContent:{turns:[{role:'user', parts:[{text}]}], turnComplete:true}}));
  liveAnalyzeUser(text).then(out => { if(out && LIVE.on) showAnalysis(el, null, out); }).catch(e => { console.warn('live analysis failed', e); toast('Οι διορθώσεις απέτυχαν: ' + (e.message || 'άγνωστο σφάλμα')); });
  convo.push({role:'user', content:text});
  const k = todayKey(); DB.days[k] = (DB.days[k] || 0) + 1; save(); renderProgress();
}
// Αποστολή όσων είπες (κουμπί ➤ δίπλα στην κυματομορφή).
function liveSendNow(){
  if(!LIVE.talking) return;
  LIVE.talking = false;
  LIVE.ws.send(JSON.stringify({realtimeInput:{activityEnd:{}}})); LIVE.relAt = Date.now();
  const chunks = LIVE.rec || []; LIVE.rec = null;
  $('#liveSend').hidden = true;
  $('#mic').className = 'micbtn'; $('#mic').innerHTML = ICON_MIC;
  $('#hint').textContent = 'Σε άκουσα…';
  liveReview(chunks);
}
$('#liveSend').onclick = liveSendNow;
// Περιμένει να ολοκληρωθεί η μεταγραφή και δείχνει τις διορθώσεις κάτω από τη φράση σου.
function liveReview(chunks){
  const t0 = Date.now();
  const tick = async () => {
    const quiet = Date.now() - (LIVE.lastIn || 0) > 700;
    if(!quiet && Date.now() - t0 < 4000) return setTimeout(tick, 150);
    let u = LIVE.userTxt.trim();
    // Το Groq Whisper γράφει ό,τι είπες, χωρίς να διορθώνει τα λάθη σου όπως κάνει η μεταγραφή του Gemini.
    if(chunks && chunks.length && DB.settings.keys.groq){
      try{
        const t = (await transcribe(pcmWav(chunks), 'groq')).trim();
        if(t) u = t;
      }catch(e){ console.warn('groq transcription failed', e); }
    }
    if(!u) return;
    let el = LIVE.userEl;
    if(!el){ el = document.createElement('div'); el.className = 'msg me'; chat.appendChild(el); LIVE.userEl = el; }
    el.textContent = u; LIVE.userTxt = u; scrollDown();
    try{
      const out = await liveAnalyzeUser(u);
      if(out && LIVE.on) showAnalysis(el, null, out);
    }catch(e){ console.warn('live analysis failed', e); toast('Οι διορθώσεις απέτυχαν: ' + (e.message || 'άγνωστο σφάλμα')); }
  };
  setTimeout(tick, 150);
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
  try{ LIVE.ws && LIVE.ws.close(); }catch(e){}
  if(LIVE.stream) LIVE.stream.getTracks().forEach(t => t.stop());
  liveFlush();
  try{ LIVE.outCtx && LIVE.outCtx.close(); }catch(e){}
  LIVE.stream = LIVE.inCtx = LIVE.proc = LIVE.ws = LIVE.outCtx = null;
  LIVE.tapOn = false; LIVE.rec = null;
  document.body.classList.remove('session');
  $('#btnLive').classList.remove('on');
  $('#liveSend').hidden = true;
  LIVE.talking = false;
  unlockScreen();
  setState('idle');
  if(wasOn) $('#hint').textContent = 'Κλήση τερματίστηκε';
}

/* ---------- αντίγραφο ρυθμίσεων και κλειδιών ---------- */
// Κρατά τα κλειδιά και τις ρυθμίσεις σε ένα κείμενο, ώστε να τα επαναφέρεις αν σβηστούν τα δεδομένα της εφαρμογής.
$('#bkCopy').onclick = () => {
  const text = JSON.stringify({app:'mila', v:1, settings:DB.settings});
  $('#bkText').value = text;
  $('#bkText').select();
  try{ navigator.clipboard.writeText(text).then(() => toast('Αντιγράφηκε. Κράτα το κείμενο σε ασφαλές σημείο.')).catch(() => toast('Επίλεξε το κείμενο και αντέγραψέ το.')); }
  catch(e){ toast('Επίλεξε το κείμενο και αντέγραψέ το.'); }
};
$('#bkRestore').onclick = () => {
  let d;
  try{ d = JSON.parse($('#bkText').value.trim()); }catch(e){ toast('Το κείμενο δεν είναι έγκυρο αντίγραφο'); return; }
  if(!d || d.app !== 'mila' || !d.settings){ toast('Το κείμενο δεν είναι αντίγραφο της Μίλα'); return; }
  const s = d.settings;
  DB.settings = {...DB.settings, ...s,
    keys:{...DB.settings.keys, ...(s.keys||{})},
    models:{...DB.settings.models, ...(s.models||{})},
    customs:{...DB.settings.customs, ...(s.customs||{})},
    focus:{...DB.settings.focus, ...(s.focus||{})}};
  save();
  toast('Επαναφέρθηκαν οι ρυθμίσεις. Ανανεώνεται η εφαρμογή.');
  setTimeout(() => location.reload(), 900);
};

/* ---------- WAV για το Groq Whisper ---------- */
function pcmWav(chunks){
  let n = 0; chunks.forEach(c => { n += c.length; });
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, str) => { for(let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  chunks.forEach(c => { for(let i = 0; i < c.length; i++){ v.setInt16(o, c[i], true); o += 2; } });
  return new Blob([buf], {type:'audio/wav'});
}
