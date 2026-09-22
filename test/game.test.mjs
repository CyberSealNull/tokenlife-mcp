import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, cpSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

let importCase = 0;

async function loadGameWithTempHome() {
  const realHome = homedir();
  const cachePath = join(realHome, ".tokenlife-mcp", "cache.html");
  assert.ok(existsSync(cachePath), `missing required cache fixture: ${cachePath}`);
  const tempHome = join(tmpdir(), `tokenlife-mcp-test-${process.pid}-${Date.now()}`);
  mkdirSync(join(tempHome, ".tokenlife-mcp"), { recursive: true });
  cpSync(cachePath, join(tempHome, ".tokenlife-mcp", "cache.html"));
  const oldEnv = {
    HOME: process.env.HOME,
    TOKENLIFE_PARTNER_SECRET: process.env.TOKENLIFE_PARTNER_SECRET,
    TOKENLIFE_MAX_ACTIVE_RUNS: process.env.TOKENLIFE_MAX_ACTIVE_RUNS,
  };
  process.env.HOME = tempHome;
  process.env.TOKENLIFE_PARTNER_SECRET = "e2e-secret";
  process.env.TOKENLIFE_MAX_ACTIVE_RUNS = "2";
  const mod = await import(`../src/game.mjs?case=${Date.now()}-${++importCase}`);
  return { TokenLifeGame: mod.TokenLifeGame, tempHome, oldEnv };
}

function restoreEnv(oldEnv) {
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
  const { TokenLifeGame, oldEnv } = loaded;
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
    restoreEnv(oldEnv);
  }
});

test("ending receipt is persisted and repeated calls return the same bytes", async (t) => {
  const loaded = await loadGameWithTempHome();
  const { TokenLifeGame, oldEnv } = loaded;
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
    restoreEnv(oldEnv);
  }
});

test("partner external_id uses isolated storage files", async () => {
  const loaded = await loadGameWithTempHome();
  const { TokenLifeGame, oldEnv } = loaded;
  try {
    const game = new TokenLifeGame();
    const alpha = await game.start("甲", { external_id: "aisay_alpha_store" });
    const alphaRun = game.runs.get(alpha.run_id);
    alphaRun.w.localStorage.setItem("tl_corpus_v1", "77");
    alphaRun.w.localStorage.setItem("tl_names_v1", JSON.stringify({ AlphaName: { y: 3, e: "AlphaEnd", n: 1 } }));
    alphaRun.w.localStorage.setItem("tl_achv_v1", JSON.stringify(["alpha-achv"]));
    alphaRun.persist();

    const beta = await game.start("乙", { external_id: "aisay_beta_store" });
    const betaRun = game.runs.get(beta.run_id);
    assert.notEqual(betaRun.w.localStorage.getItem("tl_corpus_v1"), "77");
    assert.equal(betaRun.w.localStorage.getItem("tl_names_v1"), null);
    assert.equal(betaRun.w.localStorage.getItem("tl_achv_v1"), null);
    betaRun.w.localStorage.setItem("tl_corpus_v1", "5");
    betaRun.w.localStorage.setItem("tl_names_v1", JSON.stringify({ BetaName: { y: 4, e: "BetaEnd", n: 1 } }));
    betaRun.w.localStorage.setItem("tl_achv_v1", JSON.stringify(["beta-achv"]));
    betaRun.persist();

    const game2 = new TokenLifeGame();
    const alpha2 = await game2.start("丙", { external_id: "aisay_alpha_store" });
    const alpha2Run = game2.runs.get(alpha2.run_id);
    assert.equal(alpha2Run.w.localStorage.getItem("tl_corpus_v1"), "77");
    assert.deepEqual(JSON.parse(alpha2Run.w.localStorage.getItem("tl_names_v1")), { AlphaName: { y: 3, e: "AlphaEnd", n: 1 } });
    assert.deepEqual(JSON.parse(alpha2Run.w.localStorage.getItem("tl_achv_v1")), ["alpha-achv"]);

    const beta2 = await game2.start("丁", { external_id: "aisay_beta_store" });
    const beta2Run = game2.runs.get(beta2.run_id);
    assert.equal(beta2Run.w.localStorage.getItem("tl_corpus_v1"), "5");
    assert.deepEqual(JSON.parse(beta2Run.w.localStorage.getItem("tl_names_v1")), { BetaName: { y: 4, e: "BetaEnd", n: 1 } });
    assert.deepEqual(JSON.parse(beta2Run.w.localStorage.getItem("tl_achv_v1")), ["beta-achv"]);
  } finally {
    restoreEnv(oldEnv);
  }
});
