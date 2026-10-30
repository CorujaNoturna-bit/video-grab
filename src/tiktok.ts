export interface TikTokVideoInfo {
  id: string;
  url: string;
  title?: string;
  author?: string;
}

export function extractTikTokFromDOM(): TikTokVideoInfo[] {
  const videos: TikTokVideoInfo[] = [];

  // 1. Tenta extrair a partir do script de hidratação (geralmente contém a melhor qualidade)
  const hydrationScript = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
  if (hydrationScript && hydrationScript.textContent) {
    try {
      const data = JSON.parse(hydrationScript.textContent);
      const defaultScope = data['__DEFAULT_SCOPE__'];
      const videoDetail = defaultScope?.['webapp.video-detail']?.itemInfo?.itemStruct;

      if (videoDetail?.video?.playAddr) {
        videos.push({
          id: videoDetail.id,
          url: videoDetail.video.playAddr,
          title: videoDetail.desc,
          author: videoDetail.author?.uniqueId,
        });
      }
    } catch (err) {
      console.warn('[VideoGrab] Falha ao fazer parse do script de hidratação do TikTok:', err);
    }
  }

  // 2. Busca de elementos <video> ativos no DOM
  if (videos.length === 0) {
    const videoElements = document.querySelectorAll<HTMLVideoElement>('video');
    videoElements.forEach((video, index) => {
      const src = video.currentSrc || video.src;
      if (src && !src.startsWith('blob:')) {
        videos.push({
          id: `dom-video-${index}`,
          url: src,
          title: document.title,
        });
      }
    });
  }

  return videos;
}