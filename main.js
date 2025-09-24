/* === Local DB (MVP) === */
const DB_KEY='zhuyin-meteor-v1';
const db=JSON.parse(localStorage.getItem(DB_KEY)||'{}'); if(!db.students) db.students={};
const saveDB=()=>localStorage.setItem(DB_KEY,JSON.stringify(db));
function upsertStudent(sid,name){ if(!db.students[sid]) db.students[sid]={name:name||'',best:0}; else if(name!==undefined) db.students[sid].name=name; saveDB(); }
function updateBest(sid,score){ if(!db.students[sid]) return; if(score>(db.students[sid].best||0)){ db.students[sid].best=score; saveDB(); } }
const topN=(n=20)=>Object.entries(db.students).map(([sid,s])=>({sid,name:s.name||'',best:s.best||0})).sort((a,b)=>b.best-a.best).slice(0,n);
function clearAll(){ db.students={}; saveDB(); }
// 放在檔案前段（常數上面即可）
const meteorImg = new Image();
// 如果 Q.png 與 index.html 在同一層：
meteorImg.src ="img/Q.png"; 
let imageReady = false;
meteorImg.onload = () => { 
  imageReady = true; 
  console.log("Q.png 載入成功"); 
};
meteorImg.onerror = () => { 
  console.warn("Q.png 載入失敗，請檢查路徑"); 
  imageReady = false; 
};


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
let W, H;
function resize(){
  const r = canvas.getBoundingClientRect();
  W = canvas.width  = Math.floor(r.width  * 2);  // 2x 像素密度
  H = canvas.height = Math.floor(r.height * 2);  // 用實際高度！
}
resize();
addEventListener('resize', resize);

let meteors=[]; let running=false, score=0, timeLeft=(LEVELS[0].duration), spawnTimer=0;
let correct=0, wrong=0;
const setUserChip=()=>document.getElementById('userChip').textContent=me.sid?`${me.sid}`:'未登入';
const setScore=()=>document.getElementById('score').textContent=score;
const setTime =()=>document.getElementById('time').textContent=timeLeft;
const setBest =()=>{ const b=document.getElementById('best'); if(b) b.textContent=(db.students[me.sid]?.best||0); }
const toast = msg => { const t=document.getElementById('toast'); if(!t) return; t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),900) }
let me={sid:null,name:''};

/* === Keyboard === */
function buildKeyboard(){
  // 四行、無聲調
  const rows=[
    ['ㄅ','ㄉ','','','ㄓ','','','ㄚ','ㄞ','ㄢ','ㄦ'],
    ['ㄆ','ㄊ','ㄍ','ㄐ','ㄔ','ㄗ','ㄧ','ㄛ','ㄟ','ㄣ',''],
    ['ㄇ','ㄋ','ㄎ','ㄑ','ㄕ','ㄘ','ㄨ','ㄜ','ㄠ','ㄤ',''],
    ['ㄈ','ㄌ','ㄏ','ㄒ','ㄖ','ㄙ','ㄩ','ㄝ','ㄡ','ㄥ','']
  ];
  const kbd=document.getElementById('kbd');
  kbd.innerHTML='';
  rows.forEach(r=>{
    const row=document.createElement('div');
    row.className='row';
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

/* === Game mechanics === */
function spawn(){ const label=ZHUYIN[Math.floor(Math.random()*ZHUYIN.length)]; const x=40+Math.random()*(W-80); const speed=1.5+Math.random()*2.5; meteors.push({x,y:-40,speed,label}); }
function drawBackground(){ ctx.clearRect(0,0,W,H); ctx.fillStyle='rgba(255,255,255,.8)'; for(let i=0;i<40;i++){ const x=(i*97%W), y=(i*181%H); ctx.globalAlpha=(i%5)/5+.2; ctx.fillRect(x,y,3,3);} ctx.globalAlpha=1;  }

function draw(){
  drawBackground();
  meteors.forEach(m=>{
    ctx.save();
    ctx.translate(m.x, m.y);

    // 1. 調整隕石圖示大小
    const size = 300;   // ← 原本是 60，這裡改大一點就會放大隕石圖
    if (imageReady) {
      ctx.drawImage(meteorImg, -size/2, -size/2, size, size);
    } else {
      ctx.fillStyle = '#3b82f6';
      ctx.beginPath();
      ctx.arc(0, 0, size*0.45, 0, Math.PI*2);
      ctx.fill();
    }

    // 2. 調整題目文字大小
   // 字體 & 對齊
ctx.font = 'bold 100px system-ui';
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.lineWidth = 5;
ctx.strokeStyle = 'rgba(0,0,0,.6)';

// 建議的比例位移（依 Q.png 石頭位置微調）
const xOffset = -size * 0.08;  // 往左 8%（火焰在左上，石頭偏右）
const yOffset =  size * 0.15;  // 往下 15%

// 這裡要用 xOffset 才會生效！
ctx.strokeText(m.label, xOffset, yOffset);
ctx.fillStyle = '#fff';
ctx.fillText(m.label, xOffset, yOffset);


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

function endGame(){
  running=false; clearInterval(timerId);
  const dur=(LEVELS[level-1]?.duration)||60;
  const elapsed=dur-Math.max(0,timeLeft);
  const minutes=Math.max(1,elapsed)/60;
  const acc=(correct+wrong)?(correct/(correct+wrong)):0;
  const speed=Math.round(correct/minutes);
  const pass=acc>=ACC_THRESHOLD;

  updateBest(me.sid,score); setBest();

  if(pass){
    if(level<LEVELS.length){ level++; toast('🎉 升到第 '+level+' 級！'); }
    score=0; correct=0; wrong=0;
    timeLeft=(LEVELS[level-1]?.duration)||60;
    setScore(); setTime(); meteors=[]; draw(); startGame();
  }else{
    // 未達標 → 直接打開排行榜
    openLeader();
  }
}

function restart(){
  level=1; score=0; correct=0; wrong=0;
  timeLeft=(LEVELS[level-1]?.duration)||60;
  setScore(); setTime(); meteors=[]; draw(); startGame();
}

/* === Leaderboard === */
function openLeader(){ const data=topN(20); const tb=document.getElementById('leaderBody'); if(tb) tb.innerHTML=data.map((r,i)=>`<tr><td>${i+1}</td><td>${r.sid}</td><td>${r.best}</td></tr>`).join(''); document.getElementById('leader').hidden=false; }
function closeLeader(){ document.getElementById('leader').hidden=true; }

/* === Login/Teacher === */
function openTeacherPane(){ const p=document.getElementById('teacherPane'); if(p) p.style.display='block'; }
function enterTeacher(){ const pass=document.getElementById('tpass').value.trim(); if(pass!=='teacher123'){ alert('密碼錯誤（測試用：teacher123）'); return;} document.getElementById('login').style.display='none'; openLeader(); }

/* === Events === */
const $ = id => document.getElementById(id);
if($('btnStart')) $('btnStart').onclick=toggleRun;
if($('btnCloseLeader')) $('btnCloseLeader').onclick=closeLeader;
if($('btnRestartGame')) $('btnRestartGame').onclick=()=>{ closeLeader(); restart(); };

if($('go')) $('go').onclick=()=>{
  let sid=$('sid').value.trim().replace(/\D/g,'');
  if(!/^\d{5}$/.test(sid)){ alert('請輸入5位數座號'); return; }
  me.sid=sid; me.name='';
  upsertStudent(sid,''); setUserChip(); setBest();
  $('login').style.display='none';
  score=0; correct=0; wrong=0; level=1;
  timeLeft=(LEVELS[level-1]?.duration)||60;
  setScore(); setTime(); meteors=[]; draw();
};

if($('teacherOpen')) $('teacherOpen').onclick=openTeacherPane;
if($('enterTeacher')) $('enterTeacher').onclick=enterTeacher;
if($('clearLocal')) $('clearLocal').onclick=()=>{ if(confirm('確定清除本機全部成績？')){ clearAll(); alert('已清除。'); } };

/* === Physical keyboard === */
addEventListener('keydown',e=>{ if(e.key===' '){ e.preventDefault(); toggleRun(); return;} if(e.key==='Escape'){ pauseGame(); return;} if(ZHUYIN.includes(e.key)){ pressKey(e.key); } });

/* === init === */
buildKeyboard(); applyKbdPref(); setUserChip(); setScore(); setTime(); setBest(); draw(); requestAnimationFrame(step);
