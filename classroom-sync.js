(() => {
  const params=new URLSearchParams(location.search);
  const isStudent=params.get("role")==="student"||params.has("guest");
  const isHost=!isStudent;
  const BASE="flashmap/broadcast";
  const cfg=window.FLASHMAP_FIREBASE_CONFIG;
  if(!cfg)return;

  const $=id=>document.getElementById(id);
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  let db=null,D=null;
  let applyingRemoteMap=false;
  let mapBound=false;
  let activeStroke=null;
  let pendingPoints=[];
  let flushTimer=null;
  let strokeOrder=[];
  let replayTimer=null;
  let lastSceneJson="";

  function injectUi(){
    const style=document.createElement("style");
    style.textContent=`
      .teacherSyncPill{position:absolute;z-index:125;top:16px;left:50%;transform:translateX(-50%);padding:8px 12px;border-radius:999px;background:#071522e8;border:1px solid #c9ff3c66;color:#c9ff3c;font-size:10px;font-weight:950;letter-spacing:.5px;display:none;box-shadow:0 12px 35px #0004}
      .teacherSyncPill.show{display:block}
      .teacherScreenNotice{position:absolute;z-index:18;inset:0;display:none;place-items:center;background:radial-gradient(circle at 50% 40%,#10273b,#030912 70%);padding:28px;text-align:center}
      .teacherScreenNotice.show{display:grid}
      .teacherScreenNotice .box{max-width:620px;padding:28px;border:1px solid #2b4864;border-radius:28px;background:#081827e8;box-shadow:0 30px 90px #0007}
      .teacherScreenNotice .ico{font-size:52px}.teacherScreenNotice h2{font-size:clamp(28px,5vw,54px);margin:12px 0 8px;letter-spacing:-2px}.teacherScreenNotice p{color:#91a9be;margin:0;font-size:14px;line-height:1.5}
      body.student-sync #board .boardTop{pointer-events:none} body.student-sync #board .boardModes,body.student-sync #board .closeBoard{display:none!important}
      body.student-sync #drawTools{display:none!important}
      .studentStageControls #stagePresentBtn{border:0;border-radius:10px;padding:8px 10px;background:#59ddff;color:#06111f;font-size:10px;font-weight:950}
    `;
    document.head.appendChild(style);

    const pill=document.createElement("div");pill.className="teacherSyncPill";pill.id="teacherSyncPill";pill.textContent="● ACOMPANHANDO O QUADRO DO PROFESSOR";$("stage")?.appendChild(pill);
    const notice=document.createElement("div");notice.className="teacherScreenNotice";notice.id="teacherScreenNotice";notice.innerHTML='<div class="box"><div class="ico">🖥️</div><h2>Apresentação em andamento</h2><p>O professor está compartilhando uma tela externa. Para turmas grandes, essa imagem chega pela transmissão do YouTube. O Quadro Cartográfico continua sincronizado diretamente pelo FLASHMAP.</p></div>';$("stage")?.appendChild(notice);

    if(isStudent){
      document.body.classList.add("student-sync");
      const controls=$("studentStageControls");
      if(controls&&!$("stagePresentBtn")){
        const b=document.createElement("button");b.id="stagePresentBtn";b.type="button";b.textContent="🖥️ Apresentar";
        b.onclick=()=>{
          if(!controls.classList.contains("show"))return;
          const hidden=$("presentBtn");
          if(hidden)hidden.click();
        };
        controls.appendChild(b);
      }
    }
  }

  async function initFirebase(){
    const A=await import("https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js");
    D=await import("https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js");
    const apps=A.getApps();
    const app=apps.find(a=>a.name==="[DEFAULT]")||A.initializeApp(cfg);
    db=D.getDatabase(app);
  }

  const ref=p=>D.ref(db,`${BASE}/${p}`);
  const set=(p,v)=>D.set(ref(p),v);
  const remove=p=>D.remove(ref(p));
  const push=(p,v)=>D.push(ref(p),v);

  function currentBoardMode(){return document.querySelector("[data-board].active")?.dataset.board||"map"}
  function getVideoIdFromFrame(){
    const src=$("youtubeFrame")?.src||"";
    const m=src.match(/\/embed\/([A-Za-z0-9_-]{11})/);return m?.[1]||"";
  }

  async function publishScene(){
    if(!isHost||!db)return;
    let scene={kind:"home",at:Date.now()};
    if($("board")?.classList.contains("show"))scene={kind:"board",mode:currentBoardMode(),at:Date.now()};
    else if($("screenLayer")?.classList.contains("show"))scene={kind:"screen",at:Date.now()};
    else if($("youtubeLayer")?.classList.contains("show"))scene={kind:"youtube",yt:getVideoIdFromFrame(),at:Date.now()};
    const j=JSON.stringify({...scene,at:0});if(j===lastSceneJson)return;lastSceneJson=j;
    await set("scene",scene).catch(()=>{});
  }

  function setupHostSceneObservers(){
    if(!isHost)return;
    const mo=new MutationObserver(()=>publishScene());
    ["board","screenLayer","youtubeLayer"].forEach(id=>{const el=$(id);if(el)mo.observe(el,{attributes:true,attributeFilter:["class"]})});
    const yf=$("youtubeFrame");if(yf)mo.observe(yf,{attributes:true,attributeFilter:["src"]});
    document.querySelectorAll("[data-board]").forEach(b=>b.addEventListener("click",()=>setTimeout(publishScene,20)));
    setTimeout(publishScene,500);
  }

  async function ensureStudentBoard(mode){
    if(!isStudent)return;
    $("teacherScreenNotice")?.classList.remove("show");
    if(!$("board")?.classList.contains("show"))$("boardBtn")?.click();
    await sleep(40);
    const b=document.querySelector(`[data-board="${mode||"map"}"]`);if(b)b.click();
    $("teacherSyncPill")?.classList.add("show");
  }
  function closeStudentBoard(){
    if(!isStudent)return;
    if($("board")?.classList.contains("show"))$("closeBoard")?.click();
    $("teacherSyncPill")?.classList.remove("show");
  }

  function applyScene(scene){
    if(!isStudent||!scene)return;
    if(scene.kind==="board"){
      ensureStudentBoard(scene.mode);
      return;
    }
    closeStudentBoard();
    if(scene.kind==="youtube"&&scene.yt){
      $("teacherScreenNotice")?.classList.remove("show");
      const f=$("youtubeFrame");if(f&&!f.src.includes(`/embed/${scene.yt}`))f.src=`https://www.youtube.com/embed/${scene.yt}?autoplay=1&playsinline=1&rel=0`;
      $("youtubeLayer")?.classList.add("show");
    }else if(scene.kind==="screen"){
      if(!$("youtubeLayer")?.classList.contains("show"))$("teacherScreenNotice")?.classList.add("show");
    }else{
      $("teacherScreenNotice")?.classList.remove("show");
    }
  }

  function getMap(){return window.FLASHMAP_BOARD_MAP||null}
  function publishMapView(){
    if(!isHost||applyingRemoteMap)return;
    const m=getMap();if(!m)return;
    const c=m.getCenter();set("map",{lat:c.lat,lng:c.lng,zoom:m.getZoom(),at:Date.now()}).catch(()=>{});
  }
  function bindMapWhenReady(){
    const loop=()=>{
      const m=getMap();
      if(m&&!mapBound){
        mapBound=true;
        if(isHost){m.on("moveend zoomend",publishMapView);publishMapView()}
      }
      if(!mapBound)setTimeout(loop,300);
    };loop();
  }
  async function applyMapView(v){
    if(!isStudent||!v)return;
    for(let i=0;i<15&&!getMap();i++)await sleep(100);
    const m=getMap();if(!m)return;
    applyingRemoteMap=true;
    try{m.setView([Number(v.lat),Number(v.lng)],Number(v.zoom),{animate:false})}catch(e){}
    setTimeout(()=>applyingRemoteMap=false,80);
  }

  function activeTool(){return document.querySelector("#drawTools [data-tool].active")?.dataset.tool||"pan"}
  function normPoint(canvas,e){const r=canvas.getBoundingClientRect();return {x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height}}
  function strokeMeta(){return {tool:activeTool(),color:$("inkColor")?.value||"#c9ff3c",size:Number($("inkSize")?.value)||5,at:Date.now()}}

  function flushStroke(){
    clearTimeout(flushTimer);flushTimer=null;
    if(!activeStroke||pendingPoints.length<2)return;
    const pts=pendingPoints.splice(0);
    push(`board/strokes/${activeStroke}/chunks`,{points:pts,at:Date.now()}).catch(()=>{});
    pendingPoints=[pts[pts.length-1]];
  }
  function scheduleFlush(){if(!flushTimer)flushTimer=setTimeout(flushStroke,70)}

  function setupHostDrawing(){
    if(!isHost)return;
    const canvas=$("boardCanvas");if(!canvas)return;
    canvas.addEventListener("pointerdown",e=>{
      const tool=activeTool();if(tool==="pan"||!$("board")?.classList.contains("show"))return;
      const key=D.push(ref("board/strokes")).key;activeStroke=key;strokeOrder.push(key);pendingPoints=[normPoint(canvas,e)];
      D.set(ref(`board/strokes/${key}/meta`),strokeMeta()).catch(()=>{});
    },true);
    canvas.addEventListener("pointermove",e=>{if(!activeStroke)return;pendingPoints.push(normPoint(canvas,e));scheduleFlush()},true);
    const finish=()=>{if(!activeStroke)return;flushStroke();activeStroke=null;pendingPoints=[]};
    canvas.addEventListener("pointerup",finish,true);canvas.addEventListener("pointercancel",finish,true);

    $("clearInk")?.addEventListener("click",()=>{
      if(!$("board")?.classList.contains("show"))return;
      strokeOrder=[];remove("board/strokes").catch(()=>{});set("board/revision",Date.now()).catch(()=>{});
    });
    $("undoInk")?.addEventListener("click",()=>{
      if(!$("board")?.classList.contains("show"))return;
      const id=strokeOrder.pop();if(id)remove(`board/strokes/${id}`).catch(()=>{});
    });
  }

  function clearRemoteCanvas(){
    const c=$("boardCanvas");if(!c)return;
    const ctx=c.getContext("2d");ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,c.width,c.height);ctx.restore();
  }
  function drawChunk(meta,chunk){
    if(!isStudent||!meta||!chunk?.points?.length)return;
    const canvas=$("boardCanvas"),ctx=canvas?.getContext("2d");if(!canvas||!ctx)return;
    const r=canvas.getBoundingClientRect();if(!r.width||!r.height)return;
    const pts=chunk.points;
    ctx.save();ctx.beginPath();ctx.lineCap="round";ctx.lineJoin="round";
    const first=pts[0];ctx.moveTo(first.x*r.width,first.y*r.height);
    if(meta.tool==="eraser"){ctx.globalCompositeOperation="destination-out";ctx.lineWidth=(Number(meta.size)||5)*3.2;ctx.globalAlpha=1}
    else{ctx.globalCompositeOperation="source-over";ctx.lineWidth=meta.tool==="highlighter"?(Number(meta.size)||5)*3:(Number(meta.size)||5);ctx.globalAlpha=meta.tool==="highlighter"?.27:1;ctx.strokeStyle=meta.color||"#c9ff3c"}
    for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i].x*r.width,pts[i].y*r.height);
    ctx.stroke();ctx.restore();
  }

  const strokeListeners=new Map();
  function subscribeStroke(id){
    if(strokeListeners.has(id))return;
    let meta=null;
    const offMeta=D.onValue(ref(`board/strokes/${id}/meta`),s=>{meta=s.val()||meta});
    const offChunks=D.onChildAdded(ref(`board/strokes/${id}/chunks`),s=>{if(meta)drawChunk(meta,s.val())});
    strokeListeners.set(id,()=>{offMeta();offChunks()});
  }
  async function replayBoard(){
    if(!isStudent)return;
    clearRemoteCanvas();
    const snap=await D.get(ref("board/strokes"));const raw=snap.val()||{};
    const rows=Object.entries(raw).sort((a,b)=>(a[1]?.meta?.at||0)-(b[1]?.meta?.at||0));
    rows.forEach(([,s])=>{
      const chunks=Object.values(s.chunks||{}).sort((a,b)=>(a.at||0)-(b.at||0));chunks.forEach(ch=>drawChunk(s.meta,ch));
    });
  }
  function scheduleReplay(){clearTimeout(replayTimer);replayTimer=setTimeout(replayBoard,120)}
  function setupStudentDrawing(){
    if(!isStudent)return;
    D.onChildAdded(ref("board/strokes"),s=>subscribeStroke(s.key));
    D.onChildRemoved(ref("board/strokes"),s=>{strokeListeners.get(s.key)?.();strokeListeners.delete(s.key);scheduleReplay()});
    D.onValue(ref("board/revision"),()=>scheduleReplay());
    setTimeout(replayBoard,500);
  }

  async function boot(){
    injectUi();
    try{
      await initFirebase();
      if(isHost){setupHostSceneObservers();setupHostDrawing()}
      else{
        D.onValue(ref("scene"),s=>applyScene(s.val()||{kind:"home"}));
        D.onValue(ref("map"),s=>applyMapView(s.val()));
        setupStudentDrawing();
      }
      bindMapWhenReady();
    }catch(err){console.error("FLASHMAP classroom sync",err)}
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot,{once:true});else boot();
})();
