import type { VideoInfo } from "./types";

function describe(v: HTMLVideoElement): VideoInfo {
  const src = v.currentSrc || v.src || v.querySelector("source")?.src || "";
  return {
    src,
    kind: src.startsWith("blob:") ? "blob" : src ? "direct" : "none",
    duration: Number.isFinite(v.duration) ? v.duration : 0,
    width: v.videoWidth,
    height: v.videoHeight,
    poster: v.poster,
    frameUrl: location.href,
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
document.addEventListener("loadedmetadata", schedule, true);
document.addEventListener("durationchange", schedule, true);

scan();
