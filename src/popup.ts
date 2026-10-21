import type { VideoInfo, MediaInfo } from "./types";
import { loadDir } from "./store";

const list = document.getElementById("list")!;
const selected = new Set<string>();
let mergeBtn: HTMLButtonElement | null = null;
let tabTitle = "";

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
    const safe = (tabTitle || "video").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
    const q = new URLSearchParams({ url: a, url2: b, kind: "merge", name: `${safe}.mp4` });
    chrome.tabs.create({ url: chrome.runtime.getURL("download.html") + "?" + q.toString() });
  }, true);
  const hint = document.createElement("div");
  hint.style.cssText = "color:#555;margin-top:4px";
  hint.textContent = "Marque 2 itens (um de vídeo e um de áudio) para juntar.";
  el.append(mergeBtn, hint);
  refreshMerge();
  return el;
}

function fmtTime(s: number) {
  if (!s) return "?";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

function fmtSize(n: number) {
  if (!n) return "?";
  const mb = n / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

function fileName(m: MediaInfo) {
  let base = "";
  try {
    base = decodeURIComponent(new URL(m.url).pathname.split("/").pop() || "");
  } catch {
    base = "";
  }
  base = base.replace(/[\\/:*?"<>|]/g, "_");
  if (/\.[a-z0-9]{2,4}$/i.test(base)) return base;
  const ext = m.mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "mp4";
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

function folderBar(name: string | null) {
  const el = document.createElement("div");
  el.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:8px";
  const span = document.createElement("span");
  span.textContent = name ? `Salvar em: ${name}` : "Salvar em: Downloads (padrão)";
  span.style.flex = "1";
  el.append(span, btn("Alterar", () => chrome.runtime.openOptionsPage()));
  return el;
}

function renderMedia(m: MediaInfo, hasDir: boolean): HTMLElement {
  const el = box();
  const kindLabel = { file: "arquivo", hls: "stream HLS", dash: "stream DASH" }[m.kind];

  const title = document.createElement("b");
  title.textContent = `${kindLabel} • ${m.mime || "?"} • ${fmtSize(m.size)}`;

  const url = document.createElement("div");
  url.style.cssText = "color:#555;margin-top:4px";
  url.textContent = m.url.slice(0, 120);

  const status = document.createElement("span");
  status.style.color = "#555";

  const actions = document.createElement("div");
  actions.style.marginTop = "6px";

  if (m.kind === "dash") {
    actions.append(btn("Baixar (em breve)", () => {}, true));
  } else {
    actions.append(
      btn("Baixar", async () => {
        if (m.kind === "file" && !hasDir) {
          try {
            await chrome.downloads.download({ url: m.url, filename: fileName(m) });
            status.textContent = "Download iniciado";
          } catch (e) {
            status.textContent = "Erro: " + (e as Error).message;
          }
          return;
        }
        const q = new URLSearchParams({ url: m.url, kind: m.kind, name: fileName(m) });
        chrome.tabs.create({ url: chrome.runtime.getURL("download.html") + "?" + q.toString() });
      })
    );
  }

  actions.append(
    btn("Copiar URL", async () => {
      await navigator.clipboard.writeText(m.url);
      status.textContent = "URL copiada";
    }),
    status
  );

  el.append(title, url, actions);
  if (m.kind === "file") {
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

function renderVideo(v: VideoInfo): HTMLElement {
  const el = box();
  const label = v.kind === "blob" ? "blob (use a lista de rede)" : v.kind === "direct" ? "arquivo direto" : "sem src ainda";
  const title = document.createElement("b");
  title.textContent = `${v.width}x${v.height} • ${fmtTime(v.duration)} • ${label}`;
  const url = document.createElement("div");
  url.style.cssText = "color:#555;margin-top:4px";
  url.textContent = v.src ? v.src.slice(0, 120) : "(vazio)";
  el.append(title, url);
  return el;
}

async function main() {
  const dir = await loadDir().catch(() => null);
  const bar = folderBar(dir?.name ?? null);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) {
    list.textContent = "Aba não encontrada.";
    return;
  }
  tabTitle = tab.title ?? "";
  const vk = `videos:${tab.id}`;
  const mk = `media:${tab.id}`;
  const stored = await chrome.storage.session.get([vk, mk]);

  const frames = (stored[vk] ?? {}) as Record<string, VideoInfo[]>;
  const videos = Object.values(frames).flat();
  const media = Object.values((stored[mk] ?? {}) as Record<string, MediaInfo>).sort((a, b) => b.ts - a.ts);

  if (!videos.length && !media.length) {
    const empty = document.createElement("div");
    empty.textContent = "Nada encontrado. Dê play no vídeo e reabra o popup.";
    list.replaceChildren(bar, empty);
    return;
  }

  const nodes: HTMLElement[] = [bar, mergeBar()];
  if (media.length) nodes.push(heading(`Mídia detectada na rede (${media.length})`), ...media.map((m) => renderMedia(m, !!dir)));
  if (videos.length) nodes.push(heading(`Elementos <video> (${videos.length})`), ...videos.map(renderVideo));
  list.replaceChildren(...nodes);
}

main();



