export interface VideoInfo {
  src: string;
  kind: "direct" | "blob" | "none";
  duration: number;
  width: number;
  height: number;
  poster: string;
  frameUrl: string;
  playing: boolean;
  inView: boolean;
}

export type MediaKind = "file" | "hls" | "dash";

export interface MediaInfo {
  url: string;
  kind: MediaKind;
  mime: string;
  size: number;
  ts: number;
}

export interface ProbeInfo {
  role: "video" | "audio" | "both" | "unknown";
  duration: number; // segundos (0 = desconhecida)
  width: number;
  height: number;
}
