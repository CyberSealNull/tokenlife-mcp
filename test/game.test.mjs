import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, cpSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

async function loadGameWithTempHome() {
  const realHome = homedir();
  const cachePath = join(realHome, ".tokenlife-mcp", "cache.html");
  if (!existsSync(cachePath)) return null;
  const tempHome = join(tmpdir(), `tokenlife-mcp-test-${process.pid}-${Date.now()}`);
  mkdirSync(join(tempHome, ".tokenlife-mcp"), { recursive: true });
  cpSync(cachePath, join(tempHome, ".tokenlife-mcp", "cache.html"));
  const oldHome = process.env.HOME;
  process.env.HOME = tempHome;
  process.env.TOKENLIFE_PARTNER_SECRET = "e2e-secret";
  process.env.TOKENLIFE_MAX_ACTIVE_RUNS = "2";
  const mod = await import(`../src/game.mjs?case=${Date.now()}`);
  return { TokenLifeGame: mod.TokenLifeGame, tempHome, oldHome };
}

async function chooseFirstUntilEnding(game, run_id, external_id) {
  let out = await game.look({ run_id, external_id });
  for (let i = 0; i < 90 && out.状态 !== "结局"; i++) {
    if (out.选项?.length) out = await game.choose(1, { run_id, external_id });
    else out = await game.look({ run_id, external_id });
  }
  return out;
}

test("run_id ownership, resume and LRU eviction use real cached game html", async (t) => {
  const loaded = await loadGameWithTempHome();
  if (!loaded) return t.skip("no ~/.tokenlife-mcp/cache.html fixture");
  const { TokenLifeGame, oldHome } = loaded;
  try {
    const game = new TokenLifeGame();
    const a = await game.start("甲", { external_id: "aisay_alpha" });
    const b = await game.start("乙", { external_id: "aisay_beta" });
    const c = await game.start("丙", { external_id: "aisay_gamma" });
    assert.notEqual(a.run_id, b.run_id);
    assert.notEqual(b.run_id, c.run_id);
    await assert.rejects(
      () => game.look({ run_id: a.run_id, external_id: "aisay_beta" }),
      /external_id 与 run_id 归属不匹配/,
    );
    const resumed = await game.resume(a.run_id, { external_id: "aisay_alpha" });
    assert.equal(resumed.run_id, a.run_id);
    assert.ok(resumed.状态);
  } finally {
    process.env.HOME = oldHome;
  }
});

test("ending receipt is persisted and repeated calls return the same bytes", async (t) => {
  const loaded = await loadGameWithTempHome();
  if (!loaded) return t.skip("no ~/.tokenlife-mcp/cache.html fixture");
  const { TokenLifeGame, oldHome } = loaded;
  try {
    const game = new TokenLifeGame();
    const start = await game.start("丁", { external_id: "aisay_finish" });
    const ending = await chooseFirstUntilEnding(game, start.run_id, "aisay_finish");
    assert.equal(ending.状态, "结局");
    assert.equal(ending.receipt.external_id, "aisay_finish");
    assert.equal(ending.receipt.run_id, start.run_id);
    assert.equal(ending.receipt.signed, true);
    assert.equal(ending.receipt.signature.length > 20, true);
    assert.equal(ending.receipt.payload_sha256.length, 64);
    assert.ok(ending.aisay_link.includes("source=mcp"));
    assert.ok(ending.transition_text.includes(ending.aisay_link));

    const again = await game.receipt(start.run_id, { external_id: "aisay_finish" });
    assert.deepEqual(again.receipt, ending.receipt);
    assert.equal(again.transition_text, ending.transition_text);

    const repeatChoose = await game.choose(1, { run_id: start.run_id, external_id: "aisay_finish" });
    assert.deepEqual(repeatChoose.receipt, ending.receipt);

    const game2 = new TokenLifeGame();
    const resumed = await game2.resume(start.run_id, { external_id: "aisay_finish" });
    assert.equal(resumed.receipt.run_id, start.run_id);
    assert.deepEqual(resumed.receipt, ending.receipt);
  } finally {
    process.env.HOME = oldHome;
  }
});
