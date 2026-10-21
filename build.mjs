import { build, context } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/ffmpeg", { recursive: true });
cpSync("public", "dist", { recursive: true });

// ffmpeg.wasm: worker da classe + núcleo (single-thread)
cpSync("node_modules/@ffmpeg/ffmpeg/dist/esm", "dist/ffmpeg", { recursive: true });
cpSync("node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js", "dist/ffmpeg/ffmpeg-core.js");
cpSync("node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm", "dist/ffmpeg/ffmpeg-core.wasm");

const options = {
  entryPoints: {
    background: "src/background.ts",
    content: "src/content.ts",
    popup: "src/popup.ts",
    download: "src/download.ts",
    options: "src/options.ts",
  },
  outdir: "dist",
  bundle: true,
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
