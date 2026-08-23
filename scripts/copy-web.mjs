// Copies the static web app into www/ for Capacitor (webDir = "www").
// Keeps the source files at the repo root so GitHub Pages still serves them.
import { mkdir, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const FILES = [
  "index.html",
  "app.js",
  "style.css",
  "manifest.json",
  "sw.js",
  "version.json",
  "icon.svg",
  "favicon-64.png",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png",
];

await rm("www", { recursive: true, force: true });
await mkdir("www", { recursive: true });

let copied = 0;
for (const f of FILES) {
  if (existsSync(f)) {
    await copyFile(f, "www/" + f);
    copied++;
  }
}
console.log(`Copied ${copied} files to www/`);
