// 商店的「命运钥匙」为什么会变成空数组。不联网、不碰 ~/.tokenlife-mcp，只喂一个最小的游戏全局。
// 背景：开局之前游戏里的 S 是 null 而不是 undefined，而 typeof null === "object"，
// 所以旧写法 `typeof S!=="undefined"` 会判成「S 在」然后放行，S.activeKeys 抛 TypeError，
// 被 G() 吞掉、再被 `|| []` 兜住，最后长得跟「今天没货」一模一样 —— 于是「要退出重进一次才出」。
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { TokenLifeGame } from "../src/game.mjs";

// 造一个只有商店相关全局的最小游戏页，挂到实例上（this.dom 一有值 init() 就直接返回，不会去联网）
function stub({ withKeys = true } = {}) {
  const decl = withKeys
    ? 'const KEYS={archive:{price:35,name:"旧机房的钥匙",desc:"考古暗线"},letter:{price:40,name:"一封没寄出的信",desc:"第 2 年那个人会来找你"}};'
    : "";
  const dom = new JSDOM(
    `<body><div id="app"></div><script>
      var S = null;                       /* ← 开局之前就是 null，不是 undefined */
      ${decl}
      function corpusGet(){ return 87; }
      function newGame(){ S = { year:0, dead:false, flags:{}, activeKeys:[] }; }
    </script></body>`,
    { runScripts: "dangerously" }
  );
  const g = new TokenLifeGame();
  g.dom = dom;
  g.w = dom.window;
  g.doc = dom.window.document;
  return g;
}

test("开局前（S 为 null）看货，命运钥匙照样列得出来", async () => {
  const g = stub();
  assert.equal(g.w.eval("S"), null, "前提：这时候 S 就是 null");
  const { 商店 } = await g.shop();
  assert.deepEqual(
    Array.from(商店.命运钥匙, (k) => k.id), // Array.from：钥匙表是 jsdom realm 造的数组，直接 deepEqual 会栽在原型上
    ["archive", "letter"],
    "空数组 = 又被 typeof null 骗了"
  );
  assert.ok(!("命运钥匙读取失败" in 商店), "不该有读取失败");
  assert.equal(商店.命运钥匙[1].已带上, false, "没开局自然一把都没带上");
  assert.equal(商店.开局增益[0].已买, false, "S 为 null 时 mem 也不该炸");
});

test("开局之后带着的钥匙标成已带上", async () => {
  const g = stub();
  g.w.newGame();
  g.w.eval('S.activeKeys.push({id:"letter",name:"一封没寄出的信"})');
  const { 商店 } = await g.shop();
  const byId = Object.fromEntries(Array.from(商店.命运钥匙, (k) => [k.id, k.已带上]));
  assert.deepEqual(byId, { archive: false, letter: true });
});

test("真读不到货的时候要明说，不许再拿空数组冒充没货", async () => {
  const g = stub({ withKeys: false }); // KEYS 根本不存在 = 读取失败
  const { 商店 } = await g.shop();
  assert.ok(商店.命运钥匙读取失败, "失败必须说出来，否则下一个人又要去猜是不是没货");
  assert.match(商店.命运钥匙读取失败, /KEYS/, "得带上原始报错，能直接拿去查");
  assert.deepEqual(商店.命运钥匙, [], "字段本身仍是数组，不破坏结构");
});
