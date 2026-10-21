import { FFmpeg } from "@ffmpeg/ffmpeg";
import { loadDir } from "./store";

const statusEl = document.getElementById("status")!;
const barEl = document.getElementById("bar") as HTMLProgressElement;
const errorEl = document.getElementById("error")!;
const actionsEl = document.getElementById("actions")!;

const CONCURRENCY = 6;
const RETRIES = 3;
const MAX_AHEAD = 24; // quantos segmentos podem ficar na memória esperando a vez de gravar

type PermDir = FileSystemDirectoryHandle & {
  queryPermission(d: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(d: { mode: "readwrite" }): Promise<PermissionState>;
};

interface Sink {
  label: string;
  size(): number;
  write(d: BufferSource): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

interface Part {
  blob: Blob;
  fmp4: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const abs = (u: string, base: string) => new URL(u, base).toString();

// ---------- pasta de destino ----------

async function getDir(): Promise<PermDir | null> {
  const dir = (await loadDir()) as PermDir | null;
  if (!dir) return null;
  if ((await dir.queryPermission({ mode: "readwrite" })) === "granted") return dir;

  statusEl.textContent = `Clique no botão para liberar o acesso à pasta "${dir.name}".`;
  await new Promise<void>((resolve) => {
    const b = document.createElement("button");
    b.textContent = `Permitir acesso à pasta "${dir.name}"`;
    b.addEventListener("click", async () => {
      if ((await dir.requestPermission({ mode: "readwrite" })) === "granted") {
        b.remove();
        resolve();
      }
    });
    actionsEl.append(b);
  });
  return dir;
}

async function uniqueName(dir: FileSystemDirectoryHandle, name: string) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 0; ; n++) {
    const candidate = n ? `${stem} (${n})${ext}` : name;
    try {
      await dir.getFileHandle(candidate);
    } catch (e) {
      if ((e as DOMException).name === "NotFoundError") return candidate;
      throw e;
    }
  }
}

function saveBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

async function openSink(dir: PermDir | null, name: string, mime: string): Promise<Sink> {
  let bytes = 0;

  if (dir) {
    const finalName = await uniqueName(dir, name);
    const fh = await dir.getFileHandle(finalName, { create: true });
    const w = await fh.createWritable();
    return {
      label: `${dir.name}\\${finalName}`,
      size: () => bytes,
      write: async (d) => {
        await w.write(d);
        bytes += d.byteLength;
      },
      close: () => w.close(),
      abort: async () => {
        await w.abort().catch(() => {});
        await dir.removeEntry(finalName).catch(() => {});
      },
    };
  }

  // sem pasta escolhida: junta na memória e salva em Downloads
  const chunks: BlobPart[] = [];
  return {
    label: `Downloads\\${name}`,
    size: () => bytes,
    write: async (d) => {
      chunks.push(d as BlobPart);
      bytes += d.byteLength;
    },
    close: async () => saveBlob(new Blob(chunks, { type: mime }), name),
    abort: async () => {
      chunks.length = 0;
    },
  };
}

async function saveRaw(dir: PermDir | null, name: string, blob: Blob, mime: string) {
  const sink = await openSink(dir, name, mime);
  try {
    await sink.write(await blob.arrayBuffer());
    await sink.close();
  } catch (e) {
    await sink.abort();
    throw e;
  }
  return sink.label;
}

// ---------- rede ----------

async function fetchRetry(url: string, as: "text" | "buffer") {
  let lastErr: unknown;
  for (let i = 0; i < RETRIES; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return as === "text" ? await r.text() : await r.arrayBuffer();
    } catch (e) {
      lastErr = e;
      await sleep(500 * (i + 1));
    }
  }
  throw new Error(`Falha ao baixar ${url}: ${(lastErr as Error).message}`);
}

// ---------- HLS ----------

interface Master {
  video: string;
  audio: string | null;
}

// escolhe a melhor variante de vídeo e o áudio ligado a ela (AUDIO="grupo")
function parseMaster(text: string, base: string): Master {
  const lines = text.split(/\r?\n/);

  const audioGroups = new Map<string, string>();
  for (const l of lines) {
    if (!l.startsWith("#EXT-X-MEDIA:") || !/TYPE=AUDIO/.test(l)) continue;
    const group = l.match(/GROUP-ID="([^"]+)"/)?.[1];
    const uri = l.match(/URI="([^"]+)"/)?.[1];
    if (group && uri && !audioGroups.has(group)) audioGroups.set(group, abs(uri, base));
  }

  let best = { url: "", bw: -1, group: "" };
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
    const bw = Number(lines[i].match(/BANDWIDTH=(\d+)/)?.[1] ?? 0);
    const group = lines[i].match(/AUDIO="([^"]+)"/)?.[1] ?? "";
    const uri = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith("#"));
    if (uri && bw > best.bw) best = { url: abs(uri.trim(), base), bw, group };
  }
  if (!best.url) throw new Error("Nenhuma variante encontrada na playlist master.");

  return { video: best.url, audio: best.group ? audioGroups.get(best.group) ?? null : null };
}

function parseMedia(text: string, base: string) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let init: string | null = null;
  const segments: string[] = [];

  for (const line of lines) {
    if (line.startsWith("#EXT-X-KEY:") && !/METHOD=NONE/.test(line)) {
      throw new Error("Stream criptografado (EXT-X-KEY). Ainda não suportado.");
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) init = abs(m[1], base);
    }
    if (line && !line.startsWith("#")) segments.push(abs(line, base));
  }

  if (!text.includes("#EXT-X-ENDLIST")) {
    throw new Error("Stream ao vivo (sem EXT-X-ENDLIST). Ainda não suportado.");
  }
  if (!segments.length) throw new Error("Nenhum segmento encontrado.");
  return { init, segments };
}

const isFmp4 = (init: string | null, segments: string[]) => !!init || /\.(m4s|mp4|m4a)(\?|$)/i.test(segments[0]);

// baixa em paralelo, mas grava sempre na ordem certa
async function pump(urls: string[], sink: Sink, label = "segmentos") {
  const buf = new Map<number, ArrayBuffer>();
  let next = 0;
  let writeIdx = 0;
  let done = 0;
  let error: Error | null = null;
  let chain: Promise<void> = Promise.resolve();

  barEl.max = urls.length;
  const update = () => {
    barEl.value = done;
    statusEl.textContent = `Baixando ${label}: ${done}/${urls.length}`;
  };
  update();

  const flush = () => {
    chain = chain.then(async () => {
      while (buf.has(writeIdx)) {
        const data = buf.get(writeIdx)!;
        buf.delete(writeIdx);
        await sink.write(data);
        writeIdx++;
      }
    });
    return chain;
  };

  async function worker() {
    while (!error) {
      if (next - writeIdx > MAX_AHEAD) {
        await sleep(100);
        continue;
      }
      const i = next++;
      if (i >= urls.length) return;
      try {
        buf.set(i, (await fetchRetry(urls[i], "buffer")) as ArrayBuffer);
        done++;
        update();
        await flush();
      } catch (e) {
        error = e as Error;
        throw e;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await chain;
}

// baixa uma playlist de mídia inteira para a memória
async function collect(playlistUrl: string, label: string): Promise<Part> {
  const text = (await fetchRetry(playlistUrl, "text")) as string;
  const { init, segments } = parseMedia(text, playlistUrl);
  const urls = init ? [init, ...segments] : segments;

  const chunks: BlobPart[] = [];
  let bytes = 0;
  const sink: Sink = {
    label,
    size: () => bytes,
    write: async (d) => {
      chunks.push(d as BlobPart);
      bytes += d.byteLength;
    },
    close: async () => {},
    abort: async () => {
      chunks.length = 0;
    },
  };
  await pump(urls, sink, label);
  return { blob: new Blob(chunks), fmp4: isFmp4(init, segments) };
}

function baseName(url: string) {
  try {
    const last = new URL(url).pathname.split("/").pop() || "video";
    return decodeURIComponent(last).replace(/\.[a-z0-9]+$/i, "").replace(/[\\/:*?"<>|]/g, "_") || "video";
  } catch {
    return "video";
  }
}

// ---------- mux (ffmpeg.wasm) ----------

async function muxWithFfmpeg(v: Part, a: Part): Promise<ArrayBuffer> {
  const ff = new FFmpeg();
  ff.on("log", ({ message }) => console.log("[ffmpeg]", message));

  await ff.load({
    classWorkerURL: chrome.runtime.getURL("ffmpeg/worker.js"),
    coreURL: chrome.runtime.getURL("ffmpeg/ffmpeg-core.js"),
    wasmURL: chrome.runtime.getURL("ffmpeg/ffmpeg-core.wasm"),
  });

  const vn = v.fmp4 ? "v.mp4" : "v.ts";
  const an = a.fmp4 ? "a.mp4" : "a.ts";
  await ff.writeFile(vn, new Uint8Array(await v.blob.arrayBuffer()));
  await ff.writeFile(an, new Uint8Array(await a.blob.arrayBuffer()));

  statusEl.textContent = "Juntando áudio e vídeo...";
  const code = await ff.exec(["-i", vn, "-i", an, "-map", "0", "-map", "1", "-c", "copy", "-movflags", "+faststart", "out.mp4"]);
  if (code !== 0) throw new Error(`ffmpeg terminou com código ${code}`);

  const out = await ff.readFile("out.mp4");
  ff.terminate();
  if (typeof out === "string") throw new Error("Saída inesperada do ffmpeg.");
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

async function downloadMuxed(videoUrl: string, audioUrl: string, name: string, dir: PermDir | null) {
  const v = await collect(videoUrl, "vídeo");
  const a = await collect(audioUrl, "áudio");

  barEl.removeAttribute("value"); // barra indeterminada
  statusEl.textContent = "Carregando ffmpeg...";

  try {
    const out = await muxWithFfmpeg(v, a);
    const label = await saveRaw(dir, name, new Blob([out]), "video/mp4");
    barEl.max = 1;
    barEl.value = 1;
    statusEl.textContent = `Pronto! Salvo em ${label} (${(out.byteLength / 1048576).toFixed(1)} MB). Pode fechar esta aba.`;
  } catch (e) {
    console.error("[VideoGrabber] mux falhou", e);
    errorEl.textContent = "Não consegui juntar áudio e vídeo: " + (e as Error).message;
    const base = name.replace(/\.mp4$/i, "");
    const l1 = await saveRaw(dir, `${base}.video.${v.fmp4 ? "mp4" : "ts"}`, v.blob, "video/mp4");
    const l2 = await saveRaw(dir, `${base}.audio.${a.fmp4 ? "m4a" : "ts"}`, a.blob, "audio/mp4");
    barEl.max = 1;
    barEl.value = 1;
    statusEl.textContent = `Salvei separados: ${l1} e ${l2}.`;
  }
}

async function downloadHls(url: string, dir: PermDir | null) {
  statusEl.textContent = "Lendo playlist...";
  let playlistUrl = url;
  let audioUrl: string | null = null;
  let text = (await fetchRetry(playlistUrl, "text")) as string;

  if (text.includes("#EXT-X-STREAM-INF")) {
    const m = parseMaster(text, playlistUrl);
    playlistUrl = m.video;
    audioUrl = m.audio;
    statusEl.textContent = audioUrl
      ? "Playlist master: melhor vídeo + áudio separado..."
      : "Playlist master: usando a melhor qualidade...";
    text = (await fetchRetry(playlistUrl, "text")) as string;
  }

  // vídeo e áudio em playlists separadas: baixa os dois e junta
  if (audioUrl) {
    await downloadMuxed(playlistUrl, audioUrl, `${baseName(url)}.mp4`, dir);
    return;
  }

  const { init, segments } = parseMedia(text, playlistUrl);
  const urls = init ? [init, ...segments] : segments;

  const fmp4 = isFmp4(init, segments);
  const name = `${baseName(url)}.${fmp4 ? "mp4" : "ts"}`;

  const sink = await openSink(dir, name, fmp4 ? "video/mp4" : "video/mp2t");
  try {
    await pump(urls, sink);
    await sink.close();
  } catch (e) {
    await sink.abort();
    throw e;
  }
  barEl.value = barEl.max;
  statusEl.textContent = `Pronto! Salvo em ${sink.label} (${(sink.size() / 1048576).toFixed(1)} MB). Pode fechar esta aba.`;
}

// ---------- arquivo direto ----------

async function downloadFile(url: string, name: string, dir: PermDir | null) {
  if (!dir) {
    await chrome.downloads.download({ url, filename: name });
    statusEl.textContent = `Download iniciado: ${name}. Pode fechar esta aba.`;
    return;
  }

  statusEl.textContent = "Conectando...";
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  const total = Number(r.headers.get("content-length")) || 0;
  if (total) barEl.max = total;

  const sink = await openSink(dir, name, "");
  try {
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await sink.write(value);
      const got = sink.size();
      if (total) barEl.value = got;
      statusEl.textContent = `Baixando: ${(got / 1048576).toFixed(1)} MB${total ? ` de ${(total / 1048576).toFixed(1)} MB` : ""}`;
    }
    await sink.close();
  } catch (e) {
    await sink.abort();
    throw e;
  }
  statusEl.textContent = `Pronto! Salvo em ${sink.label} (${(sink.size() / 1048576).toFixed(1)} MB). Pode fechar esta aba.`;
}

// ---------- juntar dois arquivos diretos (ex.: Facebook) ----------

async function fetchWhole(url: string, label: string): Promise<Part> {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  const total = Number(r.headers.get("content-length")) || 0;
  barEl.max = total || 1;
  barEl.value = 0;

  const chunks: BlobPart[] = [];
  let got = 0;
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as BlobPart);
    got += value.byteLength;
    if (total) barEl.value = got;
    statusEl.textContent = `Baixando ${label}: ${(got / 1048576).toFixed(1)} MB`;
  }
  return { blob: new Blob(chunks), fmp4: true };
}

async function downloadMerge(url1: string, url2: string, name: string, dir: PermDir | null) {
  const p1 = await fetchWhole(url1, "arquivo 1");
  const p2 = await fetchWhole(url2, "arquivo 2");

  barEl.removeAttribute("value");
  statusEl.textContent = "Carregando ffmpeg...";

  try {
    const out = await muxWithFfmpeg(p1, p2);
    const label = await saveRaw(dir, name, new Blob([out]), "video/mp4");
    barEl.max = 1;
    barEl.value = 1;
    statusEl.textContent = `Pronto! Salvo em ${label} (${(out.byteLength / 1048576).toFixed(1)} MB). Pode fechar esta aba.`;
  } catch (e) {
    console.error("[VideoGrabber] mux falhou", e);
    errorEl.textContent = "Não consegui juntar: " + (e as Error).message;
    const base = name.replace(/\.mp4$/i, "");
    const l1 = await saveRaw(dir, `${base}.parte1.mp4`, p1.blob, "video/mp4");
    const l2 = await saveRaw(dir, `${base}.parte2.mp4`, p2.blob, "video/mp4");
    barEl.max = 1;
    barEl.value = 1;
    statusEl.textContent = `Salvei separados: ${l1} e ${l2}.`;
  }
}

// ---------- main ----------

async function main() {
  const params = new URLSearchParams(location.search);
  const url = params.get("url");
  const kind = params.get("kind") ?? "hls";
  const name = params.get("name") || "video.mp4";
  if (!url) throw new Error("URL não informada.");

  let dir: PermDir | null = null;
  try {
    dir = await getDir();
  } catch (e) {
    console.warn("[VideoGrabber] pasta indisponível, usando Downloads", e);
    statusEl.textContent = "Não foi possível acessar a pasta salva. Usando Downloads.";
    dir = null;
  }

  const url2 = params.get("url2");
  if (kind === "merge" && url2) await downloadMerge(url, url2, name, dir);
  else if (kind === "file") await downloadFile(url, name, dir);
  else await downloadHls(url, dir);
}

main().catch((e) => {
  errorEl.textContent = "Erro: " + (e as Error).message;
  statusEl.textContent = "Falhou.";
});


