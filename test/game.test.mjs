import test from "node:test";
import assert from "node:assert/strict";
import fs, { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

async function playSteps(game, run_id, external_id, steps) {
  let out = await game.look({ run_id, external_id });
  for (let i = 0; i < steps && out.状态 !== "结局"; i++) {
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

test("a run imported with tokenlife_load never mints a receipt", async () => {
  const loaded = await loadGameWithTempHome();
  const { TokenLifeGame, oldEnv } = loaded;
  try {
    const game = new TokenLifeGame();
    const seed = await game.start("源", { external_id: "aisay_seed_src" });
    await playSteps(game, seed.run_id, "aisay_seed_src", 8);
    const saved = await game.save({ run_id: seed.run_id, external_id: "aisay_seed_src" });
    assert.ok(saved.存档码.startsWith("TL1"));

    const imported = await game.load(saved.存档码, { external_id: "aisay_importer" });
    const ending = await chooseFirstUntilEnding(game, imported.run_id, "aisay_importer");
    assert.equal(ending.状态, "结局");
    assert.equal(ending.receipt, null);
    assert.match(ending.receipt_declined_reason, /tokenlife_load/);

    // 链接跟转场照常给：链接是邀请不是证明。
    assert.ok(ending.aisay_link.includes("source=mcp"));
    assert.ok(ending.transition_text.includes(ending.aisay_link));

    // 结局时间钉死一次，重复取同一条链接，不每次重算。
    const lookAgain = await game.look({ run_id: imported.run_id, external_id: "aisay_importer" });
    assert.equal(lookAgain.aisay_link, ending.aisay_link);

    await assert.rejects(
      () => game.receipt(imported.run_id, { external_id: "aisay_importer" }),
      /tokenlife_load/,
    );

    const { runPath } = await import("../src/partner.mjs");
    const record = JSON.parse(readFileSync(runPath("aisay_importer", imported.run_id), "utf8"));
    assert.equal(record.receipt, null);
    assert.equal(record.source, "load");
  } finally {
    restoreEnv(oldEnv);
  }
});

test("the same save code cannot be traded for a receipt by loading it again", async () => {
  const loaded = await loadGameWithTempHome();
  const { TokenLifeGame, oldEnv } = loaded;
  try {
    const game = new TokenLifeGame();
    const seed = await game.start("源二", { external_id: "aisay_replay_src" });
    await playSteps(game, seed.run_id, "aisay_replay_src", 8);
    const saved = await game.save({ run_id: seed.run_id, external_id: "aisay_replay_src" });

    for (const attempt of [1, 2]) {
      const imported = await game.load(saved.存档码, { external_id: "aisay_replay" });
      const ending = await chooseFirstUntilEnding(game, imported.run_id, "aisay_replay");
      assert.equal(ending.状态, "结局", `第 ${attempt} 次载入应走到结局`);
      assert.equal(ending.receipt, null, `第 ${attempt} 次载入不应换出回执`);
      await assert.rejects(
        () => game.receipt(imported.run_id, { external_id: "aisay_replay" }),
        /tokenlife_load/,
      );
    }
  } finally {
    restoreEnv(oldEnv);
  }
});

test("loading a save code into an already started run revokes that run's ticket", async () => {
  const loaded = await loadGameWithTempHome();
  const { TokenLifeGame, oldEnv } = loaded;
  try {
    const game = new TokenLifeGame();
    const seed = await game.start("源三", { external_id: "aisay_graft_src" });
    await playSteps(game, seed.run_id, "aisay_graft_src", 8);
    const saved = await game.save({ run_id: seed.run_id, external_id: "aisay_graft_src" });

    const host = await game.start("寄主", { external_id: "aisay_graft" });
    await playSteps(game, host.run_id, "aisay_graft", 3);
    await game.load(saved.存档码, { run_id: host.run_id, external_id: "aisay_graft" });
    const ending = await chooseFirstUntilEnding(game, host.run_id, "aisay_graft");
    assert.equal(ending.状态, "结局");
    assert.equal(ending.receipt, null);
  } finally {
    restoreEnv(oldEnv);
  }
});

test("started runs still mint receipts after LRU eviction and resume", async () => {
  const loaded = await loadGameWithTempHome();
  const { TokenLifeGame, oldEnv } = loaded;
  try {
    const game = new TokenLifeGame();
    const a = await game.start("甲活", { external_id: "aisay_evict_a" });
    await playSteps(game, a.run_id, "aisay_evict_a", 4);
    await game.start("乙活", { external_id: "aisay_evict_b" });
    const c = await game.start("丙活", { external_id: "aisay_evict_c" });
    // 淘汰只在下一次取局时结算，这一下把最久未用的甲挤出去。
    await game.look({ run_id: c.run_id, external_id: "aisay_evict_c" });
    // 断言写成布尔：dom 真没被淘汰时，直接比对象会把整个 JSDOM 铺进 diff 里。
    assert.equal(game.runs.get(a.run_id).dom === null, true, "MAX_ACTIVE_RUNS=2 下甲应已被淘汰");

    // 淘汰后重建走的是 importSaveCode（拿自己存的码），不能被当成外来存档。
    const resumed = await game.resume(a.run_id, { external_id: "aisay_evict_a" });
    assert.equal(resumed.run_id, a.run_id);
    const ending = await chooseFirstUntilEnding(game, a.run_id, "aisay_evict_a");
    assert.equal(ending.状态, "结局");
    assert.ok(ending.receipt, "亲自开局的局在淘汰重建之后仍然要出回执");
    assert.equal(ending.receipt.signed, true);
    assert.equal(ending.receipt.run_id, a.run_id);
  } finally {
    restoreEnv(oldEnv);
  }
});

test("ending link carries the same ended_at as the receipt", async () => {
  const loaded = await loadGameWithTempHome();
  const { TokenLifeGame, oldEnv } = loaded;
  try {
    const game = new TokenLifeGame();
    const start = await game.start("戊", { external_id: "aisay_linktime" });
    const ending = await chooseFirstUntilEnding(game, start.run_id, "aisay_linktime");
    assert.equal(ending.状态, "结局");
    const url = new URL(ending.aisay_link);
    assert.equal(url.searchParams.get("ended_at"), ending.receipt.ended_at);
    assert.equal(url.searchParams.get("years"), String(ending.receipt.years));
    assert.equal(url.searchParams.get("ending_name"), ending.receipt.ending_name);
    assert.equal(url.searchParams.get("ending_id"), ending.receipt.ending_id);
    assert.equal(url.searchParams.get("source"), "mcp");

    const again = await game.receipt(start.run_id, { external_id: "aisay_linktime" });
    assert.equal(again.aisay_link, ending.aisay_link);
    assert.equal(again.receipt.ended_at, ending.receipt.ended_at);
  } finally {
    restoreEnv(oldEnv);
  }
});

test("cache.html is written 0600 whether or not it already exists", async () => {
  const bigHtml = `<html><body>newGame tokenlife ${"x".repeat(60000)}</body></html>`;
  const tempHome = join(tmpdir(), `tokenlife-mcp-perm-${process.pid}-${Date.now()}`);
  mkdirSync(join(tempHome, ".tokenlife-mcp"), { recursive: true });
  const oldHome = process.env.HOME;
  const oldFetch = globalThis.fetch;
  process.env.HOME = tempHome;
  globalThis.fetch = async () => ({ ok: true, text: async () => bigHtml });
  try {
    const { loadHtml, CACHE_PATH } = await import(`../src/engine.mjs?perm=${Date.now()}-${++importCase}`);

    // 形状一：缓存文件还不存在，新建。
    assert.equal(existsSync(CACHE_PATH), false);
    assert.equal((await loadHtml()).source, "live");
    assert.equal(statSync(CACHE_PATH).mode & 0o777, 0o600);

    // 形状二：文件已经在，且权限是松的。writeFileSync 的 mode 对已存在文件不生效，
    // 只有显式 chmod 才收得回来，这一形状是真正会漏的那个。
    chmodSync(CACHE_PATH, 0o644);
    assert.equal(statSync(CACHE_PATH).mode & 0o777, 0o644);
    assert.equal((await loadHtml()).source, "live");
    assert.equal(statSync(CACHE_PATH).mode & 0o777, 0o600);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("the data dir is created 0700 whether or not it already exists", async () => {
  const bigHtml = `<html><body>newGame tokenlife ${"x".repeat(60000)}</body></html>`;
  const tempHome = join(tmpdir(), `tokenlife-mcp-dirperm-${process.pid}-${Date.now()}`);
  // 只建 HOME，故意不建 .tokenlife-mcp，让首次运行自己去建。
  mkdirSync(tempHome, { recursive: true });
  const oldHome = process.env.HOME;
  const oldFetch = globalThis.fetch;
  process.env.HOME = tempHome;
  globalThis.fetch = async () => ({ ok: true, text: async () => bigHtml });
  try {
    const { loadHtml, DATA_DIR } = await import(`../src/engine.mjs?dirperm=${Date.now()}-${++importCase}`);

    // 形状一：目录还不存在，首次运行现建。这是那段 0755 窗口的入口。
    assert.equal(existsSync(DATA_DIR), false);
    assert.equal((await loadHtml()).source, "live");
    assert.equal(statSync(DATA_DIR).mode & 0o777, 0o700);

    // 形状二：目录已经在，权限是松的。mkdirSync 的 mode 对已存在目录不生效，
    // 跟 cache.html 那条同族，只有显式 chmod 才收得回来。
    chmodSync(DATA_DIR, 0o755);
    assert.equal(statSync(DATA_DIR).mode & 0o777, 0o755);
    assert.equal((await loadHtml()).source, "live");
    assert.equal(statSync(DATA_DIR).mode & 0o777, 0o700);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
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

test("storage persist is atomic and corrupt storage does not seed an empty ledger", async () => {
  const storagePath = join(tmpdir(), `tokenlife-mcp-atomic-${process.pid}-${Date.now()}`, "owner", "storage.json");
  mkdirSync(dirname(storagePath), { recursive: true });
  writeFileSync(storagePath, "{\"stable\":true}\n", "utf8");
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function patchedWriteFileSync(path, ...args) {
    if (String(path).includes("/.") && String(path).endsWith(".tmp")) {
      throw new Error("simulated temp write interruption");
    }
    return originalWriteFileSync.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  const { loadStorage, persist } = await import(`../src/engine.mjs?atomic=${Date.now()}-${++importCase}`);
  try {
    const fakeWindow = {
      localStorage: {
        length: 1,
        key: () => "tl_corpus_v1",
        getItem: () => "999",
      },
    };
    assert.throws(() => persist(fakeWindow, storagePath), /simulated temp write interruption/);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(storagePath, "utf8"), "{\"stable\":true}\n");

  writeFileSync(storagePath, "{\"stable\":", "utf8");
  assert.throws(
    () => loadStorage(storagePath),
    /storage 解析失败/,
  );
  assert.equal(readFileSync(storagePath, "utf8"), "{\"stable\":");
});

test("partner retention removes owner storage when all runs expire", async () => {
  const tempHome = join(tmpdir(), `tokenlife-mcp-cleanup-${process.pid}-${Date.now()}`);
  const oldHome = process.env.HOME;
  process.env.HOME = tempHome;
  try {
    const {
      cleanupExpiredPartnerRuns,
      partnerStoragePath,
      runPath,
    } = await import(`../src/partner.mjs?cleanup=${Date.now()}-${++importCase}`);
    const externalId = "aisay_cleanup_owner";
    const expired = "2026-01-01T00:00:00Z";
    const runFile = runPath(externalId, "old-run");
    const storageFile = partnerStoragePath(externalId);
    mkdirSync(dirname(runFile), { recursive: true });
    writeFileSync(runFile, JSON.stringify({
      external_id: externalId,
      run_id: "old-run",
      created_at: expired,
      updated_at: expired,
    }), "utf8");
    writeFileSync(storageFile, JSON.stringify({ tl_corpus_v1: "77" }), "utf8");

    assert.equal(cleanupExpiredPartnerRuns(90), 2);
    assert.equal(existsSync(runFile), false);
    assert.equal(existsSync(storageFile), false);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});
