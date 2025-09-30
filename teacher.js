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

// 建議：集中一個 fetch 包裝，能把 4xx/5xx 的訊息吐出來
async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',    // 關鍵 1：一定帶 JSON
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    // 讀出後端丟回的錯誤訊息（例如缺欄位、驗證失敗），幫助判斷 400 的真正原因
    let msg = '';
    try { msg = await res.text(); } catch (_) {}
    // 401：清除 token 並顯示鎖
    if (res.status === 401) {
      localStorage.removeItem('teacher_token');
      showLock && showLock();
    }
    throw new Error(`${res.status} ${res.statusText}${msg ? ' - ' + msg : ''}`);
  }
  // 嘗試解析 JSON；若不是 JSON 也要容錯
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// API 介面：請確認路徑名稱與你的 server 一致
const API = {
  adminClearClass: (classPrefix, token) =>
    jsonFetch('/api/admin/clear-class', {
      method: 'POST',
      headers: { 'x-teacher-token': token }, // 關鍵 2：一定帶 token
      // 關鍵 3：欄位名採通用命名；若後端用別名（如 prefix / cls / p），錯誤訊息會 alert 出來
      body: JSON.stringify({ classPrefix, mode: 'delete' })
    }),
  adminClearAll: (token) =>
    jsonFetch('/api/admin/clear-all', {
      method: 'POST',
      headers: { 'x-teacher-token': token },
      body: JSON.stringify({ mode: 'delete' })
    }),
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

// 事件：清除單一班級
async function clearClass(){
  const p = $('classPrefix').value.trim();
  const token = getToken();
  if(!token){ showLock(); alert('請先輸入教師密碼。'); return; }
  if(!/^\d{3}$/.test(p)){ alert('請輸入班級前三碼（三碼，允許 0 開頭）'); return; }
  if(!confirm(`確認要清除 ${p} 班全部學生紀錄（含學號）？`)) return;

  try {
    await API.adminClearClass(p, token);
    toast(`已清除 ${p} 班`);
    await loadClassRank();
  } catch (e) {
    if (String(e.message).startsWith('401')) {
      alert('教師密碼錯誤或已過期，請重新輸入。');
    } else {
      alert('清除失敗：' + e.message); // 400 會包含後端提示（缺欄位/欄位名錯誤）
    }
  }
}

// 事件：清除全部
async function clearAll(){
  const token = getToken();
  if(!token){ showLock(); alert('請先輸入教師密碼。'); return; }
  if(!confirm('確認要「清除全部學生紀錄（含學號）」嗎？')) return;

  try {
    await API.adminClearAll(token);
    toast('已清除全部學生紀錄');
    await loadAllRank();
  } catch (e) {
    if (String(e.message).startsWith('401')) {
      alert('教師密碼錯誤或已過期，請重新輸入。');
    } else {
      alert('清除失敗：' + e.message);
    }
  }
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
