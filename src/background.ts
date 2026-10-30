import type { VideoInfo, MediaInfo, MediaKind } from "./types";

type FrameMap = Record<number, VideoInfo[]>;
type MediaMap = Record<string, MediaInfo>;

const vKey = (tabId: number) => `videos:${tabId}`;
const mKey = (tabId: number) => `media:${tabId}`;
const MAX_MEDIA_PER_TAB = 50;
const MIN_FILE_SIZE = 20_000; // ignora arquivos pequenos (segmentos, previews)

// fila para evitar corrida de leitura/escrita no storage
let queue: Promise<void> = Promise.resolve();
function enqueue(fn: () => Promise<void>) {
  queue = queue.then(fn).catch((e) => console.error("[VideoGrabber]", e));
}

async function updateBadge(tabId: number) {
  const s = await chrome.storage.session.get([vKey(tabId), mKey(tabId)]);
  const frames = (s[vKey(tabId)] ?? {}) as FrameMap;
  const media = (s[mKey(tabId)] ?? {}) as MediaMap;
  const nVideos = Object.values(frames).reduce((n, l) => n + l.length, 0);
  const nMedia = Object.keys(media).length;
  const total = Math.max(nVideos, nMedia);
  await chrome.action.setBadgeText({ tabId, text: total ? String(total) : "" });
}

// --- vídeos vindos do content script ---
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "videos" || sender.tab?.id == null) return;
  const tabId = sender.tab.id;
  const frameId = sender.frameId ?? 0;

  enqueue(async () => {
    const stored = await chrome.storage.session.get(vKey(tabId));
    const data = (stored[vKey(tabId)] ?? {}) as FrameMap;
    data[frameId] = msg.videos as VideoInfo[];
    await chrome.storage.session.set({ [vKey(tabId)]: data });
    await updateBadge(tabId);
  });
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    const isTikTokVideo = 
      (url.includes('tiktokcdn.com') || url.includes('byteoversea.com')) &&
      (url.includes('/video/') || url.includes('.mp4') || details.type === 'media');

    if (isTikTokVideo && details.tabId >= 0) {
      console.log('[VideoGrab] Vídeo TikTok interceptado:', url);

      // Aqui você envia a URL para o seu store local ou avisa o popup
      // Exemplo:
      // store.addVideo(details.tabId, { url, type: 'mp4', source: 'tiktok' });
    }
  },
  { urls: ['*://*.tiktok.com/*', '*://*.tiktokcdn.com/*', '*://*.byteoversea.com/*'] }
);

// --- mídia detectada na rede ---
function classify(url: string, mime: string): MediaKind | null {
  const m = mime.toLowerCase();
  const path = new URL(url).pathname.toLowerCase();
  
  if (m.includes("mpegurl") || path.endsWith(".m3u8")) return "hls";
  if (m.includes("dash+xml") || path.endsWith(".mpd")) return "dash";
  if (m === "video/mp2t" || path.endsWith(".m4s")) return null; // segmentos isolados
  
  // Trata arquivos de mídia diretos
  if (m.startsWith("video/") || m.startsWith("audio/") || m === "application/octet-stream") {
    if (/\.(mp4|m4a|webm|m4v|mov|mkv)$/.test(path) || url.includes(".fbcdn.net/") || url.includes(".cdninstagram.com/")) {
      return "file";
    }
  }
  
  if (/\.(mp4|webm|m4v|mov|mkv|m4a)$/.test(path)) return "file";
  return null;
}

function headerValue(headers: chrome.webRequest.HttpHeader[], name: string) {
  return headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";
}

function getSize(headers: chrome.webRequest.HttpHeader[]) {
  const range = headerValue(headers, "content-range").match(/\/(\d+)$/);
  if (range) return Number(range[1]);
  return Number(headerValue(headers, "content-length")) || 0;
}

function normalize(url: string) {
  const u = new URL(url);
  for (const p of ["range", "rn", "rbuf", "bytestart", "byteend"]) u.searchParams.delete(p);
  return u.toString();
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0) return;
    if (d.statusCode !== 200 && d.statusCode !== 206) return;

    const headers = d.responseHeaders ?? [];
    const mime = headerValue(headers, "content-type").split(";")[0].trim();

    let kind: MediaKind | null;
    let url: string;
    try {
      kind = classify(d.url, mime);
      url = normalize(d.url);
    } catch {
      return;
    }
    if (!kind) return;

    const size = getSize(headers);
    if (kind === "file" && size && size < MIN_FILE_SIZE) return;

    const tabId = d.tabId;
    enqueue(async () => {
      const stored = await chrome.storage.session.get(mKey(tabId));
      const data = (stored[mKey(tabId)] ?? {}) as MediaMap;

      const prev = data[url];
      data[url] = { url, kind: kind!, mime, size: Math.max(size, prev?.size ?? 0), ts: prev?.ts ?? Date.now() };

      const entries = Object.entries(data).sort((a, b) => b[1].ts - a[1].ts).slice(0, MAX_MEDIA_PER_TAB);
      await chrome.storage.session.set({ [mKey(tabId)]: Object.fromEntries(entries) });
      await updateBadge(tabId);
    });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"]
);

// --- limpeza ---
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") {
    chrome.storage.session.remove([vKey(tabId), mKey(tabId)]);
    chrome.action.setBadgeText({ tabId, text: "" });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([vKey(tabId), mKey(tabId)]);
});

// Injeta o Referer do TikTok automaticamente para evitar HTTP 403 nas CDNs
// Registra/atualiza as regras do DeclarativeNetRequest para contornar proteções de CDN (TikTok, etc.)
async function setupNetRules() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1001],
    addRules: [
      {
        id: 1001,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [
            {
              header: "Referer",
              operation: chrome.declarativeNetRequest.HeaderOperation.SET,
              value: "https://www.tiktok.com/",
            },
            {
              header: "Origin",
              operation: chrome.declarativeNetRequest.HeaderOperation.SET,
              value: "https://www.tiktok.com",
            },
          ],
        },
        condition: {
          urlFilter: "*",
          requestDomains: [
            "tiktok.com",          // <-- Crucial: seu vídeo vem de v16-webapp-prime.tiktok.com
            "tiktokcdn.com",
            "tiktokcdn-us.com",
            "byteoversea.com",
            "ibytedtos.com",
            "muscdn.com",
          ],
          resourceTypes: [
            chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
            chrome.declarativeNetRequest.ResourceType.MEDIA,
            chrome.declarativeNetRequest.ResourceType.OTHER,
          ],
        },
      },
    ],
  });
  console.log("[VideoGrabber] Regras de cabeçalho do TikTok ativadas.");
}

chrome.runtime.onInstalled.addListener(setupNetRules);
setupNetRules();