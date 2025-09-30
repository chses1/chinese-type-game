// teacher.js — 獨立教師後台頁面（覆蓋版）

const API_BASE = "/api";
const $ = id => document.getElementById(id);
const toast = msg => { const t=$('toast'); if(!t) return; t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),1200); };

function getToken(){ return localStorage.getItem('teacher-token') || ''; }
function setToken(v){ localStorage.setItem('teacher-token', v || ''); }

function showLock(){
  const lock = $('lock'), app = $('app');
  if (lock && app){ lock.style.display = 'flex'; app.style.display = 'none'; }
}
function hideLock(){
  const lock = $('lock'), app = $('app');
  if (lock && app){ lock.style.display = 'none'; app.style.display = ''; }
}

async function jsonFetch(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type":"application/json", ...(options.headers || {}) },
    ...options
  });
  if (!res.ok) {
    // 🔒 若未授權，清 token、顯示鎖
    if (res.status === 401) { setToken(''); showLock(); }
    let d=""; try { d = JSON.stringify(await res.json()); } catch {}
    throw new Error(`HTTP ${res.status} ${res.statusText} ${d}`);
  }
  return res.json();
}

const API = {
  leaderboard(limit=10, classPrefix=""){
    const qs=new URLSearchParams({limit}); if(classPrefix) qs.set("classPrefix", classPrefix);
    return jsonFetch(`${API_BASE}/leaderboard?`+qs.toString());
  },
  getClasses(){ return jsonFetch(`${API_BASE}/classes`); },
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

async function loadClasses(){
  try{
    const resp = await API.getClasses();
    const box = $('classList'); box.innerHTML = "";
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
  const limit = Number($('lbLimit').value || 20);
  const tb = $('teacherLbBody'); tb.innerHTML = "";
  try {
    const resp = await API.leaderboard(limit);
    tb.innerHTML = resp.data.map((r,i)=>`<tr><td>${i+1}</td><td>${r.sid}</td><td>${r.best}</td></tr>`).join('');
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="3">讀取失敗：${e.message}</td></tr>`;
  }
}

async function loadClassRank(){
  const p = $('classPrefix').value.trim();
  if(!/^\d{3}$/.test(p)){ alert('請先輸入班級前三碼（三碼，允許 0 開頭）'); return; }
  const limit = Number($('lbLimit').value || 20);
  const tb = $('teacherLbBody'); tb.innerHTML = "";
  try {
    const resp = await API.leaderboard(limit, p);
    tb.innerHTML = resp.data.map((r,i)=>`<tr><td>${i+1}</td><td>${r.sid}</td><td>${r.best}</td></tr>`).join('');
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="3">讀取失敗：${e.message}</td></tr>`;
  }
}

async function clearClass(){
  const p = $('classPrefix').value.trim();
  const token = getToken();
  if(!token){ showLock(); alert('請先輸入教師密碼。'); return; }
  if(!/^\d{3}$/.test(p)){ alert('請先輸入班級前三碼（三碼，允許 0 開頭）'); return; }
  if(!confirm(`確認要清除 ${p} 班「全部學生紀錄（含學號）」嗎？`)) return;
  await API.adminClearClass(p, token);
  toast(`已清除 ${p} 班`);
  await loadClassRank();
}

async function clearAll(){
  const token = getToken();
  if(!token){ showLock(); alert('請先輸入教師密碼。'); return; }
  if(!confirm('確認要「清除全部學生紀錄（含學號）」嗎？')) return;
  await API.adminClearAll(token);
  toast('已清除全部學生紀錄');
  await loadAllRank();
}

// 綁定
$('btnLoadClasses').onclick   = loadClasses;
$('btnShowAll').onclick       = loadAllRank;
$('btnLoadClassRank').onclick = loadClassRank;
$('btnClearClass').onclick    = clearClass;
$('btnClearAll').onclick      = clearAll;

// 🔒 鎖定流程
(function init(){
  // 清除鍵與輸入鎖
  const ipt = $('classPrefix');
  const btn = $('btnClearClass');
  const toggle = () => { if(btn) btn.disabled = !/^\d{3}$/.test((ipt.value||'').trim()); };
  ipt.addEventListener('input', toggle); toggle();

  $('lockEnter').onclick = () => {
    const v = ($('lockPass').value || '').trim();
    if (!v) return alert('請輸入教師密碼');
    setToken(v);
    hideLock();
    loadClasses(); loadAllRank();
    toast('已解鎖');
  };

  $('btnRelock').onclick = () => { setToken(''); showLock(); $('lockPass').value=''; };

  // 啟動時決定是否鎖住
  if (getToken()) { hideLock(); loadClasses(); loadAllRank(); }
  else { showLock(); }
})();
