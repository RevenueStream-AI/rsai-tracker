export async function onRequestGet() {
    const owner = "AmericanMedicalCompliance";
    const repo = "amc-tracker";
    const branch = "classic-tracker";
    const files = ["manifest.json", "background.js", "popup.html", "popup.js"];
    const enc = new TextEncoder();

  const entries = [];
    for (const name of files) {
          const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/browser-extension/${name}`);
          if (!res.ok) return new Response(`Failed to fetch ${name}`, { status: 500 });
          entries.push({ name, data: enc.encode(await res.text()) });
    }

  return new Response(buildZip(entries), {
        headers: {
                "Content-Type": "application/zip",
                "Content-Disposition": 'attachment; filename="amc-time-tracker-extension.zip"',
                "Cache-Control": "no-store"
        }
  });
}

function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
          crc ^= bytes[i];
          for (let j = 0; j < 8; j++) crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : (crc >>> 1);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(entries) {
    const local = [], central = [];
    let offset = 0;
    for (const e of entries) {
          const nameBytes = new TextEncoder().encode(e.name);
          const crc = crc32(e.data), size = e.data.length;
          const lh = new Uint8Array(30 + nameBytes.length);
          const lv = new DataView(lh.buffer);
          lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0, true);
          lv.setUint16(8, 0, true); lv.setUint16(10, 0, true); lv.setUint16(12, 0x21, true);
          lv.setUint32(14, crc, true); lv.setUint32(18, size, true); lv.setUint32(22, size, true);
          lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true);
          lh.set(nameBytes, 30);
          local.push(lh, e.data);

      const ch = new Uint8Array(46 + nameBytes.length);
          const cv = new DataView(ch.buffer);
          cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
          cv.setUint16(8, 0, true); cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
          cv.setUint32(16, crc, true); cv.setUint32(20, size, true); cv.setUint32(24, size, true);
          cv.setUint16(28, nameBytes.length, true); cv.setUint32(42, offset, true);
          ch.set(nameBytes, 46);
          central.push(ch);

      offset += lh.length + e.data.length;
    }
    const centralSize = central.reduce((a, b) => a + b.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);

  const total = offset + centralSize + end.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of [...local, ...central, end]) { out.set(p, pos); pos += p.length; }
    return out;
}
