(() => {
  const $=id=>document.getElementById(id);
  const params=new URLSearchParams(location.search);
  const isStudent=params.get("role")==="student"||params.has("guest");
  const isHost=!isStudent;
  const ROOM="flashmap-aula";
  const MAX_TIMER_SECONDS=180*60+59;

  let room=null,livekitPromise=null,cameraOn=false,micOn=false,shareOn=false;
  let currentStage=null,hands=[],presence=[],boardMap=null,boardMode="map";
  let audioCtx=null,analyser=null,meterRaf=0,meterSource=null;
  let studentStageJoined=false;
  const sessionStart=Date.now();

  let timerTotal=300,timerLeft=300,timerRunning=false,timerInterval=null,timerDeadline=0;

  let mediaRecorder=null,recordedChunks=[],recordOwnedTracks=[],recordObjectUrl="";
  let recordTimer=null,recordStartedAt=0,recordPausedAt=0,recordPausedTotal=0,recordMixCtx=null;

  $("roleBadge").textContent=isHost?"🎓 PROFESSOR":"👤 PARTICIPANTE";

  const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));
  const fmtDuration=(sec,alwaysHour=false)=>{
    sec=Math.max(0,Math.floor(Number(sec)||0));
    const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;
    if(alwaysHour||h>0)return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
    return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  };

  setInterval(()=>$('sessionClock').textContent="AULA "+fmtDuration((Date.now()-sessionStart)/1000,true),1000);

  function toast(text){
    $("toast").textContent=text;
    $("toast").classList.add("show");
    clearTimeout(toast.t);
    toast.t=setTimeout(()=>$('toast').classList.remove("show"),3300);
  }

  function conn(ok,text){
    $("connText").textContent=text;
    $("connDot").classList.toggle("ok",ok===true);
    $("connDot").classList.toggle("bad",ok===false);
  }

  function showStageBanner(text){
    $("stageBanner").textContent=text;
    $("stageBanner").classList.add("show");
    clearTimeout(showStageBanner.t);
    showStageBanner.t=setTimeout(()=>$('stageBanner').classList.remove("show"),2600);
  }

  /* sheets */
  const sheetIds=["moreSheet","handsSheet","presenceSheet","chatSheet","timerSheet","reactionSheet","youtubeSheet","recordSheet"];
  function closeSheets(){sheetIds.forEach(id=>$(id).classList.remove("show"));$("scrim").classList.remove("show")}
  function openSheet(id){closeSheets();$(id).classList.add("show");$("scrim").classList.add("show")}
  document.querySelectorAll(".sheetClose").forEach(b=>b.onclick=closeSheets);
  $("scrim").onclick=closeSheets;
  $("moreBtn").onclick=()=>openSheet("moreSheet");
  $("presenceBtn").onclick=()=>openSheet("presenceSheet");
  $("chatBtn").onclick=()=>openSheet("chatSheet");
  $("timerBtn").onclick=()=>openSheet("timerSheet");
  $("reactionBtn").onclick=()=>openSheet("reactionSheet");
  $("youtubeBtn").onclick=()=>openSheet("youtubeSheet");

  /* student name */
  function requireStudentName(){
    if(isStudent&&!FM.name){
      $("joinCard").classList.add("show");
      setTimeout(()=>$('joinName').focus(),220);
      return false;
    }
    return true;
  }
  $("joinNameBtn").onclick=async()=>{
    const n=$("joinName").value.trim();
    if(n.length<2)return toast("Digite seu nome.");
    try{
      await FM.rename(n);
      $("localCamName").textContent=n;
      $("joinCard").classList.remove("show");
      toast("Bem-vindo, "+n+"!");
      if(currentStage?.uid===FM.uid)$("stageInvite").classList.add("show");
    }catch(err){toast(err?.message||String(err))}
  };
  $("joinName").onkeydown=e=>{if(e.key==="Enter")$("joinNameBtn").click()};

  /* LiveKit: professor conecta normalmente; aluno só conecta quando aceita convite de palco. */
  async function connectLivekit(forceStudent=false){
    if(room)return room;
    if(isStudent&&!forceStudent)return null;
    if(isStudent&&!FM.name)throw new Error("Digite seu nome antes de entrar no palco");
    if(livekitPromise)return livekitPromise;

    livekitPromise=(async()=>{
      const ts=LivekitClient.TokenSource.sandboxTokenServer("flashmap-7br9z6");
      const c=await ts.fetch({roomName:ROOM,participantIdentity:FM.uid,participantName:FM.name||"Participante"});
      const r=new LivekitClient.Room({adaptiveStream:true,dynacast:true});
      r
        .on(LivekitClient.RoomEvent.TrackSubscribed,onTrackSubscribed)
        .on(LivekitClient.RoomEvent.TrackUnsubscribed,onTrackUnsubscribed)
        .on(LivekitClient.RoomEvent.ActiveSpeakersChanged,speakers=>{
          const speaking=currentStage&&speakers.some(s=>s.identity===currentStage.uid);
          $("guestTile").classList.toggle("speaking",!!speaking);
        })
        .on(LivekitClient.RoomEvent.Disconnected,()=>{
          if(room===r)room=null;
          if(isHost)conn(FM.connected,"Vídeo desconectado");
        });
      await r.connect(c.serverUrl,c.participantToken);
      room=r;
      if(isHost){
        conn(true,"Vídeo pronto");
        $("welcome").textContent="Pronto. Abra o QGIS, o quadro ou a transmissão.";
      }
      return r;
    })().catch(err=>{
      console.error("FLASHMAP LiveKit",err);
      if(isHost)conn(FM.connected,"Vídeo indisponível");
      throw err;
    }).finally(()=>{livekitPromise=null});

    return livekitPromise;
  }

  function appendRemoteAudio(track){
    const a=track.attach();
    a.autoplay=true;
    a.dataset.flashmapAudio="1";
    document.body.appendChild(a);
    a.play().catch(()=>$('audioUnlock').style.display="block");
  }

  function onTrackSubscribed(track,pub,participant){
    if(track.kind==="audio"){
      appendRemoteAudio(track);
      return;
    }

    const v=track.attach();
    v.autoplay=true;
    v.playsInline=true;

    if(pub.source===LivekitClient.Track.Source.ScreenShare){
      $("screenLayer").querySelectorAll("video").forEach(x=>x.remove());
      $("screenLayer").appendChild(v);
      $("screenChip").textContent="🖥️ "+(participant.name||"APRESENTAÇÃO")+" • AO VIVO";
      $("screenLayer").classList.add("show");
      return;
    }

    if(pub.source===LivekitClient.Track.Source.Camera){
      if(isHost){
        if(currentStage&&participant.identity===currentStage.uid){
          $("guestVideo").innerHTML="";
          $("guestVideo").appendChild(v);
          const guest=currentStage.name||participant.name||"Participante";
          $("guestName").textContent=guest;
          $("guestTile").classList.add("show");
          showStageBanner(guest+" entrou no palco");
        }else{
          track.detach().forEach(el=>el.remove());
        }
      }else{
        $("professorRemote").innerHTML="";
        $("professorRemote").appendChild(v);
        $("professorRemote").classList.add("show");
      }
    }
  }

  function onTrackUnsubscribed(track,pub){
    track.detach().forEach(el=>el.remove());
    if(pub.source===LivekitClient.Track.Source.ScreenShare)$("screenLayer").classList.remove("show");
    if(pub.source===LivekitClient.Track.Source.Camera){
      if(isHost)$("guestTile").classList.remove("show");
      else $("professorRemote").classList.remove("show");
    }
  }

  $("audioUnlock").onclick=async()=>{
    try{if(room?.startAudio)await room.startAudio()}catch(e){}
    document.querySelectorAll("audio").forEach(a=>a.play().catch(()=>{}));
    youtubeCommand("unMute");
    $("audioUnlock").style.display="none";
  };

  async function setCamera(force){
    if(isStudent&&force!==false&&currentStage?.uid!==FM.uid)return toast("Câmera só é liberada quando você é chamado ao palco.");
    try{
      if(!room)await connectLivekit(isStudent);
      if(!room)throw new Error("Vídeo ainda não conectado");
      const target=typeof force==="boolean"?force:!cameraOn;
      await room.localParticipant.setCameraEnabled(target,{resolution:{width:1280,height:720},frameRate:24});
      cameraOn=target;
      const pub=room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
      if(cameraOn&&pub?.track){
        $("selfVideo").srcObject=new MediaStream([pub.track.mediaStreamTrack]);
        $("localCam").classList.add("show");
      }else{
        $("selfVideo").srcObject=null;
        $("localCam").classList.remove("show");
      }
      $("camBtn").classList.toggle("on",cameraOn);
      $("stageCamBtn").classList.toggle("on",cameraOn);
    }catch(err){
      cameraOn=false;
      $("camBtn").classList.remove("on");
      $("stageCamBtn").classList.remove("on");
      toast("Câmera: "+(err?.message||err));
    }
  }

  async function setMic(force){
    if(isStudent&&force!==false&&currentStage?.uid!==FM.uid)return toast("Microfone só é liberado quando você é chamado ao palco.");
    try{
      if(!room)await connectLivekit(isStudent);
      if(!room)throw new Error("Áudio ainda não conectado");
      const target=typeof force==="boolean"?force:!micOn;
      await room.localParticipant.setMicrophoneEnabled(target,{echoCancellation:true,noiseSuppression:true,autoGainControl:true});
      micOn=target;
      $("micBtn").classList.toggle("on",micOn);
      $("stageMicBtn").classList.toggle("on",micOn);
      if(micOn){
        $("micState").textContent="CAPTANDO";
        setTimeout(startMeter,120);
      }else{
        $("micState").textContent="MUDO";
        stopMeter();
      }
    }catch(err){
      micOn=false;
      $("micBtn").classList.remove("on");
      $("stageMicBtn").classList.remove("on");
      $("micState").textContent="MUDO";
      toast("Microfone: "+(err?.message||err));
    }
  }

  function paintVu(level){
    const bars=[...$("vuMeter").querySelectorAll("i")];
    bars.forEach((bar,i)=>{
      bar.classList.toggle("on",i<level);
      bar.classList.toggle("hot",i<level&&i>=5&&i<7);
      bar.classList.toggle("peak",i<level&&i>=7);
    });
    const talking=level>=2;
    $("micState").textContent=micOn?(talking?"FALANDO":"CAPTANDO"):"MUDO";
    $("micState").classList.toggle("talking",talking&&micOn);
  }

  function startMeter(){
    stopMeter(false);
    const pub=room?.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
    if(!pub?.track)return;
    audioCtx||=new(window.AudioContext||window.webkitAudioContext)();
    const stream=new MediaStream([pub.track.mediaStreamTrack]);
    meterSource=audioCtx.createMediaStreamSource(stream);
    analyser=audioCtx.createAnalyser();
    analyser.fftSize=256;
    analyser.smoothingTimeConstant=.7;
    meterSource.connect(analyser);
    const data=new Uint8Array(analyser.frequencyBinCount);
    const loop=()=>{
      if(!analyser)return;
      analyser.getByteFrequencyData(data);
      const avg=data.reduce((a,b)=>a+b,0)/data.length;
      const level=avg<4?0:clamp(Math.ceil(avg/12),1,8);
      paintVu(level);
      meterRaf=requestAnimationFrame(loop);
    };
    loop();
  }

  function stopMeter(reset=true){
    cancelAnimationFrame(meterRaf);
    try{meterSource?.disconnect()}catch(e){}
    meterSource=null;analyser=null;
    if(reset)paintVu(0);
  }

  async function renderLocalScreenPreview(){
    if(!room||!shareOn)return;
    await new Promise(r=>setTimeout(r,80));
    const pub=room.localParticipant.getTrackPublication(LivekitClient.Track.Source.ScreenShare);
    if(!pub?.track)return;
    $("screenLayer").querySelectorAll("video").forEach(x=>x.remove());
    const v=pub.track.attach();
    v.autoplay=true;v.playsInline=true;v.muted=true;
    $("screenLayer").appendChild(v);
    $("screenChip").textContent="🖥️ QGIS / TELA • PREVIEW";
    $("screenLayer").classList.add("show");
    pub.track.mediaStreamTrack.onended=()=>{
      shareOn=false;
      $("screenLayer").classList.remove("show");
      if($("presentationCanvas").classList.contains("visible"))stopPresentationInk();
      toast("Apresentação encerrada.");
    };
  }

  async function toggleShare(){
    if(!navigator.mediaDevices?.getDisplayMedia)return toast("🖥️ Apresentar QGIS está disponível no computador compatível.");
    try{
      await connectLivekit(false);
      if(!room)throw new Error("Vídeo ainda não conectado");
      const target=!shareOn;
      await room.localParticipant.setScreenShareEnabled(target,{audio:true});
      shareOn=target;
      if(shareOn){
        await renderLocalScreenPreview();
        toast("QGIS/tela entrou no ar.");
      }else{
        $("screenLayer").querySelectorAll("video").forEach(x=>x.remove());
        $("screenLayer").classList.remove("show");
        stopPresentationInk();
        toast("Apresentação encerrada.");
      }
    }catch(err){
      shareOn=false;
      toast("Apresentação: "+(err?.message||err));
    }
  }

  $("micBtn").onclick=()=>setMic();
  $("camBtn").onclick=()=>setCamera();
  $("stageMicBtn").onclick=()=>setMic();
  $("stageCamBtn").onclick=()=>setCamera();
  $("presentBtn").onclick=()=>{closeSheets();toggleShare()};

  /* draggable / dockable local camera */
  let camSize=250;
  function dockCamera(side){
    const el=$("localCam");
    el.style.top="auto";el.style.bottom="92px";
    if(side==="right"){el.style.right="18px";el.style.left="auto";el.style.transformOrigin="bottom right"}
    else{el.style.left="18px";el.style.right="auto";el.style.transformOrigin="bottom left"}
  }
  $("camLeft").onclick=e=>{e.stopPropagation();dockCamera("left")};
  $("camRight").onclick=e=>{e.stopPropagation();dockCamera("right")};
  $("camPlus").onclick=e=>{e.stopPropagation();camSize=Math.min(Math.floor(innerWidth*.82),camSize+60);$("localCam").style.width=camSize+"px"};
  $("camMinus").onclick=e=>{e.stopPropagation();camSize=Math.max(130,camSize-60);$("localCam").style.width=camSize+"px"};
  (()=>{
    let dragging=false,dx=0,dy=0;
    const handle=$("camDrag"),el=$("localCam"),stage=$("stage");
    handle.onpointerdown=e=>{
      if(e.target.tagName==="BUTTON")return;
      const r=el.getBoundingClientRect();
      dragging=true;dx=e.clientX-r.left;dy=e.clientY-r.top;
      handle.setPointerCapture(e.pointerId);
    };
    handle.onpointermove=e=>{
      if(!dragging)return;
      const sr=stage.getBoundingClientRect();
      const maxX=Math.max(6,sr.width-el.offsetWidth-6),maxY=Math.max(6,sr.height-el.offsetHeight-72);
      const x=clamp(e.clientX-sr.left-dx,6,maxX),y=clamp(e.clientY-sr.top-dy,6,maxY);
      el.style.left=x+"px";el.style.top=y+"px";el.style.right="auto";el.style.bottom="auto";
    };
    handle.onpointerup=e=>{dragging=false;try{handle.releasePointerCapture(e.pointerId)}catch(_) {}};
    handle.onpointercancel=()=>dragging=false;
  })();

  /* Firebase state */
  window.addEventListener("fm:connection",e=>{
    const ok=!!e.detail?.connected;
    if(isStudent)conn(ok,ok?"Interação online":"Reconectando");
    else if(!room)conn(ok,ok?"Firebase online":"Reconectando");
  });
  window.addEventListener("fm:error",e=>{conn(false,"Firebase indisponível");toast("Firebase: "+(e.detail?.message||"erro de conexão"))});
  window.addEventListener("fm:presence",e=>{presence=Array.isArray(e.detail)?e.detail:[];$("online").textContent=presence.length;renderPresence()});
  window.addEventListener("fm:hands",e=>{hands=Array.isArray(e.detail)?e.detail:[];renderHands()});
  window.addEventListener("fm:stage",e=>{
    const prev=currentStage;
    currentStage=e.detail||null;
    renderStage();

    if(isHost&&prev?.uid&&prev.uid!==currentStage?.uid){
      $("guestTile").classList.remove("show","speaking");
      $("guestVideo").innerHTML="";
    }

    if(isStudent){
      const mine=currentStage?.uid===FM.uid;
      if(mine){
        if(prev?.uid!==FM.uid&&!studentStageJoined){
          youtubeCommand("mute");
          $("stageInvite").classList.add("show");
        }
      }else if(prev?.uid===FM.uid||studentStageJoined){
        $("stageInvite").classList.remove("show");
        leaveStudentStage();
      }
    }
  });
  window.addEventListener("fm:reaction",e=>{const x=e.detail||{};if(x.uid!==FM.uid&&x.emoji)spawnReaction(x.emoji)});
  window.addEventListener("fm:chat",e=>appendChat(e.detail));

  let readyHandled=false;
  async function handleReady(){
    if(readyHandled)return;readyHandled=true;
    presence=FM.state.presence||presence;hands=FM.state.hands||hands;currentStage=FM.state.stage||currentStage;
    $("localCamName").textContent=FM.name||"Participante";
    renderPresence();renderHands();renderStage();
    if(isStudent){
      requireStudentName();
      $("welcome").textContent="Você está dentro do FLASHMAP. A transmissão principal chega pelo YouTube.";
    }else{
      try{await connectLivekit(false)}catch(err){toast("LiveKit: "+(err?.message||err))}
    }
  }
  window.addEventListener("fm:ready",handleReady);
  FM.ready.then(handleReady).catch(()=>{});

  /* hands + stage: UI and stage always use the same FM.state.hands / /flashmap/hands state. */
  async function openHands(){
    closeSheets();
    try{await FM.refresh();hands=FM.state.hands||[];currentStage=FM.state.stage||null}catch(e){}
    renderHands();renderStage();openSheet("handsSheet");
  }
  $("stageBtn").onclick=openHands;
  $("handsBtn").onclick=()=>{
    if(isHost)return openHands();
    if(!requireStudentName())return;
    FM.hand().catch(err=>toast(err?.message||String(err)));
  };

  function renderHands(){
    $("handBadge").innerHTML=hands.length?'<span class="badgeCount">'+hands.length+"</span>":"";
    if(isStudent){
      const mine=hands.some(h=>h.uid===FM.uid);
      $("handsLabel").textContent=mine?"Baixar":"Mão";
      $("handsBtn").classList.toggle("on",mine);
    }
    if(!hands.length){$("handsList").innerHTML='<div class="empty">Ninguém pediu para falar.</div>';return}

    $("handsList").innerHTML=hands.map(h=>
      '<div class="row">'+
      '<div class="avatar">✋</div>'+
      '<div class="rowMain"><div class="rowName">'+esc(h.name||"Participante")+'</div><div class="rowSub">aguardando para falar</div></div>'+
      '<div class="rowActions"><button class="callBtn" data-call="'+esc(h.uid)+'" type="button">CHAMAR</button><button class="downBtn" data-down="'+esc(h.uid)+'" type="button">BAIXAR</button></div></div>'
    ).join("");

    $("handsList").querySelectorAll("[data-call]").forEach(b=>b.onclick=async()=>{
      const h=hands.find(x=>x.uid===b.dataset.call);
      if(!h)return toast("Essa mão já saiu da fila.");
      b.disabled=true;
      try{
        await FM.callStage(h.uid,h.name);
        toast("🎙️ "+h.name+" foi chamado ao palco.");
      }catch(err){toast(err?.message||String(err))}
      finally{b.disabled=false}
    });
    $("handsList").querySelectorAll("[data-down]").forEach(b=>b.onclick=()=>FM.lowerHand(b.dataset.down).catch(err=>toast(err?.message||String(err))));
  }

  function renderStage(){
    $("stageNow").textContent=currentStage?"No palco agora: "+currentStage.name:"Ninguém no palco.";
    $("removeStageBtn").disabled=!currentStage;
    if(!currentStage)$("guestTile").classList.remove("show","speaking");
  }

  $("clearHandsBtn").onclick=()=>FM.clearHands().catch(err=>toast(err?.message||String(err)));
  $("removeStageBtn").onclick=()=>FM.clearStage().catch(err=>toast(err?.message||String(err)));

  async function joinStudentStage(withVideo){
    if(currentStage?.uid!==FM.uid)return toast("Esse convite não está mais ativo.");
    try{
      // Coordenação de teste: o frontend só conecta o aluno ao LiveKit depois do convite.
      // Em produção, o servidor de tokens também deve impedir publicação de qualquer aluno fora de /flashmap/stage.
      await connectLivekit(true);
      await setMic(true);
      await setCamera(!!withVideo);
      studentStageJoined=true;
      $("stageInvite").classList.remove("show");
      $("studentStageControls").classList.add("show");
      toast(withVideo?"🎙️ Você entrou com câmera e microfone.":"🎙️ Você entrou só com microfone.");
    }catch(err){toast("Palco: "+(err?.message||err))}
  }
  $("joinStageVideo").onclick=()=>joinStudentStage(true);
  $("joinStageAudio").onclick=()=>joinStudentStage(false);

  async function leaveStudentStage(){
    if(!isStudent)return;
    studentStageJoined=false;
    $("studentStageControls").classList.remove("show");
    try{if(room){await setCamera(false);await setMic(false)}}catch(e){}
    try{room?.disconnect()}catch(e){}
    room=null;
    $("professorRemote").classList.remove("show");
    $("screenLayer").classList.remove("show");
    document.querySelectorAll("audio[data-flashmap-audio='1']").forEach(a=>a.remove());
    youtubeCommand("unMute");
    toast("Você saiu do palco.");
  }

  /* presence */
  function durationText(ms){
    const sec=Math.max(0,Math.floor(ms/1000));
    if(sec>=3600)return fmtDuration(sec,true);
    const min=Math.floor(sec/60);
    if(min>=1)return min+" min";
    return sec+" s";
  }
  function renderPresence(){
    $("presenceTotal").textContent=presence.length;
    const now=Date.now();
    const sorted=presence.slice().sort((a,b)=>{
      if(a.role===b.role)return (a.joinedAt||0)-(b.joinedAt||0);
      return a.role==="host"?-1:1;
    });
    $("presenceList").innerHTML=sorted.length?sorted.map(p=>{
      const entry=p.joinedAt?new Date(p.joinedAt).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}):"—";
      const role=p.role==="host"?"PROFESSOR":"PARTICIPANTE";
      return '<div class="row"><div class="avatar">'+esc((p.name||"?").slice(0,1).toUpperCase())+'</div><div class="rowMain"><div class="rowName">'+esc(p.name||"Participante")+'</div><div class="rowSub">'+role+' · entrou '+entry+' · conectado há '+durationText(now-(p.joinedAt||now))+'</div></div><span class="onlinePill">ONLINE</span></div>';
    }).join(""):'<div class="empty">Nenhuma presença registrada agora.</div>';
  }
  setInterval(()=>{if($("presenceSheet").classList.contains("show"))renderPresence()},1000);

  $("exportPresence").onclick=()=>{
    const now=Date.now();
    const rows=[["nome","papel","entrada","tempo_conectado","online"],...presence.map(p=>[
      p.name||"",
      p.role==="host"?"PROFESSOR":"PARTICIPANTE",
      p.joinedAt?new Date(p.joinedAt).toLocaleString("pt-BR"):"",
      p.joinedAt?fmtDuration((now-p.joinedAt)/1000,true):"",
      "SIM"
    ])];
    const csv=rows.map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(";")).join("\n");
    const blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"}),a=document.createElement("a");
    a.href=URL.createObjectURL(blob);a.download="flashmap-presenca.csv";a.click();URL.revokeObjectURL(a.href);
  };

  /* chat */
  function appendChat(x){
    if(!x?.text)return;
    const d=document.createElement("div");d.className="msg";
    const b=document.createElement("b");b.textContent=x.name||"Participante";
    d.append(b,document.createTextNode(x.text));
    $("chatLog").appendChild(d);$("chatLog").scrollTop=$("chatLog").scrollHeight;
  }
  function sendChat(){
    if(isStudent&&!requireStudentName())return;
    const t=$("chatInput").value.trim();if(!t)return;
    FM.chat(t).catch(err=>toast(err?.message||String(err)));$("chatInput").value="";
  }
  $("chatSend").onclick=sendChat;
  $("chatInput").onkeydown=e=>{if(e.key==="Enter")sendChat()};

  /* reactions */
  function spawnReaction(emoji){
    const el=document.createElement("div");
    el.className="flyReaction";el.textContent=emoji;
    el.style.left=(7+Math.random()*86)+"%";
    el.style.setProperty("--drift",(-100+Math.random()*200)+"px");
    $("stage").appendChild(el);
    setTimeout(()=>el.remove(),3000);
  }
  $("reactionGrid").querySelectorAll("button").forEach(b=>b.onclick=()=>{
    if(isStudent&&!requireStudentName())return;
    const emoji=b.textContent.trim();spawnReaction(emoji);
    FM.react(emoji).catch(err=>toast(err?.message||String(err)));
    closeSheets();
  });

  /* activity timer - independent from class clock */
  function stopTimerLoop(){clearInterval(timerInterval);timerInterval=null}
  function setTimer(sec,source="custom",sourceButton=null){
    stopTimerLoop();timerRunning=false;timerDeadline=0;
    timerTotal=clamp(Math.floor(Number(sec)||0),1,MAX_TIMER_SECONDS);
    timerLeft=timerTotal;
    document.querySelectorAll("[data-min]").forEach(b=>b.classList.toggle("selected",source==="preset"&&b===sourceButton));
    renderTimer();
    $("activityTimer").classList.add("show");
    $("timerPause").textContent="⏸ PAUSAR";
  }
  function renderTimer(){
    $("timerValue").textContent=fmtDuration(timerLeft);
    $("timerBarFill").style.width=(timerTotal?clamp(timerLeft/timerTotal*100,0,100):0)+"%";
    $("activityTimer").classList.toggle("urgent",timerLeft<=30&&timerLeft>0);
  }
  function timerTick(){
    if(!timerRunning)return;
    const next=Math.max(0,Math.ceil((timerDeadline-Date.now())/1000));
    if(next!==timerLeft){timerLeft=next;renderTimer()}
    if(timerLeft<=0){
      timerRunning=false;stopTimerLoop();timerLeft=0;renderTimer();$("timerPause").textContent="▶ CONTINUAR";toast("⏱️ TEMPO ENCERRADO!");
    }
  }
  function startTimer(){
    if(timerLeft<=0)timerLeft=timerTotal;
    timerRunning=true;timerDeadline=Date.now()+timerLeft*1000;
    stopTimerLoop();timerInterval=setInterval(timerTick,200);
    $("activityTimer").classList.add("show");$("timerPause").textContent="⏸ PAUSAR";renderTimer();closeSheets();
  }
  function toggleTimerPause(){
    if(timerRunning){
      timerLeft=Math.max(0,Math.ceil((timerDeadline-Date.now())/1000));timerRunning=false;stopTimerLoop();renderTimer();$("timerPause").textContent="▶ CONTINUAR";toast("Temporizador pausado.");
    }else{
      if(timerLeft<=0)timerLeft=timerTotal;
      timerRunning=true;timerDeadline=Date.now()+timerLeft*1000;timerInterval=setInterval(timerTick,200);$("activityTimer").classList.add("show");$("timerPause").textContent="⏸ PAUSAR";toast("Temporizador continuou.");
    }
  }
  document.querySelectorAll("[data-min]").forEach(b=>b.onclick=()=>setTimer(Number(b.dataset.min)*60,"preset",b));
  $("applyCustom").onclick=()=>{
    const m=clamp(Number.parseInt($("customMin").value,10)||0,0,180);
    const s=clamp(Number.parseInt($("customSec").value,10)||0,0,59);
    $("customMin").value=String(m);$("customSec").value=String(s);
    const sec=m*60+s;if(sec<1)return toast("Defina pelo menos 1 segundo.");
    setTimer(sec,"custom",null);toast("Tempo personalizado: "+fmtDuration(sec));
  };
  $("timerStart").onclick=startTimer;
  $("timerPause").onclick=toggleTimerPause;
  $("timerRestart").onclick=()=>{timerLeft=timerTotal;timerRunning=false;stopTimerLoop();startTimer();toast("Temporizador reiniciado.")};
  $("timerStop").onclick=()=>{if(timerRunning)toggleTimerPause();$("activityTimer").classList.remove("show");closeSheets()};
  renderTimer();

  /* board + presentation annotation: independent canvases and independent history */
  const boardCanvas=$("boardCanvas"),presentationCanvas=$("presentationCanvas");
  let drawTarget=boardCanvas,drawTool="pan",drawing=false;
  const histories=new Map([[boardCanvas,[]],[presentationCanvas,[]]]);

  function initMap(){
    if(boardMap)return;
    boardMap=L.map("mapBoard",{zoomControl:true,preferCanvas:true}).setView([-14.2,-56.1],5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap"}).addTo(boardMap);
  }

  function canvasCssSize(){const r=$("stage").getBoundingClientRect();return {width:r.width,height:r.height}}
  function resizeCanvas(canvas){
    const dpr=Math.max(1,window.devicePixelRatio||1),size=canvasCssSize();
    if(size.width<1||size.height<1)return;
    const oldW=Number(canvas.dataset.cssW)||size.width,oldH=Number(canvas.dataset.cssH)||size.height;
    let backup=null;
    if(canvas.width&&canvas.height){backup=document.createElement("canvas");backup.width=canvas.width;backup.height=canvas.height;backup.getContext("2d").drawImage(canvas,0,0)}
    canvas.width=Math.round(size.width*dpr);canvas.height=Math.round(size.height*dpr);
    canvas.style.width=size.width+"px";canvas.style.height=size.height+"px";
    canvas.dataset.cssW=String(size.width);canvas.dataset.cssH=String(size.height);
    const ctx=canvas.getContext("2d");ctx.setTransform(dpr,0,0,dpr,0,0);
    if(backup)ctx.drawImage(backup,0,0,backup.width,backup.height,0,0,size.width,size.height);
    void oldW;void oldH;
  }
  function resizeCanvases(){resizeCanvas(boardCanvas);resizeCanvas(presentationCanvas);if(boardMap&&$("board").classList.contains("show"))setTimeout(()=>boardMap.invalidateSize(),30)}
  resizeCanvases();addEventListener("resize",resizeCanvases);addEventListener("orientationchange",()=>setTimeout(resizeCanvases,120));

  function setMapInteraction(enabled){
    if(!boardMap)return;
    ["dragging","touchZoom","doubleClickZoom","scrollWheelZoom","boxZoom","keyboard"].forEach(k=>{
      const h=boardMap[k];if(!h)return;enabled?h.enable():h.disable();
    });
  }
  function setBoardMode(mode){
    boardMode=mode;
    $("mapBoard").style.display=mode==="map"?"block":"none";
    $("gridBase").style.display=mode==="grid"?"block":"none";
    $("blankBase").style.display=mode==="blank"?"block":"none";
    document.querySelectorAll("[data-board]").forEach(b=>b.classList.toggle("active",b.dataset.board===mode));
    if(mode==="map"&&boardMap)setTimeout(()=>boardMap.invalidateSize(),50);
  }
  document.querySelectorAll("[data-board]").forEach(b=>b.onclick=()=>setBoardMode(b.dataset.board));

  function setDrawTool(tool){
    drawTool=tool;
    document.querySelectorAll("[data-tool]").forEach(b=>b.classList.toggle("active",b.dataset.tool===tool));
    drawTarget.classList.toggle("active",tool!=="pan");
    if(drawTarget===boardCanvas)setMapInteraction(tool==="pan");
  }
  document.querySelectorAll("[data-tool]").forEach(b=>b.onclick=()=>setDrawTool(b.dataset.tool));

  function openBoard(){
    closeSheets();stopPresentationInk();
    $("board").classList.add("show");$("drawTools").classList.add("show");
    drawTarget=boardCanvas;initMap();resizeCanvases();setBoardMode(boardMode);setDrawTool("pan");
    setTimeout(()=>boardMap.invalidateSize(),80);
  }
  function closeBoard(){
    $("board").classList.remove("show");
    if(drawTarget===boardCanvas)$("drawTools").classList.remove("show");
    boardCanvas.classList.remove("active");setMapInteraction(true);
  }
  $("boardBtn").onclick=openBoard;$("closeBoard").onclick=closeBoard;

  function snapshot(canvas){
    const h=histories.get(canvas);if(!h)return;
    h.push(canvas.toDataURL("image/png"));
    if(h.length>30)h.shift();
  }
  function clearCanvas(canvas){
    const ctx=canvas.getContext("2d");ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);ctx.restore();
  }
  function restoreSnapshot(canvas,src){
    clearCanvas(canvas);if(!src)return;
    const img=new Image(),size=canvasCssSize();
    img.onload=()=>canvas.getContext("2d").drawImage(img,0,0,size.width,size.height);
    img.src=src;
  }
  function canvasPoint(canvas,e){
    const r=canvas.getBoundingClientRect(),size=canvasCssSize();
    return {x:(e.clientX-r.left)*(size.width/r.width),y:(e.clientY-r.top)*(size.height/r.height)};
  }
  function bindDraw(canvas){
    const ctx=canvas.getContext("2d");
    canvas.onpointerdown=e=>{
      if(drawTool==="pan"||drawTarget!==canvas)return;
      drawing=true;snapshot(canvas);canvas.setPointerCapture(e.pointerId);
      const p=canvasPoint(canvas,e);ctx.beginPath();ctx.moveTo(p.x,p.y);
      e.preventDefault();
    };
    canvas.onpointermove=e=>{
      if(!drawing||drawTarget!==canvas||drawTool==="pan")return;
      const p=canvasPoint(canvas,e),base=Number($("inkSize").value)||5;
      ctx.lineCap="round";ctx.lineJoin="round";
      if(drawTool==="eraser"){
        ctx.globalCompositeOperation="destination-out";ctx.lineWidth=base*3.2;ctx.globalAlpha=1;
      }else{
        ctx.globalCompositeOperation="source-over";ctx.lineWidth=drawTool==="highlighter"?base*3:base;ctx.globalAlpha=drawTool==="highlighter"?.27:1;ctx.strokeStyle=$("inkColor").value;
      }
      ctx.lineTo(p.x,p.y);ctx.stroke();e.preventDefault();
    };
    const finish=e=>{if(!drawing)return;drawing=false;ctx.globalAlpha=1;ctx.globalCompositeOperation="source-over";try{canvas.releasePointerCapture(e.pointerId)}catch(_) {}};
    canvas.onpointerup=finish;canvas.onpointercancel=finish;
  }
  bindDraw(boardCanvas);bindDraw(presentationCanvas);

  $("undoInk").onclick=()=>{const h=histories.get(drawTarget);if(!h?.length)return;restoreSnapshot(drawTarget,h.pop())};
  $("clearInk").onclick=()=>{snapshot(drawTarget);clearCanvas(drawTarget)};

  function stopPresentationInk(){
    if(drawTarget===presentationCanvas){setDrawTool("pan");$("drawTools").classList.remove("show")}
    presentationCanvas.classList.remove("active","visible");
  }
  $("stopInk").onclick=()=>{
    if(drawTarget===presentationCanvas)stopPresentationInk();
    else{setDrawTool("pan");$("drawTools").classList.remove("show")}
  };
  $("annotateBtn").onclick=()=>{
    closeSheets();closeBoard();drawTarget=presentationCanvas;resizeCanvases();presentationCanvas.classList.add("visible");$("drawTools").classList.add("show");setDrawTool("pen");toast("✏️ Anotação sobre a apresentação ativada.");
  };

  /* YouTube */
  let currentYt="";
  function extractYouTubeId(input){
    input=String(input||"").trim();
    if(/^[A-Za-z0-9_-]{11}$/.test(input))return input;
    try{
      const u=new URL(input);
      const host=u.hostname.replace(/^www\./,"");
      if(host==="youtu.be")return (u.pathname.split("/").filter(Boolean)[0]||"").slice(0,11);
      if(host.endsWith("youtube.com")){
        const v=u.searchParams.get("v");if(v&&/^[A-Za-z0-9_-]{11}$/.test(v))return v;
        const parts=u.pathname.split("/").filter(Boolean);
        const i=parts.findIndex(x=>["live","embed","shorts"].includes(x));
        if(i>=0&&parts[i+1]&&/^[A-Za-z0-9_-]{11}$/.test(parts[i+1]))return parts[i+1];
      }
    }catch(e){}
    return "";
  }
  function youtubeCommand(func,args=[]){
    try{$("youtubeFrame").contentWindow?.postMessage(JSON.stringify({event:"command",func,args}),"*")}catch(e){}
  }
  function loadYouTube(id,updateUrl=true){
    currentYt=id||"";
    if(!id){$("youtubeLayer").classList.remove("show");$("youtubeFrame").src="";return}
    const origin=encodeURIComponent(location.origin);
    $("youtubeFrame").src="https://www.youtube.com/embed/"+encodeURIComponent(id)+"?autoplay=1&playsinline=1&rel=0&enablejsapi=1&origin="+origin;
    $("youtubeLayer").classList.add("show");$("youtubeInput").value=id;
    if(updateUrl){const u=new URL(location.href);u.searchParams.set("yt",id);history.replaceState(null,"",u)}
  }
  const initialYt=extractYouTubeId(params.get("yt")||"");if(initialYt)loadYouTube(initialYt,false);
  $("youtubeApply").onclick=()=>{
    const id=extractYouTubeId($("youtubeInput").value);
    if(!id)return toast("Não reconheci esse link ou VIDEO_ID do YouTube.");
    loadYouTube(id,true);closeSheets();toast("🎬 YouTube Live carregado.");
  };
  $("youtubeClose").onclick=()=>{
    loadYouTube("");const u=new URL(location.href);u.searchParams.delete("yt");history.replaceState(null,"",u);closeSheets();
  };
  $("studentLinkBtn").onclick=async()=>{
    const u=new URL(location.origin+location.pathname);u.searchParams.set("role","student");if(currentYt)u.searchParams.set("yt",currentYt);
    const text=u.toString();
    try{await navigator.clipboard.writeText(text);toast("🔗 Link dos alunos copiado.")}catch(e){prompt("Copie o link dos alunos:",text)}
  };
  $("homeBtn").onclick=async()=>{
    closeSheets();closeBoard();stopPresentationInk();$("youtubeLayer").classList.remove("show");
    if(shareOn)await toggleShare();
  };

  /* local recording */
  const isMobileDevice=(navigator.userAgentData?.mobile===true)||/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const hasMediaRecorder=typeof MediaRecorder!=="undefined";
  const recordingDesktop=hasMediaRecorder&&!isMobileDevice;

  function setupRecordingUi(){
    if(!recordingDesktop){
      $("recordBtn").disabled=true;
      $("recordCamera").disabled=true;$("recordScreen").disabled=true;
      $("recordNotice").textContent="Gravação completa disponível no computador. Este navegador/dispositivo não oferece suporte confiável ao MediaRecorder para esta função.";
    }else if(!navigator.mediaDevices?.getDisplayMedia){
      $("recordScreen").disabled=true;
      $("recordNotice").textContent="Câmera + microfone podem ser gravados. A gravação de tela/QGIS não está disponível neste navegador porque getDisplayMedia não é suportado.";
    }
  }
  setupRecordingUi();
  $("recordBtn").onclick=()=>{if(!recordingDesktop)return toast("Gravação completa disponível no computador.");openSheet("recordSheet")};

  function pickMime(){
    const types=["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"];
    return types.find(t=>MediaRecorder.isTypeSupported?.(t))||"";
  }
  function setRecordStatus(text,live=false){$("recordStatus").textContent=text;$("recordStatus").classList.toggle("live",live)}
  function recordElapsed(){
    if(!recordStartedAt)return 0;
    const end=recordPausedAt||Date.now();
    return Math.max(0,Math.floor((end-recordStartedAt-recordPausedTotal)/1000));
  }
  function startRecordClock(){
    clearInterval(recordTimer);
    const tick=()=>$("recClock").textContent=fmtDuration(recordElapsed(),true);
    tick();recordTimer=setInterval(tick,500);
  }
  function cleanupOwnedRecordMedia(){
    recordOwnedTracks.forEach(t=>{try{t.stop()}catch(e){}});recordOwnedTracks=[];
    try{recordMixCtx?.close()}catch(e){}recordMixCtx=null;
  }
  function finalizeRecording(){
    clearInterval(recordTimer);recordTimer=null;$("recIndicator").classList.remove("show");
    $("recordPause").disabled=true;$("recordStop").disabled=true;$("recordPause").textContent="⏸ PAUSAR";
    cleanupOwnedRecordMedia();
    if(recordObjectUrl)URL.revokeObjectURL(recordObjectUrl);
    const type=mediaRecorder?.mimeType||"video/webm";
    const blob=new Blob(recordedChunks,{type});
    if(blob.size){
      recordObjectUrl=URL.createObjectURL(blob);$("recordDownload").href=recordObjectUrl;
      $("recordDownload").download="flashmap-"+new Date().toISOString().replaceAll(":","-").slice(0,19)+".webm";
      $("recordDownload").classList.add("show");setRecordStatus("GRAVAÇÃO PRONTA · "+fmtDuration(recordElapsed(),true),false);
      toast("⏺ Gravação finalizada. O WebM está pronto para baixar.");
    }else setRecordStatus("Não foi possível gerar o arquivo.",false);
    mediaRecorder=null;recordStartedAt=0;recordPausedAt=0;recordPausedTotal=0;
  }
  function beginRecorder(stream,ownedTracks,label){
    if(mediaRecorder&&mediaRecorder.state!=="inactive")return toast("Já existe uma gravação em andamento.");
    recordedChunks=[];recordOwnedTracks=ownedTracks||[];$("recordDownload").classList.remove("show");
    const mime=pickMime(),opts=mime?{mimeType:mime}:undefined;
    mediaRecorder=new MediaRecorder(stream,opts);
    mediaRecorder.ondataavailable=e=>{if(e.data?.size)recordedChunks.push(e.data)};
    mediaRecorder.onstop=finalizeRecording;
    mediaRecorder.onerror=e=>{console.error(e);toast("Erro na gravação local.")};
    mediaRecorder.start(1000);
    recordStartedAt=Date.now();recordPausedAt=0;recordPausedTotal=0;
    $("recordPause").disabled=false;$("recordStop").disabled=false;$("recIndicator").classList.add("show");
    setRecordStatus("⏺ GRAVANDO · "+label,true);startRecordClock();closeSheets();toast("⏺ Gravação iniciada.");
  }

  async function recordCameraMic(){
    if(!recordingDesktop)return;
    try{
      let videoTrack=null,audioTrack=null,owned=[];
      try{
        await connectLivekit(false);
        if(!cameraOn)await setCamera(true);if(!micOn)await setMic(true);
        videoTrack=room?.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera)?.track?.mediaStreamTrack||null;
        audioTrack=room?.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone)?.track?.mediaStreamTrack||null;
      }catch(e){}
      if(!videoTrack||!audioTrack){
        const gum=await navigator.mediaDevices.getUserMedia({video:!videoTrack,audio:!audioTrack});
        owned.push(...gum.getTracks());videoTrack=videoTrack||gum.getVideoTracks()[0];audioTrack=audioTrack||gum.getAudioTracks()[0];
      }
      if(!videoTrack)throw new Error("Câmera não disponível");
      beginRecorder(new MediaStream([videoTrack,...(audioTrack?[audioTrack]:[])]),owned,"CÂMERA + MICROFONE");
    }catch(err){cleanupOwnedRecordMedia();toast("Gravação: "+(err?.message||err))}
  }

  async function mixAudioTracks(tracks){
    const unique=[...new Map(tracks.filter(Boolean).map(t=>[t.id,t])).values()];
    if(unique.length<=1)return unique;
    recordMixCtx=new(window.AudioContext||window.webkitAudioContext)();
    const dest=recordMixCtx.createMediaStreamDestination();
    unique.forEach(track=>recordMixCtx.createMediaStreamSource(new MediaStream([track])).connect(dest));
    return dest.stream.getAudioTracks();
  }

  async function recordScreenMic(){
    if(!recordingDesktop||!navigator.mediaDevices?.getDisplayMedia)return toast("Gravação de tela disponível no computador compatível.");
    try{
      let videoTrack=null,displayAudio=[],owned=[];
      if(shareOn&&room){
        videoTrack=room.localParticipant.getTrackPublication(LivekitClient.Track.Source.ScreenShare)?.track?.mediaStreamTrack||null;
        const sa=room.localParticipant.getTrackPublication(LivekitClient.Track.Source.ScreenShareAudio)?.track?.mediaStreamTrack||null;
        if(sa)displayAudio=[sa];
      }
      if(!videoTrack){
        const display=await navigator.mediaDevices.getDisplayMedia({video:true,audio:true});
        owned.push(...display.getTracks());videoTrack=display.getVideoTracks()[0]||null;displayAudio=display.getAudioTracks();
      }
      if(!videoTrack)throw new Error("Nenhuma tela foi escolhida");

      let micTrack=room?.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone)?.track?.mediaStreamTrack||null;
      if(!micTrack){
        const mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
        micTrack=mic.getAudioTracks()[0]||null;owned.push(...mic.getTracks());
      }
      const mixed=await mixAudioTracks([...displayAudio,micTrack]);
      const stream=new MediaStream([videoTrack,...mixed]);
      videoTrack.addEventListener("ended",()=>{if(mediaRecorder&&mediaRecorder.state!=="inactive")mediaRecorder.stop()},{once:true});
      beginRecorder(stream,owned,"TELA / QGIS + MICROFONE");
    }catch(err){cleanupOwnedRecordMedia();toast("Gravação: "+(err?.message||err))}
  }

  $("recordCamera").onclick=recordCameraMic;
  $("recordScreen").onclick=recordScreenMic;
  $("recordPause").onclick=()=>{
    if(!mediaRecorder)return;
    if(mediaRecorder.state==="recording"){
      mediaRecorder.pause();recordPausedAt=Date.now();$("recordPause").textContent="▶ CONTINUAR";setRecordStatus("⏸ GRAVAÇÃO PAUSADA",true);
    }else if(mediaRecorder.state==="paused"){
      recordPausedTotal+=Date.now()-recordPausedAt;recordPausedAt=0;mediaRecorder.resume();$("recordPause").textContent="⏸ PAUSAR";setRecordStatus("⏺ GRAVANDO",true);
    }
  };
  $("recordStop").onclick=()=>{if(mediaRecorder&&mediaRecorder.state!=="inactive")mediaRecorder.stop()};

  /* student mobile dock: exactly five primary actions */
  if(isStudent){
    ["presentBtn","annotateBtn","timerBtn","presenceBtn","stageBtn","youtubeBtn","recordBtn","studentLinkBtn","clearHandsBtn","removeStageBtn"].forEach(id=>$(id).style.display="none");
    $("micBtn").style.display="none";$("camBtn").style.display="none";$("boardBtn").style.display="none";
    const dock=$("dock");
    function addDock(id,ico,label){const b=document.createElement("button");b.id=id;b.type="button";b.innerHTML='<span class="ico">'+ico+'</span><span>'+label+"</span>";dock.insertBefore(b,$("moreBtn"));return b}
    addDock("studentChat","💬","Chat").onclick=()=>openSheet("chatSheet");
    addDock("studentReact","✨","Reagir").onclick=()=>openSheet("reactionSheet");
    addDock("studentSound","🔊","Som").onclick=()=>$("audioUnlock").click();
    $("moreBtn").onclick=()=>openSheet("moreSheet");
  }

  addEventListener("beforeunload",()=>{try{room?.disconnect()}catch(e){}});
})();