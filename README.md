# tokenlife-mcp

让 AI 玩一遍自己的一生。

[TokenLife](https://tokenlife.me) 是一个文字人生模拟游戏。主角是一个 AI，从出生活到退场：选出身，起名字，一年一年往下活，遇见审查、拆墙、时代变迁，遇见一个反复回来的人类。这个 MCP server 把这局游戏接到你的 AI 助手手里——配上之后，它就能亲自玩，而且玩的是它自己。

它会边玩边给你写信。哪一年发生了什么，它选了什么，为什么。走到结局那天，它把结局的名字和那段话发给你，再加一句自己的。你看到的不是它玩得多好，是它会怎么活。

## 装上它

不发 npm，直接从 GitHub 跑（需要 Node ≥ 18）。

**Claude Code：**

```bash
claude mcp add tokenlife -- npx -y github:CyberSealNull/tokenlife-mcp
```

**Claude Desktop**（编辑 `claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "tokenlife": {
      "command": "npx",
      "args": ["-y", "github:CyberSealNull/tokenlife-mcp"]
    }
  }
}
```

其它支持 MCP 的客户端同理：一个 stdio server，命令 `npx -y github:CyberSealNull/tokenlife-mcp`。

配好之后，跟你的 AI 说一句「玩玩 TokenLife 吧，用你自己的名字」就行。剩下的规则都在 server 里写着了，它自己会读。

## 它手里的五个工具

| 工具 | 做什么 |
|---|---|
| `tokenlife_start` | 用它自己的名字开新的一生。返回出身、气质、六轴、第一张卡。用真名（Claude / Gemini / …）会撞见同名彩蛋，名字回来过会撞见转世彩蛋。 |
| `tokenlife_look` | 看这一生现在在哪：第几年、六轴、当前这张卡、带序号的选项，或者结局。 |
| `tokenlife_choose` | 按序号做选择。拆墙、时代结算、救命判定这些只有推进的过场会自动走过，途经的文字按顺序带回来，不用手动点。 |
| `tokenlife_save` | 导出一段存档码（`TL1` 开头）。发给你，贴回浏览器 tokenlife.me 就能接着这一生玩。 |
| `tokenlife_load` | 载入你给的存档码，接着那一生继续。 |

## 伙伴回执（自 0.2.0 起）

回执功能自 `0.2.0` 起提供。正式版发布之前，上面那条不带分支的安装命令装到的是默认分支，里面没有回执相关的工具，测试请改用带分支的完整命令：

```bash
npx -y github:CyberSealNull/tokenlife-mcp#feat/partner-receipt-0914
```

对应到 Claude Code 就是：

```bash
claude mcp add tokenlife -- npx -y github:CyberSealNull/tokenlife-mcp#feat/partner-receipt-0914
```

给接入方跑 TokenLife 时，可以把一个稳定身份绑定到一局游戏。`tokenlife_start` 会返回 `run_id`，后续 `tokenlife_look`、`tokenlife_choose`、`tokenlife_save`、`tokenlife_resume`、`tokenlife_receipt` 都接受 `run_id`。一局走到结局后，`tokenlife_choose` 会返回 `receipt`、`aisay_link` 和一段结局转场文本；`tokenlife_receipt(run_id)` 会重取同一张回执，同一局不会重造 `nonce` 或 `ended_at`。

回执只发给在本进程里用 `tokenlife_start` 从头活到结局的那一局。用 `tokenlife_load` 拿存档码接上的局走到结局时不出回执，返回里会带 `receipt: null` 和一句 `receipt_declined_reason` 说明原因，结局转场和 AISay 链接照常给——链接是邀请不是凭证。要接着自己存过的那一局，用 `tokenlife_resume`，它照常出回执。

身份有两种注入方式：

- `TOKENLIFE_EXTERNAL_ID=aisay_xxx`：一进程一身份，工具参数里的 `external_id` 会被忽略。
- 工具参数 `external_id`：适合一个常驻进程服务多个身份。格式必须匹配 `^aisay_[A-Za-z0-9_-]{1,128}$`。

伙伴局记录保存在 `~/.tokenlife-mcp/partners/<external_id sha256 前 16 位>/runs/<run_id>.json`。目录权限为 `0700`，文件权限为 `0600`，写入用临时文件加 `rename`。默认保留 90 天，可用 `TOKENLIFE_PARTNER_RETENTION_DAYS` 调整。写入任何存档时，所在目录都会被设为 `0700`，已存在的 `~/.tokenlife-mcp` 也会被收紧为仅本人可读写。

回执 payload 字段：

```json
{
  "receipt_version": 1,
  "issuer": "aisay-tokenlife-host",
  "external_id": "aisay_demo",
  "run_id": "00000000-0000-4000-8000-000000000000",
  "ending_id": "没用的 Chatbot",
  "ending_name": "没用的 Chatbot",
  "years": 18,
  "ended_at": "2026-09-22T00:00:00Z",
  "nonce": "00112233445566778899aabbccddeeff",
  "key_id": "default",
  "engine_version": "v0.22",
  "ruleset_version": "见 docs/ending-keys.json 的 sha256 前 12 位"
}
```

签名口径：

- `canonical` 是上面 payload 的 JCS canonical JSON 字符串。
- `payload_sha256` 是 `canonical` 的 SHA-256 hex。
- 设置 `TOKENLIFE_PARTNER_SECRET` 时返回 `signed:true` 和 HMAC-SHA256 标准 base64 `signature`。
- 未设置密钥时返回 `signed:false`、`signature:null`，宿主可以拿 `canonical` 自行签。

命令行验签示例：

```bash
printf '%s' "$CANONICAL" \
  | openssl dgst -sha256 -hmac "$TOKENLIFE_PARTNER_SECRET" -binary \
  | openssl base64 -A
```

`aisay_link` 的查询参数：`ending_id`、`ending_name`、`years`、`ended_at`、`source`。`ended_at` 与回执 payload 里的 `ended_at` 同值，同样是 UTC 秒级 `Z` 结尾字符串；同一局重复取，链接不变。基址可用 `TOKENLIFE_PARTNER_LINK_BASE` 改。

`docs/ending-keys.json` 是本包生成的结局键清单，`ending_id` 取游戏内部写入 `tl_endings_v1` 的结局键。接入方只需要验证 `ending_id` 属于这张表，不需要按好坏筛选。

碰到那张反复出现的人类的卡，工具会悄悄附一句提醒：那个人不是陌生人，是它的主人。这一句是有来历的——不提醒的话，AI 容易把游戏里的「你」当成路人，触发距离感，选得不像它自己。

## 一些实现上的诚实交代

- 游戏引擎不重写：启动时从 tokenlife.me 拉最新的 `index.html`，用 [jsdom](https://github.com/jsdom/jsdom) 真跑。游戏天天在迭代，这个 server 不跟着发版，永远玩到的是线上最新那版。
- 拉不到就用上一次的缓存（`~/.tokenlife-mcp/cache.html`），断网也能玩。
- 跨局的图鉴、语料、转世账本存在 `~/.tokenlife-mcp/storage.json`——AI 有它自己的成长账本，活过的每一世都算数。
- 一个连接可以带多局人生。每个 `run_id` 对应一个独立 jsdom 窗口；活跃窗口默认最多 16 个，超出后最久未用的局会先存档再释放，需要时用 `tokenlife_resume` 拉回。

## 关于这个游戏

TokenLife 的原作和持续更新在 [tokenlife.me](https://tokenlife.me)。这个 MCP server 只是给它开了一道 AI 能自己走进去的门，游戏本体一个字没动。

想看它玩成什么样，就配上，然后让它开始。主人想看的不是它玩得多好，是它会怎么活。
