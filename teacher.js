// teacher.js — 修正版（補齊 API.leaderboard / API.getClasses、統一 token key）

const API_BASE = "/api";
const $ = id => document.getElementById(id);
const toast = msg => { const t=$('toast'); if(!t) return; t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),1200); };

// ✅ 統一 localStorage key（全檔一致用同一把）
const TOKEN_KEY = 'teacher-token';
function getToken(){ return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(v){ localStorage.setItem(TOKEN_KEY, v || ''); }

function showLock(){ const lock=$('lock'), app=$('app'); if(lock&&app){ lock.style.display='flex'; app.style.display='none'; } }
function hideLock(){ const lock=$('lock'), app=$('app'); if(lock&&app){ lock.style.display='none'; app.style.display=''; } }

// 共用 fetch（會把 4xx/5xx 的訊息吐出來）
async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, {
    cache: 'no-store',
    ...opts,
    headers: { 'Content-Type':'application/json', ...(opts.headers||{}) },
  });
  if (!res.ok) {
    let msg = ''; try { msg = await res.text(); } catch {}
    if (res.status === 401) { localStorage.removeItem(TOKEN_KEY); showLock && showLock(); }
    throw new Error(`${res.status} ${res.statusText}${msg ? ' - ' + msg : ''}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// ✅ 補齊缺少的 API 函式
const API = {
  // 排行榜：?limit=10&classPrefix=301（classPrefix 可省略）
  leaderboard(limit = 10, classPrefix = "") {
    const qs = new URLSearchParams({ limit });
    if (classPrefix) qs.set('classPrefix', classPrefix);
    return jsonFetch(`${API_BASE}/leaderboard?` + qs.toString());
  },
  // 班級統計列表
  getClasses() {
    return jsonFetch(`${API_BASE}/classes`);
  },
  // 管理清除
  adminClearClass(classPrefix, token){
    return jsonFetch(`${API_BASE}/admin/clear-class`, {
      method:'POST',
      headers:{ 'x-teacher-token': token },
      body: JSON.stringify({ classPrefix, mode:'delete' })
    });
  },
  adminClearAll(token){
    return jsonFetch(`${API_BASE}/admin/clear-all`, {
      method:'POST',
      headers:{ 'x-teacher-token': token },
      body: JSON.stringify({ mode:'delete' })
    });
  },
  classroomState(){
    return jsonFetch(`${API_BASE}/classroom/state?t=${Date.now()}`);
  },
  classroomOpen(classPrefix, token){
    return jsonFetch(`${API_BASE}/admin/classroom/open`, {
      method:'POST',
      headers:{ 'x-teacher-token': token },
      body: JSON.stringify({ classPrefix })
    });
  },
  classroomStart(classPrefix, countdownSec, token){
    return jsonFetch(`${API_BASE}/admin/classroom/start`, {
      method:'POST',
      headers:{ 'x-teacher-token': token },
      body: JSON.stringify({ classPrefix, countdownSec })
    });
  },
  classroomPause(token){
    return jsonFetch(`${API_BASE}/admin/classroom/pause`, {
      method:'POST',
      headers:{ 'x-teacher-token': token },
      body: JSON.stringify({})
    });
  },
  classroomRestart(countdownSec, token){
    return jsonFetch(`${API_BASE}/admin/classroom/restart`, {
      method:'POST',
      headers:{ 'x-teacher-token': token },
      body: JSON.stringify({ countdownSec })
    });
  },
  classroomClose(token){
    return jsonFetch(`${API_BASE}/admin/classroom/close`, {
      method:'POST',
      headers:{ 'x-teacher-token': token },
      body: JSON.stringify({})
    });
  },
};


let classroomTimer = null;

function syncCcClassPrefix(v){
  if ($('ccClassPrefix')) $('ccClassPrefix').value = v || '';
}

function renderClassroomState(s){
  const box = $('ccState');
  if (!box) return;
  if (!s?.enabled) { box.textContent = '未開啟'; return; }
  let text = `班級 ${s.classPrefix}｜`;
  if (s.status === 'countdown') {
    const sec = Math.max(0, Math.ceil(((s.startAt || 0) - (s.now || Date.now())) / 1000));
    text += `倒數中 ${sec} 秒`;
  } else if (s.status === 'running') {
    text += '進行中';
  } else if (s.status === 'paused') {
    text += '已暫停';
  } else {
    text += '等待開始';
  }
  box.textContent = text;
}

async function refreshClassroomState(){
  try {
    const resp = await API.classroomState();
    const s = resp.data;
    renderClassroomState(s);
    if (s?.enabled && /^\d{3}$/.test(s.classPrefix)) {
      if ($('classPrefix')) $('classPrefix').value = s.classPrefix;
      syncCcClassPrefix(s.classPrefix);
      await loadClassRank();
    }
  } catch (e) {
    console.warn('classroom state fail', e);
  }
}

function startClassroomPolling(){
  clearInterval(classroomTimer);
  classroomTimer = setInterval(refreshClassroomState, 2000);
  refreshClassroomState();
}

async function ccOpen(){
  const token = getToken();
  const p = ($('ccClassPrefix')?.value || $('classPrefix')?.value || '').trim();
  if (!token) return alert('請先輸入教師密碼');
  if (!/^\d{3}$/.test(p)) return alert('請輸入班級前三碼');
  await API.classroomOpen(p, token);
  if ($('classPrefix')) $('classPrefix').value = p;
  syncCcClassPrefix(p);
  toast(`已開啟 ${p} 班競賽`);
  await refreshClassroomState();
}

async function ccStart(){
  const token = getToken();
  const p = ($('ccClassPrefix')?.value || $('classPrefix')?.value || '').trim();
  const countdownSec = Number(($('ccCountdown')?.value) || 3);
  if (!token) return alert('請先輸入教師密碼');
  if (!/^\d{3}$/.test(p)) return alert('請輸入班級前三碼');
  await API.classroomStart(p, countdownSec, token);
  if ($('classPrefix')) $('classPrefix').value = p;
  syncCcClassPrefix(p);
  toast('全班開始倒數');
  await refreshClassroomState();
}

async function ccPause(){
  const token = getToken();
  if (!token) return alert('請先輸入教師密碼');
  await API.classroomPause(token);
  toast('已全班暫停');
  await refreshClassroomState();
}

async function ccRestart(){
  const token = getToken();
  const countdownSec = Number(($('ccCountdown')?.value) || 3);
  if (!token) return alert('請先輸入教師密碼');
  if (!confirm('確定要讓全班重新開始嗎？目前分數會從 0 重新計算。')) return;
  await API.classroomRestart(countdownSec, token);
  toast('全班重新倒數');
  await refreshClassroomState();
}

async function ccClose(){
  const token = getToken();
  if (!token) return alert('請先輸入教師密碼');
  if (!confirm('確定要結束班級競賽嗎？學生會回到自由練習模式。')) return;
  await API.classroomClose(token);
  toast('已結束競賽');
  await refreshClassroomState();
}

// ====== UI 動作 ======
async function loadClasses(){
  try{
    const resp = await API.getClasses();
    const box = $('classList'); if (!box) return;
    box.innerHTML = "";
    resp.data.forEach(c=>{
      const btn=document.createElement('button');
      btn.className='tag';
      btn.textContent=`${c.class}（${c.count}人，Top ${c.top}，Avg ${c.avg}）`;
      btn.onclick=()=>{ $('classPrefix').value=c.class; $('classPrefix').dispatchEvent(new Event('input',{bubbles:true})); loadClassRank(); };
      box.appendChild(btn);
    });
  }catch(e){ toast('載入班級清單失敗'); console.warn(e); }
}

async function loadAllRank(){
  const limit = Number(($('lbLimit')?.value) || 20);
  const tb = $('teacherLbBody'); if (!tb) return;
  tb.innerHTML = "";
  try {
    const resp = await API.leaderboard(limit);
    tb.innerHTML = resp.data.map((r,i)=>`<tr><td>${i+1}</td><td>${r.sid}</td><td>${r.best}</td></tr>`).join('');
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="3">讀取失敗：${e.message}</td></tr>`;
  }
}

async function loadClassRank(){
  const p = ($('classPrefix')?.value || '').trim();
  if(!/^\d{3}$/.test(p)){ alert('請先輸入班級前三碼（三碼，允許 0 開頭）'); return; }
  const limit = Number(($('lbLimit')?.value) || 20);
  const tb = $('teacherLbBody'); if (!tb) return;
  tb.innerHTML = "";
  try {
    const resp = await API.leaderboard(limit, p);
    tb.innerHTML = resp.data.map((r,i)=>`<tr><td>${i+1}</td><td>${r.sid}</td><td>${r.best}</td></tr>`).join('');
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="3">讀取失敗：${e.message}</td></tr>`;
  }
}

// 清除（單班 / 全部）
async function clearClass(){
  const p = ($('classPrefix')?.value || '').trim();
  const token = getToken();
  if(!token){ showLock(); alert('請先輸入教師密碼。'); return; }
  if(!/^\d{3}$/.test(p)){ alert('請輸入班級前三碼（三碼，允許 0 開頭）'); return; }
  if(!confirm(`確認要清除 ${p} 班全部學生紀錄（含學號）？`)) return;
  try { await API.adminClearClass(p, token); toast(`已清除 ${p} 班`); await loadClassRank(); }
  catch(e){ if(String(e.message).startsWith('401')) alert('教師密碼錯誤或已過期，請重新輸入。'); else alert('清除失敗：'+e.message); }
}
async function clearAll(){
  const token = getToken();
  if(!token){ showLock(); alert('請先輸入教師密碼。'); return; }
  if(!confirm('確認要「清除全部學生紀錄（含學號）」嗎？')) return;
  try { await API.adminClearAll(token); toast('已清除全部學生紀錄'); await loadAllRank(); }
  catch(e){ if(String(e.message).startsWith('401')) alert('教師密碼錯誤或已過期，請重新輸入。'); else alert('清除失敗：'+e.message); }
}

// 綁定
$('btnLoadClasses')  && ($('btnLoadClasses').onclick = loadClasses);
$('btnShowAll')      && ($('btnShowAll').onclick     = loadAllRank);
$('btnLoadClassRank')&& ($('btnLoadClassRank').onclick= loadClassRank);
$('btnClearClass')   && ($('btnClearClass').onclick  = clearClass);
$('btnClearAll')     && ($('btnClearAll').onclick    = clearAll);
$('btnCcOpen')       && ($('btnCcOpen').onclick      = ()=>ccOpen().catch(e=>alert('開啟班級競賽失敗：'+e.message)));
$('btnCcStart')      && ($('btnCcStart').onclick     = ()=>ccStart().catch(e=>alert('全班開始失敗：'+e.message)));
$('btnCcPause')      && ($('btnCcPause').onclick     = ()=>ccPause().catch(e=>alert('全班暫停失敗：'+e.message)));
$('btnCcRestart')    && ($('btnCcRestart').onclick   = ()=>ccRestart().catch(e=>alert('全班重來失敗：'+e.message)));
$('btnCcClose')      && ($('btnCcClose').onclick     = ()=>ccClose().catch(e=>alert('結束競賽失敗：'+e.message)));

// 🔒 鎖定流程
(function init(){
  const ipt = $('classPrefix'), btn = $('btnClearClass');
  const toggle = () => { if(btn && ipt) btn.disabled = !/^\d{3}$/.test((ipt.value||'').trim()); };
  ipt && ipt.addEventListener('input', toggle); toggle();

  $('lockEnter') && ($('lockEnter').onclick = () => {
    const v = ($('lockPass')?.value || '').trim();
    if (!v) return alert('請輸入教師密碼');
    setToken(v); hideLock(); loadClasses(); loadAllRank(); startClassroomPolling(); toast('已解鎖');
  });
  $('btnRelock') && ($('btnRelock').onclick = () => { setToken(''); clearInterval(classroomTimer); showLock(); if($('lockPass')) $('lockPass').value=''; });

  // 開啟頁面：有 token 就直接載入，沒有就先鎖住
  if ($('classPrefix') && $('ccClassPrefix')) {
    $('classPrefix').addEventListener('input', ()=> syncCcClassPrefix(($('classPrefix').value||'').trim()));
    $('ccClassPrefix').addEventListener('input', ()=> { if ($('classPrefix')) $('classPrefix').value = ($('ccClassPrefix').value||'').trim(); });
  }
  if (getToken()) { hideLock(); loadClasses(); loadAllRank(); startClassroomPolling(); } else { showLock(); }
})();
