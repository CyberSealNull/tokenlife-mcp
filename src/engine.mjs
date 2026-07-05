// TokenLife 引擎宿主：jsdom 加载 tokenlife.me 线上 html 真跑（不重写引擎）。
// html 启动时拉线上缓存到 ~/.tokenlife-mcp/cache.html，拉不到用缓存，都没有给清晰报错。
// localStorage 持久化到 ~/.tokenlife-mcp/storage.json（跨局图鉴/语料/转世账本活着）。
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DATA_DIR = join(homedir(), ".tokenlife-mcp");
const CACHE_PATH = join(DATA_DIR, "cache.html");
const STORAGE_PATH = join(DATA_DIR, "storage.json");
const GAME_URL = "https://tokenlife.me/index.html";

function ensureDir() { mkdirSync(DATA_DIR, { recursive: true }); }

// 拉线上 html，成功则刷新缓存；失败回退缓存；都没有抛清晰错误。
export async function loadHtml() {
  ensureDir();
  let liveErr = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    const res = await fetch(GAME_URL + "?cb=" + Date.now(), { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const html = await res.text();
      // sanity：确认是游戏 html 不是错误页/CDN 卡 building
      if (html.includes("newGame") && html.includes("tokenlife") && html.length > 50000) {
        writeFileSync(CACHE_PATH, html, "utf8");
        return { html, source: "live" };
      }
      liveErr = `线上返回的不像游戏 html（长度 ${html.length}），可能 Pages 在 building`;
    } else {
      liveErr = `HTTP ${res.status}`;
    }
  } catch (e) {
    liveErr = e && e.name === "AbortError" ? "请求超时" : (e && e.message) || String(e);
  }
  if (existsSync(CACHE_PATH)) {
    return { html: readFileSync(CACHE_PATH, "utf8"), source: "cache", liveErr };
  }
  throw new Error(
    `拉不到 tokenlife.me（${liveErr}）且本地无缓存 ${CACHE_PATH}。` +
    `请先联网跑一次让它缓存，或检查网络后重试。`
  );
}

export function loadStorage() {
  if (existsSync(STORAGE_PATH)) {
    try { return JSON.parse(readFileSync(STORAGE_PATH, "utf8")); } catch { return {}; }
  }
  return {};
}
function saveStorage(obj) {
  ensureDir();
  writeFileSync(STORAGE_PATH, JSON.stringify(obj, null, 2), "utf8");
}

// 一个连接一个 jsdom 实例（单人生）。seedStorage 在 boot 读 localStorage 前注入。
export function bootEngine(html, seedStorage) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", () => {}); // 吞掉 window.scrollTo 之类无头浏览器不支持的（真浏览器正常）
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://tokenlife.me/",
    virtualConsole: vc,
    beforeParse(window) {
      try {
        for (const [k, v] of Object.entries(seedStorage || {})) {
          if (v != null) window.localStorage.setItem(k, String(v));
        }
      } catch { /* localStorage 不可用时静默，游戏自己也 try/catch */ }
    },
  });
  return dom;
}

// 把当前 jsdom 的 localStorage 落回 storage.json（跨局账本持久）
export function persist(window) {
  try {
    const ls = window.localStorage;
    const out = {};
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      out[k] = ls.getItem(k);
    }
    saveStorage(out);
  } catch { /* 无 localStorage 时不持久，不崩 */ }
}

export { DATA_DIR, CACHE_PATH, STORAGE_PATH, GAME_URL };
