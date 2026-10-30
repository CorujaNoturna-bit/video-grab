import type { VideoInfo, MediaInfo, ProbeInfo } from "./types";
import { loadDir } from "./store";
import { getHlsInfos, pathKey, type HlsInfo } from "./hls";
import { probeAll } from "./mp4";

const list = document.getElementById("list")!;
const selected = new Set<string>();
let mergeBtn: HTMLButtonElement | null = null;
let tabTitle = "";
const TOL = 1.5; // diferença máxima de duração (s) para considerar o mesmo vídeo

interface State {
  dir: FileSystemDirectoryHandle | null;
  videos: VideoInfo[];
  media: MediaInfo[];
  infos: Map<string, HlsInfo>;
  probes: Map<string, ProbeInfo>;
  advanced: boolean;
}

type Entry =
  | { t: "pair"; v: MediaInfo; a: MediaInfo; pv: ProbeInfo; rank: number; ts: number }
  | { t: "media"; m: MediaInfo; note?: string; rank: number; ts: number };

// ---------- utilidades ----------

function fmtTime(s: number) {
  if (!s || isNaN(s)) return "?";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

function fmtSize(n: number) {
  if (!n) return "?";
  const mb = n / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

function safeTitle() {
  return (tabTitle || "video").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
}

function fileName(m: MediaInfo) {
  const cleanTitle = safeTitle();
  const ext = m.mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "mp4";
  if (cleanTitle && cleanTitle !== "video") {
    return `${cleanTitle}.${ext}`;
  }
  let base = "";
  try {
    base = decodeURIComponent(new URL(m.url).pathname.split("/").pop() || "");
  } catch {
    base = "";
  }
  base = base.replace(/[\\/:*?"<>|]/g, "_");
  if (/\.[a-z0-9]{2,4}$/i.test(base)) return base;
  return `video.${ext}`;
}

function box() {
  const el = document.createElement("div");
  el.style.cssText = "border:1px solid #ccc;border-radius:6px;padding:8px;margin-bottom:8px;font-size:12px;word-break:break-all";
  return el;
}

function btn(label: string, onClick: () => void, disabled = false) {
  const b = document.createElement("button");
  b.textContent = label;
  b.disabled = disabled;
  b.style.marginRight = "6px";
  b.addEventListener("click", onClick);
  return b;
}

function heading(text: string) {
  const h = document.createElement("h4");
  h.textContent = text;
  h.style.margin = "12px 0 6px";
  return h;
}

function note(text: string) {
  const d = document.createElement("div");
  d.textContent = text;
  d.style.cssText = "font-size:12px;margin:8px 0";
  return d;
}

function openDownload(q: Record<string, string>) {
  chrome.tabs.create({ url: chrome.runtime.getURL("download.html") + "?" + new URLSearchParams(q).toString() });
}

// ---------- barras ----------

function folderBar(name: string | null) {
  const el = document.createElement("div");
  el.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:8px";
  const span = document.createElement("span");
  span.textContent = name ? `Salvar em: ${name}` : "Salvar em: Downloads (padrão)";
  span.style.flex = "1";
  el.append(span, btn("Alterar", () => chrome.runtime.openOptionsPage()));
  return el;
}

function refreshMerge() {
  if (!mergeBtn) return;
  mergeBtn.disabled = selected.size !== 2;
  mergeBtn.textContent = `Juntar vídeo + áudio (${selected.size}/2)`;
}

function mergeBar() {
  const el = document.createElement("div");
  el.style.cssText = "margin-bottom:8px;font-size:12px";
  mergeBtn = btn("", () => {
    const [a, b] = [...selected];
    openDownload({ url: a, url2: b, kind: "merge", name: `${safeTitle()}.mp4` });
  }, true);
  const hint = document.createElement("div");
  hint.style.cssText = "color:#555;margin-top:4px";
  hint.textContent = "Marque 2 itens (um de vídeo e um de áudio) para juntar.";
  el.append(mergeBtn, hint);
  refreshMerge();
  return el;
}

// ---------- itens ----------

function roleLabel(info: HlsInfo | undefined) {
  if (info?.role === "master") return "master (vídeo + áudio)";
  if (info?.role === "media") return "faixa única";
  return "";
}

function probeLabel(p: ProbeInfo | undefined) {
  if (!p) return "";
  const role = { video: "só vídeo", audio: "só áudio", both: "vídeo + áudio", unknown: "?" }[p.role];
  const res = p.width && p.height ? ` ${p.width}x${p.height}` : "";
  return ` • ${role} • ${fmtTime(p.duration)}${res}`;
}

function renderMedia(m: MediaInfo, s: State, simple: boolean, extra?: string): HTMLElement {
  const info = s.infos.get(m.url);
  const probe = s.probes.get(m.url);
  const el = box();
  const title = document.createElement("b");

  // Fallback de duração: se o probe falhar (ex: CORS/403), usa a duração do <video> ativo na página
  const fallbackDuration = referenceDurations(s.videos)[0] || 0;
  const durationSec = probe?.duration || fallbackDuration;
  const durText = durationSec ? ` • ${fmtTime(durationSec)}` : "";
  const shortTitle = tabTitle ? `${tabTitle.slice(0, 45)}${tabTitle.length > 45 ? "..." : ""}` : "Arquivo de mídia";

  if (simple) {
    title.textContent =
      m.kind === "hls"
        ? `${shortTitle} (HLS)${info?.resolution ? ` • ${info.resolution}` : ""}${durText}`
        : `${shortTitle} • ${fmtSize(m.size)}${durText}`;
  } else {
    const kindLabel = { file: "arquivo", hls: "stream HLS", dash: "stream DASH" }[m.kind];
    const role = m.kind === "hls" && roleLabel(info) ? ` • ${roleLabel(info)}` : "";
    title.textContent = `${kindLabel} • ${m.mime || "?"} • ${fmtSize(m.size)}${role}${m.kind === "file" ? (probe ? probeLabel(probe) : durText) : ""}`;
  }
  el.append(title);

  if (extra) {
    const n = document.createElement("div");
    n.style.cssText = "color:#555;margin-top:4px";
    n.textContent = extra;
    el.append(n);
  }

  if (!simple) {
    const url = document.createElement("div");
    url.style.cssText = "color:#555;margin-top:4px";
    url.textContent = m.url.slice(0, 120);
    el.append(url);
  }

  const status = document.createElement("span");
  status.style.color = "#555";

  const actions = document.createElement("div");
  actions.style.marginTop = "6px";

  if (m.kind === "dash") {
    actions.append(btn("Baixar (em breve)", () => {}, true));
  } else {
    actions.append(
      btn("Baixar", () => {
        openDownload({ url: m.url, kind: m.kind, name: fileName(m) });
      })
    );
  }

  if (!simple) {
    actions.append(
      btn("Copiar URL", async () => {
        await navigator.clipboard.writeText(m.url);
        status.textContent = "URL copiada";
      })
    );
  }
  actions.append(status);
  el.append(actions);

  if (!simple && m.kind === "file") {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(m.url);
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(m.url);
      else selected.delete(m.url);
      refreshMerge();
    });
    const lab = document.createElement("label");
    lab.style.cssText = "display:block;margin-top:6px";
    lab.append(cb, " selecionar para juntar");
    el.append(lab);
  }

  return el;
}

function renderPair(e: Extract<Entry, { t: "pair" }>): HTMLElement {
  const el = box();
  const title = document.createElement("b");
  const res = e.pv.width && e.pv.height ? `${e.pv.width}x${e.pv.height} • ` : "";
  const shortTitle = tabTitle ? `${tabTitle.slice(0, 45)} • ` : "Vídeo + áudio • ";
  title.textContent = `${shortTitle}${res}${fmtTime(e.pv.duration)}`;

  const actions = document.createElement("div");
  actions.style.marginTop = "6px";
  actions.append(
    btn("Baixar", () => {
      openDownload({
        url: e.v.url,
        url2: e.a.url,
        kind: "merge",
        name: `${safeTitle()}.mp4`,
      });
    })
  );

  el.append(title, actions);
  return el;
}

function renderVideo(v: VideoInfo): HTMLElement {
  const el = box();
  const label = v.kind === "blob" ? "blob (use a lista de rede)" : v.kind === "direct" ? "arquivo direto" : "sem src ainda";
  const title = document.createElement("b");
  title.textContent = `${v.width}x${v.height} • ${fmtTime(v.duration)} • ${label}${v.playing ? " • tocando" : ""}${v.inView ? " • na tela" : ""}`;
  const url = document.createElement("div");
  url.style.cssText = "color:#555;margin-top:4px";
  url.textContent = v.src ? v.src.slice(0, 120) : "(vazio)";
  el.append(title, url);
  return el;
}

// ---------- lógica do modo simples ----------

function referenceDurations(videos: VideoInfo[]): number[] {
  const withDur = videos.filter((v) => v.duration > 0);
  const tiers = [
    withDur.filter((v) => v.playing && v.inView),
    withDur.filter((v) => v.playing),
    withDur.filter((v) => v.inView),
    withDur,
  ];
  return (tiers.find((t) => t.length) ?? []).map((v) => v.duration);
}

function buildEntries(s: State): { entries: Entry[]; hidden: number } {
  const entries: Entry[] = [];
  let hidden = 0;

  const children = new Set<string>();
  for (const m of s.media) {
    const info = s.infos.get(m.url);
    if (m.kind === "hls" && info?.role === "master") info.children.forEach((c) => children.add(pathKey(c)));
  }
  for (const m of s.media) {
    if (m.kind !== "hls" || children.has(pathKey(m.url))) continue;
    entries.push({ t: "media", m, rank: s.infos.get(m.url)?.role === "master" ? 0 : 1, ts: m.ts });
  }

  const refs = referenceDurations(s.videos);
  const vids: MediaInfo[] = [];
  const auds: MediaInfo[] = [];

  for (const m of s.media.filter((x) => x.kind === "file")) {
    const p = s.probes.get(m.url);
    const known = !!p && p.duration > 0;

    if (!known) {
      entries.push({ t: "media", m, rank: 1, ts: m.ts });
      continue;
    }
    if (refs.length && !refs.some((d) => Math.abs(d - p.duration) <= TOL)) {
      hidden++;
      continue;
    }
    if (p.role === "video") vids.push(m);
    else if (p.role === "audio") auds.push(m);
    else entries.push({ t: "media", m, rank: 1, ts: m.ts });
  }

  if (refs.length && vids.length && auds.length) {
    const pv = (m: MediaInfo) => s.probes.get(m.url)!;
    const v = [...vids].sort((a, b) => pv(b).height - pv(a).height || b.size - a.size)[0];
    const a = [...auds].sort((x, y) => y.size - x.size)[0];
    entries.push({ t: "pair", v, a, pv: pv(v), rank: 0, ts: Math.max(v.ts, a.ts) });
    hidden += vids.length - 1 + auds.length - 1;
  } else {
    for (const m of vids) entries.push({ t: "media", m, note: "Só vídeo (sem áudio separado encontrado)", rank: 1, ts: m.ts });
    for (const m of auds) entries.push({ t: "media", m, note: "Só áudio", rank: 1, ts: m.ts });
  }

  entries.sort((a, b) => a.rank - b.rank || b.ts - a.ts);
  return { entries, hidden };
}

// ---------- tela ----------

function render(s: State) {
  const nodes: HTMLElement[] = [folderBar(s.dir?.name ?? null)];

  if (s.advanced) {
    nodes.push(mergeBar());
    if (s.media.length) nodes.push(heading(`Mídia detectada na rede (${s.media.length})`), ...s.media.map((m) => renderMedia(m, s, false)));
    if (s.videos.length) nodes.push(heading(`Elementos <video> (${s.videos.length})`), ...s.videos.map(renderVideo));
    if (!s.media.length && !s.videos.length) nodes.push(note("Nada encontrado. Dê play no vídeo e reabra o popup."));
  } else {
    const { entries, hidden } = buildEntries(s);
    if (entries.length) {
      nodes.push(...entries.map((e) => (e.t === "pair" ? renderPair(e) : renderMedia(e.m, s, true, e.note))));
      if (hidden) nodes.push(note(`${hidden} arquivo(s) de outros vídeos ou qualidades ocultos. Veja tudo no modo avançado.`));
    } else if (s.media.length || s.videos.length) {
      nodes.push(note("Nada pronto para baixar ainda. Dê play no vídeo e reabra o popup, ou veja tudo no modo avançado."));
    } else {
      nodes.push(note("Nada encontrado. Dê play no vídeo e reabra o popup."));
    }
  }

  const toggle = btn(s.advanced ? "Voltar ao modo simples" : "Ver tudo (avançado)", async () => {
    s.advanced = !s.advanced;
    await chrome.storage.local.set({ advanced: s.advanced });
    render(s);
  });
  nodes.push(toggle);

  list.replaceChildren(...nodes);
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) {
    list.textContent = "Aba não encontrada.";
    return;
  }
  tabTitle = tab.title ?? "";

  const vk = `videos:${tab.id}`;
  const mk = `media:${tab.id}`;
  const [stored, prefs, dir] = await Promise.all([
    chrome.storage.session.get([vk, mk]),
    chrome.storage.local.get("advanced"),
    loadDir().catch(() => null),
  ]);

  const frames = (stored[vk] ?? {}) as Record<string, VideoInfo[]>;
  const videos = Object.values(frames).flat();
  const media = Object.values((stored[mk] ?? {}) as Record<string, MediaInfo>).sort((a, b) => b.ts - a.ts);

  const [infos, probes] = await Promise.all([
    getHlsInfos(media.filter((m) => m.kind === "hls").map((m) => m.url)),
    probeAll(media.filter((m) => m.kind === "file").map((m) => m.url)),
  ]);

  render({ dir, videos, media, infos, probes, advanced: !!prefs.advanced });
}

main();