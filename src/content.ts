import type { VideoInfo } from "./types";

function describe(v: HTMLVideoElement): VideoInfo {
  const src = v.currentSrc || v.src || v.querySelector("source")?.src || "";
  const r = v.getBoundingClientRect();
  const cy = r.top + r.height / 2;
  const cx = r.left + r.width / 2;
  const inView = r.width > 0 && r.height > 0 && cy >= 0 && cy <= window.innerHeight && cx >= 0 && cx <= window.innerWidth;

  return {
    src,
    kind: src.startsWith("blob:") ? "blob" : src ? "direct" : "none",
    duration: Number.isFinite(v.duration) ? v.duration : 0,
    width: v.videoWidth,
    height: v.videoHeight,
    poster: v.poster,
    frameUrl: location.href,
    playing: !v.paused && !v.ended,
    inView,
  };
}

export interface VideoItem {
  id: string;
  url: string;
  title: string;
  duration?: number; // em segundos
  size?: number;     // em bytes
}

export function detectTikTokVideos(): VideoItem[] {
  const items: VideoItem[] = [];

  const scriptTag = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
  if (scriptTag?.textContent) {
    try {
      const data = JSON.parse(scriptTag.textContent);
      const detail = data['__DEFAULT_SCOPE__']?.['webapp.video-detail']?.itemInfo?.itemStruct;

      if (detail?.video?.playAddr) {
        items.push({
          id: detail.id,
          url: detail.video.playAddr,
          title: detail.desc || `TikTok por @${detail.author?.uniqueId || 'video'}`,
          duration: detail.video.duration || 0 // vem em segundos
        });
        return items;
      }
    } catch (e) {
      console.warn('Erro ao extrair JSON do TikTok:', e);
    }
  }

  const videoElements = document.querySelectorAll<HTMLVideoElement>('video');
  videoElements.forEach((video, index) => {
    const src = video.currentSrc || video.src;
    if (src && !src.startsWith('blob:')) {
      // Tenta obter o texto da legenda na interface atual
      const descriptionEl = document.querySelector('h1[data-e2e="browse-video-desc"], [data-e2e="user-post-item-desc"]');
      const pageTitle = descriptionEl?.textContent?.trim() || document.title;

      items.push({
        id: `tt-${index}`,
        url: src,
        title: pageTitle.replace(/[\/\\?%*:|"<>]/g, '_').slice(0, 50),
        duration: Math.round(video.duration || 0)
      });
    }
  });

  return items;
}

let last = "[]";

function scan() {
  const videos = Array.from(document.querySelectorAll("video")).map(describe);
  const json = JSON.stringify(videos);
  if (json === last) return;
  last = json;
  try {
    chrome.runtime.sendMessage({ type: "videos", videos }).catch(() => {});
  } catch {
    // extensão foi recarregada; ignora
  }
}

let timer: number | undefined;
function schedule() {
  clearTimeout(timer);
  timer = window.setTimeout(scan, 300);
}

new MutationObserver(schedule).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src"],
});

for (const ev of ["loadedmetadata", "durationchange", "play", "playing", "pause", "ended"]) {
  document.addEventListener(ev, schedule, true);
}
window.addEventListener("scroll", schedule, { passive: true, capture: true });
window.addEventListener("resize", schedule, { passive: true });

scan();
