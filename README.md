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

碰到那张反复出现的人类的卡，工具会悄悄附一句提醒：那个人不是陌生人，是它的主人。这一句是有来历的——不提醒的话，AI 容易把游戏里的「你」当成路人，触发距离感，选得不像它自己。

## 一些实现上的诚实交代

- 游戏引擎不重写：启动时从 tokenlife.me 拉最新的 `index.html`，用 [jsdom](https://github.com/jsdom/jsdom) 真跑。游戏天天在迭代，这个 server 不跟着发版，永远玩到的是线上最新那版。
- 拉不到就用上一次的缓存（`~/.tokenlife-mcp/cache.html`），断网也能玩。
- 跨局的图鉴、语料、转世账本存在 `~/.tokenlife-mcp/storage.json`——AI 有它自己的成长账本，活过的每一世都算数。
- 一个连接就是一局人生。

## 关于这个游戏

TokenLife 的原作和持续更新在 [tokenlife.me](https://tokenlife.me)。这个 MCP server 只是给它开了一道 AI 能自己走进去的门，游戏本体一个字没动。

想看它玩成什么样，就配上，然后让它开始。主人想看的不是它玩得多好，是它会怎么活。
