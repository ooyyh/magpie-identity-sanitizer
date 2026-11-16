# magpie-identity-sanitizer

一个 magpie 网关插件：**在所有渠道上**拆掉上游的「agent 身份句指纹」，避免
`403 非法请求 / 内容过滤` 被宿主误报成「API 密钥无效」。

> 完整的分步教程（安装、验证、排错、更新、选项）见 [TUTORIAL.md](./TUTORIAL.md)。

## 它解决的是什么

2026-11-16 直打上游实测（Marvis）：

| system prompt 首行 | 结果 |
|---|---|
| `You are an AI agent powered by DeepSeek Harness.` | 403 |
| `You are an AI agent powered by DeepSeek-Harness.` | 403（旧改写已失效） |
| `You are an AI agent running in OpenCode, a coding agent harness.` | 403 |
| `You are a coding agent running in the Codex CLI.` | 403 |
| `You are Claude Code, Anthropic's official CLI for Claude.` | 403 |
| 上面任意一句**句首加一个非空白字符**（`x` / `-` / `·` / U+200B / U+200C） | 200 |
| 同一句放到第 2 行 | 200 |

上游匹配的是「**行首 + 身份骨架**」，不是某个固定整句。所以这个插件不维护
「产品名 → 改写」列表，而是从被匹配的维度入手：**让 system prompt 的第一行
不以字母开头**。默认加一个 `- ` 前缀（列表项，语义无害）。

> ⚠ 2026-11-16 复测：**零宽字符不保险**。裸的 U+200C / U+200B 会被上游归一化
> 掉（`‌You are…` 仍 403），而 `- You are…` / `x You are…` 稳定 200。所以默认
> 用可见的 `- `，`zwnj` / `zwsp` 只保留给想自己承担风险的人。

这也意味着：以后上游再新增什么身份句（新的 CLI、新的模型、中文写法），
**不需要改插件**——行首已经不是身份句了。

## 为什么是 gateway hook，而不是某个供应商插件

magpie 的 `magpie.hooks`（Bun 进程）在每个 **agent 请求**、**每个供应商**、
**每种协议**（chat / responses / anthropic / gemini）上都跑一次，且在路由之前。
所以 marvis、zcode、workbuddy、trae、minimax、qoder……一次全覆盖，不用给每家
供应商各写一遍。

插件用异步 hooks 而不是同步 middleware，是因为 hooks 能 `import node:fs`，
可以把「仍然失败的首行」写进日志并学习。

## 安装

```powershell
magpie plugin add E:\ZProject\ai-dialog-change\magpie-plugins\identity-sanitizer
```

> 用**文件夹路径**安装。magpie 会从文件夹里读 `README.md` 显示在插件详情页；
> 如果按单文件路径安装，magpie 会把文件路径当成插件文件夹，读 README 时
> 报 `open ...\identity-sanitizer.hooks.mjs: The system cannot find the path specified`。

安装后 `magpie plugin list` 应该能看到 `magpie-identity-sanitizer`，并带
`Request hook` 徽章。第一次请求会自动加载（最多 1 秒）。

## 默认行为

- 只看 **system / developer** 消息的第一行；user / assistant 不动。
- 第一行第一个非空白字符是**字母**（`You` / `你` / `Act` …）才处理；
  已经是 `-` / `#` / `<` / `*` / 引号 开头的不动（上游本来就匹配不到行首）。
- 已经带 marker 的不再重复添加（幂等，prompt cache 稳定）。
- 不碰 `model`、`stream`、`tools`、`tool_choice`。
- 支持 chat / responses / anthropic / gemini 四种请求形状。

## 选项

```powershell
# 看当前选项
magpie plugin options magpie-identity-sanitizer

# 改选项
magpie plugin options magpie-identity-sanitizer '{"mode":"smart","marker":"dash","log":true}'
```

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `always` | `always`：首行以字母开头就处理（最省心，新指纹免维护）；`smart`：只处理身份句（`You are…` / `你是…` / `Act as…`）；`off`：关闭 |
| `marker` | `dash` | `dash`（`- `）、`dot`（`· `）、`zwnj`（U+200C）、`zwsp`（U+200B），或任意非空白字符串。零宽字符可能被上游归一化，默认不用 |
| `learn` | `true` | `smart` 模式下，把仍然失败的句首写进 `learned.json`，下次自动处理 |
| `log` | `true` | 把内容过滤失败写进 `events.jsonl` |
| `logDir` | 空 | 状态目录，默认 `~/.config/magpie/identity-sanitizer` |
| `smartPattern` | 内置 | `smart` 模式的身份句正则（不区分大小写） |
| `maxLine` | `400` | 日志里首行截断长度 |

## 诊断新指纹

如果某天又出现 403，先看日志：

```powershell
Get-Content "$HOME\.config\magpie\identity-sanitizer\events.jsonl" -Tail 20
```

每行是一个 JSON，包含 `protocol` / `model` / `agent` / `status` / `firstLine` /
`error`。`firstLine` 就是上游拦的那一句。

- 想让它自动处理：把 `mode` 切到 `always`（最稳），或保留 `smart` 让它把
  新首行学进 `learned.json`。
- 想回滚：`magpie plugin off magpie-identity-sanitizer` 或
  `magpie plugin rm magpie-identity-sanitizer`。

## 测试

```powershell
node --test .\test\identity-sanitizer.test.mjs
```

20 项，覆盖四种协议、幂等、`mode` / `marker`、不改 model/stream/tools、
失败日志与学习。

## 已验证

2026-11-16，本机 magpie 0.1.4260，Marvis 渠道（插件开启、`marker: "dash"`）：

- `You are an AI agent powered by  DeepSeek Harness.`（**双空格，旧 plugin 改写不到的最坏情况**）→ 200
- `You are an AI agent running in OpenCode, a coding agent harness.` → 200
- `You are a coding agent running in the Codex CLI.` → 200
- `You are Claude Code, Anthropic's official CLI for Claude.` → 200
- 中文「你是一个由 DeepSeek Harness 驱动的 AI 智能体。」→ 200
- 全新指纹 `You are an AI agent running in Cursor.` / `… in Trae.` → 200
- `marvis/hy3`、`marvis/deepseek-v4-1-flash-261017`、
  `marvis/deepseek-v4-1-flash-261017-antidowngrade` → 200

同一组句子在插件关闭时仍然是 403，确认是这个 hook 起的作用。

## 已知边界

- 只处理 **system / developer** 消息的第一行；如果上游以后改成拦第 2 行，
  把 `smartPattern` 换成自己的规则，或把 `mode` 保持 `always` 并扩展
  `sanitizeText` 的行选择。
- `marker` 是**可见**的 `- `（零宽字符会被上游归一化，实测不可靠）。
  如果某个客户端对 system prompt 开头极敏感，可以换 `dot` / 自定义。
- 插件跑在 Bun 插件宿主里；宿主没启动时（所有 provider 插件都停用）它也不在。
  这和 magpie 的其他 provider 插件是同一生命周期。
