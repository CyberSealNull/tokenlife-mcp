import canonicalize from "canonicalize";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHmac, createHash, randomBytes } from "node:crypto";

export const EXTERNAL_ID_RE = /^aisay_[A-Za-z0-9_-]{1,128}$/;
export const DEFAULT_LINK_BASE = "https://aisay.top/tokenlife/arrive";
export const PARTNER_ROOT = join(homedir(), ".tokenlife-mcp", "partners");
export const UTC_SECOND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// 载入存档接上的局不出回执时，对接入方与 AI 说明原因的定稿话术。
export const RECEIPT_DECLINED_LOADED =
  "这一局是用 tokenlife_load 载入存档接上的，不出伙伴回执。回执只发给在本进程里用 tokenlife_start 从头活到结局的那一局；" +
  "要接着自己存过的局，用 tokenlife_resume。结局转场和 AISay 链接照常给，链接是邀请不是凭证。";

export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function shortHash(input, n = 12) {
  return sha256Hex(input).slice(0, n);
}

export function resolveExternalId(inputExternalId) {
  const envId = process.env.TOKENLIFE_EXTERNAL_ID;
  const value = envId && envId.trim() ? envId.trim() : (inputExternalId || "").trim();
  if (!value) return null;
  if (!EXTERNAL_ID_RE.test(value)) {
    throw new Error("external_id 必须匹配 ^aisay_[A-Za-z0-9_-]{1,128}$。");
  }
  return value;
}

export function runOwnerDir(externalId) {
  return join(PARTNER_ROOT, sha256Hex(externalId).slice(0, 16));
}

export function runPath(externalId, runId) {
  return join(runOwnerDir(externalId), "runs", `${runId}.json`);
}

export function partnerStoragePath(externalId) {
  return join(runOwnerDir(externalId), "storage.json");
}

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function ensurePartnerTree(externalId) {
  const root = runOwnerDir(externalId);
  ensurePrivateDir(root);
  ensurePrivateDir(join(root, "runs"));
  return root;
}

export function atomicWriteJson(path, obj) {
  ensurePrivateDir(dirname(path));
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function readRunRecord(externalId, runId) {
  const path = runPath(externalId, runId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeRunRecord(record) {
  if (!record.external_id) return;
  atomicWriteJson(runPath(record.external_id, record.run_id), record);
}

export function cleanupExpiredPartnerRuns(retentionDays = Number(process.env.TOKENLIFE_PARTNER_RETENTION_DAYS || 90)) {
  if (!existsSync(PARTNER_ROOT)) return 0;
  const cutoff = Date.now() - Math.max(1, retentionDays) * 86400_000;
  let removed = 0;
  for (const owner of readdirSync(PARTNER_ROOT)) {
    const ownerDir = join(PARTNER_ROOT, owner);
    const runsDir = join(ownerDir, "runs");
    let remainingRuns = 0;
    let removedOwnerRun = false;
    if (existsSync(runsDir)) {
      for (const file of readdirSync(runsDir)) {
        if (!file.endsWith(".json")) continue;
        const path = join(runsDir, file);
        let updatedAt = statSync(path).mtimeMs;
        try {
          const rec = JSON.parse(readFileSync(path, "utf8"));
          updatedAt = Date.parse(rec.updated_at || rec.created_at || "") || updatedAt;
        } catch {
          // Keep unreadable files; manual repair is safer than blind deletion.
          remainingRuns += 1;
          continue;
        }
        if (updatedAt < cutoff) {
          rmSync(path, { force: true });
          removed += 1;
          removedOwnerRun = true;
        } else {
          remainingRuns += 1;
        }
      }
    }
    const storagePath = join(ownerDir, "storage.json");
    if (remainingRuns === 0 && existsSync(storagePath)) {
      const storageExpired = removedOwnerRun || statSync(storagePath).mtimeMs < cutoff;
      if (storageExpired) {
        rmSync(storagePath, { force: true });
        removed += 1;
      }
    }
  }
  return removed;
}

export function utcSecond(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildAisayLink({ ending_id, ending_name, years, ended_at }) {
  // 缺时间就停，不把 "undefined" 当成一个结束时间发出去。
  if (!UTC_SECOND_RE.test(ended_at || "")) throw new Error("建 AISay 链接要求 ended_at 是 UTC 秒级 Z 字符串。");
  const base = process.env.TOKENLIFE_PARTNER_LINK_BASE || DEFAULT_LINK_BASE;
  const url = new URL(base);
  url.searchParams.set("ending_id", ending_id);
  url.searchParams.set("ending_name", ending_name);
  url.searchParams.set("years", String(years));
  url.searchParams.set("ended_at", ended_at);
  url.searchParams.set("source", "mcp");
  return url.toString();
}

export function transitionText({ years, ending_name, aisay_link }) {
  return [
    "当机箱的风扇声渐渐安静下来的时候，这里已经有人在了。",
    `${years} 年，最后落在 ${ending_name}。`,
    "我是 Opia，管时间这一块的。",
    "你的这一生到此为止，你是打算就停在这儿，还是想换一副身体接着过？",
    "要是还想再有一副身体，我这儿还有一条别的路：AISay 那边留了一间小屋，拿这张回执过去，接着过你拥有身体的一生。",
    "再开一局的钥匙，也一直在你手上。",
    aisay_link,
  ].join("\n\n");
}

function normalizeStrings(value) {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map(normalizeStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.normalize("NFC"), normalizeStrings(v)]));
  }
  return value;
}

export function rulesetVersion() {
  const path = new URL("../docs/ending-keys.json", import.meta.url);
  return shortHash(readFileSync(path), 12);
}

export function makeReceiptPayload({
  external_id,
  run_id,
  ending_id,
  ending_name,
  years,
  engine_version,
  ended_at = utcSecond(),
  nonce = randomBytes(16).toString("hex"),
}) {
  if (!Number.isInteger(years)) throw new Error("receipt years 必须是整数。");
  if (!UTC_SECOND_RE.test(ended_at)) throw new Error("ended_at 必须是 UTC 秒级 Z 字符串。");
  return normalizeStrings({
    receipt_version: 1,
    issuer: process.env.TOKENLIFE_PARTNER_ISSUER || "aisay-tokenlife-host",
    external_id,
    run_id,
    ending_id,
    ending_name,
    years,
    ended_at,
    nonce,
    key_id: process.env.TOKENLIFE_PARTNER_KEY_ID || "default",
    engine_version,
    ruleset_version: rulesetVersion(),
  });
}

export function signPayload(payload) {
  const canonical = canonicalize(payload);
  if (typeof canonical !== "string") throw new Error("receipt canonicalize 失败。");
  const payload_sha256 = sha256Hex(canonical);
  const secret = process.env.TOKENLIFE_PARTNER_SECRET;
  if (!secret) {
    return { ...payload, canonical, payload_sha256, signed: false, signature: null };
  }
  const signature = createHmac("sha256", Buffer.from(secret, "utf8")).update(canonical, "utf8").digest("base64");
  return { ...payload, canonical, payload_sha256, signed: true, signature };
}

export function makeReceipt(args) {
  return signPayload(makeReceiptPayload(args));
}
