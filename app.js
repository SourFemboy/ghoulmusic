(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const audio = $("#audio");
  const filePicker = $("#filePicker");

  let tracks = [];
  let playlists = [];
  let queue = [];
  let queueIndex = -1;
  let currentId = null;
  let currentObjectUrl = null;
  let currentPlaylistId = null;
  let shuffle = false;
  let repeat = "off";
  let targetPlaylistTrackId = null;

  const iconFallback = "./icons/icon-180.png";

  async function init() {
    await GMDB.open();
    tracks = await GMDB.all("tracks");
    playlists = await GMDB.all("playlists");
    tracks.sort((a,b)=>b.addedAt-a.addedAt);
    bind();
    renderAll();
    updateStorageStatus();
    if ("serviceWorker" in navigator) {
      try { await navigator.serviceWorker.register("./sw.js"); } catch {}
    }
  }

  function bind() {
    ["#addMusicTop","#addMusicHero","#addMusicLibrary"].forEach(s => $(s).addEventListener("click",()=>filePicker.click()));
    filePicker.addEventListener("change", importFiles);

    $$(".nav-btn").forEach(b => b.addEventListener("click",()=>showView(b.dataset.view)));
    $("#searchInput").addEventListener("input", renderSearch);

    $$(".seg").forEach(b=>b.addEventListener("click",()=>{
      $$(".seg").forEach(x=>x.classList.remove("active")); b.classList.add("active"); renderLibrary(b.dataset.library);
    }));

    $("#miniPlay").addEventListener("click", togglePlay);
    $("#mainPlay").addEventListener("click", togglePlay);
    $("#miniMeta").addEventListener("click", openNowPlaying);
    $("#closePlayer").addEventListener("click", closeNowPlaying);
    $("#miniLike").addEventListener("click",()=>toggleLike(currentId));
    $("#nowLike").addEventListener("click",()=>toggleLike(currentId));
    $("#prevBtn").addEventListener("click", prevTrack);
    $("#nextBtn").addEventListener("click", nextTrack);
    $("#shuffleBtn").addEventListener("click",()=>{shuffle=!shuffle; $("#shuffleBtn").classList.toggle("active",shuffle); toast(shuffle?"Shuffle on":"Shuffle off")});
    $("#repeatBtn").addEventListener("click",()=>{
      repeat = repeat==="off" ? "all" : repeat==="all" ? "one" : "off";
      $("#repeatBtn").classList.toggle("active",repeat!=="off");
      $("#repeatBtn").textContent = repeat==="one" ? "↻¹" : "↻";
      toast(`Repeat ${repeat}`);
    });
    $("#seek").addEventListener("input",()=>{ if (isFinite(audio.duration)) audio.currentTime=(+$("#seek").value/100)*audio.duration; });
    audio.addEventListener("timeupdate", updateProgress);
    audio.addEventListener("loadedmetadata", updateProgress);
    audio.addEventListener("play", updatePlayButtons);
    audio.addEventListener("pause", updatePlayButtons);
    audio.addEventListener("ended",()=> repeat==="one" ? (audio.currentTime=0,audio.play()) : nextTrack());

    $("#queueBtn").addEventListener("click",()=>{renderQueue(); openModal("queueSheet")});
    $("#newPlaylist").addEventListener("click", createPlaylist);
    $("#playlistBack").addEventListener("click",()=>showView("playlistsView"));
    $("#renameCurrentPlaylist").addEventListener("click", renameCurrentPlaylist);
    $("#deleteCurrentPlaylist").addEventListener("click", deleteCurrentPlaylist);
    $("#addToCurrentPlaylist").addEventListener("click",()=>openPlaylistTrackPicker(currentPlaylistId));
    $("#addCurrentToPlaylist").addEventListener("click",()=>openPlaylistPicker(currentId));

    $$("[data-close-modal]").forEach(b=>b.addEventListener("click",()=>closeModal(b.dataset.closeModal)));

    $("#requestPersistent").addEventListener("click", requestPersistence);
    $("#exportLibrary").addEventListener("click", exportData);
    $("#clearLibrary").addEventListener("click", clearLibrary);
  }

  async function importFiles(e) {
    const files = [...e.target.files];
    if (!files.length) return;
    toast(`Importing ${files.length} song${files.length===1?"":"s"}…`, 5000);
    let added=0, skipped=0, failed=0;
    for (const file of files) {
      try {
        if (!file.type.startsWith("audio/") && !/\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i.test(file.name)) { failed++; continue; }
        const meta = await GMMetadata.parse(file);
        if (await GMDB.get("tracks", meta.id)) { skipped++; continue; }
        const track = {
          ...meta,
          file,
          artwork: meta.artwork || null,
          liked:false,
          addedAt:Date.now()+added,
          lastPlayed:0,
          playCount:0
        };
        await GMDB.put("tracks", track);
        tracks.unshift(track); added++;
      } catch(err) { console.error(err); failed++; }
    }
    filePicker.value="";
    renderAll();
    const parts=[`${added} added`]; if(skipped)parts.push(`${skipped} duplicates skipped`); if(failed)parts.push(`${failed} couldn't import`);
    toast(parts.join(" • "), 4500);
    requestPersistence(false);
  }

  function trackById(id){ return tracks.find(t=>t.id===id); }

  async function playTrack(id, sourceIds=null) {
    const t = trackById(id); if(!t)return;
    if(sourceIds){ queue=[...sourceIds]; queueIndex=queue.indexOf(id); }
    else if(!queue.length || !queue.includes(id)){ queue=tracks.map(x=>x.id); queueIndex=queue.indexOf(id); }
    else queueIndex=queue.indexOf(id);

    currentId=id;
    if(currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl=URL.createObjectURL(t.file);
    audio.src=currentObjectUrl;

    t.lastPlayed=Date.now(); t.playCount=(t.playCount||0)+1;
    await GMDB.put("tracks",t);
    await audio.play().catch(()=>{});
    updatePlayerUI(t);
    renderHome();
    setMediaSession(t);
  }

  function setMediaSession(t){
    if(!("mediaSession" in navigator)) return;
    let art = iconFallback;
    if(t.artwork) {
      try { art=URL.createObjectURL(t.artwork); } catch {}
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title:t.title, artist:t.artist, album:t.album,
      artwork:[{src:art,sizes:"512x512"}]
    });
    try {
      navigator.mediaSession.setActionHandler("play",()=>audio.play());
      navigator.mediaSession.setActionHandler("pause",()=>audio.pause());
      navigator.mediaSession.setActionHandler("previoustrack",prevTrack);
      navigator.mediaSession.setActionHandler("nexttrack",nextTrack);
      navigator.mediaSession.setActionHandler("seekto",d=>{ if(d.seekTime!=null)audio.currentTime=d.seekTime; });
    } catch {}
  }

  function togglePlay(){ if(!currentId){ if(tracks[0])playTrack(tracks[0].id); return; } audio.paused?audio.play():audio.pause(); }
  function nextTrack(){
    if(!queue.length)return;
    if(shuffle && queue.length>1){
      let n; do{n=Math.floor(Math.random()*queue.length)}while(n===queueIndex); queueIndex=n;
    } else {
      queueIndex++;
      if(queueIndex>=queue.length){ if(repeat==="all")queueIndex=0; else {queueIndex=queue.length-1; return;} }
    }
    playTrack(queue[queueIndex]);
  }
  function prevTrack(){
    if(audio.currentTime>4){audio.currentTime=0;return}
    if(!queue.length)return;
    queueIndex=Math.max(0,queueIndex-1); playTrack(queue[queueIndex]);
  }

  function updatePlayButtons(){
    const p=!audio.paused;
    $("#miniPlay").textContent=p?"❚❚":"▶"; $("#mainPlay").textContent=p?"❚❚":"▶";
  }
  function updateProgress(){
    const dur=isFinite(audio.duration)?audio.duration:0;
    $("#seek").value=dur?audio.currentTime/dur*100:0;
    $("#currentTime").textContent=fmt(audio.currentTime||0); $("#duration").textContent=fmt(dur);
  }
  function fmt(s){ s=Math.max(0,Math.floor(s||0)); return `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`; }

  function artUrl(t){
    if(t?.artwork) try{return URL.createObjectURL(t.artwork)}catch{}
    return iconFallback;
  }

  function updatePlayerUI(t){
    $("#miniPlayer").classList.remove("hidden");
    $("#miniTitle").textContent=t.title; $("#miniArtist").textContent=t.artist;
    $("#nowTitle").textContent=t.title; $("#nowArtist").textContent=t.artist;
    $("#miniCover").src=artUrl(t); $("#nowCover").src=artUrl(t);
    renderLikeButtons(t);
  }
  function renderLikeButtons(t){
    const liked=!!t?.liked;
    $("#miniLike").textContent=liked?"♥":"♡"; $("#nowLike").textContent=liked?"♥":"♡";
    $("#miniLike").classList.toggle("liked",liked); $("#nowLike").classList.toggle("liked",liked);
  }

  async function toggleLike(id){
    const t=trackById(id); if(!t)return;
    t.liked=!t.liked; await GMDB.put("tracks",t);
    renderAll(); if(id===currentId)renderLikeButtons(t);
    toast(t.liked?"Added to Liked Songs":"Removed from Liked Songs");
  }

  function showView(id){
    $$(".view").forEach(v=>v.classList.toggle("active",v.id===id));
    $$(".nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.view===id));
    if(id==="searchView") setTimeout(()=>$("#searchInput").focus(),80);
    if(id==="libraryView") renderLibrary($(".seg.active")?.dataset.library||"songs");
    if(id==="likedView") renderLiked();
    if(id==="playlistsView") renderPlaylists();
    window.scrollTo({top:0,behavior:"smooth"});
  }

  function trackRow(t, sourceIds=tracks.map(x=>x.id), extra=""){
    const div=document.createElement("div"); div.className="track";
    const img=document.createElement("img"); img.src=artUrl(t); img.alt="";
    const meta=document.createElement("button"); meta.className="mini-meta track-meta"; meta.innerHTML=`<strong></strong><span></span>`;
    meta.querySelector("strong").textContent=t.title; meta.querySelector("span").textContent=`${t.artist} • ${t.album}`;
    meta.onclick=()=>playTrack(t.id,sourceIds);
    const actions=document.createElement("div"); actions.className="track-actions";
    const heart=document.createElement("button"); heart.className=`plain-btn ${t.liked?"liked":""}`; heart.textContent=t.liked?"♥":"♡"; heart.onclick=()=>toggleLike(t.id);
    const more=document.createElement("button"); more.className="plain-btn"; more.textContent="⋯"; more.onclick=()=>trackMenu(t.id,extra);
    actions.append(heart,more); div.append(img,meta,actions); return div;
  }

  function trackMenu(id, context=""){
    const t=trackById(id); if(!t)return;
    const action=prompt(`${t.title}\n\nType:\n1 = Add to playlist\n2 = Play next${context==="playlist"?"\n3 = Remove from this playlist":""}`);
    if(action==="1") openPlaylistPicker(id);
    if(action==="2"){ const at=Math.max(queueIndex+1,0); queue.splice(at,0,id); toast("Playing next"); }
    if(action==="3" && context==="playlist") removeFromCurrentPlaylist(id);
  }

  function renderAll(){ renderHome(); renderSearch(); renderLibrary($(".seg.active")?.dataset.library||"songs"); renderLiked(); renderPlaylists(); }

  function renderHome(){
    renderGrid("#recentGrid",[...tracks].filter(t=>t.lastPlayed).sort((a,b)=>b.lastPlayed-a.lastPlayed).slice(0,6));
    renderGrid("#addedGrid",[...tracks].sort((a,b)=>b.addedAt-a.addedAt).slice(0,6));
    $("#heroSub").textContent=tracks.length?`${tracks.length} song${tracks.length===1?"":"s"} in your private library.`:"Import songs from iCloud Drive or Files and keep listening offline.";
  }

  function renderGrid(sel,list){
    const el=$(sel); el.innerHTML=""; el.classList.remove("empty-state");
    if(!list.length){el.classList.add("empty-state");el.textContent=sel.includes("recent")?"Nothing played yet.":"Your imported songs will appear here.";return}
    for(const t of list){
      const b=document.createElement("button"); b.className="album-card";
      const img=document.createElement("img"); img.src=artUrl(t);
      const strong=document.createElement("strong"); strong.textContent=t.title;
      const span=document.createElement("span"); span.textContent=t.artist;
      b.append(img,strong,span); b.onclick=()=>playTrack(t.id,list.map(x=>x.id)); el.append(b);
    }
  }

  function renderSearch(){
    const q=($("#searchInput")?.value||"").trim().toLowerCase();
    const el=$("#searchResults"); if(!el)return; el.innerHTML="";
    const list=q?tracks.filter(t=>`${t.title} ${t.artist} ${t.album} ${t.genre||""}`.toLowerCase().includes(q)):tracks.slice(0,20);
    if(!list.length){el.innerHTML='<p class="muted">No matching songs.</p>';return}
    list.forEach(t=>el.append(trackRow(t,list.map(x=>x.id))));
  }

  function renderLibrary(type){
    const el=$("#libraryContent"); if(!el)return; el.innerHTML="";
    if(type==="songs"){
      const list=[...tracks].sort((a,b)=>a.title.localeCompare(b.title));
      const wrap=document.createElement("div"); wrap.className="track-list"; list.forEach(t=>wrap.append(trackRow(t,list.map(x=>x.id)))); el.append(wrap);
      if(!list.length) el.innerHTML='<p class="muted">Tap Add Music to import your first songs.</p>';
      return;
    }
    const key=type==="artists"?"artist":"album";
    const map=new Map();
    tracks.forEach(t=>{const k=t[key]||`Unknown ${type==="artists"?"Artist":"Album"}`; if(!map.has(k))map.set(k,[]);map.get(k).push(t)});
    const wrap=document.createElement("div"); wrap.className="group-list";
    [...map.entries()].sort((a,b)=>a[0].localeCompare(b[0])).forEach(([name,list])=>{
      const b=document.createElement("button");b.className="group-card";
      const art=document.createElement("div");art.className="group-art";
      const first=list.find(x=>x.artwork); if(first){const img=document.createElement("img");img.src=artUrl(first);art.append(img)}else art.textContent=type==="artists"?"♟":"♫";
      const m=document.createElement("div");m.className="track-meta";m.innerHTML="<strong></strong><span></span>";m.querySelector("strong").textContent=name;m.querySelector("span").textContent=`${list.length} song${list.length===1?"":"s"}`;
      b.append(art,m); b.onclick=()=>playTrack(list[0].id,list.map(x=>x.id)); wrap.append(b);
    });
    el.append(wrap); if(!map.size)el.innerHTML='<p class="muted">Nothing here yet.</p>';
  }

  function renderLiked(){
    const list=tracks.filter(t=>t.liked).sort((a,b)=>b.addedAt-a.addedAt);
    $("#likedCount").textContent=`${list.length} song${list.length===1?"":"s"}`;
    const el=$("#likedList");el.innerHTML="";list.forEach(t=>el.append(trackRow(t,list.map(x=>x.id))));
    if(!list.length)el.innerHTML='<p class="muted">Tap ♡ on a song to add it here.</p>';
  }

  async function createPlaylist(){
    const name=prompt("Playlist name"); if(!name?.trim())return;
    const p={id:`pl-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,name:name.trim(),trackIds:[],createdAt:Date.now()};
    await GMDB.put("playlists",p);playlists.push(p);renderPlaylists();toast("Playlist created");
  }
  function renderPlaylists(){
    const el=$("#playlistList");if(!el)return;el.innerHTML="";
    [...playlists].sort((a,b)=>b.createdAt-a.createdAt).forEach(p=>{
      const b=document.createElement("button");b.className="playlist-card";
      const m=document.createElement("div");m.className="track-meta";m.innerHTML="<strong></strong><span></span>";m.querySelector("strong").textContent=p.name;m.querySelector("span").textContent=`${p.trackIds.length} song${p.trackIds.length===1?"":"s"}`;
      const c=document.createElement("span");c.textContent="›";c.style.fontSize="28px";b.append(m,c);b.onclick=()=>openPlaylist(p.id);el.append(b);
    });
    if(!playlists.length)el.innerHTML='<p class="muted">Create playlists for whatever you want — driving, anime, goth, sleep, favorites, anything.</p>';
  }
  function openPlaylist(id){
    currentPlaylistId=id; const p=playlists.find(x=>x.id===id);if(!p)return;
    $("#playlistDetailName").textContent=p.name;$("#playlistDetailCount").textContent=`${p.trackIds.length} song${p.trackIds.length===1?"":"s"}`;
    const el=$("#playlistDetailList");el.innerHTML="";
    const list=p.trackIds.map(trackById).filter(Boolean);list.forEach(t=>el.append(trackRow(t,p.trackIds,"playlist")));
    if(!list.length)el.innerHTML='<p class="muted">This playlist is empty.</p>';
    showView("playlistDetailView");
  }
  async function renameCurrentPlaylist(){
    const p=playlists.find(x=>x.id===currentPlaylistId);if(!p)return;
    const n=prompt("New playlist name",p.name);if(!n?.trim())return;p.name=n.trim();await GMDB.put("playlists",p);openPlaylist(p.id);renderPlaylists();
  }
  async function deleteCurrentPlaylist(){
    const p=playlists.find(x=>x.id===currentPlaylistId);if(!p)return;
    if(!confirm(`Delete "${p.name}"? Your music files will not be deleted.`))return;
    await GMDB.del("playlists",p.id);playlists=playlists.filter(x=>x.id!==p.id);currentPlaylistId=null;showView("playlistsView");renderPlaylists();toast("Playlist deleted");
  }
  async function removeFromCurrentPlaylist(id){
    const p=playlists.find(x=>x.id===currentPlaylistId);if(!p)return;
    const i=p.trackIds.indexOf(id);if(i>=0)p.trackIds.splice(i,1);await GMDB.put("playlists",p);openPlaylist(p.id);toast("Removed from playlist");
  }

  function openPlaylistPicker(trackId){
    targetPlaylistTrackId=trackId; const el=$("#playlistPickerList");el.innerHTML="";
    if(!playlists.length){el.innerHTML='<p class="muted">Create a playlist first.</p>'}
    playlists.forEach(p=>{
      const b=document.createElement("button");b.className="playlist-card";
      b.innerHTML=`<div class="track-meta"><strong></strong><span>${p.trackIds.length} songs</span></div><span>＋</span>`;
      b.querySelector("strong").textContent=p.name;
      b.onclick=async()=>{if(!p.trackIds.includes(trackId))p.trackIds.push(trackId);await GMDB.put("playlists",p);closeModal("playlistPicker");toast(`Added to ${p.name}`);if(currentPlaylistId===p.id)openPlaylist(p.id)};
      el.append(b);
    });
    openModal("playlistPicker");
  }

  function openPlaylistTrackPicker(playlistId){
    const p=playlists.find(x=>x.id===playlistId);if(!p)return;
    const available=tracks.filter(t=>!p.trackIds.includes(t.id));
    const el=$("#playlistPickerList");el.innerHTML="";
    if(!available.length)el.innerHTML='<p class="muted">All songs are already in this playlist.</p>';
    available.forEach(t=>{
      const b=document.createElement("button");b.className="playlist-card";
      b.innerHTML=`<div class="track-meta"><strong></strong><span></span></div><span>＋</span>`;
      b.querySelector("strong").textContent=t.title;b.querySelector("span").textContent=t.artist;
      b.onclick=async()=>{p.trackIds.push(t.id);await GMDB.put("playlists",p);closeModal("playlistPicker");openPlaylist(p.id);toast("Song added")};el.append(b);
    });
    openModal("playlistPicker");
  }

  function renderQueue(){
    const el=$("#queueList");el.innerHTML="";
    queue.map(trackById).filter(Boolean).forEach((t,i)=>{
      const row=trackRow(t,queue); if(i===queueIndex)row.style.background="rgba(216,108,255,.08)"; el.append(row);
    });
    if(!queue.length)el.innerHTML='<p class="muted">Your queue is empty.</p>';
  }

  function openNowPlaying(){ if(!currentId)return; $("#nowPlayingSheet").classList.remove("hidden");$("#nowPlayingSheet").setAttribute("aria-hidden","false"); }
  function closeNowPlaying(){ $("#nowPlayingSheet").classList.add("hidden");$("#nowPlayingSheet").setAttribute("aria-hidden","true"); }
  function openModal(id){$("#"+id).classList.remove("hidden")}
  function closeModal(id){$("#"+id).classList.add("hidden")}

  async function requestPersistence(show=true){
    if(navigator.storage?.persist){
      const ok=await navigator.storage.persist();
      if(show)toast(ok?"Local storage protection enabled":"iOS did not grant persistent storage");
      updateStorageStatus();
    } else if(show) toast("Persistent storage request isn't supported here");
  }

  async function updateStorageStatus(){
    const el=$("#storageStatus");if(!el)return;
    try{
      const est=await navigator.storage.estimate();
      const used=(est.usage/1024/1024).toFixed(1);
      const quota=(est.quota/1024/1024/1024).toFixed(1);
      const persisted=navigator.storage.persisted?await navigator.storage.persisted():false;
      el.textContent=`GhoulMusic is using about ${used} MB. Browser storage allowance: about ${quota} GB. Protected: ${persisted?"Yes":"Not confirmed"}.`;
    }catch{el.textContent="Storage information unavailable."}
  }

  async function exportData(){
    const data={
      exportedAt:new Date().toISOString(),
      tracks:tracks.map(({file,artwork,...t})=>t),
      playlists
    };
    const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="GhoulMusic-library-backup.json";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
    toast("Library data exported");
  }

  async function clearLibrary(){
    if(!confirm("Delete every locally imported song and playlist from GhoulMusic on this iPhone? Your originals in iCloud will not be touched."))return;
    if(!confirm("This cannot be undone inside GhoulMusic. Continue?"))return;
    audio.pause();audio.removeAttribute("src");currentId=null;queue=[];$("#miniPlayer").classList.add("hidden");
    await GMDB.clear("tracks");await GMDB.clear("playlists");tracks=[];playlists=[];renderAll();updateStorageStatus();toast("Local library deleted");
  }

  function toast(msg,ms=2500){
    const el=$("#toast");el.textContent=msg;el.classList.remove("hidden");clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.add("hidden"),ms);
  }

  init();
})();
