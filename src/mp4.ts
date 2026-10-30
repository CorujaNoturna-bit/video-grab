import type { ProbeInfo } from "./types";

const HEAD = 262144; // 256 KB por leitura
const MAX_MOOV = 8 * 1048576;
const CACHE_KEY = "mp4probe";

interface Box {
  type: string;
  start: number;
  size: number;
  header: number;
}

const fourcc = (v: DataView, p: number) =>
  String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));

function* boxes(v: DataView, from: number, to: number): Generator<Box> {
  let p = from;
  while (p + 8 <= to) {
    let size = v.getUint32(p);
    const type = fourcc(v, p + 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > to) return;
      size = Number(v.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) {
      size = to - p;
    }
    if (size < header) return;
    yield { type, start: p, size, header };
    p += size;
  }
}

const kids = (v: DataView, b: Box) => boxes(v, b.start + b.header, b.start + b.size);

async function range(url: string, from: number, to: number): Promise<ArrayBuffer | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { Range: `bytes=${from}-${to}` }, signal: ctl.signal });
    if (r.status !== 206) {
      ctl.abort(); // servidor ignorou o Range: não baixa o arquivo inteiro
      return null;
    }
    return await r.arrayBuffer();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// devolve um DataView que começa exatamente no box "moov"
async function findMoov(url: string): Promise<DataView | null> {
  let offset = 0;
  for (let i = 0; i < 5; i++) {
    const buf = await range(url, offset, offset + HEAD - 1);
    if (!buf) return null;
    const v = new DataView(buf);

    let next = 0;
    let found: Box | null = null;
    for (const b of boxes(v, 0, v.byteLength)) {
      if (b.type === "moov") {
        found = b;
        break;
      }
      next = b.start + b.size;
    }

    if (found) {
      if (found.start + found.size <= v.byteLength) return new DataView(buf, found.start, found.size);
      if (found.size > MAX_MOOV) return null;
      const full = await range(url, offset + found.start, offset + found.start + found.size - 1);
      return full ? new DataView(full) : null;
    }

    if (next <= 0) return null;
    offset += next; // pula o mdat e tenta de novo
  }
  return null;
}

function parseMoov(v: DataView): ProbeInfo {
  const top = boxes(v, 0, v.byteLength).next().value as Box;
  let timescale = 1;
  let duration = 0;
  let fragDur = 0;
  let width = 0;
  let height = 0;
  const roles = new Set<string>();

  for (const b of kids(v, top)) {
    const c = b.start + b.header;

    if (b.type === "mvhd") {
      if (v.getUint8(c) === 1) {
        timescale = v.getUint32(c + 20);
        duration = Number(v.getBigUint64(c + 24));
      } else {
        timescale = v.getUint32(c + 12);
        duration = v.getUint32(c + 16);
      }
    } else if (b.type === "mvex") {
      for (const k of kids(v, b)) {
        if (k.type !== "mehd") continue;
        const kc = k.start + k.header;
        fragDur = v.getUint8(kc) === 1 ? Number(v.getBigUint64(kc + 4)) : v.getUint32(kc + 4);
      }
    } else if (b.type === "trak") {
      let tw = 0;
      let th = 0;
      let handler = "";
      for (const k of kids(v, b)) {
        const kc = k.start + k.header;
        if (k.type === "tkhd") {
          const o = v.getUint8(kc) === 1 ? 88 : 76;
          tw = v.getUint32(kc + o) / 65536;
          th = v.getUint32(kc + o + 4) / 65536;
        } else if (k.type === "mdia") {
          for (const h of kids(v, k)) {
            if (h.type === "hdlr") handler = fourcc(v, h.start + h.header + 8);
          }
        }
      }
      if (handler) roles.add(handler);
      if (handler === "vide") {
        width = Math.round(tw);
        height = Math.round(th);
      }
    }
  }

  const hasV = roles.has("vide");
  const hasA = roles.has("soun");
  const total = duration || fragDur;
  return {
    role: hasV && hasA ? "both" : hasV ? "video" : hasA ? "audio" : "unknown",
    duration: timescale ? total / timescale : 0,
    width,
    height,
  };
}

async function probeOne(url: string): Promise<ProbeInfo | null> {
  try {
    const moov = await findMoov(url);
    return moov ? parseMoov(moov) : null;
  } catch {
    return null;
  }
}

export async function probeAll(urls: string[]): Promise<Map<string, ProbeInfo>> {
  const stored = await chrome.storage.session.get(CACHE_KEY);
  const cache = (stored[CACHE_KEY] ?? {}) as Record<string, ProbeInfo>;
  const out = new Map<string, ProbeInfo>();
  let changed = false;

  await Promise.all(
    urls.map(async (u) => {
      if (cache[u]) {
        out.set(u, cache[u]);
        return;
      }
      const info = await probeOne(u);
      if (info) {
        cache[u] = info; // falhas não vão para o cache
        changed = true;
        out.set(u, info);
      }
    })
  );

  if (changed) await chrome.storage.session.set({ [CACHE_KEY]: cache });
  return out;
}
