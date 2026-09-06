(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const audio = $("#audio");
  const filePicker = $("#filePicker");
  const playlistCoverPicker = $("#playlistCoverPicker");
  const backupPicker = $("#backupPicker");

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
  let importPlaylistId = null;
  let coverPlaylistId = null;

  const iconFallback = "./icons/icon-180.png";

  async function init() {
    await GMDB.open();
    tracks = await GMDB.all("tracks");
    playlists = await GMDB.all("playlists");
    await migrateStableFingerprints();
    await migrateLegacyAudioStorage();
    await reconcilePendingRestores();
    tracks.sort((a,b)=>b.addedAt-a.addedAt);
    bind();
    renderAll();
    updateStorageStatus();
    if ("serviceWorker" in navigator) {
      try { await navigator.serviceWorker.register("./sw.js"); } catch {}
    }
  }

  function stableFingerprintFromLegacyId(id){
    const m = String(id||"").match(/^(\d+)-\d+-([0-9a-f]+)$/i);
    return m ? `${m[1]}-${m[2]}` : "";
  }

  function normalizedTrackKey(t){
    return [
      (t.title||"").trim().toLowerCase(),
      (t.artist||"").trim().toLowerCase(),
      (t.album||"").trim().toLowerCase()
    ].join("|");
  }

  async function migrateStableFingerprints(){
    let changed = 0;
    for(const t of tracks){
      if(!t.fingerprint){
        t.fingerprint = stableFingerprintFromLegacyId(t.id);
        if(t.fingerprint){
          await GMDB.put("tracks", t);
          changed++;
        }
      }
    }
    return changed;
  }


  async function makeDurableAudioBlob(file){
    // Force the selected File's bytes into memory, then create a plain Blob.
    // This avoids keeping a disk-backed File object in IndexedDB on iOS.
    const bytes = await file.arrayBuffer();
    return new Blob([bytes], {type:file.type || "application/octet-stream"});
  }

  async function migrateLegacyAudioStorage(){
    let upgraded=0, broken=0;
    for(const t of tracks){
      if(t.audioBlob instanceof Blob && t.audioBlob.size>0) continue;
      if(t.file instanceof Blob){
        try{
          const bytes=await t.file.arrayBuffer();
          if(!bytes.byteLength) throw new Error("empty audio");
          t.audioBlob=new Blob([bytes],{type:t.file.type || t.mimeType || "application/octet-stream"});
          t.fileName=t.file.name || t.fileName || `${t.title || "track"}`;
          t.mimeType=t.file.type || t.mimeType || "";
          t.needsRepair=false;
          delete t.file;
          await GMDB.put("tracks",t);
          upgraded++;
        }catch(err){
          console.warn("Legacy audio needs repair",t.title,err);
          t.needsRepair=true;
          broken++;
        }
      }else{
        t.needsRepair=true;
        broken++;
      }
    }
    return {upgraded,broken};
  }

  function savedTrackRef(t){
    if(!t) return null;
    return {
      id:t.id || "",
      fingerprint:t.fingerprint || stableFingerprintFromLegacyId(t.id),
      title:t.title || "",
      artist:t.artist || "",
      album:t.album || "",
      genre:t.genre || "",
      year:t.year || "",
      liked:!!t.liked,
      playCount:t.playCount || 0,
      lastPlayed:t.lastPlayed || 0
    };
  }

  function buildTrackMaps(){
    const byFingerprint=new Map();
    const byKey=new Map();
    for(const t of tracks){
      const fp=t.fingerprint || stableFingerprintFromLegacyId(t.id);
      if(fp) byFingerprint.set(fp,t);
      byKey.set(normalizedTrackKey(t),t);
    }
    return {byFingerprint,byKey};
  }

  function findCurrentForSaved(saved,maps){
    if(!saved) return null;
    const fp=saved.fingerprint || stableFingerprintFromLegacyId(saved.id);
    return (fp && maps.byFingerprint.get(fp)) || maps.byKey.get(normalizedTrackKey(saved)) || null;
  }

  async function applySavedState(current,saved){
    if(!current || !saved) return;
    current.liked=!!saved.liked;
    current.playCount=Math.max(current.playCount||0,saved.playCount||0);
    current.lastPlayed=Math.max(current.lastPlayed||0,saved.lastPlayed||0);
    if((!current.title || current.title==="Unknown") && saved.title) current.title=saved.title;
    if((!current.artist || current.artist==="Unknown Artist") && saved.artist) current.artist=saved.artist;
    if((!current.album || current.album==="Unknown Album") && saved.album) current.album=saved.album;
    await GMDB.put("tracks",current);
  }

  async function getPendingRestore(){
    const rec=await GMDB.get("settings","pendingRestore");
    return rec?.value || {tracks:[]};
  }

  async function setPendingRestore(state){
    const clean={tracks:[...(state?.tracks||[])]};
    if(clean.tracks.length){
      await GMDB.put("settings",{key:"pendingRestore",value:clean});
    }else{
      await GMDB.del("settings","pendingRestore");
    }
  }

  async function reconcilePendingRestores(){
    const maps=buildTrackMaps();
    const pending=await getPendingRestore();
    const stillPending=[];
    let resolved=0;

    for(const saved of pending.tracks||[]){
      const current=findCurrentForSaved(saved,maps);
      if(current){
        await applySavedState(current,saved);
        resolved++;
      }else{
        stillPending.push(saved);
      }
    }
    await setPendingRestore({tracks:stillPending});

    for(const p of playlists){
      if(!Array.isArray(p.pendingTrackRefs) || !p.pendingTrackRefs.length) continue;
      const left=[];
      for(const ref of p.pendingTrackRefs){
        const current=findCurrentForSaved(ref,maps);
        if(current){
          if(!p.trackIds.includes(current.id)) p.trackIds.push(current.id);
          resolved++;
        }else{
          left.push(ref);
        }
      }
      p.pendingTrackRefs=left;
      await GMDB.put("playlists",p);
    }
    return {resolved,remaining:stillPending.length};
  }

  function playlistTotal(p){
    return (p.trackIds?.length||0)+(p.pendingTrackRefs?.length||0);
  }

  function bind() {
    $("#settingsTop").addEventListener("click",()=>showView("settingsView"));
    $("#settingsBack").addEventListener("click",()=>showView("homeView"));

    ["#addMusicTop","#addMusicHero","#addMusicLibrary"].forEach(s => $(s).addEventListener("click",()=>{
      importPlaylistId = null;
      filePicker.click();
    }));
    filePicker.addEventListener("change", importFiles);
    playlistCoverPicker.addEventListener("change", importPlaylistCover);

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
    audio.addEventListener("error",()=>{
      const t=trackById(currentId);
      if(t) toast(`"${t.title}" could not play. Re-import it from iCloud.`,4500);
    });
    audio.addEventListener("ended",()=> repeat==="one" ? (audio.currentTime=0,audio.play()) : nextTrack());

    $("#queueBtn").addEventListener("click",()=>{renderQueue(); openModal("queueSheet")});
    $("#newPlaylist").addEventListener("click", createPlaylist);
    $("#playlistBack").addEventListener("click",()=>showView("playlistsView"));
    $("#renameCurrentPlaylist").addEventListener("click", renameCurrentPlaylist);
    $("#deleteCurrentPlaylist").addEventListener("click", deleteCurrentPlaylist);
    $("#addFilesToCurrentPlaylist").addEventListener("click",()=>{
      if(!currentPlaylistId) return;
      importPlaylistId = currentPlaylistId;
      filePicker.click();
    });
    $("#addToCurrentPlaylist").addEventListener("click",()=>openPlaylistTrackPicker(currentPlaylistId));
    $("#changePlaylistCover").addEventListener("click",()=>{
      if(!currentPlaylistId) return;
      coverPlaylistId = currentPlaylistId;
      playlistCoverPicker.click();
    });
    $("#addCurrentToPlaylist").addEventListener("click",()=>openPlaylistPicker(currentId));

    $$("[data-close-modal]").forEach(b=>b.addEventListener("click",()=>closeModal(b.dataset.closeModal)));

    $("#requestPersistent").addEventListener("click",()=>requestPersistence(true));
    $("#repairMusic").addEventListener("click",()=>{
      importPlaylistId=null;
      filePicker.click();
    });
    $("#exportLibrary").addEventListener("click", exportData);
    $("#restoreLibrary").addEventListener("click",()=>backupPicker.click());
    backupPicker.addEventListener("change", restoreData);
    $("#clearLibrary").addEventListener("click", clearLibrary);
  }

  async function importFiles(e) {
    const files = [...e.target.files];
    const destinationPlaylistId = importPlaylistId;
    importPlaylistId = null;
    if (!files.length) return;

    const destination = destinationPlaylistId ? playlists.find(p=>p.id===destinationPlaylistId) : null;
    toast(destination ? `Adding ${files.length} song${files.length===1?"":"s"} to ${destination.name}…` : `Importing ${files.length} song${files.length===1?"":"s"}…`, 5000);

    let added=0, refreshed=0, failed=0, addedToPlaylist=0;

    for (const file of files) {
      try {
        if (!file.type.startsWith("audio/") && !/\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i.test(file.name)) { failed++; continue; }

        const meta = await GMMetadata.parse(file);
        const audioBlob = await makeDurableAudioBlob(file);
        if(!audioBlob.size) throw new Error("Audio file was empty");

        let track = await GMDB.get("tracks", meta.id);

        if (track) {
          // Re-importing a known song repairs/replaces its local audio bytes
          // while keeping likes, play history, etc.
          track.audioBlob=audioBlob;
          track.fileName=file.name;
          track.mimeType=file.type || "";
          track.needsRepair=false;
          track.artwork=meta.artwork || track.artwork || null;
          track.fingerprint=meta.fingerprint || track.fingerprint;
          delete track.file;
          await GMDB.put("tracks",track);
          refreshed++;
        } else {
          track = {
            ...meta,
            audioBlob,
            fileName:file.name,
            mimeType:file.type || "",
            artwork: meta.artwork || null,
            liked:false,
            addedAt:Date.now()+added,
            lastPlayed:0,
            playCount:0,
            needsRepair:false
          };
          await GMDB.put("tracks", track);
          tracks.unshift(track);
          added++;
        }

        if (destination && !destination.trackIds.includes(track.id)) {
          destination.trackIds.push(track.id);
          addedToPlaylist++;
        }
      } catch(err) {
        console.error(err);
        failed++;
      }
    }

    if (destination) await GMDB.put("playlists", destination);

    // If a backup was restored before the audio, reconnect those songs now.
    const recovered=await reconcilePendingRestores();

    filePicker.value="";
    renderAll();

    if (destination) {
      openPlaylist(destination.id);
      const parts=[`${addedToPlaylist} added to playlist`];
      if (added) parts.push(`${added} new`);
      if (refreshed) parts.push(`${refreshed} repaired/refreshed`);
      if (recovered.resolved) parts.push(`${recovered.resolved} backup links restored`);
      if (failed) parts.push(`${failed} couldn't import`);
      toast(parts.join(" • "), 5000);
    } else {
      const parts=[];
      if(added) parts.push(`${added} added`);
      if(refreshed) parts.push(`${refreshed} repaired/refreshed`);
      if(recovered.resolved) parts.push(`${recovered.resolved} backup links restored`);
      if(failed) parts.push(`${failed} couldn't import`);
      toast(parts.length?parts.join(" • "):"No changes", 5000);
    }
    requestPersistence(false);
    updateStorageStatus();
  }

  async function importPlaylistCover(e) {
    const file = e.target.files?.[0];
    const playlistId = coverPlaylistId;
    coverPlaylistId = null;
    playlistCoverPicker.value = "";
    if (!file || !playlistId) return;

    const p = playlists.find(x=>x.id===playlistId);
    if (!p) return;

    try {
      p.cover = await makePlaylistCover(file);
      await GMDB.put("playlists", p);
      renderPlaylists();
      if (currentPlaylistId === p.id) openPlaylist(p.id);
      toast("Playlist photo updated");
    } catch(err) {
      console.error(err);
      toast("Couldn't use that photo");
    }
  }

  function makePlaylistCover(file) {
    return new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onerror = ()=>reject(reader.error);
      reader.onload = ()=>{
        const img = new Image();
        img.onerror = ()=>reject(new Error("Image could not be read"));
        img.onload = ()=>{
          const size = 700;
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d");

          const scale = Math.max(size / img.width, size / img.height);
          const w = img.width * scale;
          const h = img.height * scale;
          const x = (size - w) / 2;
          const y = (size - h) / 2;

          ctx.drawImage(img, x, y, w, h);
          resolve(canvas.toDataURL("image/jpeg", .86));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function trackById(id){ return tracks.find(t=>t.id===id); }

  async function playTrack(id, sourceIds=null) {
    const t = trackById(id); if(!t)return;
    if(sourceIds){ queue=[...sourceIds]; queueIndex=queue.indexOf(id); }
    else if(!queue.length || !queue.includes(id)){ queue=tracks.map(x=>x.id); queueIndex=queue.indexOf(id); }
    else queueIndex=queue.indexOf(id);

    currentId=id;

    try{
      // Lazy-upgrade any remaining v1.3 File record before playback.
      if(!(t.audioBlob instanceof Blob) || !t.audioBlob.size){
        if(t.file instanceof Blob){
          const bytes=await t.file.arrayBuffer();
          if(!bytes.byteLength) throw new Error("legacy file has no readable bytes");
          t.audioBlob=new Blob([bytes],{type:t.file.type || t.mimeType || "application/octet-stream"});
          t.fileName=t.file.name || t.fileName || t.title;
          t.mimeType=t.file.type || t.mimeType || "";
          delete t.file;
          t.needsRepair=false;
          await GMDB.put("tracks",t);
        }else{
          throw new Error("audio bytes missing");
        }
      }

      // Verify IndexedDB actually returned readable bytes.
      await t.audioBlob.slice(0,Math.min(8,t.audioBlob.size)).arrayBuffer();

      if(currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl=URL.createObjectURL(t.audioBlob);
      audio.src=currentObjectUrl;

      await audio.play();
      t.needsRepair=false;
      t.lastPlayed=Date.now();
      t.playCount=(t.playCount||0)+1;
      await GMDB.put("tracks",t);
      updatePlayerUI(t);
      renderHome();
      setMediaSession(t);
    }catch(err){
      console.error("Playback failed",err);
      t.needsRepair=true;
      try{await GMDB.put("tracks",t)}catch{}
      toast(`"${t.title}" needs to be re-imported from iCloud`,4500);
    }
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
    const p={id:`pl-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,name:name.trim(),trackIds:[],cover:null,createdAt:Date.now()};
    await GMDB.put("playlists",p);
    playlists.push(p);
    renderPlaylists();
    openPlaylist(p.id);
    toast("Playlist created — add songs straight from Files");
  }
  function renderPlaylists(){
    const el=$("#playlistList");if(!el)return;el.innerHTML="";
    [...playlists].sort((a,b)=>b.createdAt-a.createdAt).forEach(p=>{
      const b=document.createElement("button");b.className="playlist-card playlist-card-with-cover";

      const cover=document.createElement("div");
      cover.className="playlist-thumb";
      if(p.cover){
        const img=document.createElement("img");
        img.src=p.cover;
        img.alt="";
        cover.append(img);
      } else {
        cover.textContent="♫";
      }

      const m=document.createElement("div");
      m.className="track-meta playlist-card-meta";
      m.innerHTML="<strong></strong><span></span>";
      m.querySelector("strong").textContent=p.name;
      const pending=p.pendingTrackRefs?.length||0;
      m.querySelector("span").textContent=`${playlistTotal(p)} song${playlistTotal(p)===1?"":"s"}${pending?` • ${pending} waiting for re-import`:""}`;

      const c=document.createElement("span");
      c.textContent="›";
      c.style.fontSize="28px";

      b.append(cover,m,c);
      b.onclick=()=>openPlaylist(p.id);
      el.append(b);
    });
    if(!playlists.length)el.innerHTML='<p class="muted">Create a playlist, then import songs directly from Files and give it a custom photo.</p>';
  }

  function openPlaylist(id){
    currentPlaylistId=id;
    const p=playlists.find(x=>x.id===id);
    if(!p)return;

    $("#playlistDetailName").textContent=p.name;
    const pending=p.pendingTrackRefs?.length||0;
    $("#playlistDetailCount").textContent=`${playlistTotal(p)} song${playlistTotal(p)===1?"":"s"}${pending?` • ${pending} waiting for re-import`:""}`;

    const cover=$("#playlistDetailCover");
    cover.innerHTML="";
    if(p.cover){
      const img=document.createElement("img");
      img.src=p.cover;
      img.alt="";
      cover.append(img);
    } else {
      cover.textContent="♫";
    }

    const el=$("#playlistDetailList");
    el.innerHTML="";
    const list=p.trackIds.map(trackById).filter(Boolean);
    list.forEach(t=>el.append(trackRow(t,p.trackIds,"playlist")));

    if(!list.length && pending){
      el.innerHTML=`<div class="recovery-note"><strong>Your playlist is remembered.</strong><br>${pending} song${pending===1?" is":"s are"} waiting for their audio files. Tap <b>Add from Files</b> and select those songs from iCloud; GhoulMusic will reconnect them automatically.</div>`;
    }else if(pending){
      const note=document.createElement("div");
      note.className="recovery-note";
      note.innerHTML=`<strong>${pending} more song${pending===1?"":"s"} remembered by your backup.</strong><br>Re-import them from iCloud and they will return to this playlist automatically.`;
      el.append(note);
    }else if(!list.length){
      el.innerHTML='<p class="muted">No songs yet. Tap <strong>Add from Files</strong> to choose songs directly from iCloud Drive or Files.</p>';
    }
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
      el.textContent=`Local GhoulMusic storage: about ${used} MB • allowance about ${quota} GB • persistent protection: ${persisted?"ON":"not confirmed"}.`;
    }catch{el.textContent="Storage information unavailable."}
  }

  async function exportData(){
    await migrateStableFingerprints();
    const pending=await getPendingRestore();

    const byId=new Map(tracks.map(t=>[t.id,t]));
    const allSavedTracks=[
      ...tracks.map(savedTrackRef),
      ...(pending.tracks||[])
    ].filter(Boolean);

    // Dedupe saved track descriptors.
    const unique=new Map();
    for(const t of allSavedTracks){
      const k=t.fingerprint || t.id || normalizedTrackKey(t);
      if(k && !unique.has(k)) unique.set(k,t);
    }

    const data={
      format:"GhoulMusicBackup",
      version:4,
      exportedAt:new Date().toISOString(),
      app:"GhoulMusic",
      tracks:[...unique.values()],
      playlists:playlists.map(p=>{
        const resolved=(p.trackIds||[]).map(id=>savedTrackRef(byId.get(id))).filter(Boolean);
        const pendingRefs=[...(p.pendingTrackRefs||[])];
        return {
          id:p.id,
          name:p.name,
          trackIds:[...(p.trackIds||[])],
          trackRefs:[...resolved,...pendingRefs],
          cover:p.cover||null,
          createdAt:p.createdAt||Date.now()
        };
      })
    };

    const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
    const a=document.createElement("a");
    a.href=URL.createObjectURL(blob);
    const stamp=new Date().toISOString().slice(0,10);
    a.download=`GhoulMusic-Backup-${stamp}.json`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);

    const status=$("#backupStatus");
    if(status) status.textContent=`Backup created ${new Date().toLocaleString()}. Save it in iCloud Drive.`;
    toast("GhoulMusic backup created");
  }

  async function restoreData(e){
    const file=e.target.files?.[0];
    backupPicker.value="";
    if(!file) return;

    try{
      const raw=await file.text();
      const data=JSON.parse(raw);
      if(!data || !Array.isArray(data.tracks) || !Array.isArray(data.playlists)){
        throw new Error("Not a GhoulMusic backup");
      }

      await migrateStableFingerprints();
      const maps=buildTrackMaps();
      const oldTrackById=new Map((data.tracks||[]).map(t=>[t.id,t]));
      const unmatched=[];
      let matched=0;

      for(const saved of data.tracks){
        const current=findCurrentForSaved(saved,maps);
        if(current){
          await applySavedState(current,saved);
          matched++;
        }else{
          unmatched.push(saved);
        }
      }

      for(const savedP of data.playlists){
        const existing=playlists.find(p=>p.id===savedP.id) || playlists.find(p=>p.name===savedP.name);
        const p=existing || {
          id:savedP.id || `pl-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
          name:savedP.name || "Restored Playlist",
          trackIds:[],
          pendingTrackRefs:[],
          createdAt:savedP.createdAt||Date.now()
        };

        p.name=savedP.name || p.name;
        p.cover=savedP.cover || p.cover || null;
        p.createdAt=savedP.createdAt || p.createdAt || Date.now();

        // v4 has trackRefs. v3 backups only have trackIds, so derive
        // references from the global backup track list.
        const refs=Array.isArray(savedP.trackRefs) && savedP.trackRefs.length
          ? savedP.trackRefs
          : (savedP.trackIds||[]).map(oldId=>oldTrackById.get(oldId)).filter(Boolean);

        const resolvedIds=[];
        const pendingRefs=[];
        for(const ref of refs){
          const current=findCurrentForSaved(ref,maps);
          if(current){
            resolvedIds.push(current.id);
          }else{
            pendingRefs.push(ref);
          }
        }

        // Merge with any songs currently in the playlist to avoid data loss.
        p.trackIds=[...new Set([...(p.trackIds||[]),...resolvedIds])];
        p.pendingTrackRefs=pendingRefs;
        await GMDB.put("playlists",p);
      }

      // Keep unmatched song state so Likes/play counts can also return later.
      await setPendingRestore({tracks:unmatched});

      tracks=await GMDB.all("tracks");
      playlists=await GMDB.all("playlists");
      tracks.sort((a,b)=>b.addedAt-a.addedAt);
      renderAll();
      updateStorageStatus();

      const waiting=unmatched.length;
      const status=$("#backupStatus");
      if(status){
        status.textContent=waiting
          ? `Backup restored. ${matched} songs matched now; ${waiting} are remembered and will reconnect automatically when you re-import them from iCloud.`
          : `Backup restored. All ${matched} songs matched.`;
      }
      toast(waiting ? `Backup restored • ${waiting} songs waiting for re-import` : "Backup fully restored",5000);
    }catch(err){
      console.error(err);
      const status=$("#backupStatus");
      if(status) status.textContent="That file could not be restored. Make sure it is a GhoulMusic backup JSON file.";
      toast("Backup restore failed");
    }
  }

  async function clearLibrary(){
    if(!confirm("Delete every locally imported song and playlist from GhoulMusic on this iPhone? Your originals in iCloud will not be touched."))return;
    if(!confirm("This cannot be undone inside GhoulMusic. Continue?"))return;
    audio.pause();audio.removeAttribute("src");currentId=null;queue=[];$("#miniPlayer").classList.add("hidden");
    await GMDB.clear("tracks");await GMDB.clear("playlists");tracks=[];playlists=[];renderAll();updateStorageStatus();
    if($("#backupStatus")) $("#backupStatus").textContent="";
    toast("Local library deleted");
  }

  function toast(msg,ms=2500){
    const el=$("#toast");el.textContent=msg;el.classList.remove("hidden");clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.add("hidden"),ms);
  }

  init();
})();
