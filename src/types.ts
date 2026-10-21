export interface VideoInfo {
  src: string;
  kind: "direct" | "blob" | "none";
  duration: number;
  width: number;
  height: number;
  poster: string;
  frameUrl: string;
}

export type MediaKind = "file" | "hls" | "dash";

export interface MediaInfo {
  url: string;
  kind: MediaKind;
  mime: string;
  size: number;
  ts: number;
}
