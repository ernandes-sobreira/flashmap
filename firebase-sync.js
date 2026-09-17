(() => {
  // Configuração Firebase existente do projeto brasa-pantanal. NÃO trocar por outro projeto.
  const cfg={
    apiKey:"AIzaSyBWcGAa3CWurSiDs5udEtESGwCGGnYTX5Y",
    authDomain:"brasa-pantanal.firebaseapp.com",
    databaseURL:"https://brasa-pantanal-default-rtdb.firebaseio.com",
    projectId:"brasa-pantanal",
    storageBucket:"brasa-pantanal.firebasestorage.app",
    messagingSenderId:"876718329822",
    appId:"1:876718329822:web:e0e0254ee909a933dad74f"
  };

  const BASE="flashmap";
  const params=new URLSearchParams(location.search);
  const isStudent=params.get("role")==="student" || params.has("guest");
  const role=isStudent?"participant":"host";
  const uid=(sessionStorage.fmuid ||= crypto.randomUUID().replaceAll("-","").slice(0,18));
  let name=isStudent ? (sessionStorage.fmname || "") : "Ernandes";
  let joinedAt=Number(sessionStorage.fmJoinedAt)||Date.now();
  sessionStorage.fmJoinedAt=String(joinedAt);

  let db=null,D=null,connected=false;
  let readyResolve;
  const ready=new Promise(r=>readyResolve=r);

  const state={presence:[],hands:[],stage:null};
  const dispatch=(type,detail)=>window.dispatchEvent(new CustomEvent(type,{detail}));
  const clean=s=>String(s??"").replace(/\s+/g," ").trim().slice(0,300);

  function normalizeSnapshot(raw={}){
    state.presence=Object.entries(raw.presence||{}).map(([id,x])=>({uid:id,...x}));
    state.hands=Object.entries(raw.hands||{}).map(([id,x])=>({uid:id,...x})).sort((a,b)=>(a.at||0)-(b.at||0));
    state.stage=raw.stage||null;
  }

  async function registerPresence(){
    if(!db||!D||!name||!connected)return;
    const presenceRef=D.ref(db,`${BASE}/presence/${uid}`);
    await D.set(presenceRef,{name,role,joinedAt,online:true,lastSeen:D.serverTimestamp()});
    D.onDisconnect(presenceRef).remove();
  }

  async function boot(){
    try{
      const A=await import("https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js");
      D=await import("https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js");
      db=D.getDatabase(A.initializeApp(cfg));

      D.onValue(D.ref(db,".info/connected"),async snap=>{
        connected=snap.val()===true;
        if(connected){
          try{
            await registerPresence();
            if(!isStudent)D.onDisconnect(D.ref(db,`${BASE}/stage`)).remove();
          }catch(err){console.warn("FLASHMAP presence",err)}
        }
        dispatch("fm:connection",{connected});
      });

      D.onValue(D.ref(db,`${BASE}/presence`),snap=>{
        const raw=snap.val()||{};
        state.presence=Object.entries(raw).map(([id,x])=>({uid:id,...x}));
        dispatch("fm:presence",state.presence);
      });

      // Mãos e palco são lidos do MESMO estado /flashmap. A fila nunca é duplicada em outro lugar.
      D.onValue(D.ref(db,`${BASE}/hands`),snap=>{
        const raw=snap.val()||{};
        state.hands=Object.entries(raw).map(([id,x])=>({uid:id,...x})).sort((a,b)=>(a.at||0)-(b.at||0));
        dispatch("fm:hands",state.hands);
      });

      D.onValue(D.ref(db,`${BASE}/stage`),snap=>{
        state.stage=snap.val()||null;
        dispatch("fm:stage",state.stage);
      });

      const reactionQuery=D.query(D.ref(db,`${BASE}/reactions`),D.orderByChild("at"),D.startAt(Date.now()-4000));
      D.onChildAdded(reactionQuery,snap=>{
        const x=snap.val();
        if(x?.emoji)dispatch("fm:reaction",x);
      });

      const chatQuery=D.query(D.ref(db,`${BASE}/chat`),D.limitToLast(80));
      D.onChildAdded(chatQuery,snap=>{
        const x=snap.val();
        if(x?.text)dispatch("fm:chat",x);
      });

      readyResolve();
      dispatch("fm:ready",{uid,name,role});
    }catch(err){
      console.error("FLASHMAP Firebase",err);
      dispatch("fm:error",{message:err?.message||String(err)});
    }
  }

  async function useDb(){await ready;if(!db)throw new Error("Firebase não conectado");}
  function requireHost(){if(isStudent)throw new Error("Ação disponível somente para o professor");}

  window.FM={
    uid,state,role,ready,
    get name(){return name},
    get connected(){return connected},

    async rename(newName){
      await useDb();
      newName=clean(newName).slice(0,40);
      if(newName.length<2)throw new Error("Nome muito curto");
      name=newName;
      sessionStorage.fmname=name;
      await registerPresence();

      const handRef=D.ref(db,`${BASE}/hands/${uid}`),hand=await D.get(handRef);
      if(hand.exists())await D.update(handRef,{name});
      const stageRef=D.ref(db,`${BASE}/stage`),stage=await D.get(stageRef);
      if(stage.exists()&&stage.val()?.uid===uid)await D.update(stageRef,{name});
      return name;
    },

    async refresh(){
      await useDb();
      const snap=await D.get(D.ref(db,BASE));
      normalizeSnapshot(snap.val()||{});
      dispatch("fm:presence",state.presence);
      dispatch("fm:hands",state.hands);
      dispatch("fm:stage",state.stage);
      return state;
    },

    async react(emoji){
      await useDb();
      if(!name)throw new Error("Digite seu nome primeiro");
      await D.push(D.ref(db,`${BASE}/reactions`),{emoji:String(emoji).slice(0,8),name,uid,at:D.serverTimestamp()});
    },

    async chat(text){
      await useDb();
      if(!name)throw new Error("Digite seu nome primeiro");
      text=clean(text).slice(0,300);if(!text)return;
      await D.push(D.ref(db,`${BASE}/chat`),{name,uid,text,at:D.serverTimestamp()});
    },

    async hand(){
      await useDb();
      if(!name)throw new Error("Digite seu nome primeiro");
      const r=D.ref(db,`${BASE}/hands/${uid}`),s=await D.get(r);
      if(s.exists())await D.remove(r);
      else{
        await D.set(r,{name,uid,at:D.serverTimestamp()});
        D.onDisconnect(r).remove();
      }
    },

    async lowerHand(targetUid=uid){
      await useDb();
      if(isStudent&&targetUid!==uid)throw new Error("Participante só pode baixar a própria mão");
      if(targetUid)await D.remove(D.ref(db,`${BASE}/hands/${targetUid}`));
    },

    async clearHands(){
      await useDb();requireHost();
      await D.remove(D.ref(db,`${BASE}/hands`));
    },

    async callStage(targetUid,targetName){
      await useDb();requireHost();
      if(!targetUid)return;
      const stage={uid:targetUid,name:clean(targetName).slice(0,40)||"Participante",at:D.serverTimestamp()};
      // Atualização multipath atômica: entra no palco e sai da fila na MESMA operação.
      await D.update(D.ref(db,BASE),{
        stage,
        [`hands/${targetUid}`]:null
      });

      // SEGURANÇA DE PRODUÇÃO:
      // este bloqueio é apenas de coordenação frontend/Firebase. Em produção, o backend que emite
      // tokens LiveKit deve conceder permissão de publicar câmera/microfone SOMENTE ao uid presente
      // em /flashmap/stage. Não confiar no frontend como barreira de segurança.
    },

    async clearStage(){
      await useDb();requireHost();
      await D.remove(D.ref(db,`${BASE}/stage`));
    },

    async leave(){
      await useDb();
      try{await D.remove(D.ref(db,`${BASE}/presence/${uid}`))}catch(e){}
      try{await D.remove(D.ref(db,`${BASE}/hands/${uid}`))}catch(e){}
    }
  };

  boot();
})();