#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadHtml, bootEngine, loadStorage } from "../src/engine.mjs";
import { engineVersionFromHtml, extractEndingKeys } from "../src/ending-keys.mjs";

const outPath = resolve("docs/ending-keys.json");
const { html, source, liveErr } = await loadHtml();
const dom = bootEngine(html, loadStorage());
try {
  const payload = {
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    source,
    live_error: liveErr || null,
    engine_version: engineVersionFromHtml(html) || null,
    endings: extractEndingKeys(dom.window),
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.error(`[tokenlife-mcp] wrote ${outPath} (${payload.endings.length} endings)`);
} finally {
  dom.window.close();
}
