
const API_BASE = "/api";
const $ = id => document.getElementById(id);
const TOKEN_KEY = 'teacher-session-token';
const ACTION_COOLDOWN_MS = 8000;
const POLL_INTERVAL_MS = 5000;
const CLASS_LIST_REFRESH_MS = 30000;

const state = {
  classroom: null,
  classes: [],
  onlineRows: [],
  liveRows: [],
  pollTimer: null,
  eventCooldownUntil: 0,
  missionCooldownUntil: 0,
  lastClassesFetchAt: 0,
};

const toast = msg => {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove('show'), 1400);
};

function getToken(){ return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(v){ if (v) localStorage.setItem(TOKEN_KEY, v); else localStorage.removeItem(TOKEN_KEY); }
function showLock(){ if ($('lock')) $('lock').style.display = 'flex'; if ($('app')) $('app').style.display = 'none'; }
function hideLock(){ if ($('lock')) $('lock').style.display = 'none'; if ($('app')) $('app').style.display = ''; }

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, {
    cache: 'no-store',
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) {
    let msg = '';
    try { msg = await res.text(); } catch {}
    if (res.status === 401) {
      setToken('');
      showLock();
    }
    throw new Error(`${res.status} ${res.statusText}${msg ? ' - ' + msg : ''}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

const authHeaders = token => token ? { 'x-admin-session': token } : {};
const API = {
  adminLogin(password){ return jsonFetch(`${API_BASE}/admin/login`, { method:'POST', body: JSON.stringify({ password }) }); },
  getClasses(forceRefresh = false){ return jsonFetch(`${API_BASE}/classes${forceRefresh ? '?refresh=1' : ''}`); },
  leaderboard(limit = 500, classPrefix = '') {
    const qs = new URLSearchParams({ limit });
    if (classPrefix) qs.set('classPrefix', classPrefix);
    return jsonFetch(`${API_BASE}/leaderboard?${qs.toString()}`);
  },
  classroomState(){ return jsonFetch(`${API_BASE}/classroom/state?t=${Date.now()}`); },
  onlineStudents(classPrefix, token){
    const qs = new URLSearchParams();
    if (classPrefix) qs.set('classPrefix', classPrefix);
    return jsonFetch(`${API_BASE}/admin/online-students?${qs.toString()}`, { headers: authHeaders(token) });
  },
  liveLeaderboard(classPrefix, limit, token){
    const qs = new URLSearchParams();
    if (classPrefix) qs.set('classPrefix', classPrefix);
    if (limit) qs.set('limit', limit);
    return jsonFetch(`${API_BASE}/admin/live-leaderboard?${qs.toString()}`, { headers: authHeaders(token) });
  },
  adminClearClass(classPrefix, token){
    return jsonFetch(`${API_BASE}/admin/clear-class`, { method:'POST', headers: authHeaders(token), body: JSON.stringify({ classPrefix, mode:'delete' }) });
  },
  adminClearAll(token){
    return jsonFetch(`${API_BASE}/admin/clear-all`, { method:'POST', headers: authHeaders(token), body: JSON.stringify({ mode:'delete' }) });
  },
  adminDeleteStudent(sid, token){
    return jsonFetch(`${API_BASE}/admin/delete-student`, { method:'POST', headers: authHeaders(token), body: JSON.stringify({ sid }) });
  },
  classroomOpen(classPrefix, token){
    return jsonFetch(`${API_BASE}/admin/classroom/open`, { method:'POST', headers: authHeaders(token), body: JSON.stringify({ classPrefix }) });
  },
  classroomStart(classPrefix, countdownSec, token){
    return jsonFetch(`${API_BASE}/admin/classroom/start`, { method:'POST', headers: authHeaders(token), body: JSON.stringify({ classPrefix, countdownSec }) });
  },
  classroomPause(token){
    return jsonFetch(`${API_BASE}/admin/classroom/pause`, { method:'POST', headers: authHeaders(token), body: JSON.stringify({}) });
  },
  classroomRestart(countdownSec, token){
    return jsonFetch(`${API_BASE}/admin/classroom/restart`, { method:'POST', headers: authHeaders(token), body: JSON.stringify({ countdownSec }) });
  },
  classroomClose(token){
    return jsonFetch(`${API_BASE}/admin/classroom/close`, { method:'POST', headers: authHeaders(token), body: JSON.stringify({}) });
  },
  classroomTriggerEvent(eventId, token){
    return jsonFetch(`${API_BASE}/admin/classroom/trigger-event`, { method:'POST', headers: authHeaders(token), body: JSON.stringify({ eventId }) });
  },
  classroomAssignMission(missionId, token){
    return jsonFetch(`${API_BASE}/admin/classroom/assign-mission`, { method:'POST', headers: authHeaders(token), body: JSON.stringify({ missionId }) });
  },
};

function switchTab(name){
  document.querySelectorAll('.tabBtn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === name));
  document.querySelectorAll('.tabPanel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
}

function formatAgo(ts){
  const t = new Date(ts || 0).getTime();
  if (!t) return '—';
  const diff = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diff < 1) return '剛剛';
  if (diff < 60) return `${diff} 秒前`;
  return `${Math.floor(diff / 60)} 分前`;
}

function syncClassInputs(v){
  const value = (v || '').trim();
  if ($('classPrefix')) $('classPrefix').value = value;
  if ($('ccClassPrefix')) $('ccClassPrefix').value = value;
}

function getSelectedClassPrefix(){
  const cc = ($('ccClassPrefix')?.value || '').trim();
  const cp = ($('classPrefix')?.value || '').trim();
  return /^\d{3}$/.test(cc) ? cc : (/^\d{3}$/.test(cp) ? cp : '');
}

function renderStateBadge(classroom){
  const el = $('ccStateBadge');
  if (!el) return;
  if (!classroom?.enabled) {
    el.className = 'stateBadge idle';
    el.textContent = '未開啟';
    return;
  }
  const status = String(classroom.status || 'idle');
  const now = Number(classroom.now || Date.now());
  let text = `班級 ${classroom.classPrefix || '—'}｜`;
  if (status === 'countdown') {
    const sec = Math.max(0, Math.ceil(((classroom.startAt || 0) - now) / 1000));
    text += `倒數中 ${sec} 秒`;
  } else if (status === 'running') {
    text += '進行中';
  } else if (status === 'paused') {
    text += '已暫停';
  } else {
    text += '等待開始';
  }
  el.className = `stateBadge ${status}`;
  el.textContent = text;
}

function humanEventName(id){
  return ({ meteorShower:'☄️ 流星雨', iceWind:'🧊 冰風暴', goldRush:'✨ 黃金時刻', bossWave:'👾 Boss 波次' }[id] || '目前無事件');
}
function humanMissionName(id){
  return ({ goldHunter:'✨ 黃金獵人', iceBreaker:'❄️ 冰凍專家', comboMaster:'🔥 連擊高手', quickShot:'⚡ 快速反應', bossBreaker:'👾 Boss 剋星' }[id] || '目前無指定任務');
}

function renderHud(){
  const c = state.classroom || {};
  $('hudClass').textContent = c.enabled ? (c.classPrefix || '—') : '—';
  $('hudStatus').textContent = !c.enabled ? '未開啟' : ({ idle:'等待開始', countdown:'倒數中', running:'進行中', paused:'已暫停' }[c.status] || c.status || '未開啟');
  $('hudOnline').textContent = String(state.onlineRows.length || 0);
  $('hudLeader').textContent = state.liveRows.length ? `${state.liveRows[0].sid}｜${Number(state.liveRows[0].currentScore || 0)} 分` : '—';
  renderStateBadge(c);

  const eventName = c?.forcedEventId ? humanEventName(c.forcedEventId) : '目前無事件';
  const missionName = c?.forcedMissionId ? humanMissionName(c.forcedMissionId) : '目前無指定任務';
  $('activeEventText').textContent = eventName;
  $('activeMissionText').textContent = missionName;

  let hint = '老師可在「戰情總覽」直接完成競賽控制，並在右側戰術派送區派送事件卡或任務卡。';
  if (c?.forcedEventIssuedAt || c?.forcedMissionIssuedAt) {
    const parts = [];
    if (c.forcedEventIssuedAt) parts.push(`事件更新於 ${formatAgo(c.forcedEventIssuedAt)}`);
    if (c.forcedMissionIssuedAt) parts.push(`任務更新於 ${formatAgo(c.forcedMissionIssuedAt)}`);
    hint = parts.join('｜');
  }
  $('directiveHint').textContent = hint;
}

function renderRankRows(rows){
  const body = $('liveRankBody');
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5">目前沒有即時競賽資料</td></tr>';
    return;
  }
  body.innerHTML = rows.map((r, i) => `
    <tr class="${i===0?'top1':i===1?'top2':i===2?'top3':''}">
      <td>${i+1}</td>
      <td>${r.sid}</td>
      <td>${Number(r.currentScore || 0)}</td>
      <td>${Number(r.best || 0)}</td>
      <td>${r.onlineStatus || 'online'}</td>
    </tr>`).join('');
}

function renderOnlineRows(rows){
  const body = $('onlineStudentsBody');
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5">目前沒有學生在線</td></tr>';
    return;
  }
  body.innerHTML = rows.map((r, i) => `
    <tr>
      <td>${i+1}</td>
      <td>${r.sid}</td>
      <td>${Number(r.currentScore || 0)}</td>
      <td>${r.onlineStatus || 'online'}</td>
      <td>${formatAgo(r.lastSeenAt)}</td>
    </tr>`).join('');
}

function renderClassRankRows(rows){
  const body = $('teacherLbBody');
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5">目前沒有排行榜資料</td></tr>';
    return;
  }
  body.innerHTML = rows.map((r, i) => `
    <tr>
      <td>${i+1}</td>
      <td>${r.sid}</td>
      <td>${Number(r.best || 0)}</td>
      <td>${Number(r.bestLevel || 0) > 0 ? `第 ${Number(r.bestLevel)} 關` : '—'}</td>
      <td><button class="ghost btnDeleteStudent" data-sid="${r.sid}">刪除</button></td>
    </tr>`).join('');

  body.querySelectorAll('.btnDeleteStudent').forEach(btn => {
    btn.addEventListener('click', () => deleteStudent(btn.dataset.sid).catch(err => alert(err.message)));
  });
}

function renderClassChips(classes = []){
  const box = $('classList');
  const toggle = $('btnToggleClasses');
  if (!box) return;
  box.innerHTML = '';
  state.classes = classes;
  classes.forEach((c, index) => {
    const btn = document.createElement('button');
    btn.className = 'tag' + (index >= 8 ? ' extraChip' : '');
    btn.textContent = `${c.class}｜${c.count}人｜Top ${c.top}`;
    btn.onclick = () => {
      syncClassInputs(c.class);
      loadClassRank();
      toast(`已選取 ${c.class} 班`);
    };
    box.appendChild(btn);
  });
  const needToggle = classes.length > 8;
  if (toggle) {
    toggle.style.display = needToggle ? 'inline-flex' : 'none';
    toggle.textContent = box.classList.contains('collapsed') ? '展開全部班級' : '收合班級清單';
  }
}

function updateCooldownButtons(){
  const now = Date.now();
  const eventRemain = Math.max(0, state.eventCooldownUntil - now);
  const missionRemain = Math.max(0, state.missionCooldownUntil - now);
  document.querySelectorAll('.eventBtn').forEach(btn => {
    const disabled = eventRemain > 0;
    btn.classList.toggle('cooling', disabled);
    btn.disabled = disabled;
    const label = btn.dataset.originalLabel || btn.querySelector('span')?.textContent || btn.textContent;
    if (!btn.dataset.originalLabel) btn.dataset.originalLabel = label;
    if (btn.querySelector('span')) btn.querySelector('span').textContent = disabled ? `${label}（${Math.ceil(eventRemain / 1000)}秒）` : label;
  });
  document.querySelectorAll('.missionBtn').forEach(btn => {
    const disabled = missionRemain > 0;
    btn.classList.toggle('cooling', disabled);
    btn.disabled = disabled;
    const label = btn.dataset.originalLabel || btn.querySelector('span')?.textContent || btn.textContent;
    if (!btn.dataset.originalLabel) btn.dataset.originalLabel = label;
    if (btn.querySelector('span')) btn.querySelector('span').textContent = disabled ? `${label}（${Math.ceil(missionRemain / 1000)}秒）` : label;
  });
}
setInterval(updateCooldownButtons, 500);

async function loadClasses(){
  const resp = await API.getClasses();
  renderClassChips(resp.data || []);
}

async function loadClassRank(){
  const prefix = ($('classPrefix')?.value || '').trim();
  if (!/^\d{3}$/.test(prefix)) return alert('請輸入正確的班級前三碼');
  const resp = await API.leaderboard(500, prefix);
  renderClassRankRows(resp.data || []);
}

async function loadAllRank(){
  const resp = await API.leaderboard(500);
  renderClassRankRows(resp.data || []);
}

async function loadAdminRealtime(){
  const token = getToken();
  if (!token) return;
  const prefix = getSelectedClassPrefix();
  const limit = Number(($('lbLimit')?.value) || 10);
  const [onlineResp, liveResp] = await Promise.all([
    API.onlineStudents(prefix, token),
    API.liveLeaderboard(prefix, limit, token),
  ]);
  state.onlineRows = onlineResp.data || [];
  state.liveRows = liveResp.data || [];
  renderOnlineRows(state.onlineRows);
  renderRankRows(state.liveRows);
}

async function refreshAll({ forceClasses = false } = {}){
  const shouldRefreshClasses = forceClasses || !state.lastClassesFetchAt || (Date.now() - state.lastClassesFetchAt >= CLASS_LIST_REFRESH_MS);

  const classroomResp = await API.classroomState();
  state.classroom = classroomResp.data || null;
  if (state.classroom?.enabled && /^\d{3}$/.test(state.classroom.classPrefix || '')) syncClassInputs(state.classroom.classPrefix);

  if (shouldRefreshClasses) {
    const classesResp = await API.getClasses(forceClasses);
    state.classes = classesResp.data || [];
    state.lastClassesFetchAt = Date.now();
    renderClassChips(state.classes);
  } else if (Array.isArray(state.classes)) {
    renderClassChips(state.classes);
  }

  await loadAdminRealtime();
  renderHud();
}

function ensureTeacherReady(){
  const token = getToken();
  if (!token) throw new Error('請先輸入教師密碼');
  const prefix = getSelectedClassPrefix();
  if (!/^\d{3}$/.test(prefix)) throw new Error('請先輸入班級前三碼');
  return { token, prefix };
}

async function onOpen(){ const { token, prefix } = ensureTeacherReady(); await API.classroomOpen(prefix, token); toast(`已開啟 ${prefix} 班競賽`); await refreshAll(); }
async function onStart(){ const { token, prefix } = ensureTeacherReady(); const sec = Number(($('ccCountdown')?.value) || 3); await API.classroomStart(prefix, sec, token); toast('全班開始倒數'); await refreshAll(); }
async function onPause(){ const token = getToken(); if (!token) throw new Error('請先輸入教師密碼'); await API.classroomPause(token); toast('已全班暫停'); await refreshAll(); }
async function onRestart(){ const token = getToken(); if (!token) throw new Error('請先輸入教師密碼'); if (!confirm('確定讓全班重新開始嗎？目前分數會從 0 重新計算。')) return; const sec = Number(($('ccCountdown')?.value) || 3); await API.classroomRestart(sec, token); toast('全班重新倒數'); await refreshAll(); }
async function onClose(){ const token = getToken(); if (!token) throw new Error('請先輸入教師密碼'); if (!confirm('確定結束班級競賽嗎？學生會回到自由練習模式。')) return; await API.classroomClose(token); toast('已結束競賽'); await refreshAll(); }

async function onTriggerEvent(eventId){
  const token = getToken();
  if (!token) throw new Error('請先輸入教師密碼');
  if (!(state.classroom?.enabled)) throw new Error('請先開啟班級競賽');
  await API.classroomTriggerEvent(eventId, token);
  state.eventCooldownUntil = Date.now() + ACTION_COOLDOWN_MS;
  updateCooldownButtons();
  toast(`已派送 ${humanEventName(eventId)}`);
  await refreshAll();
}

async function onAssignMission(missionId){
  const token = getToken();
  if (!token) throw new Error('請先輸入教師密碼');
  if (!(state.classroom?.enabled)) throw new Error('請先開啟班級競賽');
  await API.classroomAssignMission(missionId, token);
  state.missionCooldownUntil = Date.now() + ACTION_COOLDOWN_MS;
  updateCooldownButtons();
  toast(`已派送 ${missionId === 'random' ? '🎲 隨機任務' : humanMissionName(missionId)}`);
  await refreshAll();
}

async function clearClass(){
  const token = getToken();
  const prefix = ($('classPrefix')?.value || '').trim();
  if (!token) return alert('請先輸入教師密碼');
  if (!/^\d{3}$/.test(prefix)) return alert('請先輸入班級前三碼');
  if (!confirm(`確認清除 ${prefix} 班全部紀錄（含學號）？`)) return;
  await API.adminClearClass(prefix, token);
  toast(`已清除 ${prefix} 班資料`);
  await refreshAll({ forceClasses:true });
  await loadClassRank();
}

async function clearAll(){
  const token = getToken();
  if (!token) return alert('請先輸入教師密碼');
  if (!confirm('確認清除全部學生紀錄（含學號）？')) return;
  await API.adminClearAll(token);
  toast('已清除全部學生紀錄');
  await refreshAll({ forceClasses:true });
  renderClassRankRows([]);
}


async function deleteStudent(sid){
  const token = getToken();
  if (!token) return alert('請先輸入教師密碼');
  if (!/^\d{5}$/.test(String(sid || '').trim())) return alert('學生學號格式錯誤');
  if (!confirm(`確認刪除學生 ${sid} 的成績資料？此動作無法復原。`)) return;
  await API.adminDeleteStudent(String(sid).trim(), token);
  toast(`已刪除 ${sid} 的成績`);
  await refreshAll({ forceClasses:true });
  const selectedPrefix = ($('classPrefix')?.value || '').trim();
  if (/^\d{3}$/.test(selectedPrefix)) await loadClassRank();
}

function startPolling(){
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => refreshAll().catch(err => console.warn(err)), POLL_INTERVAL_MS);
}

function bindEvents(){
  document.querySelectorAll('.tabBtn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  $('btnRefreshOverview')?.addEventListener('click', () => refreshAll({ forceClasses:true }).then(() => toast('已重新整理')).catch(err => alert(err.message)));
  $('btnLoadClasses')?.addEventListener('click', () => loadClasses().then(() => toast('已載入班級清單')).catch(err => alert(err.message)));
  $('btnShowAll')?.addEventListener('click', () => loadAllRank().catch(err => alert(err.message)));
  $('btnLoadClassRank')?.addEventListener('click', () => loadClassRank().catch(err => alert(err.message)));
  $('btnClearClass')?.addEventListener('click', () => clearClass().catch(err => alert(err.message)));
  $('btnClearAll')?.addEventListener('click', () => clearAll().catch(err => alert(err.message)));
  $('btnCcOpen')?.addEventListener('click', () => onOpen().catch(err => alert(err.message)));
  $('btnCcStart')?.addEventListener('click', () => onStart().catch(err => alert(err.message)));
  $('btnCcPause')?.addEventListener('click', () => onPause().catch(err => alert(err.message)));
  $('btnCcRestart')?.addEventListener('click', () => onRestart().catch(err => alert(err.message)));
  $('btnCcClose')?.addEventListener('click', () => onClose().catch(err => alert(err.message)));
  $('btnToggleClasses')?.addEventListener('click', () => {
    const box = $('classList');
    if (!box) return;
    box.classList.toggle('collapsed');
    $('btnToggleClasses').textContent = box.classList.contains('collapsed') ? '展開全部班級' : '收合班級清單';
  });
  $('classPrefix')?.addEventListener('input', e => { const v = e.target.value.replace(/\D/g, '').slice(0,3); e.target.value = v; if ($('ccClassPrefix')) $('ccClassPrefix').value = v; });
  $('ccClassPrefix')?.addEventListener('input', e => { const v = e.target.value.replace(/\D/g, '').slice(0,3); e.target.value = v; if ($('classPrefix')) $('classPrefix').value = v; });
  document.querySelectorAll('.eventBtn').forEach(btn => btn.addEventListener('click', () => onTriggerEvent(btn.dataset.event).catch(err => alert(err.message))));
  document.querySelectorAll('.missionBtn').forEach(btn => btn.addEventListener('click', () => onAssignMission(btn.dataset.mission).catch(err => alert(err.message))));

  $('lockEnter')?.addEventListener('click', async () => {
    const password = ($('lockPass')?.value || '').trim();
    if (!password) return alert('請輸入教師密碼');
    try {
      const resp = await API.adminLogin(password);
      setToken(resp?.data?.sessionToken || '');
      if ($('lockPass')) $('lockPass').value = '';
      hideLock();
      await refreshAll({ forceClasses:true });
      startPolling();
      toast('已解鎖');
    } catch {
      alert('教師密碼錯誤或伺服器驗證失敗');
      showLock();
    }
  });
}

(async function init(){
  bindEvents();
  const token = getToken();
  if (!token) { showLock(); return; }
  try {
    await API.onlineStudents('', token);
    hideLock();
    await refreshAll();
    startPolling();
  } catch {
    setToken('');
    showLock();
  }
})();
