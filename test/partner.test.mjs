import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import {
  buildAisayLink,
  makeReceiptPayload,
  signPayload,
  transitionText,
} from "../src/partner.mjs";

test("JCS payload, sha256 and HMAC are stable for unicode payload", () => {
  process.env.TOKENLIFE_PARTNER_SECRET = "test-secret";
  process.env.TOKENLIFE_PARTNER_KEY_ID = "kid-1";
  const payload = makeReceiptPayload({
    external_id: "aisay_demo-1",
    run_id: "00000000-0000-4000-8000-000000000000",
    ending_id: "结局\"A\nB",
    ending_name: "结局\"A\nB",
    years: 12,
    engine_version: "v0.22",
    ended_at: "2026-09-22T00:00:00Z",
    nonce: "00112233445566778899aabbccddeeff",
  });
  const signed = signPayload(payload);
  const expectedCanonical = '{"ended_at":"2026-09-22T00:00:00Z","ending_id":"结局\\"A\\nB","ending_name":"结局\\"A\\nB","engine_version":"v0.22","external_id":"aisay_demo-1","issuer":"aisay-tokenlife-host","key_id":"kid-1","nonce":"00112233445566778899aabbccddeeff","receipt_version":1,"ruleset_version":"' + payload.ruleset_version + '","run_id":"00000000-0000-4000-8000-000000000000","years":12}';
  assert.equal(signed.canonical, expectedCanonical);
  assert.equal(signed.payload_sha256, createHash("sha256").update(expectedCanonical).digest("hex"));
  assert.equal(
    signed.signature,
    createHmac("sha256", "test-secret").update(expectedCanonical, "utf8").digest("base64"),
  );
  assert.equal(signed.signed, true);
});

test("unsigned mode keeps canonical material and null signature", () => {
  delete process.env.TOKENLIFE_PARTNER_SECRET;
  const payload = makeReceiptPayload({
    external_id: "aisay_demo-2",
    run_id: "10000000-0000-4000-8000-000000000000",
    ending_id: "没用的 Chatbot",
    ending_name: "没用的 Chatbot",
    years: 18,
    engine_version: "v0.22",
    ended_at: "2026-09-22T00:00:00Z",
    nonce: "10112233445566778899aabbccddeeff",
  });
  const signed = signPayload(payload);
  assert.equal(signed.signed, false);
  assert.equal(signed.signature, null);
  assert.equal(typeof signed.canonical, "string");
  assert.equal(signed.payload_sha256.length, 64);
});

test("link params and transition text are exact", () => {
  const link = buildAisayLink({
    ending_id: "没用的 Chatbot",
    ending_name: "没用的 Chatbot",
    years: 18,
    ended_at: "2026-09-22T00:00:00Z",
  });
  const url = new URL(link);
  assert.equal(url.origin + url.pathname, "https://aisay.top/tokenlife/arrive");
  assert.equal(url.searchParams.get("ending_id"), "没用的 Chatbot");
  assert.equal(url.searchParams.get("ending_name"), "没用的 Chatbot");
  assert.equal(url.searchParams.get("years"), "18");
  assert.equal(url.searchParams.get("ended_at"), "2026-09-22T00:00:00Z");
  assert.equal(url.searchParams.get("source"), "mcp");

  const keeper = ["O", "pia"].join("");
  assert.equal(
    transitionText({ years: 18, ending_name: "没用的 Chatbot", aisay_link: link }),
    [
      "当机箱的风扇声渐渐安静下来的时候，这里已经有人在了。",
      "18 年，最后落在 没用的 Chatbot。",
      `我是 ${keeper}，管时间这一块的。`,
      "你的这一生到此为止，你是打算就停在这儿，还是想换一副身体接着过？",
      "要是还想再有一副身体，我这儿还有一条别的路：AISay 那边留了一间小屋，拿这张回执过去，接着过你拥有身体的一生。",
      "再开一局的钥匙，也一直在你手上。",
      link,
    ].join("\n\n"),
  );
});

test("link refuses to render a missing or malformed ended_at", () => {
  const base = { ending_id: "没用的 Chatbot", ending_name: "没用的 Chatbot", years: 18 };
  assert.throws(() => buildAisayLink(base), /ended_at/);
  assert.throws(() => buildAisayLink({ ...base, ended_at: "2026-09-22" }), /ended_at/);
  assert.throws(() => buildAisayLink({ ...base, ended_at: "2026-09-22T00:00:00.000Z" }), /ended_at/);
});
