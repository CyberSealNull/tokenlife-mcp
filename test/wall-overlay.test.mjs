// 拆墙 overlay 的退场等待。不联网、不碰 ~/.tokenlife-mcp，只测 settleOverlay 本身。
// 背景：breakWall() 同步只做 opacity=0，真正的 remove()+nextYear() 在 820ms 后的 setTimeout 里；
// choose() 不等就读卡，会读回一张正文为空、选项照旧的「复读墙」。
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { TokenLifeGame } from "../src/game.mjs";

// 造一个只有 overlay 的最小 DOM，挂到一个没 init 过的实例上（settleOverlay 只用 this.doc）
function stub(html) {
  const dom = new JSDOM(`<body><div id="app"></div>${html}</body>`);
  const g = new TokenLifeGame();
  g.dom = dom;
  g.w = dom.window;
  g.doc = dom.window.document;
  return g;
}
const OVERLAY = '<div id="wall-overlay"><div class="wall-title">你看见了那堵墙</div></div>';

test("墙正在淡出时，等到它真的退场才返回", async () => {
  const g = stub(OVERLAY);
  const ov = g.doc.getElementById("wall-overlay");
  ov.style.opacity = "0"; // breakWall() 同步做的那一步
  setTimeout(() => ov.remove(), 300); // 那个 820ms setTimeout 的替身
  const t0 = Date.now();
  await g.settleOverlay();
  assert.equal(g.doc.getElementById("wall-overlay"), null, "墙应该已经退场");
  assert.ok(Date.now() - t0 >= 250, "应该真的等过了，而不是立刻返回");
});

test("墙没在淡出（真决策点）时立刻返回，一秒都不等", async () => {
  const g = stub(OVERLAY); // opacity 没归零 = showWall() 刚立起来，正等着玩家选
  const t0 = Date.now();
  await g.settleOverlay();
  assert.ok(Date.now() - t0 < 50, "真决策点不该等");
  assert.ok(g.doc.getElementById("wall-overlay"), "墙还在，等着做选择");
});

test("没有 overlay（退回去是同步 remove）时立刻返回", async () => {
  const g = stub("");
  const t0 = Date.now();
  await g.settleOverlay();
  assert.ok(Date.now() - t0 < 50);
});

test("墙迟迟不退场也会超时放弃，不把工具吊死", async () => {
  const g = stub(OVERLAY);
  g.doc.getElementById("wall-overlay").style.opacity = "0";
  const t0 = Date.now();
  await g.settleOverlay(150);
  const dt = Date.now() - t0;
  assert.ok(dt >= 150 && dt < 800, `应在超时后返回，实际 ${dt}ms`);
});
