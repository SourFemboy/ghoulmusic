const GMMetadata = (() => {
  const textDecoderLatin1 = new TextDecoder("latin1");
  const textDecoderUtf8 = new TextDecoder("utf-8");

  function safeName(name) {
    return name.replace(/\.[^.]+$/, "").replace(/[_]+/g," ").trim();
  }

  async function hashFile(file) {
    // Keep the original ID behavior, but also create a stable fingerprint
    // that does not depend on the file's modified date. This lets backups
    // reconnect playlists after the same audio is re-imported later.
    const head = await file.slice(0, Math.min(file.size, 65536)).arrayBuffer();
    const bytes = new Uint8Array(head);
    let h1 = 2166136261;
    for (const b of bytes) { h1 ^= b; h1 = Math.imul(h1, 16777619); }
    const hash = (h1>>>0).toString(16);
    return {
      id: `${file.size}-${file.lastModified}-${hash}`,
      fingerprint: `${file.size}-${hash}`
    };
  }

  function decodeText(bytes, encodingByte=3) {
    if (!bytes || !bytes.length) return "";
    try {
      if (encodingByte === 0) return textDecoderLatin1.decode(bytes).replace(/\0/g,"").trim();
      if (encodingByte === 1 || encodingByte === 2) {
        const little = bytes[0] === 0xFF && bytes[1] === 0xFE;
        const big = bytes[0] === 0xFE && bytes[1] === 0xFF;
        let start = (little || big) ? 2 : 0;
        let out = "";
        for (let i=start; i+1<bytes.length; i+=2) {
          const code = little ? bytes[i] | (bytes[i+1]<<8) : (bytes[i]<<8) | bytes[i+1];
          if (code) out += String.fromCharCode(code);
        }
        return out.trim();
      }
      return textDecoderUtf8.decode(bytes).replace(/\0/g,"").trim();
    } catch { return ""; }
  }

  function syncSafe(b0,b1,b2,b3){ return (b0<<21)|(b1<<14)|(b2<<7)|b3; }
  function be32(a,b,c,d){ return ((a<<24)>>>0)+(b<<16)+(c<<8)+d; }

  async function parseID3(file) {
    const buf = await file.slice(0, Math.min(file.size, 2_000_000)).arrayBuffer();
    const u = new Uint8Array(buf);
    if (u.length < 10 || String.fromCharCode(...u.slice(0,3)) !== "ID3") return {};
    const version = u[3];
    const tagSize = syncSafe(u[6],u[7],u[8],u[9]);
    const end = Math.min(u.length, 10 + tagSize);
    let pos = 10, result = {};

    while (pos + 10 <= end) {
      const id = String.fromCharCode(...u.slice(pos,pos+4));
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const size = version === 4 ? syncSafe(u[pos+4],u[pos+5],u[pos+6],u[pos+7]) : be32(u[pos+4],u[pos+5],u[pos+6],u[pos+7]);
      if (!size || pos + 10 + size > u.length) break;
      const data = u.slice(pos+10,pos+10+size);

      if (["TIT2","TPE1","TALB","TCON","TDRC","TYER"].includes(id) && data.length>1) {
        const val = decodeText(data.slice(1), data[0]);
        if (id==="TIT2") result.title=val;
        if (id==="TPE1") result.artist=val;
        if (id==="TALB") result.album=val;
        if (id==="TCON") result.genre=val;
        if (id==="TDRC"||id==="TYER") result.year=val.slice(0,4);
      } else if (id==="APIC" && data.length>5) {
        const enc = data[0];
        let i=1;
        let mimeEnd=i; while(mimeEnd<data.length && data[mimeEnd]!==0) mimeEnd++;
        const mime=textDecoderLatin1.decode(data.slice(i,mimeEnd)) || "image/jpeg";
        i=mimeEnd+1;
        i++; // picture type
        if (enc===0 || enc===3) {
          while(i<data.length && data[i]!==0) i++;
          i++;
        } else {
          while(i+1<data.length && !(data[i]===0 && data[i+1]===0)) i+=2;
          i+=2;
        }
        if (i<data.length) result.artwork = new Blob([data.slice(i)],{type:mime});
      }
      pos += 10 + size;
    }
    return result;
  }

  async function parse(file) {
    const hashed = await hashFile(file);
    const id = hashed.id;
    let meta = {};
    if (/\.mp3$/i.test(file.name) || file.type === "audio/mpeg") {
      try { meta = await parseID3(file); } catch {}
    }
    return {
      id,
      fingerprint: hashed.fingerprint,
      title: meta.title || safeName(file.name),
      artist: meta.artist || "Unknown Artist",
      album: meta.album || "Unknown Album",
      genre: meta.genre || "",
      year: meta.year || "",
      artwork: meta.artwork || null
    };
  }
  return { parse };
})();
