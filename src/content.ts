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

// eventos de mídia não "borbulham", então usamos captura
for (const ev of ["loadedmetadata", "durationchange", "play", "playing", "pause", "ended"]) {
  document.addEventListener(ev, schedule, true);
}
window.addEventListener("scroll", schedule, { passive: true, capture: true });
window.addEventListener("resize", schedule, { passive: true });

scan();
