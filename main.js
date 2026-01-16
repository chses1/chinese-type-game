// main.js — DOM Ready + 防呆 + 刪除模式

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

  // ✅ 「刪除整筆」模式（含學號）
  adminClearClass(prefix, token){
    return jsonFetch(`${API_BASE}/admin/clear-class`, {
      method:"POST",
      headers:{ "x-teacher-token": token },
      body: JSON.stringify({ classPrefix: prefix, mode: "delete" })
    });
  },
  adminClearAll(token){
    return jsonFetch(`${API_BASE}/admin/clear-all`, {
      method:"POST",
      headers:{ "x-teacher-token": token },
      body: JSON.stringify({ mode: "delete" })
    });
  }
};

// ====== 等待 DOM 準備好再初始化（避免抓不到節點）======
document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);
  const toast = msg => { const t=$('toast'); if(!t) return; t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),900); };

  // 若頁面沒有遊戲畫面（如 teacher.html），直接略過以下初始化
  const canvas = $('gameCanvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
    const meteorImg = new Image();

  // ✅ 隕石圖請放在 /img/Q.png（建議與 earth_bg.png 同一層）
  meteorImg.src = "img/Q.png";

  let imageReady = false;
  meteorImg.onload = () => imageReady = true;

  // ✅ 加上 onerror，方便你在 Console 一眼看出是不是路徑問題
  meteorImg.onerror = () => {
    console.warn("❌ 隕石圖片載入失敗：", meteorImg.src);
    imageReady = false;
  };


  const ZHUYIN=['ㄅ','ㄆ','ㄇ','ㄈ','ㄉ','ㄊ','ㄋ','ㄌ','ㄍ','ㄎ','ㄏ','ㄐ','ㄑ','ㄒ','ㄓ','ㄔ','ㄕ','ㄖ','ㄗ','ㄘ','ㄙ','ㄧ','ㄨ','ㄩ','ㄚ','ㄛ','ㄜ','ㄝ','ㄞ','ㄟ','ㄠ','ㄡ','ㄢ','ㄣ','ㄤ','ㄥ','ㄦ'];
  const SHENGMU=new Set(['ㄅ','ㄆ','ㄇ','ㄈ','ㄉ','ㄊ','ㄋ','ㄌ','ㄍ','ㄎ','ㄏ','ㄐ','ㄑ','ㄒ','ㄓ','ㄔ','ㄕ','ㄖ','ㄗ','ㄘ','ㄙ']);
  const MEDIAL =new Set(['ㄧ','ㄨ','ㄩ']);
  const keyClass = ch => SHENGMU.has(ch) ? 'shengmu' : (MEDIAL.has(ch)?'medial':'yunmu');

  // === 等級 & 速度 ===
  let level = 1;
  const ACC_THRESHOLD = 0.8;
  const LEVELS = [{ lpm:10, duration:60 }, { lpm:15, duration:60 }, { lpm:20, duration:60 }];
  const spawnInterval = () => Math.max(320, Math.round(60000 / (LEVELS[level-1] || LEVELS.at(-1)).lpm));
  const levelFallFactor = () => 1 + 0.1 * (level - 1);

  let W,H;
  function resize(){
    const r=canvas.getBoundingClientRect();
    W=canvas.width=Math.floor(r.width*2);
    H=canvas.height=Math.floor(r.height*2);
  }
  resize(); addEventListener('resize', resize);

  // 狀態
  let meteors=[]; let running=false, score=0, timeLeft=(LEVELS[0].duration), spawnTimer=0;
  let correct=0, wrong=0;
  let me={sid:null,name:''};
  let teacherToken="";

  const setUserChip=()=>$('userChip') && ($('userChip').textContent=me.sid?`${me.sid}`:'未登入');
  const setScore=()=>$('score') && ($('score').textContent=score);
  const setTime =()=>$('time') && ($('time').textContent=timeLeft);

  async function setBest(){
    const b = $('best');
    if (!b || !me.sid) return;
    try { const r = await API.getStudent(me.sid); if (r.ok) b.textContent = r.data.best; } catch{}
  }
  async function submitBest(sid, score){
    try { await API.updateBest({ sid, score }); } catch(e){ console.warn('submitBest fail', e); }
  }

  function buildKeyboard(){
    const rows=[
      ['ㄅ','ㄉ','','','ㄓ','','','ㄚ','ㄞ','ㄢ','ㄦ'],
      ['ㄆ','ㄊ','ㄍ','ㄐ','ㄔ','ㄗ','ㄧ','ㄛ','ㄟ','ㄣ',''],
      ['ㄇ','ㄋ','ㄎ','ㄑ','ㄕ','ㄘ','ㄨ','ㄜ','ㄠ','ㄤ',''],
      ['ㄈ','ㄌ','ㄏ','ㄒ','ㄖ','ㄙ','ㄩ','ㄝ','ㄡ','ㄥ','']
    ];
    const kbd=$('kbd'); if(!kbd) return;
    kbd.innerHTML='';
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
  function applyKbdPref(){ const k=$('kbd'); if(!k) return; const compact=localStorage.getItem('kbd-compact')==='1'; k.classList.toggle('compact',compact); }

  function spawn(){
  const label = ZHUYIN[Math.floor(Math.random() * ZHUYIN.length)];

  // ✅ 出生點：右上方（畫面外）
  const x = W + 80;                         // 右邊畫面外
  const y = -60 + Math.random() * (H * 0.25); // 上方 1/4 區域隨機

  // ✅ 基礎速度（刻意放慢，增加反應時間）
  const base = 0.9 + Math.random() * 1.3;  // 約 0.9 ~ 2.2

  // ✅ 斜向移動：右上 → 左下
  const vx = -(base * 1.8); // 往左
  const vy =  (base * 1.2); // 往下

  meteors.push({
    x,
    y,
    vx,
    vy,
    label,
    born: performance.now()
  });
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

  function calcPoints(rtMs){
    if (rtMs <= 1500) return 3;
    if (rtMs <= 2500) return 2;
    return 1;
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
      toast && toast(`✅ +${pts}（${Math.round(rt)}ms）`);
    }else{
      score = Math.max(0, score-1); wrong++;
      setScore(); toast && toast('❌ -1');
    }
  }

  function step(){
    if(running){
      spawnTimer += 16;
      if (spawnTimer > spawnInterval()) { spawn(); spawnTimer = 0; }
      const f = 1 + 0.08 * (level - 1); // ✅ 等級加速，但不要太兇（0.08 比 0.1 更溫和）
meteors.forEach(m => {
  m.x += m.vx * 2 * f;
  m.y += m.vy * 2 * f;
});

      for (let i = meteors.length - 1; i >= 0; i--) {
  const m = meteors[i];
  const outBottom = m.y > H + 60;
  const outLeft   = m.x < -80;

  if (outBottom || outLeft) {
    meteors.splice(i, 1);
    score = Math.max(0, score - 1);
    wrong++;
  }
}

      draw();
    }
    requestAnimationFrame(step);
  }

  function startGame(){ if(!me.sid){ toast && toast('請先登入'); return; } running=true; ticker(); }
  function pauseGame(){ running=false; }
  function toggleRun(){ running?pauseGame():startGame(); }

  let timerId=null;
  function ticker(){ clearInterval(timerId); timerId=setInterval(()=>{ if(!running) return; timeLeft--; setTime(); if(timeLeft<=0) endGame(); },1000); }

  function showResult({correct, wrong, acc, speed, passed}){
    if ($('resCorrect')) $('resCorrect').textContent = correct;
    if ($('resWrong'))   $('resWrong').textContent   = wrong;
    if ($('resAcc'))     $('resAcc').textContent     = Math.round(acc*100) + '%';
    if ($('resSpeed'))   $('resSpeed').textContent   = Math.round(speed);
    if ($('resPromo'))   $('resPromo').textContent   = passed ? '✅ 達標' : '❌ 未達標';

    const btn = $('resultPrimaryBtn');
    if (btn) {
      const freshBtn = btn.cloneNode(true);
      btn.replaceWith(freshBtn);
      if (passed) {
        freshBtn.textContent = '挑戰下一關';
        freshBtn.onclick = () => { closeResult(); startGame(); };
      } else {
        freshBtn.textContent = '重新開始';
        freshBtn.onclick = () => { closeResult(); restart(); };
      }
    }
    if ($('resultBox')) $('resultBox').style.display = 'flex';
  }
  function closeResult(){ if ($('resultBox')) $('resultBox').style.display='none'; }

  async function endGame(){
    running = false; clearInterval(timerId);

    const dur = (LEVELS[level-1]?.duration) || 60;
    const elapsed = dur - Math.max(0, timeLeft);
    const minutes = Math.max(1, elapsed) / 60;
    const acc = (correct + wrong) ? (correct / (correct + wrong)) : 0;
    const speed = correct / minutes;
    const passed = acc >= ACC_THRESHOLD;

    showResult({ correct, wrong, acc, speed, passed });

    if (me.sid) await submitBest(me.sid, score);
    await setBest();

    if (passed && level < LEVELS.length) level++;
    correct = 0; wrong = 0; meteors.length = 0;
    timeLeft = (LEVELS[level-1]?.duration) || 60; setTime(); draw();
  }

  function restart(){
    level=1; score=0; correct=0; wrong=0;
    timeLeft=(LEVELS[level-1]?.duration)||60; setScore(); setTime();
    meteors=[]; draw(); closeResult(); startGame();
  }

  // 排行榜（教師按鈕在遊戲頁也可用）
  async function openLeader() {
    const tb = $('leaderBody'); if(!tb) return;
    try {
      const data = await API.leaderboard(50);
      tb.innerHTML = data.data.map((r,i)=>`<tr><td>${i+1}</td><td>${r.sid}</td><td>${r.best}</td></tr>`).join('');
    } catch (e) {
      tb.innerHTML = `<tr><td colspan="3">讀取失敗：${e.message}</td></tr>`;
    }
    const panel = $('leader'); if(panel){ panel.classList.add('show'); panel.removeAttribute('hidden'); }
  }
  function closeLeader(){ const p=$('leader'); if(p){ p.classList.remove('show'); p.setAttribute('hidden',''); } }

  async function loadClasses(){ try{ const resp=await API.getClasses(); const box=$('classList'); if(!box) return; box.innerHTML=""; resp.data.forEach(c=>{ const btn=document.createElement('button'); btn.className='tag'; btn.textContent=`${c.class}（${c.count}人，Top ${c.top}，Avg ${c.avg}）`; btn.onclick=()=>{ const cp=$('classPrefix'); if(cp){ cp.value=c.class; loadClassRank(); } }; box.appendChild(btn); }); }catch(e){ toast && toast('載入班級清單失敗'); } }
  async function loadAllRank(){ const limit=Number(($('lbLimit')?.value)||20); const tb=$('teacherLbBody'); if(!tb) return; tb.innerHTML=""; try{ const resp=await API.leaderboard(limit); tb.innerHTML=resp.data.map((r,i)=>`<tr><td style="padding:8px 10px">${i+1}</td><td style="padding:8px 10px">${r.sid}</td><td style="padding:8px 10px">${r.best}</td></tr>`).join(''); }catch(e){ tb.innerHTML=`<tr><td colspan="3" style="padding:8px 10px">讀取失敗：${e.message}</td></tr>`; } }
  async function loadClassRank(){ const p=$('classPrefix')?.value.trim(); if(!/^\d{3}$/.test(p)){ alert('請輸入正確的班級前三碼'); return; } const limit=Number(($('lbLimit')?.value)||20); const tb=$('teacherLbBody'); if(!tb) return; tb.innerHTML=""; try{ const resp=await API.leaderboard(limit,p); tb.innerHTML=resp.data.map((r,i)=>`<tr><td style="padding:8px 10px">${i+1}</td><td style="padding:8px 10px">${r.sid}</td><td style="padding:8px 10px">${r.best}</td></tr>`).join(''); }catch(e){ tb.innerHTML=`<tr><td colspan="3" style="padding:8px 10px">讀取失敗：${e.message}</td></tr>`; } }
  async function clearClass(){ const p=$('classPrefix')?.value.trim(); if(!/^\d{3}$/.test(p)){ alert('請先輸入班級前三碼'); return; } if(!confirm(`確認清除 ${p} 班全部紀錄（含學號）？`)) return; try{ await API.adminClearClass(p,teacherToken); toast && toast(`已清除 ${p} 班`); await loadClassRank(); }catch(e){ alert('清除失敗：'+e.message); } }
  async function clearAll(){ if(!confirm('確認清除全部學生紀錄（含學號）？')) return; try{ await API.adminClearAll(teacherToken); toast && toast('已清除全部學生紀錄'); await loadAllRank(); }catch(e){ alert('清除失敗：'+e.message); } }

  // 綁定 UI（存在才綁）
  $('btnStart')        && ($('btnStart').onclick=toggleRun);
  $('btnShowLeader')   && ($('btnShowLeader').onclick=openLeader);
  $('btnRestart')      && ($('btnRestart').onclick=()=>{ closeLeader(); closeResult(); restart(); });
  $('btnCloseLeader')  && ($('btnCloseLeader').onclick=closeLeader);
  $('btnRestartGame')  && ($('btnRestartGame').onclick=()=>{ closeLeader(); restart(); });

  $('go') && ($('go').onclick = async () => {
    let sid = $('sid').value.trim().replace(/\D/g,'');
    if (!/^\d{5}$/.test(sid)) { alert('請輸入5位數學號'); return; }
    me.sid = sid; me.name = '';
    try { await API.upsertStudent({ sid }); } catch (e) { alert('登入失敗：' + e.message); return; }
    setUserChip(); await setBest();
    if ($('login')) $('login').style.display='none';
    score=0; correct=0; wrong=0; level=1;
    timeLeft=(LEVELS[level-1]?.duration)||60;
    setScore(); setTime(); meteors=[]; draw();
  });

  $('teacherOpen') && ($('teacherOpen').onclick = () => { /* 預設超連結就會導去 /teacher */ });

  // 實體鍵盤
  addEventListener('keydown',e=>{
    if(e.key===' '){ e.preventDefault(); toggleRun(); return; }
    if(e.key==='Escape'){ pauseGame(); return; }
    if(ZHUYIN.includes(e.key)){ pressKey(e.key); }
  });

  // 初始化
  buildKeyboard(); applyKbdPref(); setUserChip(); setScore(); setTime(); setBest(); draw(); requestAnimationFrame(step);
});

/* ===== Admin Clear Utilities (for game page) =====
   作用：
   - 與 teacher.js 相同：固定帶 Content-Type 與 x-teacher-token
   - 401 會自動清掉 token，提醒重新輸入
   - 400 會把後端的錯誤訊息完整 alert 出來（便於查欄位/規則）
   用法：
   - window.clearClassFromGame('101')   // 清 101 班（含學號）
   - window.clearAllFromGame()          // 清全部（含學號）
   - 若頁面上有 #btnClearClass / #btnClearAll，會自動綁定
*/

function getTeacherToken() {
  return localStorage.getItem('teacher_token') || '';
}

function showTeacherLock() {
  // 遊戲頁通常沒有鎖定層，這裡保留掛鉤避免報錯
  if (typeof showLock === 'function') showLock();
}

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    let msg = '';
    try { msg = await res.text(); } catch (e) {}
    if (res.status === 401) {
      localStorage.removeItem('teacher_token');
      showTeacherLock();
    }
    throw new Error(`${res.status} ${res.statusText}${msg ? ' - ' + msg : ''}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

const AdminAPI = {
  clearClass: (classPrefix, token) =>
    jsonFetch('/api/admin/clear-class', {
      method: 'POST',
      headers: { 'x-teacher-token': token },
      body: JSON.stringify({ classPrefix, mode: 'delete' })
    }),
  clearAll: (token) =>
    jsonFetch('/api/admin/clear-all', {
      method: 'POST',
      headers: { 'x-teacher-token': token },
      body: JSON.stringify({ mode: 'delete' })
    })
};

// 導出給 console 或其他模組呼叫
window.clearClassFromGame = async function (prefix) {
  const p = String(prefix || '').trim();
  const token = getTeacherToken();
  if (!token) { showTeacherLock(); alert('請先在教師後台輸入教師密碼。'); return; }
  if (!/^\d{3}$/.test(p)) { alert('請輸入班級前三碼（三碼，允許 0 開頭）'); return; }
  if (!confirm(`確認要清除 ${p} 班全部學生紀錄（含學號）？`)) return;

  try {
    await AdminAPI.clearClass(p, token);
    alert(`已清除 ${p} 班紀錄`);
    // 若遊戲頁也有排行榜刷新函式，可在此呼叫
    if (typeof refreshLeaderboard === 'function') refreshLeaderboard();
  } catch (e) {
    if (String(e.message).startsWith('401')) {
      alert('教師密碼錯誤或已過期，請回教師後台重新輸入。');
    } else {
      alert('清除失敗：' + e.message); // 會包含 400 的詳細原因
    }
  }
};

window.clearAllFromGame = async function () {
  const token = getTeacherToken();
  if (!token) { showTeacherLock(); alert('請先在教師後台輸入教師密碼。'); return; }
  if (!confirm('確認要「清除全部學生紀錄（含學號）」嗎？')) return;

  try {
    await AdminAPI.clearAll(token);
    alert('已清除全部學生紀錄');
    if (typeof refreshLeaderboard === 'function') refreshLeaderboard();
  } catch (e) {
    if (String(e.message).startsWith('401')) {
      alert('教師密碼錯誤或已過期，請回教師後台重新輸入。');
    } else {
      alert('清除失敗：' + e.message);
    }
  }
};

// 如果頁面上剛好有按鈕，幫你自動綁定（沒有也不會報錯）
(function autoBindAdminButtons(){
  const btnC = document.getElementById('btnClearClass');
  const btnA = document.getElementById('btnClearAll');
  const inputP = document.getElementById('classPrefix');
  if (btnC && inputP) {
    btnC.addEventListener('click', () => window.clearClassFromGame(inputP.value));
  }
  if (btnA) {
    btnA.addEventListener('click', () => window.clearAllFromGame());
  }
})();
