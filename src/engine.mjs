// TokenLife 引擎宿主：jsdom 加载 tokenlife.me 线上 html 真跑（不重写引擎）。
// html 启动时拉线上缓存到 ~/.tokenlife-mcp/cache.html，拉不到用缓存，都没有给清晰报错。
// 未绑定身份时 localStorage 持久化到 ~/.tokenlife-mcp/storage.json（跨局图鉴/语料/转世账本活着）。
// 绑定伙伴身份的局由调用方传入独立 storagePath，避免多个 AI 共享同一本账。
import { JSDOM, VirtualConsole } from "jsdom";
import { chmodSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, ensurePrivateDir } from "./partner.mjs";

const DATA_DIR = join(homedir(), ".tokenlife-mcp");
const CACHE_PATH = join(DATA_DIR, "cache.html");
const STORAGE_PATH = join(DATA_DIR, "storage.json");
const GAME_URL = "https://tokenlife.me/index.html";

// 走跟伙伴目录同一个私有目录助手：建出来就是 0700，已经在的宽权限目录也当场收紧。
function ensureDir() { ensurePrivateDir(DATA_DIR); }

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
        writeFileSync(CACHE_PATH, html, { encoding: "utf8", mode: 0o600 });
        // mode 只在新建文件时生效，旧缓存是宽权限的话要显式收回来。
        chmodSync(CACHE_PATH, 0o600);
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

export function loadStorage(storagePath = STORAGE_PATH) {
  if (!existsSync(storagePath)) return {};
  try {
    return JSON.parse(readFileSync(storagePath, "utf8"));
  } catch (e) {
    throw new Error(`storage 解析失败 ${storagePath}: ${(e && e.message) || String(e)}`);
  }
}
function saveStorage(obj, storagePath = STORAGE_PATH) {
  atomicWriteJson(storagePath, obj);
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
export function persist(window, storagePath = STORAGE_PATH) {
  let ls;
  try {
    ls = window.localStorage;
  } catch { /* 无 localStorage 时不持久，不崩 */ }
  if (!ls) return;
  const out = {};
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    out[k] = ls.getItem(k);
  }
  saveStorage(out, storagePath);
}

export { DATA_DIR, CACHE_PATH, STORAGE_PATH, GAME_URL };
