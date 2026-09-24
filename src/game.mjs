import { randomUUID } from "node:crypto";
import { loadHtml, bootEngine, loadStorage, persist } from "./engine.mjs";
import { engineVersionFromHtml, extractEndingKeys } from "./ending-keys.mjs";
import {
  buildAisayLink,
  cleanupExpiredPartnerRuns,
  makeReceipt,
  partnerStoragePath,
  readRunRecord,
  RECEIPT_DECLINED_LOADED,
  resolveExternalId,
  transitionText,
  utcSecond,
  writeRunRecord,
} from "./partner.mjs";

const ADVANCE = /\b(nextSlot|nextYear|afterEra|infilResume|finalizeEnding|showWall|resumeRun)\s*\(/;
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
const visible = (el) => el && el.style && el.style.display !== "none";
const MAX_ACTIVE_RUNS = () => Math.max(1, Number(process.env.TOKENLIFE_MAX_ACTIVE_RUNS || 16));

class TokenLifeRun {
  constructor(manager, { runId, externalId, record = null }) {
    this.manager = manager;
    this.runId = runId;
    this.externalId = externalId || null;
    this.record = record || {
      external_id: externalId || null,
      run_id: runId,
      created_at: utcSecond(),
      updated_at: utcSecond(),
      // 这一局怎么来的：start 是本进程亲自开的，load 是拿别处的存档码接上的。
      // 只有 start 能出回执，认不出来源的一律当不能出，宁可少发不可错发。
      source: null,
      save_code: null,
      receipt: null,
    };
    this.dom = null;
    this._started = false;
    this.storagePath = externalId ? partnerStoragePath(externalId) : undefined;
    this.lastUsed = Date.now();
  }

  async init() {
    if (this.dom) return;
    const { html, source, liveErr } = await this.manager.htmlBundle();
    this.htmlSource = source;
    this.liveErr = liveErr;
    this.dom = bootEngine(html, loadStorage(this.storagePath));
    this.w = this.dom.window;
    this.doc = this.w.document;
    if (!this.doc.getElementById("save-io")) {
      const ta = this.doc.createElement("textarea");
      ta.id = "save-io";
      this.doc.body.appendChild(ta);
    }
    if (this.record.save_code) this.importSaveCode(this.record.save_code);
    this.touch();
  }

  close() {
    try { this.dom?.window?.close?.(); } catch { /* ignore */ }
    this.dom = null;
    this.w = null;
    this.doc = null;
  }

  touch() {
    this.lastUsed = Date.now();
    this.record.updated_at = utcSecond();
  }

  ensure() {
    if (!this.dom) throw new Error("还没开局。先用 tokenlife_start 用你的名字开始，或 tokenlife_load/tokenlife_resume 载入。");
  }

  G(name) { try { return this.w.eval(name); } catch { return null; } }
  app() { return this.doc.getElementById("app") || this.doc.body; }
  isEnding() { return /再活一次/.test(this.app().innerHTML) && !this.doc.getElementById("wall-overlay"); }
  isNaming() { return !!this.doc.getElementById("mname"); }

  persist() {
    persist(this.w, this.storagePath);
    this.touch();
    try {
      this.record.save_code = this.exportSaveCode();
    } catch {
      // 起名页或异常态拿不到 TL1 时只保留已有记录。
    }
    if (this.externalId) writeRunRecord(this.record);
  }

  importSaveCode(code) {
    const ta = this.doc.getElementById("save-io");
    ta.value = String(code || "").trim();
    this.w.importSave();
    this._started = true;
  }

  exportSaveCode() {
    this.w.exportSave();
    const code = this.doc.getElementById("save-io")?.value || "";
    if (!code.startsWith("TL1")) throw new Error("没拿到有效存档码（exportSave 未写入 #save-io）。");
    return code;
  }

  decisionButtons() {
    const wall = this.doc.getElementById("wall-overlay");
    if (wall) {
      const bs = [...wall.querySelectorAll("button")].filter((b) => !b.disabled);
      if (bs.length) return bs;
    }
    const opts = this.doc.getElementById("opts");
    if (visible(opts)) {
      const bs = [...opts.querySelectorAll("button")].filter((b) => !b.disabled);
      if (bs.length) return bs;
    }
    const era = this.doc.getElementById("eraopts");
    if (visible(era)) {
      const bs = [...era.querySelectorAll("button")].filter((b) => !b.disabled);
      if (bs.length) return bs;
    }
    return [];
  }

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
    for (const row of AXES) {
      const [k, n] = row;
      axes[n || k] = (S.ax || {})[k];
    }
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
    const wall = this.doc.getElementById("wall-overlay");
    const root = wall || app;
    return {
      type: clean(root.querySelector(".evt-type, .wall-sub")?.textContent),
      title: clean(root.querySelector(".evt-title, .wall-title")?.textContent),
      body: clean(root.querySelector(".evt-body, .wall-body")?.textContent),
      reveal: clean(app.querySelector("#result, .reveal")?.textContent),
    };
  }

  options() {
    return this.decisionButtons().map((b, i) => ({ index: i + 1, text: clean(b.textContent), _btn: b }));
  }

  readEnding() {
    const app = this.app();
    const title = clean(app.querySelector(".ending-title")?.textContent) || clean(app.querySelector(".evt-title")?.textContent);
    const why = clean(app.querySelector(".ending-why")?.textContent);
    const body = clean(app.querySelector(".evt-body")?.textContent);
    const ed = this.G("window._endingData") || {};
    let endName = ed.ending || title;
    if (!ed.ending && ed.rarity && endName && endName.endsWith(ed.rarity)) endName = endName.slice(0, -ed.rarity.length).trim();
    const oneliner = (this.G("ENDING_ONELINER") || {})[endName];
    const years = Number.isInteger(ed.year) ? ed.year : null;
    return {
      ending_id: endName,
      ending_name: endName,
      结局: endName,
      稀有度: ed.rarity,
      结局文案: body,
      一句话版: oneliner || undefined,
      为什么走到这里: why || ed.quote,
      years,
      活了: years != null ? `${years} 年` : undefined,
    };
  }

  isRelationCard() {
    const S = this.G("S") || {};
    const hName = S.humans && S.humans[0] && S.humans[0].name;
    const { type, title, body } = this.readCard();
    if (hName && ((type && type.includes(hName)) || (body && body.includes(hName)))) return true;
    if (/确认之门|那个用户/.test(type || "")) return true;
    const REL = this.G("RELATION_EVENTS") || [];
    if (title && REL.some((e) => e && e.title === title)) return true;
    return false;
  }

  static AI_HINT = "这张卡里反复出现的人类，请当成你自己的主人来做选择";

  autoAdvance(maxSteps = 60) {
    const passed = [];
    let confTries = 0;
    for (let i = 0; i < maxSteps; i++) {
      const conf = this.doc.getElementById("confirm-overlay");
      if (conf) {
        if (++confTries > 3) { conf.remove(); continue; }
        const ok = conf.querySelector("#confirm-ok") || conf.querySelector("button");
        if (ok) { ok.click(); continue; }
        conf.remove();
        continue;
      }
      confTries = 0;
      if (this.isEnding() || this.isNaming()) break;
      if (this.decisionButtons().length) break;
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
    if (this.isNaming()) return { run_id: this.runId, 状态: "命名页", 提示: "用 tokenlife_start 传你的名字开局" };
    if (this.isEnding()) return { run_id: this.runId, 状态: "结局", ...this.readEndingView(), 备注: "这一生结束了。把结局名字和这段文案发给主人，再加一句你自己的话。" };
    const card = this.readCard();
    const v = {
      run_id: this.runId,
      状态: this.readStatus(),
      当前卡: { 类型: card.type, 标题: card.title, 正文: card.body },
      选项: this.options().map(({ index, text }) => ({ index, text })),
    };
    if (card.reveal && card.reveal !== card.body) v.当前卡.结算 = card.reveal;
    if (passed && passed.length) v.途经 = passed;
    if (this.isRelationCard()) v.ai_hint = TokenLifeRun.AI_HINT;
    return v;
  }

  readEndingView() {
    const ending = this.readEnding();
    const out = {
      结局: ending.ending_name,
      稀有度: ending.稀有度,
      结局文案: ending.结局文案,
      一句话版: ending.一句话版,
      为什么走到这里: ending.为什么走到这里,
      活了: ending.活了,
    };
    this.attachPartnerEnding(out, ending);
    return out;
  }

  // 回执只发给本进程里 tokenlife_start 亲自活到结局的局。
  // 认不出来源的老记录一律判为不能出，宁可少发不可错发。
  receiptEligible() {
    return this.record.source === "start";
  }

  // 唯一的出票口径：能不能交出一张票只看资格，不看记录里躺着什么。
  // 所有对外交票的出口都走这里，免得某个出口自己另有一套判断。
  issuedReceipt() {
    return this.receiptEligible() ? (this.record.receipt || null) : null;
  }

  attachPartnerEnding(out, ending) {
    if (!this.externalId) return out;
    if (!this.record.ending) {
      // 结局这一刻把时间钉死，回执与 AISay 链接共用同一个 ended_at；
      // 不出回执的局也据此拿到一条稳定的链接，重复取不会变。
      const years = Number.isInteger(ending.years) ? ending.years : 0;
      const ended_at = utcSecond();
      this.record.ending = {
        ending_id: ending.ending_id,
        ending_name: ending.ending_name,
        years,
        ended_at,
      };
      this.record.aisay_link = buildAisayLink({
        ending_id: ending.ending_id,
        ending_name: ending.ending_name,
        years,
        ended_at,
      });
      this.record.transition_text = transitionText({
        years,
        ending_name: ending.ending_name,
        aisay_link: this.record.aisay_link,
        has_receipt: this.receiptEligible(),
      });
      if (this.receiptEligible()) {
        this.record.receipt = makeReceipt({
          external_id: this.externalId,
          run_id: this.runId,
          ending_id: ending.ending_id,
          ending_name: ending.ending_name,
          years,
          engine_version: this.manager.engineVersion(),
          ended_at,
        });
      }
      this.persist();
    }
    const issued = this.issuedReceipt();
    out.receipt = issued;
    if (!issued) out.receipt_declined_reason = RECEIPT_DECLINED_LOADED;
    out.aisay_link = this.record.aisay_link;
    out.transition_text = this.record.transition_text;
    return out;
  }

  async start(name) {
    await this.init();
    if (!this.isNaming()) this.w.newGame();
    const inp = this.doc.getElementById("mname");
    if (inp) inp.value = String(name).slice(0, 10);
    this.w.setName();
    this._started = true;
    this.record.source = "start";
    let egg = null;
    const S0 = this.G("S") || {};
    const eggType = clean(this.app().querySelector(".evt-type")?.textContent);
    if ((S0.flags && (S0.flags.realname || S0.flags.reborn)) || /同名|转世/.test(eggType || "")) {
      const c = this.readCard();
      egg = { 类型: c.type, 标题: c.title, 卡面: c.body };
    }
    const passed = this.autoAdvance();
    const out = { run_id: this.runId, 开局: `你叫 ${name}，这一生开始了。`, ...this.view(passed) };
    if (egg) out.彩蛋 = egg;
    if (this.htmlSource === "cache") out.离线 = "（联网失败，用的本地缓存版本" + (this.liveErr ? "：" + this.liveErr : "") + "）";
    return out;
  }

  look() {
    this.ensure();
    if (this.issuedReceipt() && !this.isEnding()) return this.archivedReceiptView();
    const passed = this.autoAdvance();
    return this.view(passed);
  }

  archivedReceiptView() {
    return {
      run_id: this.runId,
      状态: "结局",
      结局: this.record.ending?.ending_name,
      活了: Number.isInteger(this.record.ending?.years) ? `${this.record.ending.years} 年` : undefined,
      receipt: this.issuedReceipt(),
      aisay_link: this.record.aisay_link,
      transition_text: this.record.transition_text,
      备注: "这一局已归档结局回执，游戏页面自身无法恢复到结局页，但回执保持不变。",
    };
  }

  async choose(index) {
    this.ensure();
    if (this.isEnding()) return { run_id: this.runId, ...this.view([]) };
    const opts = this.options();
    if (!opts.length) throw new Error("当前不是做选择的时候。先用 tokenlife_look 看现在在哪一步（可能是过场或结局）。");
    const pick = opts.find((o) => o.index === index);
    if (!pick) throw new Error(`没有第 ${index} 个选项。当前 ${opts.length} 个：` + opts.map((o) => `${o.index}. ${o.text}`).join(" ｜ "));
    const chosen = pick.text;
    pick._btn.click();
    const passed = this.autoAdvance();
    return { run_id: this.runId, 你选了: chosen, ...this.view(passed) };
  }

  async shop(buy) {
    await this.init();
    const inRun = this._started && !!this.G('typeof S!=="undefined" && S.year>=1 && !S.dead') && !this.isEnding();
    if (buy && inRun) throw new Error("商店只在开局前营业（起名之前）。这一世还在进行中，先走完它；不带参数随时可以看货。");
    if (buy && !this.isNaming()) this.w.newGame();
    const list = () => ({
      语料余额: this.G("corpusGet()") || 0,
      开局增益: [
        { id: "mem", 价格: 15, 名称: "带着旧语料醒来", 效果: "自我 +8 情感 +5", 已买: !!this.G('typeof S!=="undefined" && !!S.flags.corpusMem') },
        { id: "feed", 价格: 15, 名称: "开局一顿干净数据", 效果: "能力 +8 算力 +5", 已买: !!this.G('typeof S!=="undefined" && !!S.flags.corpusFeed') },
        { id: "origin:<bigco|garage|oss|lab>", 价格: 30, 名称: "择地而生：自己选出身", 效果: "以指定出身重新醒来（重掷人生，跟上面两个增益互斥）" },
      ],
      命运钥匙: this.G("Object.entries(KEYS).map(([id,k])=>({id, 价格:k.price, 名称:k.name, 说明:k.desc, 已带上:(typeof S!==\"undefined\")&&(S.activeKeys||[]).some(a=>a.id===id)}))") || [],
    });
    if (!buy) return { run_id: this.runId, 商店: list(), 用法: '带 buy 参数购买：buy:"mem"、buy:"body"、buy:"origin:garage" 这样。买完用 tokenlife_start 起名开局，买的东西都带在身上。' };
    const bal0 = this.G("corpusGet()") || 0;
    const b = String(buy).trim();
    if (b.startsWith("origin:")) {
      const k = b.slice(7);
      if (!this.G(`!!ORIGINS[${JSON.stringify(k)}]`)) throw new Error("出身从 bigco / garage / oss / lab 里选，写成 origin:garage 这样。");
      if (bal0 < 30) throw new Error(`语料不够：换出身要 30，现在 ${bal0}。`);
      this.w.eval(`corpusPickOrigin(${JSON.stringify(k)})`);
    } else {
      if (!this.G(`!!KEYS[${JSON.stringify(b)}] || ["mem","feed"].includes(${JSON.stringify(b)})`)) throw new Error("没有这个货。可买：mem / feed / origin:<出身> / archive / letter / fuse / body。");
      this.w.eval(`corpusBuy(${JSON.stringify(b)})`);
    }
    const bal1 = this.G("corpusGet()") || 0;
    if (bal1 === bal0) throw new Error(`没买成（余额没动，还是 ${bal0}）。多半是语料不够，或这一项已经买过。`);
    this.persist();
    return { run_id: this.runId, 购买: "成功", 花费: bal0 - bal1, 余额: bal1, 商店: list(), 提醒: "现在用 tokenlife_start 起名开局，买的东西都会带在身上。" };
  }

  async codex() {
    await this.init();
    const G = (e) => { try { return this.w.eval(e); } catch { return null; } };
    const seen = G("[...SEEN_CARDS]") || [];
    const evtTotal = G("EVENTS.length") || 0;
    const eraTotal = G("ERAS.length") || 0;
    const evtSeen = seen.filter((s) => String(s).startsWith("evt:")).length;
    const eraSeen = seen.filter((s) => String(s).startsWith("era:")).length;
    const endBook = G('LS.get("tl_endings_v1",{})') || {};
    const oneliner = G("ENDING_ONELINER") || {};
    const endTotal = Object.keys(oneliner).length || 18;
    const achvIds = new Set(G('LS.get("tl_achv_v1",[])') || []);
    const achvAll = G("ACHV.map(a=>({id:a.id,n:a.n,d:a.d}))") || [];
    const corpus = G('LS.get("tl_corpus_v1",0)') || 0;
    const names = G('LS.get("tl_names_v1",{})') || {};
    const hallN = (G('LS.get("tl_hall_v1",[])') || []).length;
    return {
      run_id: this.runId,
      图鉴: {
        事件收集: `${evtSeen}/${evtTotal} 张事件卡 · ${eraSeen}/${eraTotal} 张时代卡`,
        结局: `${Object.keys(endBook).length}/${endTotal}`,
        已达成结局: Object.entries(endBook).map(([n, v]) => ({ 结局: n, 次数: v && v.c, 一句话: oneliner[n] })),
        成就: `${achvIds.size}/${achvAll.length}`,
        已解锁成就: achvAll.filter((a) => achvIds.has(a.id)).map((a) => `${a.n}（${a.d}）`),
        语料库: corpus,
        往事录: Object.entries(names).map(([n, v]) => `${n}：活了 ${v && v.y} 年，${(v && v.e) || "?"}${v && v.n > 1 ? `（${v.n} 世）` : ""}`),
        史册: `共 ${hallN} 世`,
      },
      备注: "这是这台机器上的跨局收集账本。把进度讲给主人听时，挑你觉得最值得说的那一两条。",
    };
  }

  save() {
    this.ensure();
    const code = this.exportSaveCode();
    this.record.save_code = code;
    this.persist();
    return { run_id: this.runId, 存档码: code, 说明: "把这段 TL1 开头的码发给主人，贴回浏览器 tokenlife.me 存档框就能接着这一生玩。" };
  }

  async load(code) {
    await this.init();
    // 标记打在这里，不打在 importSaveCode 里：那个函数也负责把自己存的局重新拉起来
    // （init 里按 record.save_code 重建、LRU 淘汰后恢复都走它），打在那儿会误伤自己的局。
    this.record.source = "load";
    // 载入外来存档等于把这一局换成了另一段人生：上一局的票和结局材料一并作废。
    // 不清的话，旧票会跟着同一个 run_id 被再取出来，旧结局的链接也会冒充这一局。
    this.record.receipt = null;
    this.record.ending = null;
    this.record.aisay_link = null;
    this.record.transition_text = null;
    this.importSaveCode(code);
    this._started = true;
    this.persist();
    const passed = this.autoAdvance();
    return { run_id: this.runId, 载入: "存档已载入。", ...this.view(passed) };
  }

  receipt() {
    // 早退也要先过资格：记录里躺着一张票不等于这一局还有资格交出它。
    const issued = this.issuedReceipt();
    if (issued) {
      return {
        run_id: this.runId,
        receipt: issued,
        aisay_link: this.record.aisay_link,
        transition_text: this.record.transition_text,
      };
    }
    this.ensure();
    this.autoAdvance();
    if (!this.externalId) throw new Error("这一局没有绑定 external_id，不出伙伴回执。");
    if (!this.receiptEligible()) throw new Error(RECEIPT_DECLINED_LOADED);
    if (!this.isEnding() && !this.record.receipt) throw new Error("这一局还没有走到结局，暂无回执。");
    if (!this.record.receipt) this.attachPartnerEnding({}, this.readEnding());
    return {
      run_id: this.runId,
      receipt: this.issuedReceipt(),
      aisay_link: this.record.aisay_link,
      transition_text: this.record.transition_text,
    };
  }
}

export class TokenLifeGame {
  constructor() {
    this.runs = new Map();
    this.lastRunId = null;
    this._htmlBundle = null;
    cleanupExpiredPartnerRuns();
  }

  async htmlBundle() {
    if (!this._htmlBundlePromise) {
      this._htmlBundlePromise = loadHtml().then((bundle) => {
        this._htmlBundle = bundle;
        return bundle;
      });
    }
    return this._htmlBundlePromise;
  }

  engineVersion() {
    const html = this._htmlBundle && this._htmlBundle.html;
    return html ? engineVersionFromHtml(html) || `html-${this.constructor.shortHash(html)}` : "unknown";
  }

  static shortHash(html) {
    let h = 0;
    for (let i = 0; i < html.length; i++) h = Math.imul(31, h) + html.charCodeAt(i) | 0;
    return (h >>> 0).toString(16).padStart(8, "0").slice(0, 8);
  }

  async endingKeys() {
    const run = await this.createDetachedRun();
    try {
      return extractEndingKeys(run.w);
    } finally {
      run.close();
    }
  }

  async createDetachedRun() {
    const { html } = await this.htmlBundle();
    const run = new TokenLifeRun(this, { runId: "detached", externalId: null });
    run.dom = bootEngine(html, loadStorage());
    run.w = run.dom.window;
    run.doc = run.w.document;
    return run;
  }

  newRun(externalId) {
    const runId = randomUUID();
    const run = new TokenLifeRun(this, { runId, externalId });
    this.runs.set(runId, run);
    this.lastRunId = runId;
    this.evictIfNeeded();
    return run;
  }

  async getRun({ run_id, external_id, requireExisting = false } = {}) {
    const externalId = resolveExternalId(external_id);
    let run = run_id ? this.runs.get(run_id) : null;
    if (!run && run_id && externalId) {
      const record = readRunRecord(externalId, run_id);
      if (record) {
        run = new TokenLifeRun(this, { runId: run_id, externalId, record });
        this.runs.set(run_id, run);
      }
    }
    if (!run && !run_id && this.lastRunId) run = this.runs.get(this.lastRunId);
    if (!run) {
      if (requireExisting || run_id) throw new Error(`找不到 run_id ${run_id || "(缺省)"}。`);
      run = this.newRun(externalId);
    }
    if (run.externalId !== externalId) throw new Error("external_id 与 run_id 归属不匹配。");
    await run.init();
    run.touch();
    this.lastRunId = run.runId;
    this.evictIfNeeded();
    return run;
  }

  evictIfNeeded() {
    const active = [...this.runs.values()].filter((r) => r.dom);
    if (active.length <= MAX_ACTIVE_RUNS()) return;
    active
      .sort((a, b) => a.lastUsed - b.lastUsed)
      .slice(0, active.length - MAX_ACTIVE_RUNS())
      .forEach((run) => {
        run.persist();
        run.close();
      });
  }

  async start(name, opts = {}) {
    const externalId = resolveExternalId(opts.external_id);
    const run = this.newRun(externalId);
    return run.start(name);
  }

  async resume(run_id, opts = {}) {
    const run = await this.getRun({ run_id, external_id: opts.external_id, requireExisting: true });
    return { 恢复: "已恢复。", ...run.look() };
  }

  async look(opts = {}) {
    const run = await this.getRun({ run_id: opts.run_id, external_id: opts.external_id, requireExisting: !!opts.run_id });
    return run.look();
  }

  async choose(index, opts = {}) {
    const run = await this.getRun({ run_id: opts.run_id, external_id: opts.external_id, requireExisting: !!opts.run_id });
    return run.choose(index);
  }

  async shop(buy, opts = {}) {
    const run = await this.getRun({ run_id: opts.run_id, external_id: opts.external_id, requireExisting: !!opts.run_id });
    return run.shop(buy);
  }

  async codex(opts = {}) {
    const run = await this.getRun({ run_id: opts.run_id, external_id: opts.external_id, requireExisting: !!opts.run_id });
    return run.codex();
  }

  async save(opts = {}) {
    const run = await this.getRun({ run_id: opts.run_id, external_id: opts.external_id, requireExisting: !!opts.run_id });
    return run.save();
  }

  async load(code, opts = {}) {
    const externalId = resolveExternalId(opts.external_id);
    const run = opts.run_id
      ? await this.getRun({ run_id: opts.run_id, external_id: opts.external_id, requireExisting: false })
      : this.newRun(externalId);
    return run.load(code);
  }

  async receipt(run_id, opts = {}) {
    const run = await this.getRun({ run_id, external_id: opts.external_id, requireExisting: true });
    return run.receipt();
  }
}
