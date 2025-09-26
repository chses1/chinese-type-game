// main.js  — 覆蓋版

// --- 防呆 ---
const db = { students: {} };
function saveDB() {}

const API_BASE = "/api";
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

const API = {
  upsertStudent(payload) { return jsonFetch(`${API_BASE}/upsert-student`, { method:"POST", body:JSON.stringify(payload) }); },
  updateBest(payload)    { return jsonFetch(`${API_BASE}/update-best`,     { method:"POST", body:JSON.stringify(payload) }); },
  leaderboard(limit=10, classPrefix=""){
    const qs = new URLSearchParams({ limit }); if (classPrefix) qs.set("classPrefix", classPrefix);
    return jsonFetch(`${API_BASE}/leaderboard?` + qs.toString());
  },
  getStudent(sid)  { return jsonFetch(`${API_BASE}/student/${sid}`); },
  getClasses()     { return jsonFetch(`${API_BASE}/classes`); },
  adminClearClass(prefix, token){ return jsonFetch(`${API_BASE}/admin/clear-class`, { method:"POST", headers:{ "x-teacher-token": token }, body:JSON.stringify({ classPrefix: prefix }) }); },
  adminClearAll(token){ return jsonFetch(`${API_BASE}/admin/clear-all`, { method:"POST", headers:{ "x-teacher-token": token } }); }
};

// 小工具
const $ = id => document.getElementById(id);
const toast = msg => { const t=$('toast'); if(!t) return; t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),900); };

// 讀取自己最佳分數
async function setBest(){
  const b = $('best');
  if (!b || !me.sid) return;
  try { const r = await API.getStudent(me.sid); if (r.ok) b.textContent = r.data.best; } catch{}
}
// 提交最佳分數
async function submitBest(sid, score){
  try { await API.updateBest({ sid, score }); } catch(e){ console.warn('submitBest fail', e); }
}

// 資源
const meteorImg = new Image();
meteorImg.src = "img/Q.png";
let imageReady=false;
meteorImg.onload=()=> imageReady=true;

// 注音 & 分群
const ZHUYIN=['ㄅ','ㄆ','ㄇ','ㄈ','ㄉ','ㄊ','ㄋ','ㄌ','ㄍ','ㄎ','ㄏ','ㄐ','ㄑ','ㄒ','ㄓ','ㄔ','ㄕ','ㄖ','ㄗ','ㄘ','ㄙ','ㄧ','ㄨ','ㄩ','ㄚ','ㄛ','ㄜ','ㄝ','ㄞ','ㄟ','ㄠ','ㄡ','ㄢ','ㄣ','ㄤ','ㄥ','ㄦ'];
const SHENGMU=new Set(['ㄅ','ㄆ','ㄇ','ㄈ','ㄉ','ㄊ','ㄋ','ㄌ','ㄍ','ㄎ','ㄏ','ㄐ','ㄑ','ㄒ','ㄓ','ㄔ','ㄕ','ㄖ','ㄗ','ㄘ','ㄙ']);
const MEDIAL =new Set(['ㄧ','ㄨ','ㄩ']);
const keyClass = ch => SHENGMU.has(ch) ? 'shengmu' : (MEDIAL.has(ch)?'medial':'yunmu');

// === 等級相關（保留原本 LEVELS 出怪更快，再新增墜落加速） ===
let level = 1;
const ACC_THRESHOLD = 0.8;
const LEVELS = [{ lpm:10, duration:60 }, { lpm:15, duration:60 }, { lpm:20, duration:60 }];
const spawnInterval = () => Math.max(320, Math.round(60000 / (LEVELS[level-1] || LEVELS.at(-1)).lpm));

// NEW: 不同等級的墜落速度倍率（1, 1.2, 1.4, ... 可自行調）
const levelFallFactor = () => 1 + 0.1 * (level - 1);
// Canvas
const canvas=$('gameCanvas'); const ctx=canvas.getContext('2d');
let W,H;
function resize(){ const r=canvas.getBoundingClientRect(); W=canvas.width=Math.floor(r.width*2); H=canvas.height=Math.floor(r.height*2); }
resize(); addEventListener('resize', resize);

// 狀態
let meteors=[]; let running=false, score=0, timeLeft=(LEVELS[0].duration), spawnTimer=0;
let correct=0, wrong=0;             // 這一關的統計（顯示於過關成績）
let me={sid:null,name:''};
let teacherToken="";

const setUserChip=()=>$('userChip').textContent=me.sid?`${me.sid}`:'未登入';
const setScore=()=>$('score').textContent=score;
const setTime =()=>$('time').textContent=timeLeft;

// 鍵盤
function buildKeyboard(){
  const rows=[
    ['ㄅ','ㄉ','','','ㄓ','','','ㄚ','ㄞ','ㄢ','ㄦ'],
    ['ㄆ','ㄊ','ㄍ','ㄐ','ㄔ','ㄗ','ㄧ','ㄛ','ㄟ','ㄣ',''],
    ['ㄇ','ㄋ','ㄎ','ㄑ','ㄕ','ㄘ','ㄨ','ㄜ','ㄠ','ㄤ',''],
    ['ㄈ','ㄌ','ㄏ','ㄒ','ㄖ','ㄙ','ㄩ','ㄝ','ㄡ','ㄥ','']
  ];
  const kbd=$('kbd'); kbd.innerHTML='';
  rows.forEach(r=>{
    const row=document.createElement('div'); row.className='row';
    r.forEach(ch=>{
      const b=document.createElement('button');
      b.className='key '+(ZHUYIN.includes(ch)?keyClass(ch):'');
      b.textContent=ch; b.onclick=()=>pressKey(ch);
      row.appendChild(b);
    });
    kbd.appendChild(row);
  });
}
function applyKbdPref(){ const compact=localStorage.getItem('kbd-compact')==='1'; $('kbd').classList.toggle('compact',compact); }

// 遊戲本體
function spawn(){
  const label=ZHUYIN[Math.floor(Math.random()*ZHUYIN.length)];
  const x=40+Math.random()*(W-80); const speed=1.5+Math.random()*2.5;
  meteors.push({x, y:-40, speed, label, born: performance.now()}); // born 用來算反應時間
}
function drawBackground(){
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle='rgba(255,255,255,.8)';
  for(let i=0;i<40;i++){ const x=(i*97%W), y=(i*181%H); ctx.globalAlpha=(i%5)/5+.2; ctx.fillRect(x,y,3,3); }
  ctx.globalAlpha=1;
}
function draw(){
  drawBackground();
  meteors.forEach(m=>{
    ctx.save(); ctx.translate(m.x,m.y);
    const size=300;
    if(imageReady) ctx.drawImage(meteorImg,-size/2,-size/2,size,size);
    else { ctx.fillStyle='#3b82f6'; ctx.beginPath(); ctx.arc(0,0,size*0.45,0,Math.PI*2); ctx.fill(); }
    ctx.font='bold 100px system-ui'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.lineWidth=5; ctx.strokeStyle='rgba(0,0,0,.6)';
    const xOffset=-size*0.08, yOffset=size*0.15;
    ctx.strokeText(m.label,xOffset,yOffset); ctx.fillStyle='#fff'; ctx.fillText(m.label,xOffset,yOffset);
    ctx.restore();
  });
}

// 反應時間 → 加分規則（毫秒）
function calcPoints(rtMs){
  if (rtMs <= 1500) return 3;   // 很快
  if (rtMs <= 2500) return 2;   // 普通
  return 1;                     // 慢一點也給分
}

function pressKey(ch){
  if(!running) return;
  let idx=-1, bestY=-1;
  for(let i=0;i<meteors.length;i++){
    const m=meteors[i];
    if(m.label===ch && m.y>bestY){ bestY=m.y; idx=i; }
  }
  if(idx>=0){
    const m = meteors[idx];
    meteors.splice(idx,1);
    const rt = performance.now() - m.born;
    const pts = calcPoints(rt);
    score += pts; correct++;
    setScore();
    toast(`✅ +${pts}（${Math.round(rt)}ms）`);
  }else{
    score = Math.max(0, score-1); wrong++;
    setScore(); toast('❌ -1');
  }
}

// CHG: 在 step() 裡面把墜落速度乘上等級倍率
function step(){
  if(running){
    spawnTimer += 16;
    if (spawnTimer > spawnInterval()) { spawn(); spawnTimer = 0; }
    meteors.forEach(m => m.y += m.speed * 2 * levelFallFactor());  // CHG ✨
    for(let i=meteors.length-1;i>=0;i--){
      if(meteors[i].y > H-40){ meteors.splice(i,1); score = Math.max(0, score-1); wrong++; }
    }
    draw();
  }
  requestAnimationFrame(step);
}


function startGame(){ if(!me.sid){ toast('請先登入'); return; } running=true; ticker(); }
function pauseGame(){ running=false; }
function toggleRun(){ running?pauseGame():startGame(); }

let timerId=null;
function ticker(){ clearInterval(timerId); timerId=setInterval(()=>{ if(!running) return; timeLeft--; setTime(); if(timeLeft<=0) endGame(); },1000); }

// CHG: 動態控制結果視窗按鈕
function showResult({correct, wrong, acc, speed, passed}){
  $('resCorrect').textContent = correct;
  $('resWrong').textContent   = wrong;
  $('resAcc').textContent     = Math.round(acc*100) + '%';
  $('resSpeed').textContent   = Math.round(speed);
  $('resPromo').textContent   = passed ? '✅ 達標' : '❌ 未達標';

  const btn = $('resultPrimaryBtn');               // NEW
  btn.replaceWith(btn.cloneNode(true));            // 解除舊監聽（保守作法）
  const freshBtn = $('resultPrimaryBtn');

  if (passed) {
    freshBtn.textContent = '挑戰下一關';           // NEW
    freshBtn.onclick = () => {
      closeResult();                               // 關閉視窗
      // 直接開始下一關（分數延續；endGame 已把 timeLeft 重設並清本關統計）
      startGame();
    };
  } else {
    freshBtn.textContent = '重新開始';             // NEW
    freshBtn.onclick = () => { closeResult(); restart(); };
  }

  $('resultBox').style.display = 'flex';
}

function closeResult(){ $('resultBox').style.display='none'; }

// CHG: endGame() — 仍保持「通關升級但不歸零」
async function endGame(){
  running = false; clearInterval(timerId);

  const dur = (LEVELS[level-1]?.duration) || 60;
  const elapsed = dur - Math.max(0, timeLeft);
  const minutes = Math.max(1, elapsed) / 60;
  const acc = (correct + wrong) ? (correct / (correct + wrong)) : 0;
  const speed = correct / minutes;
  const passed = acc >= ACC_THRESHOLD;

  // 顯示成績（會依 passed 替換按鈕與行為）
  showResult({ correct, wrong, acc, speed, passed });

  // 更新最佳使用「累計分數」
  if (me.sid) await submitBest(me.sid, score);
  await setBest();

  // 若達標 → 進下一級（加快出怪＆墜落），分數延續
  if (passed && level < LEVELS.length) level++;

  // 準備下一輪：只重置本關統計與時間、清場，不動 score
  correct = 0; wrong = 0; meteors.length = 0;
  timeLeft = (LEVELS[level-1]?.duration) || 60; setTime(); draw();
}


function restart(){
  // 重新開始整個流程：歸零分數與等級
  level=1; score=0; correct=0; wrong=0;
  timeLeft=(LEVELS[level-1]?.duration)||60; setScore(); setTime();
  meteors=[]; draw(); closeResult(); startGame();
}

// 排行榜（置中顯示）
async function openLeader() {
  const tb = $('leaderBody');
  try {
    const data = await API.leaderboard(50);
    tb.innerHTML = data.data.map((r,i)=>`<tr><td>${i+1}</td><td>${r.sid}</td><td>${r.best}</td></tr>`).join('');
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="3">讀取失敗：${e.message}</td></tr>`;
  }
  const panel = $('leader');
  panel.classList.add('show'); panel.removeAttribute('hidden');
}
function closeLeader(){ const p=$('leader'); p.classList.remove('show'); p.setAttribute('hidden',''); }

// 教師後台（保留）
function openTeacherDash(){ $('teacherDash').style.display='flex'; }
function closeTeacherDash(){ $('teacherDash').style.display='none'; }
async function loadClasses(){ try{ const resp=await API.getClasses(); const box=$('classList'); box.innerHTML=""; resp.data.forEach(c=>{ const btn=document.createElement('button'); btn.className='tag'; btn.textContent=`${c.class}（${c.count}人，Top ${c.top}，Avg ${c.avg}）`; btn.onclick=()=>{ $('classPrefix').value=c.class; loadClassRank(); }; box.appendChild(btn); }); }catch(e){ toast('載入班級清單失敗'); } }
async function loadAllRank(){ const limit=Number($('lbLimit').value||20); const tb=$('teacherLbBody'); tb.innerHTML=""; try{ const resp=await API.leaderboard(limit); tb.innerHTML=resp.data.map((r,i)=>`<tr><td style="padding:8px 10px">${i+1}</td><td style="padding:8px 10px">${r.sid}</td><td style="padding:8px 10px">${r.best}</td></tr>`).join(''); }catch(e){ tb.innerHTML=`<tr><td colspan="3" style="padding:8px 10px">讀取失敗：${e.message}</td></tr>`; } }
async function loadClassRank(){ const p=$('classPrefix').value.trim(); if(!/^\d{3}$/.test(p)){ alert('請輸入正確的班級前三碼'); return; } const limit=Number($('lbLimit').value||20); const tb=$('teacherLbBody'); tb.innerHTML=""; try{ const resp=await API.leaderboard(limit,p); tb.innerHTML=resp.data.map((r,i)=>`<tr><td style="padding:8px 10px">${i+1}</td><td style="padding:8px 10px">${r.sid}</td><td style="padding:8px 10px">${r.best}</td></tr>`).join(''); }catch(e){ tb.innerHTML=`<tr><td colspan="3" style="padding:8px 10px">讀取失敗：${e.message}</td></tr>`; } }
async function clearClass(){ const p=$('classPrefix').value.trim(); if(!/^\d{3}$/.test(p)){ alert('請先輸入班級前三碼'); return; } if(!confirm(`確認清除 ${p} 班最佳分數？`)) return; try{ await API.adminClearClass(p,teacherToken); toast(`已清除 ${p} 班`); await loadClassRank(); }catch(e){ alert('清除失敗：'+e.message); } }
async function clearAll(){ if(!confirm('確認清除所有學生最佳分數？')) return; try{ await API.adminClearAll(teacherToken); toast('已清除全部學生紀錄'); await loadAllRank(); }catch(e){ alert('清除失敗：'+e.message); } }

// 綁定 UI
if($('btnStart')) $('btnStart').onclick=toggleRun;
if($('btnShowLeader')) $('btnShowLeader').onclick=openLeader;     // NEW
if($('btnRestart')) $('btnRestart').onclick=()=>{ closeLeader(); closeResult(); restart(); }; // NEW
if($('btnCloseLeader')) $('btnCloseLeader').onclick=closeLeader;
if($('btnRestartGame')) $('btnRestartGame').onclick=()=>{ closeLeader(); restart(); };

if ($('go')) $('go').onclick = async () => {
  let sid = $('sid').value.trim().replace(/\D/g,'');
  if (!/^\d{5}$/.test(sid)) { alert('請輸入5位數學號'); return; }
  me.sid = sid; me.name = '';
  try { await API.upsertStudent({ sid }); } catch (e) { alert('登入失敗：' + e.message); return; }
  setUserChip(); await setBest();
  $('login').style.display='none';
  // 初始化，但不自動清掉分數（第一次登入仍是 0）
  score=0; correct=0; wrong=0; level=1;
  timeLeft=(LEVELS[level-1]?.duration)||60;
  setScore(); setTime(); meteors=[]; draw();
};

if($('teacherOpen')) $('teacherOpen').onclick=()=>{ const p=$('teacherPane'); if(p) p.style.display='block'; };
if($('enterTeacher')) $('enterTeacher').onclick=()=>{
  teacherToken = ($('tpass').value || '').trim();
  if(!teacherToken){ alert('請輸入教師密碼'); return; }
  $('login').style.display='none'; openTeacherDash(); loadClasses(); loadAllRank();
};

// 成績視窗內的「再玩一次」按鈕已綁定到 restart()

// 實體鍵盤
addEventListener('keydown',e=>{
  if(e.key===' '){ e.preventDefault(); toggleRun(); return; }
  if(e.key==='Escape'){ pauseGame(); return; }
  if(ZHUYIN.includes(e.key)){ pressKey(e.key); }
});

// 初始化
buildKeyboard(); applyKbdPref(); setUserChip(); setScore(); setTime(); setBest(); draw(); requestAnimationFrame(step);
