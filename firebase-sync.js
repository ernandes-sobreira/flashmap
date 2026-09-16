(()=>{
const cfg={apiKey:'AIzaSyBWcGAa3CWurSiDs5udEtESGwCGGnYTX5Y',authDomain:'brasa-pantanal.firebaseapp.com',databaseURL:'https://brasa-pantanal-default-rtdb.firebaseio.com',projectId:'brasa-pantanal',storageBucket:'brasa-pantanal.firebasestorage.app',messagingSenderId:'876718329822',appId:'1:876718329822:web:e0e0254ee909a933dad74f'};
const BASE='flashmap', uid=(sessionStorage.fmuid ||= crypto.randomUUID().replaceAll('-','').slice(0,18));
const guest=new URLSearchParams(location.search).has('guest');
const name=guest?(sessionStorage.fmname ||= 'Aluno '+uid.slice(-4)):'Ernandes';
let db,api;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fly(emoji){const e=document.createElement('div');e.textContent=emoji;e.className='fm-fly';e.style.left=(15+Math.random()*70)+'%';document.body.appendChild(e);setTimeout(()=>e.remove(),2600)}
async function boot(){
 try{
  const A=await import('https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js');
  const D=await import('https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js');
  db=D.getDatabase(A.initializeApp(cfg)); api=D;
  const pres=D.ref(db,`${BASE}/presence/${uid}`); await D.set(pres,{name,role:guest?'participant':'host',joinedAt:D.serverTimestamp()}); D.onDisconnect(pres).remove();
  D.onValue(D.ref(db,`${BASE}/presence`),s=>{const v=s.val()||{},n=Object.keys(v).length;const o=document.getElementById('online');if(o)o.textContent=n;const p=document.getElementById('people');if(p)p.innerHTML=Object.entries(v).slice(0,40).map(([id,x])=>`<div class="person"><div class="avatar">${esc(x.name?.[0]||'?')}</div><div><b>${esc(x.name)}</b><div class="tiny">${x.role==='host'?'Host':'Participante'}</div></div></div>`).join('')+(n>40?`<div class="tiny">+ ${n-40} participantes</div>`:'')});
  let lastReaction=Date.now(); D.onChildAdded(D.query(D.ref(db,`${BASE}/reactions`),D.orderByChild('at'),D.startAt(lastReaction)),s=>{const x=s.val();if(x?.emoji)fly(x.emoji)});
  D.onChildAdded(D.ref(db,`${BASE}/chat`),s=>{const x=s.val();if(!x)return;const box=document.getElementById('messages');if(box){const d=document.createElement('div');d.className='msg';d.innerHTML=`<b>${esc(x.name)}</b>${esc(x.text)}`;box.appendChild(d);box.scrollTop=box.scrollHeight}});
  D.onValue(D.ref(db,`${BASE}/hands`),s=>{const h=s.val()||{},arr=Object.values(h);const c=document.getElementById('handCount');if(c)c.textContent=arr.length?` (${arr.length})`:'';const q=document.getElementById('handQueue');if(q)q.innerHTML=arr.map(x=>`<div class="handrow">✋ ${esc(x.name)}</div>`).join('')||'<div class="tiny">Ninguém na fila.</div>'});
  D.onChildAdded(D.ref(db,`${BASE}/flashResponses/main`),s=>{const x=s.val();if(!x?.text)return;const c=document.getElementById('cloud');if(c&&!document.querySelector(`[data-fr="${s.key}"]`)){const w=document.createElement('span');w.className='word';w.dataset.fr=s.key;w.textContent=x.text;w.style.fontSize=(20+Math.random()*22)+'px';c.appendChild(w)}});
  document.documentElement.dataset.firebase='ok';
 }catch(e){console.error('FLASHMAP Firebase',e);const st=document.getElementById('firebaseStatus');if(st)st.textContent='🔴 Firebase';}
}
window.FM={
 react:async emoji=>{if(!db)return;await api.push(api.ref(db,`${BASE}/reactions`),{emoji,name,uid,at:api.serverTimestamp()})},
 chat:async text=>{text=text.trim().slice(0,300);if(db&&text)await api.push(api.ref(db,`${BASE}/chat`),{name,uid,text,at:api.serverTimestamp()})},
 hand:async()=>{if(!db)return;const r=api.ref(db,`${BASE}/hands/${uid}`),s=await api.get(r);s.exists()?await api.remove(r):await api.set(r,{name,uid,at:api.serverTimestamp()})},
 flash:async text=>{text=text.trim().slice(0,80);if(db&&text)await api.set(api.ref(db,`${BASE}/flashResponses/main/${uid}`),{name,text,at:api.serverTimestamp()})},
 leave:async()=>{if(db)await api.remove(api.ref(db,`${BASE}/presence/${uid}`))}, uid,name
};
boot();
})();