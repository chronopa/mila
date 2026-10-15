'use strict';
const $ = s => document.querySelector(s);
const KEY = 'speak.v1';
const DAY = 864e5, HOUR = 36e5;
const STEPS = [1, 3, 7, 14, 30, 60];          // spaced-repetition intervals (days)
const FAST = 'claude-haiku-5-5';               // cheap Claude model for lookups / challenge generation
const FAST_OA = 'gpt-6-luna';                  // cheap OpenAI model for the same
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
const DEFAULTS = {
  provider:'claude', apiKey:'', model:'claude-haiku-5-5',
  openaiKey:'', oaModel:'gpt-6-luna', oaCustom:'',
  voiceEngine:'browser', oaVoice:'marin', sttEngine:'browser', sttModel:'gpt-4o-mini-transcribe', silMs:1600,
  level:'B2', interests:'', accent:'en-US', explain:'el', voice:'', rate:1,
  hideAI:false, goal:15, difficulty:'normal', focus:{grammar:true,vocabulary:true,natural:true}
};

const SCENARIOS = [
  {id:'free',icon:'💬',title:'Ελεύθερη συζήτηση',prompt:'Have a relaxed, friendly open conversation about whatever interests the learner.'},
  {id:'int_devops',icon:'🛠️',title:'Interview: DevOps engineer',prompt:'ROLE-PLAY: You are a hiring manager interviewing the learner for a DevOps engineer position (CI/CD, containers, Kubernetes, cloud, monitoring, incident response). Ask ONE interview question at a time, mixing technical and behavioural questions, and follow up on their answers like a real interviewer.'},
  {id:'int_backend',icon:'⚙️',title:'Interview: Backend engineer',prompt:'ROLE-PLAY: You are a hiring manager interviewing the learner for a backend engineer position (APIs, databases, system design, testing, performance). Ask ONE interview question at a time, mixing technical and behavioural questions, and follow up like a real interviewer.'},
  {id:'int_behav',icon:'🤝',title:'Behavioral interview (STAR)',prompt:'ROLE-PLAY: You are an interviewer running a behavioural interview. Ask "Tell me about a time when..." questions one at a time and probe for the learner\'s specific actions and results.'},
  {id:'standup',icon:'📋',title:'Daily stand-up',prompt:'ROLE-PLAY: You are the team lead running the daily stand-up. Ask what the learner did yesterday, what they plan today and any blockers, and ask short follow-up questions.'},
  {id:'incident',icon:'🚨',title:'Εξήγηση incident',prompt:'ROLE-PLAY: You are a non-technical manager. The learner must explain a production incident (what happened, impact, root cause, fix, prevention) in clear simple English. Ask clarifying questions as a manager would.'},
  {id:'present',icon:'🎤',title:'Παρουσίαση project / αρχιτεκτονικής',prompt:'ROLE-PLAY: You are a colleague from another team. The learner presents a system or project they worked on. Ask curious, probing questions about the design, trade-offs and challenges.'},
  {id:'smalltalk',icon:'☕',title:'Small talk με συναδέλφους',prompt:'ROLE-PLAY: You are a friendly colleague chatting at the coffee machine. Keep it casual and natural: weekend, hobbies, news, work-life.'},
  {id:'travel',icon:'✈️',title:'Ταξίδι (ξενοδοχείο, αεροδρόμιο, εστιατόριο)',prompt:'ROLE-PLAY: Act out a realistic travel situation (hotel check-in, restaurant, asking directions, airport) playing the local staff member. Switch to a new situation after a few turns.'},
  {id:'custom',icon:'✏️',title:'Δικό σου σενάριο',prompt:''}
];
const DAILY_POOL = ['int_devops','standup','smalltalk','int_backend','incident','present','travel','int_behav'];
const DIFF = {
  easy:'DIFFICULTY easy: use simple vocabulary and short sentences, speak clearly, and flag only the single most important issue.',
  normal:'',
  hard:'DIFFICULTY hard: speak at natural native pace with idioms and phrasal verbs, ask challenging follow-up questions, and also flag subtle naturalness issues.'
};
const DICT_SYS = 'You are an English-Greek dictionary for an intermediate learner. Given a word and the sentence it appeared in, reply ONLY with JSON: {"base":"dictionary form","pos":"part of speech","el":"Greek meaning in this context, max 6 words","example":"one short natural English example sentence","example_el":"Greek translation of the example"}';
const TTS_INSTR = 'Speak like a friendly, natural native English speaker in a relaxed conversation: warm tone, natural rhythm and intonation, clear articulation suited to an intermediate learner.';
const OA_VOICES = ['marin','cedar','coral','alloy','ash','ballad','echo','fable','nova','onyx','sage','shimmer','verse'];

function load(){
  try{
    const d = JSON.parse(localStorage.getItem(KEY) || '{}');
    const s = d.settings || {};
    return {settings:{...DEFAULTS,...s,focus:{...DEFAULTS.focus,...(s.focus||{})}},
      notebook:d.notebook||[],vocab:d.vocab||[],days:d.days||{},daily:d.daily||null,dict:d.dict||{}};
  }catch(e){
    return {settings:{...DEFAULTS,focus:{...DEFAULTS.focus}},notebook:[],vocab:[],days:{},daily:null,dict:{}};
  }
}
let DB = load();
function save(){ try{ localStorage.setItem(KEY, JSON.stringify(DB)); }catch(e){} }

/* ---------- helpers: keys / engines ---------- */
const hasKey = () => DB.settings.provider === 'openai' ? !!DB.settings.openaiKey : !!DB.settings.apiKey;
const useOAVoice = () => DB.settings.voiceEngine === 'openai' && !!DB.settings.openaiKey;
const useOAStt = () => DB.settings.sttEngine === 'openai' && !!DB.settings.openaiKey;

/* ---------- state ---------- */
let convo = [];            // [{role,content}]
let sessionFixes = [];
let state = 'idle';        // idle | listening | thinking | speaking
let rec = null, silTimer = null;
let drill = false, scn = null, lastOpts = null;
const call = {active:false};
let listenTok = 0, recCancel = null, recFinish = null, micStream = null, actx = null, wake = null;
const audioEl = new Audio(); audioEl.playsInline = true;

const HINTS = {
  idle:'Πάτα το μικρόφωνο και μίλα',
  listening:'Σε ακούω… πάτα ξανά όταν τελειώσεις',
  thinking:'Σκέφτομαι…',
  speaking:'Πάτα για να διακόψεις'
};
const CALLHINTS = {
  idle:'Σε κλήση 📞',
  listening:'Μίλα — θα απαντήσω όταν σταματήσεις',
  thinking:'Σκέφτομαι…',
  speaking:'Πάτα για να με διακόψεις'
};
function setState(s){
  state = s;
  const cls = 'micbtn ' + (s==='idle' ? '' : s);
  const ico = s==='listening' ? '⏹' : s==='speaking' ? '🔊' : s==='thinking' ? '…' : '🎙️';
  ['#mic','#rvMic'].forEach(id => { const m = $(id); if(m){ m.className = cls; m.textContent = ico; } });
  $('#hint').textContent = (call.active ? CALLHINTS[s] : HINTS[s]) + (useOAVoice() ? ' · φωνή AI' : '');
}
function toast(msg, good){
  const t = $('#toast'); t.textContent = msg; t.className = good ? 'good' : ''; t.style.display = 'block';
  clearTimeout(toast.t); toast.t = setTimeout(() => t.style.display = 'none', 5000);
}
function setLive(t){ $('#live').textContent = t; $('#rvLive').textContent = t; }
function pad(n){ return String(n).padStart(2,'0'); }
function dayKey(d){ return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
const todayKey = () => dayKey(new Date());
function esc(t){ const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
function extract(raw, o, c){
  const a = raw.indexOf(o), b = raw.lastIndexOf(c);
  if(a < 0 || b < a) return null;
  try{ return JSON.parse(raw.slice(a, b+1)); }catch(e){ return null; }
}

/* ---------- progress ---------- */
function streak(){
  let n = 0; const d = new Date();
  if(!(DB.days[dayKey(d)]||0)) d.setDate(d.getDate()-1);
  while((DB.days[dayKey(d)]||0) > 0){ n++; d.setDate(d.getDate()-1); }
  return n;
}
function renderProgress(){
  const t = DB.days[todayKey()] || 0, g = DB.settings.goal || 15;
  $('#streak').textContent = '🔥 ' + streak();
  $('#today').textContent = t + '/' + g;
  $('#barfill').style.width = Math.min(100, t/g*100) + '%';
}

/* ---------- spaced repetition ---------- */
function srs(it, ok){
  if(ok){ it.step = (it.step||0) + 1; it.due = Date.now() + STEPS[Math.min(it.step-1, STEPS.length-1)]*DAY; }
  else { it.step = 0; it.due = Date.now() + 10*60e3; }
}
const dueNotes = () => DB.notebook.filter(c => (c.due||0) <= Date.now());
const dueVocab = () => DB.vocab.filter(v => (v.due||0) <= Date.now());

/* ---------- LLM (Claude or OpenAI) ---------- */
async function llm(system, messages, max, fast){
  const s = DB.settings;
  if(s.provider === 'openai'){
    const model = fast ? FAST_OA : (s.oaCustom || s.oaModel);
    const reasoning = /^(gpt-[56]|o\d)/.test(model);
    const lowLat = /luna/.test(model);
    const body = {model, instructions:system, input:messages.map(m => ({role:m.role,content:m.content}))};
    if(reasoning) body.reasoning = {effort: lowLat ? 'none' : 'low'};
    body.max_output_tokens = (max||700) + (reasoning && !lowLat ? 1000 : 0);
    const r = await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      headers:{'content-type':'application/json','authorization':'Bearer '+s.openaiKey},
      body:JSON.stringify(body)
    });
    if(!r.ok){
      let m = ''; try{ m = (await r.json()).error.message; }catch(e){}
      throw new Error(r.status + (m ? ': '+m : ''));
    }
    const j = await r.json();
    const t = (j.output||[]).filter(o => o.type === 'message')
      .map(o => (o.content||[]).filter(c => c.type === 'output_text').map(c => c.text).join('')).join('');
    return t || j.output_text || '';
  }
  const r = await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-api-key':s.apiKey,
      'anthropic-version':'2023-06-01',
      'anthropic-dangerous-direct-browser-access':'true'
    },
    body:JSON.stringify({model:fast ? FAST : s.model,max_tokens:max||700,system,messages})
  });
  if(!r.ok){
    let m = ''; try{ m = (await r.json()).error.message; }catch(e){}
    throw new Error(r.status + (m ? ': '+m : ''));
  }
  const j = await r.json();
  return (j.content||[]).map(c => c.text||'').join('');
}

/* ---------- prompts ---------- */
function focusText(){
  const f = DB.settings.focus;
  return [f.grammar&&'grammar',f.vocabulary&&'vocabulary choice',f.natural&&'naturalness / idiomatic phrasing'].filter(Boolean).join(', ') || 'grammar';
}
function recentText(){ return DB.notebook.slice(-12).map(c => `"${c.said}" -> "${c.better}"`).join('; '); }

// Conversation partner: plain spoken text only (fast), no corrections here.
function replyPrompt(){
  const s = DB.settings;
  return [
    `You are a warm, natural English conversation partner talking with a Greek-speaking learner at about CEFR ${s.level}. This is a spoken conversation: sound like a friendly human, not a teacher.`,
    s.interests ? `Learner's interests and context: ${s.interests}. Steer the conversation toward these naturally.` : 'Pick friendly everyday topics.',
    scn && scn.prompt ? `SCENARIO: ${scn.prompt} Stay in character.` : '',
    DIFF[s.difficulty] || '',
    `Rules: reply in 1-3 short spoken sentences with natural contractions. React to what they actually said (a brief interjection like "Oh nice" or "Hmm, I see" is fine), then usually ask one follow-up question or invite them to continue. Plain text only: no markdown, lists, emojis or JSON. Never point out grammar or vocabulary mistakes, because a separate system handles corrections. The learner's words come from speech-to-text, so if something is unclear, ask naturally to repeat or rephrase.`,
    drill && recentText() ? `Drill mode: steer the conversation so the learner naturally has to use the structures from these past mistakes again: ${recentText()}.` : '',
    `If the user message is exactly [START], open the session in character (for an interview, briefly introduce yourself and ask the first question).`
  ].filter(Boolean).join('\n');
}

// Teacher: runs in parallel while the reply is being spoken.
function analysisPrompt(){
  const s = DB.settings;
  const recent = recentText();
  return [
    `You are an English teacher analysing ONE spoken message from a Greek-speaking learner at about CEFR ${s.level}. It came from speech-to-text, so ignore punctuation, capitalization and likely transcription glitches. Only flag genuine learner mistakes.`,
    `Correction focus: ${focusText()}. Flag at most 3 issues, most important first. If the message is fine, return an empty list. Do not nitpick phrasing that is already natural.`,
    s.difficulty === 'easy' ? 'Flag only the single most important issue.' : '',
    recent ? `Recent mistakes by this learner (note if they repeat): ${recent}.` : '',
    `Reply with ONLY a JSON object, no markdown, in this shape:`,
    `{"corrections": [{"said": "exact fragment the learner said", "better": "corrected fragment", "type": "grammar|vocabulary|natural", "why": "one short explanation in ${s.explain==='el'?'Greek':'simple English'}"}],`,
    ` "natural_version": "the learner's whole message as a native speaker would say it, or empty string if there are no corrections",`,
    ` "new_words": [{"phrase": "a useful word or expression from the COACH's reply that a ${s.level} learner may not know", "el": "Greek meaning", "example": "short example sentence"}]}`,
    `new_words: 0-2 items, usually 0 or 1, [] if nothing is worth saving.`
  ].filter(Boolean).join('\n');
}

function parseAnalysis(raw){
  const o = extract(raw, '{', '}');
  if(!o) return null;
  return {
    corrections:(Array.isArray(o.corrections)?o.corrections:[]).filter(c=>c&&c.said&&c.better).slice(0,3),
    natural:String(o.natural_version||'').trim(),
    words:(Array.isArray(o.new_words)?o.new_words:[]).filter(w=>w&&w.phrase&&w.el).slice(0,2)
  };
}

/* ---------- chat rendering ---------- */
const chat = $('#chat');
function scrollDown(){ chat.scrollTop = chat.scrollHeight; }
function wordify(t){
  return t.split(/([A-Za-z][A-Za-z'’-]*)/).map((p,i) => i%2 ? '<span class="w">'+esc(p)+'</span>' : esc(p)).join('');
}
function addUser(text){
  const el = document.createElement('div'); el.className = 'msg me'; el.textContent = text;
  chat.appendChild(el); scrollDown(); return el;
}
function addAI(text){
  const el = document.createElement('div');
  el.className = 'msg ai' + (DB.settings.hideAI ? ' blur' : '');
  el.innerHTML = '<span class="t">'+wordify(text)+'</span><button class="replay" aria-label="Replay">🔊</button>';
  el.onclick = e => {
    if(e.target.classList.contains('replay')){ if(state==='idle'||state==='speaking') speak(text); return; }
    if(el.classList.contains('blur')){ el.classList.remove('blur'); return; }
    if(e.target.classList.contains('w')) lookup(e.target.textContent, text);
  };
  chat.appendChild(el); scrollDown(); return el;
}
function buildFix(out){
  const el = document.createElement('div');
  if(!out.corrections.length){
    el.className = 'fix ok'; el.textContent = '✓ Ακούστηκε σωστά και φυσικά';
  }else{
    el.className = 'fix';
    el.innerHTML = out.corrections.map(c =>
      '<div class="row"><span class="tag">'+esc(c.type||'')+'</span><s>'+esc(c.said)+'</s> → <b>'+esc(c.better)+'</b>'+
      (c.why ? '<div class="why">'+esc(c.why)+'</div>' : '')+'</div>'
    ).join('') + (out.natural ? '<div class="nat">Φυσικά: <em>'+esc(out.natural)+'</em></div>' : '');
  }
  return el;
}
function buildChips(words){
  const box = document.createElement('div'); box.className = 'vchips';
  words.forEach(w => {
    const b = document.createElement('button'); b.className = 'vchip';
    b.textContent = '＋ '+w.phrase+' — '+w.el;
    b.onclick = () => { addVocab(w); b.disabled = true; b.textContent = '✓ '+w.phrase; };
    box.appendChild(b);
  });
  return box;
}
function addThink(){
  const el = document.createElement('div'); el.className = 'think'; el.textContent = '…';
  chat.appendChild(el); scrollDown(); return el;
}

/* ---------- daily 5-minute plan ---------- */
function daily(){
  const k = todayKey();
  if(!DB.daily || DB.daily.date !== k){ DB.daily = {date:k,review:false,cards:false}; save(); }
  return DB.daily;
}
function topFocus(){
  const cnt = {};
  DB.notebook.slice(-20).forEach(c => { if(c.type) cnt[c.type] = (cnt[c.type]||0) + 1; });
  const e = Object.entries(cnt).sort((a,b) => b[1]-a[1]);
  return e.length ? e[0][0] : null;
}
function dailyScenario(){
  const d = new Date(), doy = Math.floor((d - new Date(d.getFullYear(),0,0)) / DAY);
  return SCENARIOS.find(s => s.id === DAILY_POOL[doy % DAILY_POOL.length]);
}
function planState(){
  const d = daily(), goal = DB.settings.goal || 15, turns = DB.days[todayKey()] || 0;
  return {d, goal, turns,
    nNotes:dueNotes().length, nCards:dueVocab().length,
    s1:d.review || dueNotes().length === 0,
    s2:d.cards || dueVocab().length === 0,
    s3:turns >= goal};
}
function dailyHTML(){
  const p = planState(), sc = dailyScenario(), f = topFocus();
  const step = (done, txt) => '<div class="step'+(done?' done':'')+'"><span>'+(done?'✓':'○')+'</span><div>'+txt+'</div></div>';
  const all = p.s1 && p.s2 && p.s3;
  return '<div class="daily"><h3>📅 Σημερινό 5λεπτο</h3>'+
    step(p.s1, 'Επανάληψη λαθών <small>('+(p.nNotes ? Math.min(p.nNotes,5)+' ερωτήσεις' : 'τίποτα για σήμερα')+')</small>')+
    step(p.s2, 'Flashcards λεξιλογίου <small>('+(p.nCards ? Math.min(p.nCards,10)+' κάρτες' : 'τίποτα για σήμερα')+')</small>')+
    step(p.s3, 'Συζήτηση: '+sc.icon+' '+esc(sc.title)+' <small>('+Math.min(p.turns,p.goal)+'/'+p.goal+(f ? ' · εστίαση: '+esc(f) : '')+')</small>')+
    '<button class="primary" id="dailyGo" style="width:100%;margin-top:10px">'+(all ? 'Έτοιμο! Νέα συνομιλία' : 'Συνέχισε')+'</button></div>';
}
function emptyState(){
  chat.innerHTML = '<div class="empty">'+dailyHTML()+
    '<button class="secondary" id="otherBtn" style="width:100%;margin-top:10px">🎭 Διάλεξε σενάριο</button>'+
    '<p class="sub" style="margin-top:14px">Πάτα 📞 για να μιλάτε σαν σε τηλέφωνο, χωρίς κουμπιά. Πάτα οποιαδήποτε λέξη του AI για μετάφραση.</p></div>';
  $('#dailyGo').onclick = dailyGo;
  $('#otherBtn').onclick = openStart;
}
function refreshEmpty(){ if(chat.querySelector('.empty')) emptyState(); }
function dailyGo(){
  const p = planState();
  if(!p.s1) return startReview();
  if(!p.s2) return startCards();
  if(!p.s3){
    const sc = dailyScenario();
    return startSession({scenarioId:sc.id, drill:DB.notebook.length >= 3});
  }
  openStart();
}

/* ---------- conversation ---------- */
function trimmed(){
  const m = convo.slice(-14);
  while(m.length && m[0].role !== 'user') m.shift();
  return m;
}
function relisten(ms){
  setTimeout(() => { if(call.active && state === 'idle') listen(); }, ms || 300);
}
function failCall(e){
  if(!call.active) return;
  if(/^40[13]/.test(e.message)) endCall(); else relisten(800);
}

async function turn(userText){
  const isStart = userText === '[START]';
  if(chat.querySelector('.empty')) chat.innerHTML = '';
  const userEl = isStart ? null : addUser(userText);
  convo.push({role:'user',content:userText});
  setState('thinking');
  const th = addThink();
  let reply;
  try{
    reply = (await llm(replyPrompt(), trimmed(), 220)).trim();
    if(!reply) throw new Error('Άδεια απάντηση, ξαναδοκίμασε');
  }catch(e){
    convo.pop(); th.remove(); setState('idle');
    toast('Σφάλμα: ' + e.message);
    failCall(e);
    return;
  }
  th.remove();
  convo.push({role:'assistant',content:reply});
  const aiEl = addAI(reply);
  if(!isStart){
    const k = todayKey(), before = DB.days[k] || 0;
    DB.days[k] = before + 1; save(); renderProgress();
    if(before + 1 === DB.settings.goal) toast('🎉 Πέτυχες τον στόχο της ημέρας! Πάτα 🏁 για σύνοψη.', true);
    // corrections are produced in parallel while the reply is spoken
    analyze(userText, reply).then(out => { if(out) showAnalysis(userEl, aiEl, out); }).catch(e => console.warn('analysis failed', e));
  }
  setState('idle');
  await speak(reply);
  setState('idle');
  if(call.active && state === 'idle') listen();
}

async function analyze(userText, reply){
  const prior = convo.slice(-7, -2).map(m => (m.role === 'user' ? 'Learner: ' : 'Coach: ') + m.content).join('\n');
  const content = (prior ? 'Earlier context:\n'+prior+'\n\n' : '') +
    'Learner\'s latest message: "'+userText+'"\nCoach\'s reply: "'+reply+'"';
  return parseAnalysis(await llm(analysisPrompt(), [{role:'user',content}], 600));
}
function showAnalysis(userEl, aiEl, out){
  const fix = buildFix(out);
  if(userEl) userEl.after(fix);
  if(out.words.length && aiEl) aiEl.after(buildChips(out.words));
  out.corrections.forEach(c => {
    const item = {ts:Date.now(),said:c.said,better:c.better,type:c.type||'',why:c.why||'',step:0,due:Date.now()+4*HOUR};
    DB.notebook.push(item); sessionFixes.push(item);
  });
  if(DB.notebook.length > 400) DB.notebook = DB.notebook.slice(-400);
  save(); scrollDown();
}

function startSession(o){
  o = o || {};
  lastOpts = o;
  stopSpeech(); abortListen(); setState('idle');
  drill = !!o.drill;
  const sc = SCENARIOS.find(s => s.id === (o.scenarioId || 'free')) || SCENARIOS[0];
  scn = {id:sc.id,title:sc.title,
    prompt: sc.id === 'custom' ? 'ROLE-PLAY / SCENARIO defined by the learner: ' + (o.custom || 'free conversation') : sc.prompt};
  convo = []; sessionFixes = [];
  chat.innerHTML = ''; showTab('chat');
  if(!hasKey()){ openSettings(); toast('Βάλε πρώτα το API key'); emptyState(); if(call.active) endCall(); return; }
  const b = document.createElement('div'); b.className = 'banner';
  b.textContent = sc.icon + ' ' + (sc.id === 'custom' ? (o.custom || 'Δικό σου σενάριο') : sc.title) + (drill ? ' · εστίαση στα λάθη' : '');
  chat.appendChild(b);
  turn('[START]');
}

/* ---------- speech out ---------- */
let speechEnd = null, ttsWarned = false;
function unlockAudio(){
  try{ audioEl.src = SILENT_WAV; audioEl.play().catch(() => {}); }catch(e){}
  try{ if(!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); }catch(e){}
}
['click','touchend'].forEach(ev => document.addEventListener(ev, unlockAudio, {once:true, passive:true}));

function stopSpeech(){
  if(speechEnd) speechEnd();
  if('speechSynthesis' in window) speechSynthesis.cancel();
}
function enVoices(){ return ('speechSynthesis' in window) ? speechSynthesis.getVoices().filter(v => v.lang.toLowerCase().startsWith('en')) : []; }

function speakBrowser(text, fin, cleanup){
  if(!('speechSynthesis' in window)){ fin(); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = DB.settings.accent;
  const vs = enVoices();
  const v = vs.find(v => v.voiceURI === DB.settings.voice) || vs.find(v => v.lang.replace('_','-') === DB.settings.accent);
  if(v) u.voice = v;
  u.rate = DB.settings.rate;
  u.onend = fin; u.onerror = fin;
  const timer = setTimeout(fin, 4000 + text.length*110);
  cleanup.push(() => clearTimeout(timer));
  window.__utter = u;               // keep a reference (iOS can drop it otherwise)
  speechSynthesis.speak(u);
}
function speakOpenAI(text, fin, cleanup){
  const ctrl = new AbortController();
  cleanup.push(() => { ctrl.abort(); try{ audioEl.pause(); }catch(e){} audioEl.onended = audioEl.onerror = null; });
  const r = DB.settings.rate;
  const instr = TTS_INSTR + (r < 0.9 ? ' Speak a little slower than normal.' : r > 1.1 ? ' Speak a little faster than normal.' : '');
  fetch('https://api.openai.com/v1/audio/speech',{
    method:'POST', signal:ctrl.signal,
    headers:{'content-type':'application/json','authorization':'Bearer '+DB.settings.openaiKey},
    body:JSON.stringify({model:'gpt-4o-mini-tts',voice:DB.settings.oaVoice||'marin',input:text,instructions:instr,response_format:'wav'})
  }).then(async res => {
    if(!res.ok){
      let m = ''; try{ m = (await res.json()).error.message; }catch(e){}
      throw new Error(res.status + (m ? ': '+m : ''));
    }
    return res.blob();
  }).then(b => {
    const url = URL.createObjectURL(b);
    cleanup.push(() => URL.revokeObjectURL(url));
    audioEl.onended = fin; audioEl.onerror = fin;
    audioEl.src = url;
    return audioEl.play();
  }).catch(e => {
    if(e && e.name === 'AbortError') return;
    if(!ttsWarned){ ttsWarned = true; toast('Φωνή OpenAI: ' + e.message + ' — χρησιμοποιώ τη φωνή του iPhone'); }
    speakBrowser(text, fin, cleanup);
  });
}
function speak(text){
  stopSpeech();
  return new Promise(res => {
    let done = false; const cleanup = [];
    const fin = () => {
      if(done) return; done = true;
      cleanup.forEach(f => { try{ f(); }catch(e){} });
      if(speechEnd === fin) speechEnd = null;
      if(state === 'speaking') setState('idle');
      res();
    };
    speechEnd = fin;
    if(state === 'idle' || state === 'speaking') setState('speaking');
    if(useOAVoice()) speakOpenAI(text, fin, cleanup); else speakBrowser(text, fin, cleanup);
  });
}

/* ---------- speech in ---------- */
function abortListen(){
  listenTok++;
  clearInterval(silTimer);
  if(rec){ rec.onresult = rec.onerror = rec.onend = null; try{ rec.abort(); }catch(e){} rec = null; }
  if(recCancel){ const f = recCancel; recCancel = null; try{ f(); }catch(e){} }
  recFinish = null;
  setLive('');
}
function listen(handler){
  handler = handler || turn;
  if(!hasKey()){ openSettings(); toast('Βάλε πρώτα το API key'); if(call.active) endCall(); return; }
  if(useOAStt()){
    if(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) return listenOA(handler);
    toast('Η εγγραφή ήχου δεν υποστηρίζεται εδώ — χρησιμοποιώ την αναγνώριση του Safari.');
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR){ toast('Αυτό το πρόγραμμα περιήγησης δεν υποστηρίζει αναγνώριση φωνής. Χρησιμοποίησε το ⌨️.'); $('#typebox').classList.add('on'); if(call.active) endCall(); return; }
  abortListen(); stopSpeech();
  rec = new SR();
  rec.lang = DB.settings.accent; rec.continuous = true; rec.interimResults = true;
  let text = '', last = Date.now(), sent = false;
  const me = rec;
  const finish = () => {
    clearInterval(silTimer);
    if(sent) return; sent = true;
    const t = text.trim(); setLive('');
    if(t.length > 1) handler(t);
    else { setState('idle'); if(handler === turn) relisten(300); }
  };
  rec.onresult = e => { text = Array.from(e.results).map(r => r[0].transcript).join(' '); last = Date.now(); setLive(text); };
  rec.onerror = e => {
    sent = true; clearInterval(silTimer); setLive(''); setState('idle');
    if(e.error === 'not-allowed' || e.error === 'service-not-allowed'){
      toast('Δεν έχω άδεια μικροφώνου. Έλεγξε Ρυθμίσεις iPhone → Safari → Μικρόφωνο, και ότι το Dictation είναι ενεργό.');
      if(call.active) endCall();
    }else if(e.error === 'network'){
      toast('Σφάλμα δικτύου στην αναγνώριση φωνής.'); if(call.active) endCall();
    }else if(e.error === 'no-speech' && handler === turn) relisten(300);
  };
  rec.onend = finish;
  silTimer = setInterval(() => {
    const idle = Date.now() - last;
    if((text && idle > (DB.settings.silMs || 1600) + 400) || (!text && idle > (call.active ? 25000 : 10000))){ try{ me.stop(); }catch(e){} }
  }, 300);
  try{ rec.start(); last = Date.now(); setState('listening'); }
  catch(e){ clearInterval(silTimer); toast(e.message); setState('idle'); }
}

/* --- OpenAI transcription path: own recorder + silence detection --- */
async function getMic(){
  if(micStream && micStream.getTracks().every(t => t.readyState === 'live')) return micStream;
  try{
    micStream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    return micStream;
  }catch(e){
    toast('Δεν έχω άδεια μικροφώνου. Έλεγξε Ρυθμίσεις iPhone → Safari → Μικρόφωνο.');
    setState('idle'); if(call.active) endCall();
    return null;
  }
}
function releaseMic(){ if(micStream){ micStream.getTracks().forEach(t => t.stop()); micStream = null; } }

function recordOnce(stream){
  return new Promise(resolve => {
    if(!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    try{ actx.resume(); }catch(e){}
    const src = actx.createMediaStreamSource(stream), an = actx.createAnalyser();
    an.fftSize = 1024; src.connect(an);
    const buf = new Float32Array(an.fftSize), chunks = [];
    const mime = ['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    let mr;
    try{ mr = new MediaRecorder(stream, mime ? {mimeType:mime} : undefined); }
    catch(e){ try{ src.disconnect(); }catch(_){} resolve({error:e}); return; }
    mr.ondataavailable = e => { if(e.data && e.data.size) chunks.push(e.data); };
    const t0 = Date.now(), sil = DB.settings.silMs || 1600;
    let floorSum = 0, floorN = 0, spoke = false, voiced = 0, lastVoice = 0, ended = false, vad;
    const end = how => {
      if(ended) return; ended = true;
      clearInterval(vad); recCancel = null; recFinish = null;
      try{ src.disconnect(); }catch(e){}
      mr.onstop = () => {
        if(how === 'speech' && chunks.length) resolve({blob:new Blob(chunks,{type:mr.mimeType || mime || 'audio/mp4'})});
        else if(how === 'cancel') resolve({cancel:true});
        else resolve({idle:true});
      };
      try{ mr.stop(); }catch(e){ resolve(how === 'cancel' ? {cancel:true} : {idle:true}); }
    };
    recCancel = () => end('cancel');
    recFinish = () => end(spoke ? 'speech' : 'idle');
    vad = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let s = 0; for(let i = 0; i < buf.length; i++) s += buf[i]*buf[i];
      const rms = Math.sqrt(s/buf.length), now = Date.now();
      if(now - t0 < 400){ floorSum += rms; floorN++; return; }
      const thr = Math.min(0.04, Math.max(0.015, (floorSum/Math.max(1,floorN))*2.5));
      if(rms > thr){ lastVoice = now; voiced += 50; if(voiced >= 150 && !spoke){ spoke = true; setLive('…'); } }
      else if(!spoke) voiced = 0;
      if(spoke && now - lastVoice > sil) end('speech');
      else if(!spoke && now - t0 > 10000) end('idle');
      else if(now - t0 > 90000) end(spoke ? 'speech' : 'idle');
    }, 50);
    mr.start();
  });
}
async function transcribe(blob){
  const t = blob.type || 'audio/mp4';
  const ext = t.includes('webm') ? 'webm' : t.includes('wav') ? 'wav' : 'mp4';
  const fd = new FormData();
  fd.append('file', new File([blob], 'speech.' + ext, {type:t}));
  fd.append('model', DB.settings.sttModel || 'gpt-4o-mini-transcribe');
  fd.append('language', 'en');
  fd.append('prompt', 'Transcribe exactly what the speaker says, including any grammar mistakes. Do not correct or rephrase.');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions',{
    method:'POST', headers:{authorization:'Bearer '+DB.settings.openaiKey}, body:fd
  });
  if(!r.ok){
    let m = ''; try{ m = (await r.json()).error.message; }catch(e){}
    throw new Error(r.status + (m ? ': '+m : ''));
  }
  return ((await r.json()).text || '').trim();
}
async function listenOA(handler){
  abortListen(); stopSpeech();
  const my = listenTok;
  setState('listening');
  const stream = await getMic();
  if(!stream || my !== listenTok) return;
  try{
    for(;;){
      const r = await recordOnce(stream);
      if(my !== listenTok || r.cancel) return;
      if(r.error){ toast('Σφάλμα εγγραφής: ' + r.error.message); setState('idle'); if(call.active) endCall(); return; }
      if(r.idle){
        if(call.active) continue;
        setState('idle'); setLive(''); return;
      }
      setState('thinking'); setLive('Μεταγραφή…');
      let text = '';
      try{ text = await transcribe(r.blob); }
      catch(e){
        setLive(''); setState('idle'); toast('Σφάλμα μεταγραφής: ' + e.message);
        if(call.active){ if(/^40[13]/.test(e.message)) endCall(); else relisten(800); }
        return;
      }
      if(my !== listenTok) return;
      setLive('');
      if(text.length > 1){ handler(text); return; }
      if(call.active){ setState('listening'); continue; }
      setState('idle'); return;
    }
  }finally{
    if(my === listenTok || !call.active) releaseMic();
  }
}

/* ---------- call mode (hands-free, like a phone call) ---------- */
async function lockScreen(){
  try{ if('wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); }catch(e){}
}
function unlockScreen(){ try{ if(wake){ wake.release(); wake = null; } }catch(e){} }
function paintCall(){
  $('#btnCall').classList.toggle('on', call.active);
  setState(state);
}
function startCall(){
  if(!hasKey()){ openSettings(); toast('Βάλε πρώτα το API key'); return; }
  call.active = true; paintCall(); unlockAudio(); lockScreen();
  if(!convo.length) startSession(lastOpts || {scenarioId:'free'});
  else if(state === 'idle') listen();
}
function endCall(){
  call.active = false;
  abortListen(); stopSpeech(); releaseMic(); unlockScreen();
  setState('idle'); paintCall();
}
$('#btnCall').onclick = () => { if(call.active) endCall(); else startCall(); };
document.addEventListener('visibilitychange', () => {
  if(document.hidden || !call.active) return;
  lockScreen();
  if(state === 'idle' || state === 'listening'){ abortListen(); setState('idle'); relisten(200); }
});

$('#mic').onclick = () => {
  unlockAudio();
  if(state === 'idle') listen();
  else if(state === 'listening'){ if(recFinish) recFinish(); else { try{ rec.stop(); }catch(e){} } }
  else if(state === 'speaking') stopSpeech();
};
$('#btnType').onclick = () => $('#typebox').classList.toggle('on');
function sendTyped(){
  const v = $('#typeIn').value.trim(); if(!v || state === 'thinking') return;
  $('#typeIn').value = ''; turn(v);
}
$('#typeGo').onclick = sendTyped;
$('#typeIn').addEventListener('keydown', e => { if(e.key === 'Enter') sendTyped(); });

/* ---------- start sheet (scenarios) ---------- */
let pick = 'free';
function paintStart(){
  $('#stList').innerHTML = SCENARIOS.map(s =>
    '<button class="scn'+(s.id===pick?' on':'')+'" data-id="'+s.id+'"><span>'+s.icon+'</span>'+esc(s.title)+'</button>').join('');
  $('#stList').querySelectorAll('.scn').forEach(b => b.onclick = () => { pick = b.dataset.id; paintStart(); });
  $('#stCustom').style.display = pick === 'custom' ? 'block' : 'none';
}
function openStart(){
  $('#sDiff').value = DB.settings.difficulty || 'normal';
  paintStart(); $('#stSheet').classList.add('on');
}
$('#btnNew').onclick = openStart;
$('#stClose').onclick = () => $('#stSheet').classList.remove('on');
$('#stGo').onclick = () => {
  DB.settings.difficulty = $('#sDiff').value; save();
  $('#stSheet').classList.remove('on');
  startSession({scenarioId:pick, custom:$('#stCustom').value.trim(), drill:$('#stDrill').checked});
};

/* ---------- word lookup (tap a word) ---------- */
let dictCur = null, lookTok = 0;
async function lookup(word, ctx){
  const k = word.toLowerCase().replace(/^['’-]+|['’-]+$/g, '');
  const tok = ++lookTok;
  $('#dWord').textContent = word; $('#dPos').textContent = ''; $('#dBody').textContent = '…';
  $('#dictSheet').classList.add('on');
  dictCur = null;
  let d = DB.dict[k];
  if(!d){
    try{
      const raw = await llm(DICT_SYS, [{role:'user',content:'Word: '+word+'\nSentence: '+ctx}], 300, true);
      d = extract(raw, '{', '}');
      if(d && d.el){
        DB.dict[k] = d;
        const keys = Object.keys(DB.dict); if(keys.length > 300) delete DB.dict[keys[0]];
        save();
      }
    }catch(e){ if(tok === lookTok) $('#dBody').textContent = 'Σφάλμα: ' + e.message; return; }
  }
  if(tok !== lookTok) return;
  if(!d || !d.el){ $('#dBody').textContent = 'Δεν βρέθηκε μετάφραση.'; return; }
  dictCur = {phrase:d.base || word, el:d.el, example:d.example || ''};
  $('#dWord').textContent = (d.base && d.base.toLowerCase() !== k) ? word + ' → ' + d.base : word;
  $('#dPos').textContent = d.pos || '';
  $('#dBody').innerHTML = '<b>'+esc(d.el)+'</b>' +
    (d.example ? '<div class="sub" style="margin-top:8px">'+esc(d.example)+(d.example_el ? '<br>'+esc(d.example_el) : '')+'</div>' : '');
}
function addVocab(w){
  const p = (w.phrase || '').trim(); if(!p) return;
  if(DB.vocab.some(v => v.phrase.toLowerCase() === p.toLowerCase())) return;
  DB.vocab.push({phrase:p,el:w.el||'',example:w.example||'',ts:Date.now(),step:0,due:Date.now()+4*HOUR});
  save();
}
$('#dSave').onclick = () => {
  if(dictCur && dictCur.el){ addVocab(dictCur); toast('Αποθηκεύτηκε στο λεξιλόγιο ✓', true); }
};
$('#dSpeak').onclick = () => { if(dictCur) speak(dictCur.phrase); else speak($('#dWord').textContent.split(' ')[0]); };
$('#dClose').onclick = () => { $('#dictSheet').classList.remove('on'); stopSpeech(); };

/* ---------- mistake review (speaking drill with SRS) ---------- */
let rv = null;
async function startReview(){
  const items = dueNotes().slice(0, 5);
  if(!items.length){ toast('Δεν έχεις λάθη για επανάληψη τώρα.', true); return; }
  if(!hasKey()){ openSettings(); toast('Βάλε πρώτα το API key'); return; }
  if(call.active) endCall();
  stopSpeech(); abortListen(); setState('idle');
  $('#rvSheet').classList.add('on');
  $('#rvCount').textContent = ''; $('#rvTag').textContent = ''; $('#rvResult').innerHTML = '';
  $('#rvPrompt').textContent = 'Φτιάχνω ερωτήσεις…';
  $('#rvMic').style.display = 'none'; $('#rvNext').style.display = 'none';
  try{
    const list = items.map((c,i) => i+') said: "'+c.said+'" | correct: "'+c.better+'"'+(c.why ? ' | note: '+c.why : '')).join('\n');
    const raw = await llm(
      'For each learner mistake below, write ONE short natural Greek sentence (everyday life or software/IT work) whose natural English translation requires using the corrected form, plus a model English answer. Return ONLY a JSON array: [{"i":0,"greek":"...","answer":"..."}]',
      [{role:'user',content:list}], 900, true);
    const arr = extract(raw, '[', ']');
    const q = (arr || []).map(a => ({item:items[a.i], greek:a.greek, answer:a.answer})).filter(x => x.item && x.greek && x.answer);
    if(!q.length) throw new Error('Δεν δημιουργήθηκαν ερωτήσεις');
    rv = {q, i:0, ok:0, retried:new Set()};
    showQ();
  }catch(e){ closeRv(); toast('Σφάλμα: ' + e.message); }
}
function showQ(){
  if(rv.i >= rv.q.length){ finishReview(); return; }
  const q = rv.q[rv.i];
  $('#rvCount').textContent = 'Ερώτηση ' + (rv.i+1) + ' / ' + rv.q.length;
  $('#rvPrompt').textContent = q.greek;
  $('#rvTag').textContent = 'Πες το στα αγγλικά';
  $('#rvResult').innerHTML = ''; setLive('');
  $('#rvMic').style.display = ''; $('#rvNext').style.display = ''; $('#rvNext').textContent = 'Παράλειψη';
}
$('#rvMic').onclick = () => {
  unlockAudio();
  if(state === 'idle') listen(rvAnswer);
  else if(state === 'listening'){ if(recFinish) recFinish(); else { try{ rec.stop(); }catch(e){} } }
  else if(state === 'speaking') stopSpeech();
};
async function rvAnswer(text){
  if(!rv) return;
  const q = rv.q[rv.i];
  setState('thinking'); $('#rvResult').innerHTML = '<div class="sub">Αξιολογώ…</div>';
  const lang = DB.settings.explain === 'el' ? 'Greek' : 'simple English';
  let r;
  try{
    const sys = 'You judge a spoken English answer (it came from speech-to-text, so ignore punctuation and capitalization). The learner was asked to say this Greek sentence in English: "'+q.greek+'". One good version: "'+q.answer+'". The point being practised: instead of "'+q.item.said+'" the correct form is "'+q.item.better+'". Reply ONLY with JSON {"ok": true or false, "feedback": "one short sentence in '+lang+'", "better": "the learner\'s sentence corrected, or the good version if they were far off"}. ok is true if the meaning is conveyed and the practised structure is used correctly, even if the wording differs.';
    r = extract(await llm(sys, [{role:'user',content:text}], 300), '{', '}');
    if(!r) throw new Error('Μη έγκυρη απάντηση');
  }catch(e){ setState('idle'); $('#rvResult').innerHTML = ''; toast('Σφάλμα: ' + e.message); return; }
  const ok = !!r.ok, better = r.better || q.answer;
  srs(q.item, ok);
  if(ok) rv.ok++; else if(!rv.retried.has(q)){ rv.retried.add(q); rv.q.push(q); }
  save();
  $('#rvResult').innerHTML =
    '<div class="res '+(ok?'good':'bad')+'">'+(ok ? '✓ Σωστό' : '✗ Όχι ακριβώς')+'</div>'+
    '<div>Είπες: '+esc(text)+'</div><div>Σωστό: <b>'+esc(better)+'</b></div>'+
    (r.feedback ? '<div class="sub">'+esc(r.feedback)+'</div>' : '');
  $('#rvMic').style.display = 'none'; $('#rvNext').textContent = 'Επόμενο';
  setState('idle');
  await speak(better);
}
$('#rvNext').onclick = () => {
  if(!rv) return;
  abortListen(); stopSpeech(); setState('idle');
  rv.i++; showQ();
};
function closeRv(){
  abortListen(); stopSpeech(); setState('idle');
  $('#rvSheet').classList.remove('on');
}
$('#rvClose').onclick = () => { closeRv(); rv = null; };
function finishReview(){
  const ok = rv.ok; closeRv(); rv = null;
  daily().review = true; save();
  toast('Επανάληψη ολοκληρώθηκε: ' + ok + ' σωστά ✓', true);
  refreshEmpty();
  if($('#notes').classList.contains('on')) renderNotes();
}

/* ---------- vocabulary flashcards ---------- */
let fc = null;
function startCards(){
  const items = dueVocab().slice(0, 10);
  if(!items.length){ toast('Δεν έχεις λέξεις για επανάληψη τώρα.', true); return; }
  stopSpeech();
  fc = {q:items.slice(), i:0, ok:0, retried:new Set()};
  $('#fcSheet').classList.add('on'); showCard();
}
function showCard(){
  if(fc.i >= fc.q.length){ endCards(); return; }
  const it = fc.q[fc.i];
  $('#fcCount').textContent = (fc.i+1) + ' / ' + fc.q.length;
  $('#fcFront').textContent = it.el || it.phrase;
  $('#fcBack').style.display = 'none'; $('#fcBack').innerHTML = '';
  $('#fcShow').style.display = ''; $('#fcGrade').style.display = 'none';
}
$('#fcShow').onclick = () => {
  unlockAudio();
  const it = fc.q[fc.i];
  $('#fcBack').innerHTML = '<div class="big" style="color:var(--accent)">'+esc(it.phrase)+'</div>'+(it.example ? '<div class="sub">'+esc(it.example)+'</div>' : '');
  $('#fcBack').style.display = 'block'; $('#fcShow').style.display = 'none'; $('#fcGrade').style.display = 'flex';
  speak(it.phrase);
};
function gradeCard(ok){
  const it = fc.q[fc.i];
  srs(it, ok);
  if(ok) fc.ok++; else if(!fc.retried.has(it)){ fc.retried.add(it); fc.q.push(it); }
  save(); fc.i++; showCard();
}
$('#fcYes').onclick = () => gradeCard(true);
$('#fcNo').onclick = () => gradeCard(false);
function endCards(){
  const ok = fc.ok;
  $('#fcSheet').classList.remove('on'); fc = null; stopSpeech();
  daily().cards = true; save();
  toast('Flashcards ολοκληρώθηκαν: ' + ok + ' σωστά ✓', true);
  refreshEmpty();
  if($('#vocab').classList.contains('on')) renderVocab();
}
$('#fcClose').onclick = () => { $('#fcSheet').classList.remove('on'); fc = null; stopSpeech(); if($('#vocab').classList.contains('on')) renderVocab(); };

/* ---------- notebook & vocabulary tabs ---------- */
function renderNotes(){
  const v = $('#notes'), nb = DB.notebook;
  if(!nb.length){ v.innerHTML = '<div class="empty"><h2>Άδειο ακόμα</h2><p>Οι διορθώσεις σου θα μαζεύονται εδώ, και το AI θα τις θυμάται για να σε προσέχει.</p></div>'; return; }
  const counts = {}; nb.forEach(c => { const k = c.type || 'other'; counts[k] = (counts[k]||0) + 1; });
  v.innerHTML =
    '<div class="stats">'+Object.entries(counts).map(([k,n]) => '<span class="chip">'+esc(k)+' · '+n+'</span>').join('')+'</div>'+
    '<div style="display:flex;gap:8px;margin-bottom:14px"><button class="primary" id="rvBtn" style="flex:1">Επανάληψη ('+dueNotes().length+')</button>'+
    '<button class="secondary" id="drillBtn" style="flex:1">Εξάσκηση στα λάθη</button></div>'+
    nb.slice().reverse().map((c,i) => {
      const idx = nb.length-1-i;
      return '<div class="nb"><button class="del" data-i="'+idx+'">×</button><span class="tag">'+esc(c.type)+'</span><s style="color:var(--bad)">'+esc(c.said)+'</s> → <b style="color:var(--ok)">'+esc(c.better)+'</b>'+(c.why ? '<div class="sub">'+esc(c.why)+'</div>' : '')+'</div>';
    }).join('');
  $('#rvBtn').onclick = startReview;
  $('#drillBtn').onclick = () => startSession({drill:true});
  v.querySelectorAll('.del').forEach(b => b.onclick = () => { DB.notebook.splice(+b.dataset.i, 1); save(); renderNotes(); });
}
function renderVocab(){
  const v = $('#vocab'), items = DB.vocab;
  if(!items.length){ v.innerHTML = '<div class="empty"><h2>Άδειο ακόμα</h2><p>Πάτα μια λέξη σε απάντηση του AI, ή το ＋ κάτω από μια απάντηση, για να αποθηκεύσεις λεξιλόγιο.</p></div>'; return; }
  v.innerHTML =
    '<button class="primary" id="fcBtn" style="width:100%;margin-bottom:14px">Flashcards ('+dueVocab().length+' προς επανάληψη)</button>'+
    items.slice().reverse().map((w,i) => {
      const idx = items.length-1-i;
      return '<div class="nb"><button class="del" data-i="'+idx+'">×</button><b>'+esc(w.phrase)+'</b> <button class="say" data-i="'+idx+'" aria-label="Say">🔊</button>'+
        (w.el ? '<div class="sub">'+esc(w.el)+'</div>' : '')+(w.example ? '<div class="sub"><em>'+esc(w.example)+'</em></div>' : '')+'</div>';
    }).join('');
  $('#fcBtn').onclick = startCards;
  v.querySelectorAll('.del').forEach(b => b.onclick = () => { DB.vocab.splice(+b.dataset.i, 1); save(); renderVocab(); });
  v.querySelectorAll('.say').forEach(b => b.onclick = () => speak(DB.vocab[+b.dataset.i].phrase));
}
function showTab(t){
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  ['chat','notes','vocab'].forEach(id => $('#'+id).classList.toggle('on', id === t));
  if(t === 'notes') renderNotes();
  if(t === 'vocab') renderVocab();
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

/* ---------- session summary ---------- */
$('#btnEnd').onclick = async () => {
  const userTurns = convo.filter(m => m.role === 'user' && m.content !== '[START]').length;
  if(userTurns < 2){ toast('Μίλα λίγο ακόμα και μετά ζήτα σύνοψη.'); return; }
  $('#sumSheet').classList.add('on'); $('#sumText').textContent = 'Φτιάχνω τη σύνοψη…';
  const transcript = convo.filter(m => m.content !== '[START]').map(m => (m.role === 'user' ? 'Learner: ' : 'Coach: ') + m.content).join('\n');
  const fixes = sessionFixes.map(c => `"${c.said}" -> "${c.better}" (${c.type})`).join('\n') || 'none';
  try{
    const txt = await llm(
      'You are an English coach. Write in Greek, plain text with no markdown, at most 130 words: (1) one sentence on what went well, (2) the 1-2 most recurring mistake patterns, (3) three natural English phrases the learner should reuse, each with a tiny example. Be specific and kind.',
      [{role:'user',content:'Conversation:\n'+transcript+'\n\nMistakes this session:\n'+fixes}], 600);
    $('#sumText').textContent = txt.trim();
  }catch(e){ $('#sumText').textContent = 'Σφάλμα: ' + e.message; }
};
$('#sumClose').onclick = () => $('#sumSheet').classList.remove('on');

/* ---------- settings ---------- */
function fillVoices(){
  const sel = $('#sVoice'), vs = enVoices();
  sel.innerHTML = '<option value="">Αυτόματη</option>' + vs.map(v => '<option value="'+esc(v.voiceURI)+'">'+esc(v.name+' ('+v.lang+')')+'</option>').join('');
  sel.value = DB.settings.voice || '';
}
function paintGroups(){
  const show = (id, on) => $(id).style.display = on ? 'block' : 'none';
  show('#grpClaude', $('#sProv').value === 'claude');
  show('#grpOAModel', $('#sProv').value === 'openai');
  show('#grpBV', $('#sVoiceEng').value === 'browser');
  show('#grpOV', $('#sVoiceEng').value === 'openai');
  show('#grpSttModel', $('#sSttEng').value === 'openai');
}
function openSettings(){
  const s = DB.settings;
  $('#sProv').value = s.provider; $('#sKey').value = s.apiKey; $('#sModel').value = s.model;
  $('#sOaKey').value = s.openaiKey; $('#sOaModel').value = s.oaModel; $('#sOaCustom').value = s.oaCustom;
  $('#sLevel').value = s.level;
  $('#sInt').value = s.interests; $('#sAccent').value = s.accent; $('#sExplain').value = s.explain;
  $('#sVoiceEng').value = s.voiceEngine; $('#sOaVoice').value = s.oaVoice;
  $('#sSttEng').value = s.sttEngine; $('#sSttModel').value = s.sttModel;
  $('#sRate').value = s.rate; $('#rateVal').textContent = s.rate;
  $('#sSil').value = s.silMs; $('#silVal').textContent = (s.silMs/1000).toFixed(1) + ' s';
  $('#fGrammar').checked = s.focus.grammar; $('#fVocab').checked = s.focus.vocabulary; $('#fNat').checked = s.focus.natural;
  $('#sGoal').value = s.goal; $('#sHide').checked = s.hideAI;
  fillVoices(); paintGroups();
  $('#setSheet').classList.add('on');
}
['#sProv','#sVoiceEng','#sSttEng'].forEach(id => $(id).onchange = paintGroups);
$('#btnSet').onclick = openSettings;
$('#setClose').onclick = () => $('#setSheet').classList.remove('on');
$('#sRate').oninput = e => $('#rateVal').textContent = e.target.value;
$('#sSil').oninput = e => $('#silVal').textContent = (e.target.value/1000).toFixed(1) + ' s';
$('#setSave').onclick = () => {
  const s = DB.settings;
  s.provider = $('#sProv').value; s.apiKey = $('#sKey').value.trim(); s.model = $('#sModel').value;
  s.openaiKey = $('#sOaKey').value.trim(); s.oaModel = $('#sOaModel').value; s.oaCustom = $('#sOaCustom').value.trim();
  s.level = $('#sLevel').value;
  s.interests = $('#sInt').value.trim(); s.accent = $('#sAccent').value; s.voice = $('#sVoice').value;
  s.voiceEngine = $('#sVoiceEng').value; s.oaVoice = $('#sOaVoice').value;
  s.sttEngine = $('#sSttEng').value; s.sttModel = $('#sSttModel').value;
  s.rate = parseFloat($('#sRate').value); s.silMs = parseInt($('#sSil').value) || 1600; s.explain = $('#sExplain').value;
  s.focus = {grammar:$('#fGrammar').checked,vocabulary:$('#fVocab').checked,natural:$('#fNat').checked};
  s.goal = Math.max(3, parseInt($('#sGoal').value) || 15); s.hideAI = $('#sHide').checked;
  ttsWarned = false;
  save(); renderProgress(); refreshEmpty(); setState(state); $('#setSheet').classList.remove('on');
};
if('speechSynthesis' in window) speechSynthesis.onvoiceschanged = fillVoices;

/* ---------- init ---------- */
renderProgress(); setState('idle'); emptyState(); paintCall();
if(!(window.SpeechRecognition || window.webkitSpeechRecognition) && !useOAStt()) $('#typebox').classList.add('on');
if(!hasKey()) setTimeout(openSettings, 400);
if('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
