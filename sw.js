const CACHE="ghoulmusic-shell-v6-media-range";
const ASSETS=[
  "./","./index.html","./styles.css","./db.js","./metadata.js","./app.js",
  "./manifest.webmanifest","./background.jpg","./icons/icon-180.png","./icons/icon-192.png","./icons/icon-512.png"
];

const DB_NAME="ghoulmusic-db";
const DB_VERSION=1;

function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}

function getTrack(id){
  return openDB().then(db=>new Promise((resolve,reject)=>{
    const req=db.transaction("tracks","readonly").objectStore("tracks").get(id);
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  }));
}

function inferMime(name="", supplied=""){
  const s=(supplied||"").toLowerCase();
  if(s.startsWith("audio/") && s!=="audio/mp3") return s;
  const n=(name||"").toLowerCase();
  if(n.endsWith(".mp3")) return "audio/mpeg";
  if(n.endsWith(".m4a") || n.endsWith(".mp4")) return "audio/mp4";
  if(n.endsWith(".aac")) return "audio/aac";
  if(n.endsWith(".flac")) return "audio/flac";
  if(n.endsWith(".wav")) return "audio/wav";
  if(n.endsWith(".ogg") || n.endsWith(".opus")) return "audio/ogg";
  return s.startsWith("audio/") ? s : "audio/mpeg";
}

async function mediaResponse(request,url){
  try{
    const marker="/__ghoulmusic_media__/";
    const rest=url.pathname.split(marker)[1]||"";
    const id=decodeURIComponent(rest.split("/")[0]||"");
    const track=await getTrack(id);
    if(!track) return new Response("Track not found",{status:404});

    let blob=track.audioBlob;
    if(!(blob instanceof Blob) && track.file instanceof Blob) blob=track.file;
    if(!(blob instanceof Blob) || !blob.size) return new Response("Audio missing",{status:404});

    const fileName=decodeURIComponent(rest.split("/").slice(1).join("/")||track.fileName||"track.mp3");
    const type=inferMime(fileName,track.mimeType||blob.type||"");
    const total=blob.size;
    const range=request.headers.get("Range") || request.headers.get("range");

    const common={
      "Content-Type":type,
      "Accept-Ranges":"bytes",
      "Cache-Control":"no-store",
      "X-Content-Type-Options":"nosniff"
    };

    if(range){
      const mm=range.match(/bytes=(\d*)-(\d*)/i);
      if(!mm) return new Response(null,{status:416,headers:{...common,"Content-Range":`bytes */${total}`}});

      let start=mm[1] ? parseInt(mm[1],10) : 0;
      let end=mm[2] ? parseInt(mm[2],10) : total-1;

      if(!mm[1] && mm[2]){
        const suffix=parseInt(mm[2],10);
        start=Math.max(0,total-suffix);
        end=total-1;
      }

      start=Math.max(0,start);
      end=Math.min(total-1,end);

      if(start>end || start>=total){
        return new Response(null,{status:416,headers:{...common,"Content-Range":`bytes */${total}`}});
      }

      const chunk=blob.slice(start,end+1,type);
      return new Response(chunk,{
        status:206,
        headers:{
          ...common,
          "Content-Range":`bytes ${start}-${end}/${total}`,
          "Content-Length":String(chunk.size)
        }
      });
    }

    return new Response(blob,{
      status:200,
      headers:{...common,"Content-Length":String(total)}
    });
  }catch(err){
    return new Response("GhoulMusic media error",{status:500});
  }
}

self.addEventListener("install",e=>e.waitUntil(
  caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())
));

self.addEventListener("activate",e=>e.waitUntil(
  caches.keys()
    .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim())
));

self.addEventListener("fetch",e=>{
  const url=new URL(e.request.url);

  if(url.pathname.includes("/__ghoulmusic_media__/")){
    e.respondWith(mediaResponse(e.request,url));
    return;
  }

  if(e.request.method!=="GET") return;

  e.respondWith(
    caches.match(e.request).then(hit=>hit||fetch(e.request).then(res=>{
      const copy=res.clone();
      caches.open(CACHE).then(c=>c.put(e.request,copy));
      return res;
    }).catch(()=>caches.match("./index.html")))
  );
});
