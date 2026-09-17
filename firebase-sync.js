(() => {
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
  const uid=(sessionStorage.fmuid ||= crypto.randomUUID().replaceAll("-","").slice(0,18));
  let name=isStudent ? (sessionStorage.fmname || params.get("name") || ("Aluno "+uid.slice(-4))) : "Ernandes";

  let db=null,D=null;
  let readyResolve;
  const ready=new Promise(r=>readyResolve=r);

  const state={presence:[],hands:[],stage:null};
  const dispatch=(type,detail)=>window.dispatchEvent(new CustomEvent(type,{detail}));
  const clean=s=>String(s??"").replace(/\s+/g," ").trim().slice(0,300);

  async function boot(){
    try{
      const A=await import("https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js");
      D=await import("https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js");
      db=D.getDatabase(A.initializeApp(cfg));

      const presenceRef=D.ref(db,`${BASE}/presence/${uid}`);
      await D.set(presenceRef,{name,role:isStudent?"participant":"host",joinedAt:D.serverTimestamp()});
      D.onDisconnect(presenceRef).remove();

      if(!isStudent){
        try{D.onDisconnect(D.ref(db,`${BASE}/stage`)).remove()}catch(e){}
      }

      D.onValue(D.ref(db,`${BASE}/presence`),snap=>{
        const raw=snap.val()||{};
        state.presence=Object.entries(raw).map(([id,x])=>({uid:id,...x}));
        dispatch("fm:presence",state.presence);
      });

      D.onValue(D.ref(db,`${BASE}/hands`),snap=>{
        const raw=snap.val()||{};
        state.hands=Object.entries(raw).map(([id,x])=>({uid:id,...x})).sort((a,b)=>(a.at||0)-(b.at||0));
        dispatch("fm:hands",state.hands);
      });

      D.onValue(D.ref(db,`${BASE}/stage`),snap=>{
        state.stage=snap.val()||null;
        dispatch("fm:stage",state.stage);
      });

      const reactionQuery=D.query(D.ref(db,`${BASE}/reactions`),D.orderByChild("at"),D.startAt(Date.now()-2500));
      D.onChildAdded(reactionQuery,snap=>{
        const x=snap.val();
        if(x?.emoji)dispatch("fm:reaction",x);
      });

      const chatQuery=D.query(D.ref(db,`${BASE}/chat`),D.limitToLast(60));
      D.onChildAdded(chatQuery,snap=>{
        const x=snap.val();
        if(x?.text)dispatch("fm:chat",x);
      });

      readyResolve();
      dispatch("fm:ready",{uid,name,role:isStudent?"participant":"host"});
    }catch(err){
      console.error("FLASHMAP Firebase",err);
      dispatch("fm:error",{message:err?.message||String(err)});
    }
  }

  async function useDb(){await ready;if(!db)throw new Error("Firebase não conectado");}

  window.FM={
    uid,state,
    get name(){return name},
    role:isStudent?"participant":"host",

    async rename(newName){
      await useDb();
      newName=clean(newName).slice(0,40);
      if(newName.length<2)throw new Error("Nome muito curto");
      name=newName;sessionStorage.fmname=name;
      await D.update(D.ref(db,`${BASE}/presence/${uid}`),{name});
      const handRef=D.ref(db,`${BASE}/hands/${uid}`),hand=await D.get(handRef);
      if(hand.exists())await D.update(handRef,{name});
      const stageRef=D.ref(db,`${BASE}/stage`),stage=await D.get(stageRef);
      if(stage.exists()&&stage.val()?.uid===uid)await D.update(stageRef,{name});
      return name;
    },

    async react(emoji){
      await useDb();
      await D.push(D.ref(db,`${BASE}/reactions`),{emoji:String(emoji).slice(0,8),name,uid,at:D.serverTimestamp()});
    },

    async chat(text){
      await useDb();
      text=clean(text).slice(0,300);if(!text)return;
      await D.push(D.ref(db,`${BASE}/chat`),{name,uid,text,at:D.serverTimestamp()});
    },

    async hand(){
      await useDb();
      const r=D.ref(db,`${BASE}/hands/${uid}`),s=await D.get(r);
      if(s.exists())await D.remove(r);
      else{await D.set(r,{name,uid,at:D.serverTimestamp()});try{D.onDisconnect(r).remove()}catch(e){}}
    },

    async lowerHand(targetUid){
      await useDb();
      if(targetUid)await D.remove(D.ref(db,`${BASE}/hands/${targetUid}`));
    },

    async clearHands(){
      await useDb();
      const s=await D.get(D.ref(db,`${BASE}/hands`)),raw=s.val()||{};
      await Promise.all(Object.keys(raw).map(id=>D.remove(D.ref(db,`${BASE}/hands/${id}`))));
    },

    async callStage(targetUid,targetName){
      await useDb();
      if(!targetUid)return;
      await D.set(D.ref(db,`${BASE}/stage`),{uid:targetUid,name:clean(targetName).slice(0,40)||"Participante",at:D.serverTimestamp()});
    },

    async clearStage(){
      await useDb();
      await D.remove(D.ref(db,`${BASE}/stage`));
    },

    async leave(){
      await useDb();
      try{await D.remove(D.ref(db,`${BASE}/presence/${uid}`))}catch(e){}
      try{await D.remove(D.ref(db,`${BASE}/hands/${uid}`))}catch(e){}
      const stage=await D.get(D.ref(db,`${BASE}/stage`));
      if(stage.exists()&&stage.val()?.uid===uid){try{await D.remove(D.ref(db,`${BASE}/stage`))}catch(e){}}
    }
  };

  boot();
})();
