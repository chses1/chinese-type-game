// teacher.js — 獨立教師後台頁面

const API_BASE = "/api";
const $ = id => document.getElementById(id);
const toast = msg => { const t=$('toast'); if(!t) return; t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),1200); };

async function jsonFetch(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type":"application/json", ...(options.headers || {}) },
    ...options
  });
  if (!res.ok) {
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
    return jsonFetch(`${API_BASE}/admin/clear-class`, { method:"POST", headers:{ "x-teacher-token": token }, body:JSON.stringify({ classPrefix: prefix }) });
  },
  adminClearAll(token){
    return jsonFetch(`${API_BASE}/admin/clear-all`, { method:"POST", headers:{ "x-teacher-token": token } });
  }
};

// token 快取
function getToken(){ return localStorage.getItem('teacher-token') || ''; }
function setToken(v){ localStorage.setItem('teacher-token', v || ''); }

async function loadClasses(){
  try{
    const resp = await API.getClasses();
    const box = $('classList'); box.innerHTML = "";
    resp.data.forEach(c=>{
      const btn=document.createElement('button');
      btn.className='tag';
      btn.textContent=`${c.class}（${c.count}人，Top ${c.top}，Avg ${c.avg}）`;
      btn.onclick=()=>{ $('classPrefix').value=c.class; loadClassRank(); };
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
  if(!/^[1-9]\d{2}$/.test(p)){ alert('請輸入正確的班級前三碼（100–999，例如 301）'); return; }
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
  if(!token){ alert('請先於畫面頂部解鎖（輸入教師密碼）。'); return; }
  if(!/^[1-9]\d{2}$/.test(p)){ alert('請先輸入正確的班級前三碼（100–999，例如 301）'); return; }
  if(!confirm(`確認要清除 ${p} 班全部學生的最佳分數嗎？`)) return;
  try{
    await API.adminClearClass(p, token);
    toast(`已清除 ${p} 班`);
    await loadClassRank();
  }catch(e){
    alert('清除失敗：' + e.message);
  }
}
async function clearAll(){
  const token = getToken();
  if(!token){ alert('請先輸入教師密碼並按「套用密碼」。'); return; }
  if(!confirm('確認要清除「所有學生」的最佳分數嗎？')) return;
  try{ await API.adminClearAll(token); toast('已清除全部學生紀錄'); await loadAllRank(); }
  catch(e){ alert('清除失敗：' + e.message); }
}

// 綁定
$('btnLoadClasses').onclick = loadClasses;
$('btnShowAll').onclick     = loadAllRank;
$('btnLoadClassRank').onclick= loadClassRank;
$('btnClearClass').onclick  = clearClass;
$('btnClearAll').onclick    = clearAll;


// 初始：若無 token 先出現鎖定層
(function init(){
  const app   = document.getElementById('app');
  const lock  = document.getElementById('lock');
  const token = getToken();

  function unlock() {
  setToken( (document.getElementById('lockPass').value || '').trim() );
  if (!getToken()) { alert('請輸入教師密碼'); return; }
  lock.style.display = 'none';
  app.style.display  = '';
  loadClasses();
  loadAllRank();
  toast('已解鎖');
}

  // 綁定鎖定層按鈕
  const btnEnter = document.getElementById('lockEnter');
  if (btnEnter) btnEnter.onclick = unlock;

  if (!token) {
    // 無密碼 → 顯示鎖，隱藏主畫面
    lock.style.display = 'flex';
    app.style.display  = 'none';
  } else {
    // 已有密碼 → 直接載入
    app.style.display  = '';
    document.getElementById('tpass').value = token;
    loadClasses(); 
    loadAllRank();
  }
})();
