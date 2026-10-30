export interface HlsInfo {
  role: "master" | "media" | "error";
  children: string[]; // variantes e áudios referenciados (só em master)
  resolution: string; // da melhor variante (só em master)
}

const CACHE_KEY = "hlsinfo";

// compara ignorando parâmetros de query (tokens mudam entre requisições)
export function pathKey(u: string) {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return u;
  }
}

async function fetchText(url: string, ms = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function analyze(text: string, base: string): HlsInfo {
  if (!text.includes("#EXT-X-STREAM-INF")) {
    return { role: "media", children: [], resolution: "" };
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const children: string[] = [];
  let best = { bw: -1, res: "" };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    if (l.startsWith("#EXT-X-MEDIA:")) {
      const uri = l.match(/URI="([^"]+)"/)?.[1];
      if (uri) children.push(new URL(uri, base).toString());
    }

    if (l.startsWith("#EXT-X-STREAM-INF:")) {
      const bw = Number(l.match(/BANDWIDTH=(\d+)/)?.[1] ?? 0);
      const res = l.match(/RESOLUTION=(\d+x\d+)/)?.[1] ?? "";
      const uri = lines.slice(i + 1).find((x) => x && !x.startsWith("#"));
      if (uri) children.push(new URL(uri, base).toString());
      if (bw > best.bw) best = { bw, res };
    }
  }

  return { role: "master", children, resolution: best.res };
}

export async function getHlsInfos(urls: string[]): Promise<Map<string, HlsInfo>> {
  const stored = await chrome.storage.session.get(CACHE_KEY);
  const cache = (stored[CACHE_KEY] ?? {}) as Record<string, HlsInfo>;
  const out = new Map<string, HlsInfo>();
  let changed = false;

  await Promise.all(
    urls.map(async (u) => {
      if (cache[u]) {
        out.set(u, cache[u]);
        return;
      }
      try {
        const info = analyze(await fetchText(u), u);
        cache[u] = info;
        changed = true;
        out.set(u, info);
      } catch {
        // não guarda erro em cache: tenta de novo na próxima abertura
        out.set(u, { role: "error", children: [], resolution: "" });
      }
    })
  );

  if (changed) await chrome.storage.session.set({ [CACHE_KEY]: cache });
  return out;
}
