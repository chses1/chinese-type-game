// --- hotfix: 防止未宣告的 db 造成載入崩潰 ---
const db = { students: {} };
function saveDB() {}

const API_BASE = "/api";

// 通用 JSON
async function jsonFetch(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()); } catch {}
    throw new Error(`HTTP ${res.status} ${res.statusText} ${detail}`);
  }
  return res.json();
}

// 封裝各 API（含教師權限）
const API = {
  upsertStudent(payload) {
    return jsonFetch(`${API_BASE}/upsert-student`, { method: "POST", body: JSON.stringify(payload) });
  },
  updateBest(payload) {
    return jsonFetch(`${API_BASE}/update-best`, { method: "POST", body: JSON.stringify(payload) });
  },
  leaderboard(limit = 10, classPrefix = "") {
    const qs = new URLSearchParams({ limit });
    if (classPrefix) qs.set("classPrefix", classPrefix);
    return jsonFetch(`${API_BASE}/leaderboard?` + qs.toString());
  },
  getStudent(sid) {
    return jsonFetch(`${API_BASE}/student/${sid}`);
  },
  getClasses() {
    return jsonFetch(`${API_BASE}/classes`);
  },
  adminClearClass(prefix, token) {
    return jsonFetch(`${API_BASE}/admin/clear-class`, {
      method: "POST",
      headers: { "x-teacher-token": token },
      body: JSON.stringify({ classPrefix: prefix })
    });
  },
  adminClearAll(token) {
    return jsonFetch(`${API_BASE}/admin/clear-all`, {
      method: "POST",
      headers: { "x-teacher-token": token }
    });
  }
};

// --- 直接從後端查自己 best ---
async function setBest() {
  const b = document.getElementById("best");
  if (!b || !me.sid) return;
  try {
    const resp = await API.getStudent(me.sid);
    if (resp.ok) b.textContent = resp.data.best;
  } catch (e) {
    console.warn("讀取最佳分數失敗", e);
  }
}

// --- 圖像資源（隕石） ---
const meteorImg = new Image();
meteorImg.src = "img/Q.png";
let imageReady = false;
meteorImg.onload = () => { imageReady = true; };
meteorImg.onerror = () => { console.warn("Q.png 載入失敗，請檢查路徑"); };

// === 常數 ===
const ZHUYIN=['ㄅ','ㄆ','ㄇ','ㄈ','ㄉ','ㄊ','ㄋ','ㄌ','ㄍ','ㄎ','ㄏ','ㄐ','ㄑ','ㄒ','ㄓ','ㄔ','ㄕ','ㄖ','ㄗ','ㄘ','ㄙ','ㄧ','ㄨ','ㄩ','ㄚ','ㄛ','ㄜ','ㄝ','ㄞ','ㄟ','ㄠ','ㄡ','ㄢ','ㄣ','ㄤ','ㄥ','ㄦ'];
const SHENGMU=new Set(['ㄅ','ㄆ','ㄇ','ㄈ','ㄉ','ㄊ','ㄋ','ㄌ','ㄍ','ㄎ','ㄏ','ㄐ','ㄑ','ㄒ','ㄓ','ㄔ','ㄕ','ㄖ','ㄗ','ㄘ','ㄙ']);
const MEDIAL=new Set(['ㄧ','ㄨ','ㄩ']);
const keyClass = ch => SHENGMU.has(ch) ? 'shengmu' : (MEDIAL.has(ch)?'medial':'yunmu');

// === 等級設定 ===
let level=1;
const ACC_THRESHOLD=0.8;
const LEVELS=[{lpm:10,duration:60},{lpm:15,duration:60}];
const spawnInterval = () => Math.max(400, Math.round(60000/(LEVELS[level-1]||LEVELS.at(-1)).lpm));

// === Canvas ===
const canvas=document.getElementById('gameCanvas');
const ctx=canvas.getContext('2d');
let W, H;
function resize(){
  const r = canvas.getBoundingClientRect();
  W = canvas.width  = Math.floor(r.width  * 2);
  H = canvas.height = Math.floor(r.height * 2);
}
resize();
addEventListener('resize', resize);

// === 狀態 ===
let meteors=[]; let running=false, score=0, timeLeft=(LEVELS[0].duration), spawnTimer=0;
let correct=0, wrong=0;
let me={sid:null,name:''};
let teacherToken = "";  // 儲存教師密碼（本機 1070；正式版請用 TEACHER_TOKEN）

const setUserChip=()=>document.getElementById('userChip').textContent=me.sid?`${me.sid}`:'未登入';
const setScore=()=>document.getElementById('score').textContent=score;
const setTime =()=>document.getElementById('time').textContent=timeLeft;
const toast = msg => { const t=document.getElementById('toast'); if(!t) return; t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),1200) }

// === 鍵盤 ===
function buildKeyboard(){
  const rows=[
    ['ㄅ','ㄉ','','','ㄓ','','','ㄚ','ㄞ','ㄢ','ㄦ'],
    ['ㄆ','ㄊ','ㄍ','ㄐ','ㄔ','ㄗ','ㄧ','ㄛ','ㄟ','ㄣ',''],
    ['ㄇ','ㄋ','ㄎ','ㄑ','ㄕ','ㄘ','ㄨ','ㄜ','ㄠ','ㄤ',''],
    ['ㄈ','ㄌ','ㄏ','ㄒ','ㄖ','ㄙ','ㄩ','ㄝ','ㄡ','ㄥ','']
  ];
  const kbd=document.getElementById('kbd');
  kbd.innerHTML='';
  rows.forEach(r=>{
    const row=document.createElement('div'); row.className='row';
    r.forEach(ch=>{
      const b=document.createElement('button');
      b.className='key '+(ZHUYIN.includes(ch)?keyClass(ch):'');
      b.textContent=ch;
      b.onclick=()=>pressKey(ch);
      row.appendChild(b);
    });
    kbd.appendChild(row);
  });
}
function applyKbdPref(){ const compact=localStorage.getItem('kbd-compact')==='1'; const k=document.getElementById('kbd'); if(!k) return; k.classList.toggle('compact',compact); }

// === 遊戲 ===
function spawn(){ const label=ZHUYIN[Math.floor(Math.random()*ZHUYIN.length)]; const x=40+Math.random()*(W-80); const speed=1.5+Math.random()*2.5; meteors.push({x,y:-40,speed,label}); }
function drawBackground(){ ctx.clearRect(0,0,W,H); ctx.fillStyle='rgba(255,255,255,.8)'; for(let i=0;i<40;i++){ const x=(i*97%W), y=(i*181%H); ctx.globalAlpha=(i%5)/5+.2; ctx.fillRect(x,y,3,3);} ctx.globalAlpha=1; }
function draw(){
  drawBackground();
  meteors.forEach(m=>{
    ctx.save();
    ctx.translate(m.x, m.y);
    const size = 300;
    if (imageReady) ctx.drawImage(meteorImg, -size/2, -size/2, size, size);
    else { ctx.fillStyle = '#3b82f6'; ctx.beginPath(); ctx.arc(0,0,size*0.45,0,Math.PI*2); ctx.fill(); }
    ctx.font = 'bold 100px system-ui';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,.6)';
    const xOffset = -size * 0.08;  
    const yOffset =  size * 0.15;
    ctx.strokeText(m.label, xOffset, yOffset);
    ctx.fillStyle = '#fff'; ctx.fillText(m.label, xOffset, yOffset);
    ctx.restore();
  });
}
function pressKey(ch){
  if(!running) return;
  let idx=-1,bestY=-1;
  for(let i=0;i<meteors.length;i++){ const m=meteors[i]; if(m.label===ch && m.y>bestY){ bestY=m.y; idx=i; } }
  if(idx>=0){ meteors.splice(idx,1); score++; correct++; setScore(); toast('✅ +1'); }
  else{ if(score>0) score--; wrong++; setScore(); toast('❌ -1'); }
}
function step(){
  if(running){
    spawnTimer+=16;
    if(spawnTimer>spawnInterval()){ spawn(); spawnTimer=0; }
    meteors.forEach(m=> m.y += m.speed*2);
    for(let i=meteors.length-1;i>=0;i--){ if(meteors[i].y>H-40){ meteors.splice(i,1); if(score>0) score--; wrong++; } }
    draw();
  }
  requestAnimationFrame(step);
}
function startGame(){ if(!me.sid){ toast('請先登入'); return;} running=true; ticker(); }
function pauseGame(){ running=false; }
function toggleRun(){ running?pauseGame():startGame(); }
let timerId=null;
function ticker(){ clearInterval(timerId); timerId=setInterval(()=>{ if(!running) return; timeLeft--; setTime(); if(timeLeft<=0){ endGame(); } },1000); }
async function endGame(){
  running=false; clearInterval(timerId);
  const dur=(LEVELS[level-1]?.duration)||60;
  const elapsed=dur-Math.max(0,timeLeft);
  const minutes=Math.max(1,elapsed)/60;
  const acc=(correct+wrong)?(correct/(correct+wrong)):0;
  const pass=acc>=ACC_THRESHOLD;
  try { await submitBest(me.sid, score); await setBest(); } 
  catch (e) { console.warn('更新最佳分數失敗：', e); }
  if(pass){
    if(level<LEVELS.length){ level++; toast('🎉 升到第 '+level+' 級！'); }
    score=0; correct=0; wrong=0;
    timeLeft=(LEVELS[level-1]?.duration)||60;
    setScore(); setTime(); meteors=[]; draw(); startGame();
  }else{ openLeader(); }
}
function restart(){
  level=1; score=0; correct=0; wrong=0;
  timeLeft=(LEVELS[level-1]?.duration)||60;
  setScore(); setTime(); meteors=[]; draw(); startGame();
}

// === 排行榜（遊戲內）===
async function openLeader() {
  const tb = document.getElementById('leaderBody');
  if (!tb) return;
  try {
    const data = await API.leaderboard(20);
    tb.innerHTML = data.data.map((r,i)=>`<tr><td>${i+1}</td><td>${r.sid}</td><td>${r.best}</td></tr>`).join('');
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="3">讀取失敗：${e.message}</td></tr>`;
  }
  document.getElementById('leader').hidden = false;
}
function closeLeader(){ document.getElementById('leader').hidden=true; }

// === 教師後台 ===
function openTeacherDash(){ $('teacherDash').style.display='flex'; }
function closeTeacherDash(){ $('teacherDash').style.display='none'; }

async function loadClasses() {
  try {
    const resp = await API.getClasses();
    const box = $('classList'); box.innerHTML = "";
    resp.data.forEach(c => {
      const btn = document.createElement('button');
      btn.className = 'tag';
      btn.textContent = `${c.class}（${c.count}人，Top ${c.top}，Avg ${c.avg}）`;
      btn.onclick = () => { $('classPrefix').value = c.class; loadClassRank(); };
      box.appendChild(btn);
    });
  } catch (e) {
    toast('載入班級清單失敗'); console.warn(e);
  }
}

async function loadAllRank() {
  const limit = Number($('lbLimit').value || 20);
  const tb = $('teacherLbBody'); tb.innerHTML = "";
  try {
    const resp = await API.leaderboard(limit);
    tb.innerHTML = resp.data.map((r,i)=>`<tr><td style="padding:8px 10px">${i+1}</td><td style="padding:8px 10px">${r.sid}</td><td style="padding:8px 10px">${r.best}</td></tr>`).join('');
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="3" style="padding:8px 10px">讀取失敗：${e.message}</td></tr>`;
  }
}

async function loadClassRank() {
  const p = $('classPrefix').value.trim();
  if (!/^\d{3}$/.test(p)) { alert('請輸入正確的班級前三碼（例如 301）'); return; }
  const limit = Number($('lbLimit').value || 20);
  const tb = $('teacherLbBody'); tb.innerHTML = "";
  try {
    const resp = await API.leaderboard(limit, p);
    tb.innerHTML = resp.data.map((r,i)=>`<tr><td style="padding:8px 10px">${i+1}</td><td style="padding:8px 10px">${r.sid}</td><td style="padding:8px 10px">${r.best}</td></tr>`).join('');
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="3" style="padding:8px 10px">讀取失敗：${e.message}</td></tr>`;
  }
}

async function clearClass() {
  const p = $('classPrefix').value.trim();
  if (!/^\d{3}$/.test(p)) { alert('請先輸入班級前三碼（例如 301）'); return; }
  if (!confirm(`確認要清除 ${p} 班全部學生的最佳分數嗎？此動作不可復原。`)) return;
  try {
    await API.adminClearClass(p, teacherToken);
    toast(`已清除 ${p} 班`);
    await loadClassRank();
  } catch (e) {
    alert('清除失敗：' + e.message);
  }
}

async function clearAll() {
  if (!confirm('確認要清除「所有學生」的最佳分數嗎？此動作不可復原。')) return;
  try {
    await API.adminClearAll(teacherToken);
    toast('已清除全部學生紀錄');
    await loadAllRank();
  } catch (e) {
    alert('清除失敗：' + e.message);
  }
}

// === 登入/教師 ===
const $ = id => document.getElementById(id);
if($('btnStart')) $('btnStart').onclick=toggleRun;
if($('btnCloseLeader')) $('btnCloseLeader').onclick=()=>{ closeLeader(); };
if($('btnRestartGame')) $('btnRestartGame').onclick=()=>{ closeLeader(); restart(); };

if ($('go')) $('go').onclick = async () => {
  let sid = $('sid').value.trim().replace(/\D/g,'');
  if (!/^\d{5}$/.test(sid)) { alert('請輸入5位數座號'); return; }
  me.sid = sid; me.name = '';
  try {
    await API.upsertStudent({ sid });
  } catch (e) {
    alert('登入失敗：' + e.message);
    return;
  }
  setUserChip(); await setBest();
  $('login').style.display = 'none';
  score=0; correct=0; wrong=0; level=1;
  timeLeft=(LEVELS[level-1]?.duration)||60;
  setScore(); setTime(); meteors=[]; draw();
};

if($('teacherOpen')) $('teacherOpen').onclick=()=>{ const p=document.getElementById('teacherPane'); if(p) p.style.display='block'; };
if($('enterTeacher')) $('enterTeacher').onclick=()=>{
  teacherToken = ($('tpass').value || '').trim();
  if(!teacherToken){ alert('請輸入教師密碼'); return; }
  // 本機與後端預設相同 1070；正式環境請改 TEACHER_TOKEN
  $('login').style.display='none';
  openTeacherDash();
  loadClasses(); loadAllRank();
};

// 教師後台的各種按鈕
if($('btnLoadClasses')) $('btnLoadClasses').onclick=loadClasses;
if($('btnShowAll')) $('btnShowAll').onclick=loadAllRank;
if($('btnLoadClassRank')) $('btnLoadClassRank').onclick=loadClassRank;
if($('btnClearClass')) $('btnClearClass').onclick=clearClass;
if($('btnClearAll')) $('btnClearAll').onclick=clearAll;
if($('btnCloseTeacher')) $('btnCloseTeacher').onclick=()=>{ closeTeacherDash(); };

// === 實體鍵盤 ===
addEventListener('keydown',e=>{
  if(e.key===' '){ e.preventDefault(); toggleRun(); return; }
  if(e.key==='Escape'){ pauseGame(); return; }
  if(ZHUYIN.includes(e.key)){ pressKey(e.key); }
});

// === 初始化 ===
buildKeyboard(); applyKbdPref(); setUserChip(); setScore(); setTime(); setBest(); draw(); requestAnimationFrame(step);
