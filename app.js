(() => {
  const $=id=>document.getElementById(id);
  const params=new URLSearchParams(location.search);
  const isStudent=params.get("role")==="student"||params.has("guest");
  const isHost=!isStudent;
  const ROOM="flashmap-aula";

  let room=null,cameraOn=false,micOn=false,shareOn=false;
  let currentStage=null,hands=[],presence=[],boardMap=null;
  let audioCtx=null,analyser=null,meterRaf=0,meterSource=null;
  let timerTotal=300,timerLeft=300,timerRunning=false,timerInterval=null;
  const sessionStart=Date.now();

  $("roleBadge").textContent=isHost?"🎓 PROFESSOR":"👤 PARTICIPANTE";

  const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const fmt=sec=>{sec=Math.max(0,Math.floor(sec));const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;return(h?String(h).padStart(2,"0")+":":"")+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0")};
  setInterval(()=>$("sessionClock").textContent="AULA "+fmt((Date.now()-sessionStart)/1000),1000);

  function toast(text){
    $("toast").textContent=text;$("toast").classList.add("show");
    clearTimeout(toast.t);toast.t=setTimeout(()=>$("toast").classList.remove("show"),3200);
  }
  function conn(ok,text){
    $("connText").textContent=text;$("connDot").classList.toggle("ok",ok===true);$("connDot").classList.toggle("bad",ok===false);
  }

  /* sheets */
  const sheetIds=["moreSheet","handsSheet","presenceSheet","chatSheet","timerSheet","reactionSheet","youtubeSheet"];
  function closeSheets(){sheetIds.forEach(id=>$(id).classList.remove("show"));$("scrim").classList.remove("show")}
  function openSheet(id){closeSheets();$(id).classList.add("show");$("scrim").classList.add("show")}
  document.querySelectorAll(".sheetClose").forEach(b=>b.onclick=closeSheets);
  $("scrim").onclick=closeSheets;
  $("moreBtn").onclick=()=>openSheet("moreSheet");
  $("presenceBtn").onclick=()=>openSheet("presenceSheet");
  $("chatBtn").onclick=()=>openSheet("chatSheet");
  $("timerBtn").onclick=()=>openSheet("timerSheet");
  $("reactionBtn").onclick=()=>openSheet("reactionSheet");
  $("stageBtn").onclick=()=>openSheet("handsSheet");
  $("youtubeBtn").onclick=()=>openSheet("youtubeSheet");

  /* student name */
  if(isStudent&&!sessionStorage.fmname){$("joinCard").classList.add("show");setTimeout(()=>$("joinName").focus(),250)}
  $("joinNameBtn").onclick=async()=>{const n=$("joinName").value.trim();if(n.length<2)return toast("Digite seu nome.");await FM.rename(n);$("joinCard").classList.remove("show");toast("Bem-vindo, "+n+"!")};
  $("joinName").onkeydown=e=>{if(e.key==="Enter")$("joinNameBtn").click()};

  /* LiveKit */
  async function connectLivekit(){
    try{
      conn(null,"Conectando");
      const ts=LivekitClient.TokenSource.sandboxTokenServer("flashmap-7br9z6");
      const c=await ts.fetch({roomName:ROOM,participantIdentity:FM.uid,participantName:FM.name});
      room=new LivekitClient.Room({adaptiveStream:true,dynacast:true});
      room
        .on(LivekitClient.RoomEvent.TrackSubscribed,onTrackSubscribed)
        .on(LivekitClient.RoomEvent.TrackUnsubscribed,onTrackUnsubscribed)
        .on(LivekitClient.RoomEvent.ActiveSpeakersChanged,speakers=>{
          const speaking=currentStage&&speakers.some(s=>s.identity===currentStage.uid);
          $("guestTile").classList.toggle("speaking",!!speaking);
        })
        .on(LivekitClient.RoomEvent.Disconnected,()=>conn(false,"Vídeo desconectado"));
      await room.connect(c.serverUrl,c.participantToken);
      conn(true,"Conectado");
      $("welcome").textContent=isHost?"Pronto. Faça a turma olhar para a tela.":"Você está dentro da aula.";
    }catch(err){console.error(err);conn(false,"Falha no vídeo");toast("Vídeo: "+(err?.message||err))}
  }

  function onTrackSubscribed(track,pub,participant){
    if(track.kind==="audio"){
      const a=track.attach();a.autoplay=true;document.body.appendChild(a);
      a.play().catch(()=>$("audioUnlock").style.display="block");
      return;
    }
    const v=track.attach();v.autoplay=true;v.playsInline=true;
    if(pub.source===LivekitClient.Track.Source.ScreenShare){
      $("screenLayer").querySelectorAll("video").forEach(x=>x.remove());
      $("screenLayer").appendChild(v);$("screenChip").textContent="🖥️ "+(participant.name||"APRESENTAÇÃO")+" • AO VIVO";$("screenLayer").classList.add("show");return;
    }
    if(pub.source===LivekitClient.Track.Source.Camera){
      if(isHost){
        if(currentStage&&participant.identity===currentStage.uid){
          $("guestVideo").innerHTML="";$("guestVideo").appendChild(v);$("guestName").textContent=currentStage.name||participant.name||"Participante";$("guestTile").classList.add("show");
        }else track.detach().forEach(el=>el.remove());
      }else{
        $("professorRemote").innerHTML="";$("professorRemote").appendChild(v);$("professorRemote").classList.add("show");
      }
    }
  }
  function onTrackUnsubscribed(track,pub){
    track.detach().forEach(el=>el.remove());
    if(pub.source===LivekitClient.Track.Source.ScreenShare)$("screenLayer").classList.remove("show");
    if(pub.source===LivekitClient.Track.Source.Camera){if(isHost)$("guestTile").classList.remove("show");else $("professorRemote").classList.remove("show")}
  }
  $("audioUnlock").onclick=async()=>{try{if(room?.startAudio)await room.startAudio()}catch(e){}document.querySelectorAll("audio").forEach(a=>a.play().catch(()=>{}));$("audioUnlock").style.display="none"};

  async function setCamera(force){
    if(!room)return toast("O vídeo ainda está conectando.");
    try{
      cameraOn=typeof force==="boolean"?force:!cameraOn;
      await room.localParticipant.setCameraEnabled(cameraOn,{resolution:{width:1280,height:720},frameRate:24});
      const pub=room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
      if(cameraOn&&pub?.track){$("selfVideo").srcObject=new MediaStream([pub.track.mediaStreamTrack]);$("localCam").classList.add("show")}else $("localCam").classList.remove("show");
      $("camBtn").classList.toggle("on",cameraOn);
    }catch(err){cameraOn=false;$("camBtn").classList.remove("on");toast("Câmera: "+(err?.message||err))}
  }
  async function setMic(force){
    if(!room)return toast("O áudio ainda está conectando.");
    try{
      micOn=typeof force==="boolean"?force:!micOn;
      await room.localParticipant.setMicrophoneEnabled(micOn,{echoCancellation:true,noiseSuppression:true,autoGainControl:true});
      $("micBtn").classList.toggle("on",micOn);$("micState").textContent=micOn?"AO VIVO":"MUDO";
      if(micOn)startMeter();else stopMeter();
    }catch(err){micOn=false;$("micBtn").classList.remove("on");toast("Microfone: "+(err?.message||err))}
  }
  function startMeter(){
    stopMeter();const pub=room?.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);if(!pub?.track)return;
    audioCtx||=new(window.AudioContext||window.webkitAudioContext)();const stream=new MediaStream([pub.track.mediaStreamTrack]);meterSource=audioCtx.createMediaStreamSource(stream);analyser=audioCtx.createAnalyser();analyser.fftSize=256;meterSource.connect(analyser);
    const data=new Uint8Array(analyser.frequencyBinCount);
    const loop=()=>{analyser.getByteFrequencyData(data);const avg=data.reduce((a,b)=>a+b,0)/data.length;$("meterFill").style.width=Math.min(100,avg*1.7)+"%";meterRaf=requestAnimationFrame(loop)};loop();
  }
  function stopMeter(){cancelAnimationFrame(meterRaf);$("meterFill").style.width="0%";try{meterSource?.disconnect()}catch(e){}meterSource=null;analyser=null}
  async function toggleShare(){
    if(!navigator.mediaDevices?.getDisplayMedia)return toast("🖥️ Apresentar QGIS funciona no computador.");
    if(!room)return toast("O vídeo ainda está conectando.");
    try{shareOn=!shareOn;await room.localParticipant.setScreenShareEnabled(shareOn,{audio:true});toast(shareOn?"QGIS/tela entrou no ar.":"Apresentação encerrada.")}catch(err){shareOn=false;toast("Apresentação: "+(err?.message||err))}
  }
  $("micBtn").onclick=()=>setMic();
  $("camBtn").onclick=()=>setCamera();
  $("presentBtn").onclick=()=>{closeSheets();toggleShare()};

  /* draggable camera */
  let camSize=250;
  $("camPlus").onclick=e=>{e.stopPropagation();camSize=Math.min(Math.floor(innerWidth*.78),camSize+70);$("localCam").style.width=camSize+"px"};
  $("camMinus").onclick=e=>{e.stopPropagation();camSize=Math.max(130,camSize-70);$("localCam").style.width=camSize+"px"};
  (()=>{let dragging=false,dx=0,dy=0;const handle=$("camDrag"),el=$("localCam");
    handle.onpointerdown=e=>{if(e.target.tagName==="BUTTON")return;const r=el.getBoundingClientRect();dragging=true;dx=e.clientX-r.left;dy=e.clientY-r.top;handle.setPointerCapture(e.pointerId)};
    handle.onpointermove=e=>{if(!dragging)return;const sr=$("stage").getBoundingClientRect(),maxX=innerWidth-el.offsetWidth-6,maxY=$("stage").clientHeight-el.offsetHeight-74;el.style.left=Math.max(6,Math.min(maxX,e.clientX-dx))+"px";el.style.top=Math.max(6,Math.min(maxY,e.clientY-sr.top-dy))+"px";el.style.bottom="auto"};
    handle.onpointerup=()=>dragging=false;handle.onpointercancel=()=>dragging=false;
  })();

  /* Firebase */
  window.addEventListener("fm:presence",e=>{presence=Array.isArray(e.detail)?e.detail:[];$("online").textContent=presence.length;renderPresence()});
  window.addEventListener("fm:hands",e=>{hands=Array.isArray(e.detail)?e.detail:[];renderHands()});
  window.addEventListener("fm:stage",e=>{
    const prev=currentStage;currentStage=e.detail||null;renderStage();
    if(isStudent){
      if(currentStage?.uid===FM.uid){$("micBtn").style.display="";$("camBtn").style.display="";if(prev?.uid!==FM.uid)$("stageInvite").classList.add("show")}
      else{$("micBtn").style.display="none";$("camBtn").style.display="none";if(prev?.uid===FM.uid){$("stageInvite").classList.remove("show");setCamera(false);setMic(false);toast("Você saiu do palco.")}}
    }
  });
  window.addEventListener("fm:reaction",e=>{const x=e.detail||{};if(x.uid!==FM.uid&&x.emoji)spawnReaction(x.emoji)});
  window.addEventListener("fm:chat",e=>appendChat(e.detail));
  window.addEventListener("fm:ready",()=>{presence=FM.state.presence||presence;hands=FM.state.hands||hands;currentStage=FM.state.stage||currentStage;renderPresence();renderHands();renderStage()});

  /* hands */
  $("handsBtn").onclick=()=>isHost?openSheet("handsSheet"):FM.hand();
  function renderHands(){
    $("handBadge").innerHTML=hands.length?'<span class="badgeCount">'+hands.length+"</span>":"";
    if(isStudent){const mine=hands.some(h=>h.uid===FM.uid);$("handsLabel").textContent=mine?"Baixar mão":"Levantar";$("handsBtn").classList.toggle("on",mine)}
    if(!hands.length){$("handsList").innerHTML='<div class="empty">Ninguém pediu para falar.</div>';return}
    $("handsList").innerHTML=hands.map(h=>'<div class="row"><div class="avatar">✋</div><div class="rowMain"><div class="rowName">'+esc(h.name)+'</div><div class="rowSub">aguardando para falar</div></div><div class="rowActions"><button class="callBtn" data-call="'+h.uid+'" type="button">CHAMAR</button><button class="downBtn" data-down="'+h.uid+'" type="button">BAIXAR</button></div></div>').join("");
    $("handsList").querySelectorAll("[data-call]").forEach(b=>b.onclick=async()=>{const h=hands.find(x=>x.uid===b.dataset.call);if(!h)return;await FM.callStage(h.uid,h.name);await FM.lowerHand(h.uid);toast("🎙️ "+h.name+" foi chamado ao palco.")});
    $("handsList").querySelectorAll("[data-down]").forEach(b=>b.onclick=()=>FM.lowerHand(b.dataset.down));
  }
  function renderStage(){$("stageNow").textContent=currentStage?"No palco agora: "+currentStage.name:"Ninguém no palco.";$("removeStageBtn").style.opacity=currentStage?"1":".45";if(!currentStage)$("guestTile").classList.remove("show")}
  $("clearHandsBtn").onclick=()=>FM.clearHands();$("removeStageBtn").onclick=()=>FM.clearStage();
  $("joinStageVideo").onclick=async()=>{$("stageInvite").classList.remove("show");await setMic(true);await setCamera(true);toast("🎙️ Você entrou no palco.")};
  $("joinStageAudio").onclick=async()=>{$("stageInvite").classList.remove("show");await setCamera(false);await setMic(true);toast("🎙️ Você entrou só com áudio.")};

  /* presence */
  function durationText(ms){const sec=Math.max(0,Math.floor(ms/1000));if(sec<60)return sec+"s";const min=Math.floor(sec/60);if(min<60)return min+" min";return Math.floor(min/60)+"h "+(min%60)+"min"}
  function renderPresence(){
    $("presenceTotal").textContent=presence.length;const now=Date.now();
    $("presenceList").innerHTML=presence.length?presence.slice().sort((a,b)=>(a.role==="host"?-1:0)-(b.role==="host"?-1:0)).map(p=>'<div class="row"><div class="avatar">'+esc((p.name||"?").slice(0,1).toUpperCase())+'</div><div class="rowMain"><div class="rowName">'+esc(p.name||"Participante")+'</div><div class="rowSub">'+(p.role==="host"?"Professor":"Participante")+" · conectado há "+durationText(now-(p.joinedAt||now))+"</div></div></div>").join(""):'<div class="empty">Nenhuma presença registrada agora.</div>';
  }
  setInterval(()=>{if($("presenceSheet").classList.contains("show"))renderPresence()},10000);
  $("exportPresence").onclick=()=>{const now=Date.now(),rows=[["nome","papel","entrada","tempo_conectado_minutos"],...presence.map(p=>[p.name||"",p.role||"participant",p.joinedAt?new Date(p.joinedAt).toLocaleString("pt-BR"):"",p.joinedAt?Math.round((now-p.joinedAt)/60000):""])];const csv=rows.map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(";")).join("\n");const blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="flashmap-presenca.csv";a.click();URL.revokeObjectURL(a.href)};

  /* chat */
  function appendChat(x){if(!x?.text)return;const d=document.createElement("div");d.className="msg";const b=document.createElement("b");b.textContent=x.name||"Participante";d.append(b,document.createTextNode(x.text));$("chatLog").appendChild(d);$("chatLog").scrollTop=$("chatLog").scrollHeight}
  function sendChat(){const t=$("chatInput").value.trim();if(!t)return;FM.chat(t);$("chatInput").value=""}
  $("chatSend").onclick=sendChat;$("chatInput").onkeydown=e=>{if(e.key==="Enter")sendChat()};

  /* reactions */
  function spawnReaction(emoji){const el=document.createElement("div");el.className="flyReaction";el.textContent=emoji;el.style.left=(8+Math.random()*84)+"%";el.style.setProperty("--drift",(-90+Math.random()*180)+"px");$("stage").appendChild(el);setTimeout(()=>el.remove(),2800)}
  $("reactionGrid").querySelectorAll("button").forEach(b=>b.onclick=()=>{const emoji=b.textContent.trim();spawnReaction(emoji);FM.react(emoji);closeSheets()});

  /* timer */
  function setTimer(sec){timerTotal=Math.max(1,Math.min(10800,Math.floor(sec)));timerLeft=timerTotal;renderTimer();$("activityTimer").classList.add("show")}
  function renderTimer(){$("timerValue").textContent=fmt(timerLeft);$("timerBarFill").style.width=(timerTotal?Math.max(0,timerLeft/timerTotal*100):0)+"%";$("activityTimer").classList.toggle("urgent",timerLeft<=30&&timerLeft>0)}
  document.querySelectorAll("[data-min]").forEach(b=>b.onclick=()=>setTimer(+b.dataset.min*60));
  $("applyCustom").onclick=()=>{const m=Math.max(0,Math.min(180,parseInt($("customMin").value)||0)),s=Math.max(0,Math.min(59,parseInt($("customSec").value)||0));if(m*60+s<1)return toast("Defina pelo menos 1 segundo.");setTimer(m*60+s);toast("Tempo personalizado pronto.")};
  $("timerStart").onclick=()=>{if(timerLeft<=0)timerLeft=timerTotal;timerRunning=true;clearInterval(timerInterval);$("activityTimer").classList.add("show");timerInterval=setInterval(()=>{if(!timerRunning)return;timerLeft--;renderTimer();if(timerLeft<=0){clearInterval(timerInterval);timerRunning=false;timerLeft=0;renderTimer();toast("⏱️ TEMPO ENCERRADO!")}},1000);closeSheets()};
  $("timerPause").onclick=()=>{timerRunning=false;clearInterval(timerInterval);toast("Temporizador pausado.")};
  $("timerStop").onclick=()=>{timerRunning=false;clearInterval(timerInterval);$("activityTimer").classList.remove("show");closeSheets()};

  /* board */
  let drawTarget=$("boardInk"),drawTool="pan",history=[],drawing=false;
  function initMap(){if(boardMap)return;boardMap=L.map("mapBoard",{zoomControl:true}).setView([-14.2,-56.1],5);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap"}).addTo(boardMap)}
  function resizeCanvas(canvas){const d=Math.max(1,devicePixelRatio||1),r=$("stage").getBoundingClientRect(),old=canvas.width?canvas.toDataURL():null;canvas.width=Math.round(r.width*d);canvas.height=Math.round(r.height*d);canvas.style.width=r.width+"px";canvas.style.height=r.height+"px";const ctx=canvas.getContext("2d");ctx.setTransform(d,0,0,d,0,0);if(old){const im=new Image();im.onload=()=>ctx.drawImage(im,0,0,r.width,r.height);im.src=old}}
  function resizeCanvases(){resizeCanvas($("boardInk"));resizeCanvas($("screenInk"))}resizeCanvases();addEventListener("resize",resizeCanvases);
  function setBoardMode(mode){$("mapBoard").style.display=mode==="map"?"block":"none";$("gridBase").style.display=mode==="grid"?"block":"none";$("blankBase").style.display=mode==="blank"?"block":"none";document.querySelectorAll("[data-board]").forEach(b=>b.classList.toggle("active",b.dataset.board===mode));if(mode==="map"&&boardMap)setTimeout(()=>boardMap.invalidateSize(),50)}
  document.querySelectorAll("[data-board]").forEach(b=>b.onclick=()=>setBoardMode(b.dataset.board));
  function setDrawTool(tool){drawTool=tool;document.querySelectorAll("[data-tool]").forEach(b=>b.classList.toggle("active",b.dataset.tool===tool));drawTarget.classList.toggle("active",tool!=="pan");if(boardMap&&drawTarget===$("boardInk")){tool==="pan"?boardMap.dragging.enable():boardMap.dragging.disable();tool==="pan"?boardMap.scrollWheelZoom.enable():boardMap.scrollWheelZoom.disable()}}
  document.querySelectorAll("[data-tool]").forEach(b=>b.onclick=()=>setDrawTool(b.dataset.tool));
  function openBoard(){closeSheets();$("board").classList.add("show");$("drawTools").classList.add("show");drawTarget=$("boardInk");initMap();setTimeout(()=>boardMap.invalidateSize(),100);setBoardMode("map");setDrawTool("pan");resizeCanvases()}
  function closeBoard(){$("board").classList.remove("show");$("drawTools").classList.remove("show");$("boardInk").classList.remove("active")}
  $("boardBtn").onclick=openBoard;$("closeBoard").onclick=closeBoard;
  function bindDraw(canvas){const ctx=canvas.getContext("2d");canvas.onpointerdown=e=>{if(drawTool==="pan")return;drawTarget=canvas;drawing=true;history.push({canvas,src:canvas.toDataURL()});canvas.setPointerCapture(e.pointerId);const r=canvas.getBoundingClientRect();ctx.beginPath();ctx.moveTo(e.clientX-r.left,e.clientY-r.top)};canvas.onpointermove=e=>{if(!drawing||drawTarget!==canvas)return;const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,base=+$("inkSize").value;ctx.lineCap="round";ctx.lineJoin="round";if(drawTool==="eraser"){ctx.globalCompositeOperation="destination-out";ctx.lineWidth=base*3;ctx.globalAlpha=1}else{ctx.globalCompositeOperation="source-over";ctx.lineWidth=drawTool==="highlighter"?base*3:base;ctx.globalAlpha=drawTool==="highlighter"?.28:1;ctx.strokeStyle=$("inkColor").value}ctx.lineTo(x,y);ctx.stroke()};canvas.onpointerup=()=>{drawing=false;ctx.globalAlpha=1};canvas.onpointercancel=()=>{drawing=false;ctx.globalAlpha=1}}
  bindDraw($("boardInk"));bindDraw($("screenInk"));
  $("undoInk").onclick=()=>{const item=history.pop();if(!item)return;const canvas=item.canvas,ctx=canvas.getContext("2d"),r=canvas.getBoundingClientRect(),im=new Image();im.onload=()=>{ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(im,0,0,r.width,r.height)};im.src=item.src};
  $("clearInk").onclick=()=>{const canvas=drawTarget,ctx=canvas.getContext("2d");history.push({canvas,src:canvas.toDataURL()});ctx.clearRect(0,0,canvas.width,canvas.height)};
  $("stopInk").onclick=()=>{$("drawTools").classList.remove("show");$("screenInk").classList.remove("active");$("boardInk").classList.remove("active");drawTool="pan"};
  $("annotateBtn").onclick=()=>{closeSheets();closeBoard();drawTarget=$("screenInk");$("drawTools").classList.add("show");setDrawTool("pen");toast("Caneta sobre a apresentação ativada.")};

  /* YouTube */
  function extractYouTubeId(input){
    input=String(input||"").trim();
    if(/^[A-Za-z0-9_-]{11}$/.test(input))return input;
    try{const u=new URL(input);if(u.hostname.includes("youtu.be"))return u.pathname.split("/").filter(Boolean)[0]||"";if(u.searchParams.get("v"))return u.searchParams.get("v");const parts=u.pathname.split("/").filter(Boolean);const i=parts.findIndex(x=>["live","embed","shorts"].includes(x));if(i>=0&&parts[i+1])return parts[i+1]}catch(e){}
    return "";
  }
  function loadYouTube(id){
    if(!id){$("youtubeLayer").classList.remove("show");$("youtubeFrame").src="";return}
    $("youtubeFrame").src="https://www.youtube.com/embed/"+encodeURIComponent(id)+"?autoplay=1&playsinline=1&rel=0";
    $("youtubeLayer").classList.add("show");
    const u=new URL(location.href);u.searchParams.set("yt",id);history.replaceState(null,"",u);
  }
  const initialYt=params.get("yt");if(initialYt)loadYouTube(initialYt);
  $("youtubeApply").onclick=()=>{const id=extractYouTubeId($("youtubeInput").value);if(!id)return toast("Não reconheci esse link do YouTube.");loadYouTube(id);closeSheets();toast("🎬 YouTube Live carregado.")};
  $("youtubeClose").onclick=()=>{loadYouTube("");const u=new URL(location.href);u.searchParams.delete("yt");history.replaceState(null,"",u);closeSheets()};
  $("studentLinkBtn").onclick=async()=>{const u=new URL(location.href);u.searchParams.set("role","student");const text=u.toString();try{await navigator.clipboard.writeText(text);toast("🔗 Link dos alunos copiado.")}catch(e){prompt("Copie o link dos alunos:",text)}};
  $("homeBtn").onclick=()=>{closeSheets();closeBoard();$("youtubeLayer").classList.remove("show");$("screenLayer").classList.remove("show")};

  /* student UI */
  if(isStudent){
    ["presentBtn","annotateBtn","timerBtn","presenceBtn","stageBtn","youtubeBtn","studentLinkBtn","clearHandsBtn","removeStageBtn"].forEach(id=>$(id).style.display="none");
    $("micBtn").style.display="none";$("camBtn").style.display="none";$("boardBtn").style.display="none";

    const dock=$("dock");
    function add(id,ico,label){const b=document.createElement("button");b.id=id;b.type="button";b.innerHTML='<span class="ico">'+ico+'</span><span>'+label+"</span>";dock.insertBefore(b,$("moreBtn"));return b}
    add("studentChat","💬","Chat").onclick=()=>openSheet("chatSheet");
    add("studentReact","✨","Reagir").onclick=()=>openSheet("reactionSheet");
    add("studentSound","🔊","Som").onclick=()=>$("audioUnlock").click();
    $("moreBtn").onclick=()=>toast("Quando você for chamado, câmera e microfone aparecem automaticamente.");
  }

  connectLivekit();
})();
