import { copyFile, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await Promise.all([
  build({
    entryPoints: ["src/contentScript.ts"],
    bundle: true,
    outfile: "dist/contentScript.js",
    format: "iife",
    target: "chrome120",
  }),
  build({
    entryPoints: ["src/background.ts"],
    bundle: true,
    outfile: "dist/background.js",
    format: "esm",
    target: "chrome120",
  }),
  build({
    entryPoints: ["src/options.ts"],
    bundle: true,
    outfile: "dist/options.js",
    format: "iife",
    target: "chrome120",
  }),
]);

await Promise.all([
  copyFile("manifest.json", "dist/manifest.json"),
  copyFile("src/options.html", "dist/options.html"),
]);
