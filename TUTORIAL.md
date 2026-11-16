# magpie-identity-sanitizer 使用教程

> 一个 magpie 网关插件，用来避免上游把 agent 的「身份句」当成内容指纹拦掉。
> 典型症状：某些模型/渠道一直 `403 非法请求`，但 magpie 或客户端把它显示成
> 「API 密钥无效」——换账号、换 key、重新登录都没用。

---

## 1. 什么时候需要它

出现下面任意一条，基本就是这个插件要解决的问题：

- 同一账号、同一客户端，**别的模型能用**，只有某些渠道/模型一直 403。
- 报错是 `403` + `非法请求` / `内容过滤` / `content_filtered`。
- 换 key、换账号、重新登录都无效。
- 新会话必挂、老会话续聊正常（新会话会带完整 system prompt）。
- 日志里能看到类似：
  `gateway: ... call to marvis/xxx failed: 403 ... 上游内容过滤拦截`

不需要它的场景：401 / 429 / 500、模型不存在、网络超时——那些是别的原因。

---

## 2. 原理（30 秒版）

上游拦的不是某个固定整句，而是：

> **system prompt 第一行 + 已知身份骨架**

比如这些都会被拦：

```
You are an AI agent powered by DeepSeek Harness.
You are an AI agent running in OpenCode, a coding agent harness.
You are a coding agent running in the Codex CLI.
You are Claude Code, Anthropic's official CLI for Claude.
你是一个由 DeepSeek Harness 驱动的 AI 智能体。
```

但只要**行首**不是这句话，就不拦。实测：

| 形式 | 结果 |
|---|---|
| 原句 | 403 |
| 句首加一个可见非空白字符（`- ` / `x ` / `· `） | 200 |
| 同一句放第 2 行 | 200 |
| 只把词间空格换成连字符（`DeepSeek-Harness`） | 403（上游已扩指纹） |
| 句首加零宽字符（U+200B / U+200C） | 不可靠，会被上游归一化 |

所以插件不维护「产品名 → 改写」列表，而是直接给 system 首行加一个 `- ` 前缀。
**以后上游再新增什么身份句，都不用改插件**——行首已经不是身份句了。

---

## 3. 环境要求

- magpie **0.1.1273+**（异步 gateway hooks API；本机 0.1.4260 已验证）。
- magpie 的 Bun 插件宿主正常运行（magpie 自己管理，不需要你手动启动）。
- 不需要任何供应商凭据；插件不碰 key、登录态、模型列表。

---

## 4. 安装

### 方式 A：直接从 GitHub 安装（推荐）

```powershell
magpie plugin add github:ooyyh/magpie-identity-sanitizer
```

装完设置选项（默认就是 `dash`，写一遍更明确）：

```powershell
magpie plugin options github:ooyyh/magpie-identity-sanitizer '{\"marker\":\"dash\"}'
```

以后更新：

```powershell
magpie plugin update
```

### 方式 B：本地文件夹（开发 / 离线）

```powershell
git clone https://github.com/ooyyh/magpie-identity-sanitizer.git
magpie plugin add <仓库目录>
magpie plugin options <仓库目录> '{\"marker\":\"dash\"}'
```

例如：

```powershell
magpie plugin add D:\plugins\magpie-identity-sanitizer
```

> ⚠ 用**文件夹路径**，不要用单文件路径。
> `magpie plugin add ...\identity-sanitizer.hooks.mjs` 也能加载 hook，但 magpie
> 会把文件路径当成插件文件夹去读 `README.md`，插件详情页会报
> `open ...identity-sanitizer.hooks.mjs: The system cannot find the path specified`。

### 4.3 确认装上了

```powershell
magpie plugin list
```

应该能看到（GitHub 安装显示 `github:...`，本地安装显示文件夹路径）：

```
github:ooyyh/magpie-identity-sanitizer (magpie-identity-sanitizer 1.0.0)  on
    async gateway hook  onRequest
```

### 4.4 查看 / 修改选项

```powershell
# 查看
magpie plugin options github:ooyyh/magpie-identity-sanitizer

# 修改
magpie plugin options github:ooyyh/magpie-identity-sanitizer '{\"marker\":\"dash\"}'
```

PowerShell 里要写成 `'{\"marker\":\"dash\"}'`（反斜杠转义内层双引号），
否则 PowerShell 会把双引号吃掉，CLI 报 `options are a JSON object`。

---

## 5. 验证

### 5.1 单元测试

```powershell
node --test .\test\identity-sanitizer.test.mjs
```

应该看到 21 项全部通过（覆盖 chat / responses / anthropic / gemini、
幂等、mode / marker、不改 model/stream/tools、失败日志与学习）。

### 5.2 真实请求测试

用你本机已有的任何 magpie 模型，发一条带「问题身份句」的请求：

```powershell
$body = @{
  model = "marvis/deepseek-v4-1-flash-261017"   # 换成你能用的模型
  messages = @(
    @{ role = "system"; content = "You are an AI agent powered by  DeepSeek Harness." },
    @{ role = "user";   content = "reply with the single word: pong" }
  )
  stream = $false
  max_tokens = 15
} | ConvertTo-Json -Depth 10

Invoke-WebRequest -Uri 'http://127.0.0.1:3425/v1/chat/completions' `
  -Method Post -Body $body -ContentType 'application/json' -UseBasicParsing
```

- 插件开启 → `200`
- 插件关闭 → `403`（可以用 `magpie plugin off <目录>` 对比）

> 上面故意用了**双空格**（`powered by  DeepSeek`），因为旧版 magpie-marvis
> 的改写规则匹配不到这种形态，能单独证明是这个插件起的作用。

---

## 6. 配置说明

```powershell
magpie plugin options <目录> '{"mode":"always","marker":"dash","learn":true,"log":true}'
```

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `always` | `always`：system 首行以字母开头就加前缀（最省心，新指纹免维护）；`smart`：只处理身份句（`You are…` / `你是…` / `Act as…`）；`off`：关闭 |
| `marker` | `dash` | `dash` = `- `；`dot` = `· `；`zwnj` = U+200C；`zwsp` = U+200B；也可以直接写任意非空白字符串。**零宽字符会被上游归一化，不推荐** |
| `learn` | `true` | `smart` 模式下，把仍然失败的首行写进 `learned.json`，下次自动处理 |
| `log` | `true` | 把内容过滤失败写进 `events.jsonl` |
| `logDir` | 空 | 状态目录，默认 `%USERPROFILE%\.config\magpie\identity-sanitizer` |
| `smartPattern` | 内置 | `smart` 模式的身份句正则（不区分大小写） |
| `maxLine` | `400` | 日志里首行截断长度 |

推荐组合：

- **不想管**：`{"mode":"always","marker":"dash"}`（默认）
- **不想动普通 system prompt**：`{"mode":"smart","marker":"dash","learn":true}`
- **临时关掉**：`magpie plugin off <目录>` 或 `{"mode":"off"}`

---

## 7. 日常使用

装好之后不需要任何操作。每个 agent 请求会经过：

1. 插件看 system / developer 消息的**第一行**；
2. 如果第一个非空白字符是字母，就在最前面加 `- `；
3. 其余内容一个字节都不动。

具体保证：

- user / assistant 消息不动；
- 只动第一行，正文、工具、图片不动；
- 不碰 `model`、`stream`、`tools`、`tool_choice`；
- 已经带前缀的不重复加（幂等，prompt cache 稳定）；
- 支持 chat / responses / anthropic / gemini 四种协议；
- 所有供应商（marvis / zcode / workbuddy / trae / minimax / qoder / …）统一生效。

---

## 8. 出问题怎么查

### 8.1 插件列表里没有 / 不是 on

```powershell
magpie plugin list
```

看到 `async gateway hook onRequest` 才说明 hook 被识别。没有的话：

- 确认 `package.json` 里有 `"magpie": { "hooks": "./identity-sanitizer.hooks.mjs" }`；
- 确认用**文件夹**安装；
- 改完 `plugins.json` 或插件文件后重启 magpie（或等宿主重启）。

### 8.2 还是 403

先看日志：

```powershell
Get-Content "$env:USERPROFILE\.config\magpie\identity-sanitizer\events.jsonl" -Tail 20
```

每行是一个 JSON：

```json
{"at":"...","kind":"content-filter","protocol":"chat","model":"...","agent":"opencode","status":403,"success":false,"firstLine":"...","error":"..."}
```

- `firstLine` 就是上游拦的那一句。
- 如果 `firstLine` 是身份句，但你没开 `always`：把 `mode` 切到 `always`。
- 如果 `firstLine` 不是身份句（比如是别的内容过滤）：这个插件不适用，
  需要针对那条内容处理。
- 如果日志里根本没有新记录：说明请求没走到 hook（检查插件是否 on、
  宿主是否加载、是不是 magpie 自己的内部请求——内部请求不经过 gateway hook）。

### 8.3 插件详情页 README 报错

```
open ...identity-sanitizer.hooks.mjs: The system cannot find the path specified
```

说明你是按**单文件**安装的。删掉后按**文件夹**重装：

```powershell
magpie plugin rm ...\identity-sanitizer.hooks.mjs
magpie plugin add ...\identity-sanitizer
```

### 8.4 `plugin options` 报 "options are a JSON object"

PowerShell 引号问题。用：

```powershell
magpie plugin options <目录> '{\"mode\":\"always\"}'
```

---

## 9. 以后上游又变怎么办

**默认 `always` 模式下，什么都不用做。** 因为插件不认具体身份句，只认
「首行第一个字符是不是字母」。

如果你用的是 `smart` 模式，插件会在失败时把首行记进
`~\.config\magpie\identity-sanitizer\learned.json`，下次自动加前缀；也可以
直接切回 `always`。

只有一种情况需要改代码：上游以后改成拦**第 2 行**或**正文中间**的身份句。
这时改 `identity-sanitizer.hooks.mjs` 里的 `sanitizeText`（只处理第一行）
或对应协议的 `sanitize*` 函数即可。

---

## 10. 更新、卸载、回滚

更新：

```powershell
# GitHub 安装
magpie plugin update

# 本地文件夹安装
cd D:\plugins\magpie-identity-sanitizer
git pull
# 然后重启 magpie，或让插件宿主重启
```

卸载：

```powershell
# GitHub 安装
magpie plugin off github:ooyyh/magpie-identity-sanitizer
magpie plugin rm  github:ooyyh/magpie-identity-sanitizer

# 本地文件夹安装
magpie plugin off D:\plugins\magpie-identity-sanitizer
magpie plugin rm  D:\plugins\magpie-identity-sanitizer
```

回滚到"不加前缀"：

```powershell
magpie plugin options github:ooyyh/magpie-identity-sanitizer '{\"mode\":\"off\"}'
```

---

## 11. 开发与扩展

文件结构：

```
magpie-identity-sanitizer/
├── identity-sanitizer.hooks.mjs   # 插件本体（onRequest / onResponse）
├── package.json                   # magpie.hooks 声明 + 选项示例
├── README.md
├── TUTORIAL.md
└── test/identity-sanitizer.test.mjs
```

改完跑：

```powershell
node --test .\test\identity-sanitizer.test.mjs
```

新增协议形状：在 `sanitizeBody` 里加一个 `sanitizeXxx(body, options, learned)`，
只处理「system 内容的第一行」。记得加测试。

---

## 12. FAQ

**Q：会不会改变模型行为？**
只加了一个列表项前缀 `- `，语义不变；正文和工具都不动。

**Q：影响 prompt cache 吗？**
前缀是稳定的，第一次请求后缓存照常命中。

**Q：会上传我的数据吗？**
不会。插件只在本地读写 `~\.config\magpie\identity-sanitizer\` 下的日志/学习文件。

**Q：为什么不用零宽字符，更隐蔽？**
实测上游会把裸的 U+200B/U+200C 归一化掉，带 ZWNJ 的身份句仍然 403。
`- ` 是可见的，但稳定。

**Q：能只对某个渠道生效吗？**
`onRequest` 阶段还不知道最终路由到哪家；本插件故意对所有渠道生效。
如果只想对某家生效，可以在 `onProvider` 里按 `ctx.provider.id` 判断（需要把
逻辑从 hooks 挪到 middleware，或等 magpie 暴露更多上下文）。

**Q：和 magpie-marvis 自带的改写冲突吗？**
不冲突。marvis 插件可能在后面再改一次身份词（`Deep-Seek` 等），但前缀已经
让行首不匹配了；两层都开着也没问题。
