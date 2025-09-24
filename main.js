
/* === Local DB (MVP) === */
const DB_KEY='zhuyin-meteor-v1';
const db=JSON.parse(localStorage.getItem(DB_KEY)||'{}'); if(!db.students) db.students={};
const saveDB=()=>localStorage.setItem(DB_KEY,JSON.stringify(db));
function upsertStudent(sid,name){ if(!db.students[sid]) db.students[sid]={name:name||'',best:0}; else if(name) db.students[sid].name=name; saveDB(); }
function updateBest(sid,score){ if(!db.students[sid]) return; if(score>(db.students[sid].best||0)){ db.students[sid].best=score; saveDB(); } }
const topN=(n=20)=>Object.entries(db.students).map(([sid,s])=>({sid,name:s.name||'',best:s.best||0})).sort((a,b)=>b.best-a.best).slice(0,n);
function clearAll(){ db.students={}; saveDB(); }

/* === Constants === */
const ZHUYIN=['ㄅ','ㄆ','ㄇ','ㄈ','ㄉ','ㄊ','ㄋ','ㄌ','ㄍ','ㄎ','ㄏ','ㄐ','ㄑ','ㄒ','ㄓ','ㄔ','ㄕ','ㄖ','ㄗ','ㄘ','ㄙ','ㄧ','ㄨ','ㄩ','ㄚ','ㄛ','ㄜ','ㄝ','ㄞ','ㄟ','ㄠ','ㄡ','ㄢ','ㄣ','ㄤ','ㄥ','ㄦ'];
const SHENGMU=new Set(['ㄅ','ㄆ','ㄇ','ㄈ','ㄉ','ㄊ','ㄋ','ㄌ','ㄍ','ㄎ','ㄏ','ㄐ','ㄑ','ㄒ','ㄓ','ㄔ','ㄕ','ㄖ','ㄗ','ㄘ','ㄙ']);
const MEDIAL=new Set(['ㄧ','ㄨ','ㄩ']);
const keyClass = ch => SHENGMU.has(ch) ? 'shengmu' : (MEDIAL.has(ch)?'medial':'yunmu');

/* === Level & threshold === */
let level=1;
const ACC_THRESHOLD=0.8; // 80%
const LEVELS=[{lpm:10,duration:60},{lpm:15,duration:60}];
const spawnInterval = () => Math.max(400, Math.round(60000/(LEVELS[level-1]||LEVELS.at(-1)).lpm));

/* === Canvas & state === */
const canvas=document.getElementById('gameCanvas');
const ctx=canvas.getContext('2d');
let W,H; function resize(){ const r=canvas.getBoundingClientRect(); W=canvas.width=Math.floor(r.width*2); H=canvas.height=Math.floor((window.innerHeight*0.58)*2);} resize();
addEventListener('resize',resize);

let meteors=[]; let running=false, score=0, timeLeft=(LEVELS[0].duration), spawnTimer=0;
let correct=0, wrong=0;
const qs=s=>document.querySelector(s);
const setUserChip=()=>document.getElementById('userChip').textContent=me.sid?`${me.sid}${me.name? '｜'+me.name:''}`:'未登入';
const setScore=()=>document.getElementById('score').textContent=score;
const setTime =()=>document.getElementById('time').textContent=timeLeft;
const setBest =()=>document.getElementById('best').textContent=(db.students[me.sid]?.best||0);
const toast = msg => { const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),900) }
let me={sid:null,name:''};

/* === Keyboard === */
function buildKeyboard(){
  const rows=[['ㄅ','ㄆ','ㄇ','ㄈ','ㄉ','ㄊ','ㄋ','ㄌ','ㄍ','ㄎ','ㄏ'],
              ['ㄐ','ㄑ','ㄒ','ㄓ','ㄔ','ㄕ','ㄖ','ㄗ','ㄘ','ㄙ'],
              ['ㄧ','ㄨ','ㄩ','ㄚ','ㄛ','ㄜ','ㄝ','ㄞ','ㄟ'],
              ['ㄠ','ㄡ','ㄢ','ㄣ','ㄤ','ㄥ','ㄦ']];
  const kbd=document.getElementById('kbd'); kbd.innerHTML='';
  rows.forEach(r=>{
    const row=document.createElement('div'); row.className='row';
    r.forEach(ch=>{ const b=document.createElement('button'); b.className='key '+keyClass(ch); b.textContent=ch; b.onclick=()=>pressKey(ch); row.appendChild(b); });
    kbd.appendChild(row);
  });
}
function applyKbdPref(){ const compact=localStorage.getItem('kbd-compact')==='1'; const k=document.getElementById('kbd'); k.classList.toggle('compact',compact); const btn=document.getElementById('btnKbdSize'); if(btn) btn.textContent=compact?'⌨️ 放大鍵盤':'⌨️ 縮小鍵盤'; }

/* === Game mechanics === */
function spawn(){ const label=ZHUYIN[Math.floor(Math.random()*ZHUYIN.length)]; const x=40+Math.random()*(W-80); const speed=1.5+Math.random()*2.5; meteors.push({x,y:-40,speed,label}); }
function drawBackground(){ ctx.clearRect(0,0,W,H); ctx.fillStyle='rgba(255,255,255,.8)'; for(let i=0;i<40;i++){ const x=(i*97%W), y=(i*181%H); ctx.globalAlpha=(i%5)/5+.2; ctx.fillRect(x,y,3,3);} ctx.globalAlpha=1; ctx.beginPath(); ctx.arc(W/2,H+120,H*.7,Math.PI*1.03,Math.PI*1.97); ctx.fillStyle='#083a7a'; ctx.fill(); }
function draw(){ drawBackground(); meteors.forEach(m=>{ ctx.save(); ctx.translate(m.x,m.y); ctx.fillStyle='#ffae00'; ctx.beginPath(); ctx.ellipse(0,0,34,28,0,0,Math.PI*2); ctx.fill(); ctx.fillStyle='#ff6b00'; ctx.beginPath(); ctx.moveTo(-28,-10); ctx.lineTo(0,-38); ctx.lineTo(28,-10); ctx.closePath(); ctx.fill(); ctx.fillStyle='#3b2a20'; ctx.beginPath(); ctx.arc(0,0,26,0,Math.PI*2); ctx.fill(); ctx.fillStyle='#fff'; ctx.beginPath(); ctx.roundRect(-18,-18,36,36,6); ctx.fill(); ctx.fillStyle='#ff6a3d'; ctx.font='bold 34px system-ui'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(m.label,0,2); ctx.restore(); }); }

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

function endGame(){
  running=false; clearInterval(timerId);
  const dur=(LEVELS[level-1]?.duration)||60;
  const elapsed=dur-Math.max(0,timeLeft);
  const minutes=Math.max(1,elapsed)/60;
  const acc=(correct+wrong)?(correct/(correct+wrong)):0;
  const speed=Math.round(correct/minutes);
  const pass=acc>=ACC_THRESHOLD;

  updateBest(me.sid,score); setBest();

  document.getElementById('resCorrect').textContent=String(correct);
  document.getElementById('resWrong').textContent=String(wrong);
  document.getElementById('resAcc').textContent=Math.round(acc*100)+'%';
  document.getElementById('resSpeed').textContent=String(speed);
  document.getElementById('resPromo').textContent=pass?'達標 ✅':'未達標 ❌';
  document.getElementById('resultBox').style.display='flex';
}
function restart(){
  const pass = document.getElementById('resPromo').textContent.includes('達標');
  if(pass && level<LEVELS.length){ level++; toast('🎉 升到第 '+level+' 級！'); }
  score=0; correct=0; wrong=0; timeLeft=(LEVELS[level-1]?.duration)||60;
  setScore(); setTime(); meteors=[]; document.getElementById('resultBox').style.display='none'; draw(); startGame();
}

/* === Leaderboard === */
function openLeader(){ const data=topN(20); const tb=document.getElementById('leaderBody'); tb.innerHTML=data.map((r,i)=>`<tr><td>${i+1}</td><td>${r.sid}${r.name?'｜'+r.name:''}</td><td>${r.best}</td></tr>`).join(''); document.getElementById('leader').hidden=false; }
function closeLeader(){ document.getElementById('leader').hidden=true; }

/* === Login/Teacher === */
function openTeacherPane(){ document.getElementById('teacherPane').style.display='block'; }
function enterTeacher(){ const pass=document.getElementById('tpass').value.trim(); if(pass!=='teacher123'){ alert('密碼錯誤（測試用：teacher123）'); return;} document.getElementById('login').style.display='none'; openLeader(); }

/* === Events === */
document.getElementById('btnStart').onclick=toggleRun;
document.getElementById('btnLeader').onclick=openLeader;
document.getElementById('btnTeacher').onclick=()=>{ document.getElementById('login').style.display='flex'; openTeacherPane(); };
document.getElementById('btnCloseLeader').onclick=closeLeader;
document.getElementById('btnKbdSize').onclick=()=>{ const compact=!(localStorage.getItem('kbd-compact')==='1'); localStorage.setItem('kbd-compact',compact?'1':'0'); applyKbdPref(); };
document.getElementById('go').onclick=()=>{
  // --- sanitize & validate ---
  let sid=document.getElementById('sid').value.trim();
  sid=sid.replace(/\D/g,''); // keep only digits
  const name=document.getElementById('sname').value.trim();
  if(!/^\d{5}$/.test(sid)){  // <- ONE backslash; correct regex literal
    alert('請輸入 5 位數學號');
    return;
  }
  // --- proceed ---
  me.sid=sid; me.name=name;
  upsertStudent(sid,name);
  setUserChip(); setBest();
  document.getElementById('login').style.display='none';
  score=0; correct=0; wrong=0; level=1;
  timeLeft=(LEVELS[level-1]?.duration)||60;
  setScore(); setTime(); meteors=[]; draw();
};
document.getElementById('teacherOpen').onclick=openTeacherPane;
document.getElementById('enterTeacher').onclick=enterTeacher;
document.getElementById('clearLocal').onclick=()=>{ if(confirm('確定清除本機全部成績？')){ clearAll(); alert('已清除。'); } };

/* === Physical keyboard === */
addEventListener('keydown',e=>{ if(e.key===' '){ e.preventDefault(); toggleRun(); return;} if(e.key==='Escape'){ pauseGame(); return;} if(ZHUYIN.includes(e.key)){ pressKey(e.key); } });

/* === init === */
buildKeyboard(); applyKbdPref(); setUserChip(); setScore(); setTime(); setBest(); draw(); requestAnimationFrame(step);
