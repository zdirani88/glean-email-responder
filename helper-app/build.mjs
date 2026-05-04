import { copyFile, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await Promise.all([
  build({
    entryPoints: ["src/main.ts"],
    bundle: true,
    external: ["electron"],
    outfile: "dist/main.cjs",
    format: "cjs",
    platform: "node",
    target: "node22",
  }),
  build({
    entryPoints: ["src/preload.ts"],
    bundle: true,
    external: ["electron"],
    outfile: "dist/preload.cjs",
    format: "cjs",
    platform: "node",
    target: "node22",
  }),
  build({
    entryPoints: ["src/renderer.ts"],
    bundle: true,
    outfile: "dist/renderer.js",
    format: "iife",
    platform: "browser",
    target: "chrome120",
  }),
]);

await copyFile("src/index.html", "dist/index.html");
