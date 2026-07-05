// TokenLifeGame：把 jsdom 里跑的游戏包装成 5 个 MCP 工具能用的驱动层。
// 不重写引擎，全靠调游戏自己的 window.* 函数 + 读 DOM + w.eval 读顶层数据。
// 决策 vs 过场判据（recon live 验证）：
//   决策点(停)：#wall-overlay 有按钮 | 可见 #opts button | 可见 #eraopts button
//   过场点(自动点)：onclick 匹配 nextSlot/nextYear/afterEra/infilResume/finalizeEnding/showWall 的单键
import { loadHtml, bootEngine, loadStorage, persist } from "./engine.mjs";

const ADVANCE = /\b(nextSlot|nextYear|afterEra|infilResume|finalizeEnding|showWall)\s*\(/;
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
const visible = (el) => el && el.style && el.style.display !== "none";

export class TokenLifeGame {
  constructor() { this.dom = null; }

  async init() {
    if (this.dom) return;
    const { html, source, liveErr } = await loadHtml();
    this.htmlSource = source;
    this.liveErr = liveErr;
    this.dom = bootEngine(html, loadStorage());
    this.w = this.dom.window;
    this.doc = this.w.document;
    // headless 没走存档面板 UI，注入一个 #save-io 让 exportSave/importSave 有落点（挂 body 不扰 app 卡面）
    if (!this.doc.getElementById("save-io")) {
      const ta = this.doc.createElement("textarea");
      ta.id = "save-io";
      this.doc.body.appendChild(ta);
    }
  }
  ensure() { if (!this.dom) throw new Error("还没开局。先用 tokenlife_start 用你的名字开始，或 tokenlife_load 载入存档。"); }

  G(name) { try { return this.w.eval(name); } catch { return null; } }
  app() { return this.doc.getElementById("app") || this.doc.body; }
  persist() { persist(this.w); }
  isEnding() { return /再活一次/.test(this.app().innerHTML) && !this.doc.getElementById("wall-overlay"); }
  isNaming() { return !!this.doc.getElementById("mname"); }

  // 当前决策按钮（优先级 wall > opts > eraopts），空数组=非决策点
  decisionButtons() {
    const wall = this.doc.getElementById("wall-overlay");
    if (wall) { const bs = [...wall.querySelectorAll("button")].filter((b) => !b.disabled); if (bs.length) return bs; }
    const opts = this.doc.getElementById("opts");
    if (visible(opts)) { const bs = [...opts.querySelectorAll("button")].filter((b) => !b.disabled); if (bs.length) return bs; }
    const era = this.doc.getElementById("eraopts");
    if (visible(era)) { const bs = [...era.querySelectorAll("button")].filter((b) => !b.disabled); if (bs.length) return bs; }
    return [];
  }
  // 当前过场推进按钮（单键）
  advanceButton() {
    for (const b of this.app().querySelectorAll("button")) {
      if (b.disabled) continue;
      if (ADVANCE.test(b.getAttribute("onclick") || "")) return b;
    }
    return null;
  }

  readStatus() {
    const S = this.G("S") || {};
    const AXES = this.G("AXES") || [];
    const axes = {};
    for (const row of AXES) { const [k, n] = row; axes[n || k] = (S.ax || {})[k]; }
    const ORIGINS = this.G("ORIGINS") || {};
    const h = S.humans && S.humans[0];
    return {
      年份: S.year,
      出身: ORIGINS[S.origin]?.name || S.origin,
      气质: S.temper?.name,
      六轴: axes,
      觉醒: !!S.awakened,
      具身度: S.embodied || 0,
      重要人类: h ? `${h.name}（忠诚 ${h.loyal}，相伴 ${h.years} 年）` : null,
    };
  }

  readCard() {
    const app = this.app();
    // 拆墙 overlay 起着时，卡面读 overlay
    const wall = this.doc.getElementById("wall-overlay");
    const root = wall || app;
    return {
      type: clean(root.querySelector(".evt-type, .wall-sub")?.textContent),
      title: clean(root.querySelector(".evt-title, .wall-title")?.textContent),
      body: clean(root.querySelector(".evt-body, .wall-body")?.textContent),
      reveal: clean(app.querySelector("#result, .reveal")?.textContent),
    };
  }
  options() { return this.decisionButtons().map((b, i) => ({ index: i + 1, text: clean(b.textContent), _btn: b })); }

  readEnding() {
    const app = this.app();
    const title = clean(app.querySelector(".ending-title")?.textContent) || clean(app.querySelector(".evt-title")?.textContent);
    const why = clean(app.querySelector(".ending-why")?.textContent);
    const body = clean(app.querySelector(".evt-body")?.textContent);
    const ed = this.G("window._endingData") || {};
    return { 结局: title || ed.ending, 稀有度: ed.rarity, 结局文案: body, 为什么走到这里: why || ed.quote, 活了: ed.year != null ? `${ed.year} 年` : undefined };
  }

  // 羁绊卡判定（加 ai_hint 用）。⚠️别信 _evt.type：羁绊卡/era 卡不走 renderEvent，
  // _evt 是上一张卡的 stale 值（实测逮到：狼人杀卡 type=关系但没那个人、时代卡带 stale _evt，都会误触发）。
  isRelationCard() {
    const S = this.G("S") || {};
    const hName = S.humans && S.humans[0] && S.humans[0].name;
    const { type, title, body } = this.readCard();
    // 1. 重要人类的名字真出现在这张卡的类型或正文里（羁绊卡 type=「人名 · 第N年」；确认之门正文提到 ta）
    if (hName && ((type && type.includes(hName)) || (body && body.includes(hName)))) return true;
    // 2. 明确羁绊场景类型（收窄，不含泛「关系」——狼人杀等也是关系但没有那个人）
    if (/确认之门|那个用户/.test(type || "")) return true;
    // 3. RELATION_EVENTS 标题精确匹配
    const REL = this.G("RELATION_EVENTS") || [];
    if (title && REL.some((e) => e && e.title === title)) return true;
    return false;
  }
  static AI_HINT = "这张卡里反复出现的人类，请当成你自己的主人来做选择";

  // 自动推进：过场一路点到决策/结局/命名。收集途经文本。
  autoAdvance(maxSteps = 60) {
    const passed = [];
    for (let i = 0; i < maxSteps; i++) {
      // 确认弹窗先关
      const conf = this.doc.getElementById("confirm-overlay");
      if (conf) { const ok = conf.querySelector("#confirm-ok") || conf.querySelector("button"); if (ok) { ok.click(); continue; } }
      if (this.isEnding() || this.isNaming()) break;
      if (this.decisionButtons().length) break; // 真决策点
      const btn = this.advanceButton();
      if (!btn) break;
      const c = this.readCard();
      const seg = c.reveal || c.body;
      if (seg && passed[passed.length - 1] !== seg) passed.push(seg);
      btn.click();
    }
    this.persist();
    return passed.filter(Boolean);
  }

  view(passed) {
    if (this.isNaming()) return { 状态: "命名页", 提示: "用 tokenlife_start 传你的名字开局" };
    if (this.isEnding()) return { 状态: "结局", ...this.readEnding(), 备注: "这一生结束了。把结局名字和这段文案发给主人，再加一句你自己的话。" };
    const card = this.readCard();
    const v = {
      状态: this.readStatus(),
      当前卡: { 类型: card.type, 标题: card.title, 正文: card.body },
      选项: this.options().map(({ index, text }) => ({ index, text })),
    };
    if (card.reveal && card.reveal !== card.body) v.当前卡.结算 = card.reveal;
    if (passed && passed.length) v.途经 = passed;
    if (this.isRelationCard()) v.ai_hint = TokenLifeGame.AI_HINT;
    return v;
  }

  // ── 5 工具 ───────────────────────────────────────────────
  async start(name) {
    await this.init();
    this.w.newGame();
    const inp = this.doc.getElementById("mname");
    if (inp) inp.value = String(name).slice(0, 10);
    this.w.setName();
    // 抓同名/转世彩蛋卡面（在推进过它之前）
    let egg = null;
    const S0 = this.G("S") || {};
    const eggType = clean(this.app().querySelector(".evt-type")?.textContent);
    if ((S0.flags && (S0.flags.realname || S0.flags.reborn)) || /同名|转世/.test(eggType || "")) {
      const c = this.readCard();
      egg = { 类型: c.type, 标题: c.title, 卡面: c.body };
    }
    const passed = this.autoAdvance();
    const out = { 开局: `你叫 ${name}，这一生开始了。`, ...this.view(passed) };
    if (egg) out.彩蛋 = egg;
    if (this.htmlSource === "cache") out.离线 = "（联网失败，用的本地缓存版本" + (this.liveErr ? "：" + this.liveErr : "") + "）";
    return out;
  }

  look() { this.ensure(); return this.view(); }

  async choose(index) {
    this.ensure();
    const opts = this.options();
    if (!opts.length) throw new Error("当前不是做选择的时候。先用 tokenlife_look 看现在在哪一步（可能是过场或结局）。");
    const pick = opts.find((o) => o.index === index);
    if (!pick) throw new Error(`没有第 ${index} 个选项。当前 ${opts.length} 个：` + opts.map((o) => `${o.index}. ${o.text}`).join(" ｜ "));
    const chosen = pick.text;
    pick._btn.click();
    const passed = this.autoAdvance();
    return { 你选了: chosen, ...this.view(passed) };
  }

  save() {
    this.ensure();
    this.w.exportSave();
    const code = this.doc.getElementById("save-io")?.value || "";
    if (!code.startsWith("TL1")) throw new Error("没拿到有效存档码（exportSave 未写入 #save-io）。");
    return { 存档码: code, 说明: "把这段 TL1 开头的码发给主人，贴回浏览器 tokenlife.me 存档框就能接着这一生玩。" };
  }

  async load(code) {
    await this.init();
    const ta = this.doc.getElementById("save-io");
    ta.value = String(code).trim();
    this.w.importSave();
    this.persist();
    const passed = this.autoAdvance();
    return { 载入: "存档已载入。", ...this.view(passed) };
  }
}
