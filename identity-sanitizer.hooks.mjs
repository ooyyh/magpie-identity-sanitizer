// magpie-identity-sanitizer
//
// 上游的「内容过滤」拦的不是某个具体句子，而是 **行首 + 身份骨架**：
//
//   You are an AI agent powered by DeepSeek Harness.        → 403
//   You are an AI agent running in OpenCode, ...            → 403
//   You are a coding agent running in the Codex CLI.        → 403
//   You are Claude Code, Anthropic's official CLI for Claude.→ 403
//
// 2026-11-16 直打上游实测：
//   · 任一**可见的非空白字符**放在句首（x / - / ·）→ 200
//   · 同一句放到第 2 行 → 200
//   · 只改词间连字符（DeepSeek-Harness）→ 现在也 403（上游已扩指纹）
//
// 所以不需要维护「产品名 → 改写」列表：只要让 system prompt 的第一行
// 不以字母开头，全新的指纹也自然失效。
//
// ⚠ 2026-11-16 复测：**零宽字符不保险**。裸的 U+200C / U+200B 会被上游
//   归一化掉（带 ZWNJ 的 `‌You are…` 仍 403），而 `- You are…` / `x You are…`
//   稳定 200。所以默认用可见但无害的 `- ` 前缀。
//
// 这个文件是 magpie 的 **gateway request hook**（Bun 进程，所有供应商、
// 所有协议、每个 agent 请求都会经过），所以 marvis / zcode / workbuddy /
// trae / minimax / qoder ... 一次全覆盖。
//
// 选项（magpie plugin options <name> '<json>'）：
//   mode    "always"（默认，首行以字母开头就处理）| "smart"（只处理身份句）| "off"
//   marker  "dash"（默认）| "dot" | "zwnj" | "zwsp" | 任意非空白字符串
//   learn   smart 模式下，把仍然失败的句首记下来，下次自动处理（默认 true）
//   log     把内容过滤失败写进 events.jsonl，方便定位新指纹（默认 true）
//   logDir  状态目录，默认 ~/.config/magpie/identity-sanitizer

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const HOOK_VERSION = "1.0.0"

// 前缀必须是非空白字符。零宽字符虽然理论上也是 Cf/非空白，但上游会归一化，
// 实测不可靠；`dash` / `dot` / 自定义可见字符才是稳的。
const MARKERS = {
  dash: "- ",
  dot: "· ",
  zwnj: "\u200C", // zero width non-joiner（可能被上游 normalize 掉）
  zwsp: "\u200B", // zero width space（同上）
}

const DEFAULTS = {
  mode: "always",
  marker: "dash",
  learn: true,
  log: true,
  logDir: "",
  // smart 模式用的身份句检测。宁可宽一点：漏掉一个变体就是一次 403。
  smartPattern:
    "^(?:you are|you're|you re|i am|i'm|as an? (?:ai|agent|assistant)|your (?:name|role|job|task)|act as|你是|你是一个|你是一名|你是由|本(?:助手|智能体|模型))",
  maxLine: 400,
}

function option(options, key) {
  const value = options?.[key]
  return value === undefined || value === null ? DEFAULTS[key] : value
}

function markerOf(options) {
  const raw = option(options, "marker")
  if (typeof raw !== "string") return MARKERS.dash
  if (MARKERS[raw]) return MARKERS[raw]
  // 自定义 marker：纯空白挡不住"行首"，退回默认值
  if (raw.length > 0 && !/^\s+$/u.test(raw)) return raw
  return MARKERS.dash
}

function isLetter(ch) {
  return !!ch && /^\p{L}$/u.test(ch)
}

function firstNonWhitespace(text) {
  for (const ch of text) {
    if (!/^\s$/u.test(ch)) return ch
  }
  return ""
}

function firstLine(text) {
  const cut = text.indexOf("\n")
  return cut < 0 ? text : text.slice(0, cut)
}

function normalizeLearned(line) {
  return String(line).replace(/\s+/g, " ").trim().slice(0, 200).toLowerCase()
}

function stateDir(options) {
  return options.logDir || join(homedir(), ".config", "magpie", "identity-sanitizer")
}

let learnedCache = null
let learnedAt = 0

function loadLearned(options) {
  const now = Date.now()
  if (learnedCache && now - learnedAt < 30_000) return learnedCache
  learnedAt = now
  try {
    const raw = readFileSync(join(stateDir(options), "learned.json"), "utf8")
    const list = JSON.parse(raw)
    learnedCache = Array.isArray(list) ? list.filter((x) => typeof x === "string") : []
  } catch {
    learnedCache = []
  }
  return learnedCache
}

function addLearned(options, line) {
  const key = normalizeLearned(line)
  if (!key) return
  const list = loadLearned(options).slice()
  if (list.includes(key)) return
  list.push(key)
  if (list.length > 200) list.splice(0, list.length - 200)
  try {
    mkdirSync(stateDir(options), { recursive: true })
    writeFileSync(join(stateDir(options), "learned.json"), JSON.stringify(list, null, 2) + "\n", "utf8")
    learnedCache = list
    learnedAt = Date.now()
  } catch {
    // 诊断信息永远不能影响请求本身
  }
}

function isLearned(line, learned) {
  const key = normalizeLearned(line)
  if (!key) return false
  return learned.some((x) => key === x || key.startsWith(x))
}

function logLine(options, record) {
  if (!option(options, "log")) return
  try {
    mkdirSync(stateDir(options), { recursive: true })
    appendFileSync(join(stateDir(options), "events.jsonl"), JSON.stringify(record) + "\n", "utf8")
  } catch {
    // 同上：日志失败不影响请求
  }
}

/**
 * 只处理一段文本的**第一行**。
 *
 * - 第一行第一非空白字符是字母（You / 你 / Act ...）才处理；
 *   已经是 - # < * 引号 等非字母开头的，上游本来就匹配不到行首。
 * - 已经带 marker 的原样返回，保证重试/幂等，也让 prompt cache 稳定。
 */
function sanitizeText(text, options, learned) {
  if (typeof text !== "string" || text.length === 0) return text
  if (option(options, "mode") === "off") return text

  const marker = markerOf(options)
  if (!marker || text.startsWith(marker)) return text

  const first = firstNonWhitespace(text)
  if (!isLetter(first)) return text

  if (option(options, "mode") === "smart") {
    const line = firstLine(text)
    let match = false
    try {
      match = new RegExp(option(options, "smartPattern"), "iu").test(line)
    } catch {
      match = false
    }
    if (!match && !isLearned(line, learned)) return text
  }

  return marker + text
}

function textFromParts(parts, keys) {
  if (!Array.isArray(parts)) return ""
  for (const part of parts) {
    if (!part || typeof part !== "object") continue
    for (const key of keys) {
      if (typeof part[key] === "string" && part[key].length > 0) return part[key]
    }
  }
  return ""
}

function firstTextOfContent(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return textFromParts(content, ["text", "input_text", "output_text"])
  return ""
}

/** 处理一个带 content 的消息（Chat / Responses input item） */
function sanitizeContentHolder(holder, options, learned) {
  if (!holder || typeof holder !== "object") return false
  if (typeof holder.content === "string") {
    const next = sanitizeText(holder.content, options, learned)
    if (next === holder.content) return false
    holder.content = next
    return true
  }
  if (Array.isArray(holder.content)) {
    for (const part of holder.content) {
      if (!part || typeof part !== "object") continue
      for (const key of ["text", "input_text", "output_text"]) {
        if (typeof part[key] === "string" && part[key].length > 0) {
          const next = sanitizeText(part[key], options, learned)
          if (next === part[key]) return false
          part[key] = next
          return true
        }
      }
    }
  }
  return false
}

function sanitizeChat(body, options, learned) {
  let changed = false
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!message || typeof message !== "object") continue
      if (message.role !== "system" && message.role !== "developer") continue
      changed = sanitizeContentHolder(message, options, learned) || changed
    }
  }
  return changed
}

function sanitizeAnthropic(body, options, learned) {
  let changed = false
  if (typeof body.system === "string") {
    const next = sanitizeText(body.system, options, learned)
    if (next !== body.system) {
      body.system = next
      changed = true
    }
  } else if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (!block || typeof block !== "object") continue
      if (typeof block.text === "string" && block.text.length > 0) {
        const next = sanitizeText(block.text, options, learned)
        if (next !== block.text) {
          block.text = next
          changed = true
        }
        break // 只处理 system 的第一块
      }
    }
  }
  return changed
}

function sanitizeResponses(body, options, learned) {
  let changed = false
  if (typeof body.instructions === "string") {
    const next = sanitizeText(body.instructions, options, learned)
    if (next !== body.instructions) {
      body.instructions = next
      changed = true
    }
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== "object") continue
      if (item.role !== "system" && item.role !== "developer") continue
      changed = sanitizeContentHolder(item, options, learned) || changed
    }
  }
  return changed
}

function sanitizeGemini(body, options, learned) {
  let changed = false
  for (const key of ["systemInstruction", "system_instruction"]) {
    const instruction = body[key]
    if (typeof instruction === "string") {
      const next = sanitizeText(instruction, options, learned)
      if (next !== instruction) {
        body[key] = next
        changed = true
      }
      continue
    }
    if (instruction && typeof instruction === "object" && Array.isArray(instruction.parts)) {
      for (const part of instruction.parts) {
        if (!part || typeof part !== "object") continue
        if (typeof part.text === "string" && part.text.length > 0) {
          const next = sanitizeText(part.text, options, learned)
          if (next !== part.text) {
            part.text = next
            changed = true
          }
          break // 只处理 systemInstruction 的第一块
        }
      }
    }
  }
  return changed
}

function sanitizeBody(body, options, learned) {
  if (!body || typeof body !== "object") return false
  let changed = false
  // 四种协议各管各的字段；互不影响，重复调用也幂等。
  changed = sanitizeChat(body, options, learned) || changed
  changed = sanitizeAnthropic(body, options, learned) || changed
  changed = sanitizeResponses(body, options, learned) || changed
  changed = sanitizeGemini(body, options, learned) || changed
  return changed
}

/** 从请求体里取 system 第一行，只用于日志/学习 */
function firstSystemLine(body, protocol) {
  if (!body || typeof body !== "object") return ""

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!message || (message.role !== "system" && message.role !== "developer")) continue
      const text = firstTextOfContent(message.content)
      if (text) return firstLine(text)
    }
  }

  if (typeof body.system === "string" && body.system) return firstLine(body.system)
  if (Array.isArray(body.system)) {
    const text = textFromParts(body.system, ["text"])
    if (text) return firstLine(text)
  }

  if (typeof body.instructions === "string" && body.instructions) return firstLine(body.instructions)
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || (item.role !== "system" && item.role !== "developer")) continue
      const text = firstTextOfContent(item.content)
      if (text) return firstLine(text)
    }
  }

  for (const key of ["systemInstruction", "system_instruction"]) {
    const instruction = body[key]
    if (typeof instruction === "string" && instruction) return firstLine(instruction)
    if (instruction && typeof instruction === "object" && Array.isArray(instruction.parts)) {
      const text = textFromParts(instruction.parts, ["text"])
      if (text) return firstLine(text)
    }
  }

  return ""
}

function replyText(reply) {
  if (reply == null) return ""
  if (typeof reply === "string") return reply
  try {
    return JSON.stringify(reply)
  } catch {
    return ""
  }
}

const FILTER_SIGNAL =
  /403|非法请求|内容过滤|content[ _-]?filter|permission[ _-]?error|sensitive|违规|风控/i

/**
 * onRequest —— 每个 agent 请求、每个供应商、每个协议都会经过。
 * 返回改过的 body，或 undefined 表示不动。
 */
export async function onRequest(body, ctx) {
  if (!body || typeof body !== "object") return undefined
  const options = { ...DEFAULTS, ...(ctx?.options ?? {}) }
  if (option(options, "mode") === "off") return undefined

  const learned = loadLearned(options)
  const changed = sanitizeBody(body, options, learned)
  if (!changed) return undefined

  return body
}

/**
 * onResponse —— 只做诊断/学习，绝不改回复。
 * 上游仍然拦了（说明出现了新指纹或 marker 被吃掉）时，把请求的 system 首行
 * 记到 events.jsonl；smart 模式下同时写进 learned.json，下次自动处理。
 */
export async function onResponse(reply, ctx) {
  const options = { ...DEFAULTS, ...(ctx?.options ?? {}) }
  if (option(options, "mode") === "off") return

  const status = Number(ctx?.status ?? 0)
  const success = ctx?.success === true
  const text = replyText(reply)
  const signal = FILTER_SIGNAL.test(text)

  // 只关心"请求失败 + 内容过滤信号"；普通 401/429/500 不记，避免污染学习集。
  if (success || (!signal && status !== 403)) return

  const request = ctx?.request ?? {}
  const line = firstSystemLine(request, ctx?.protocol)
  if (!line) return

  logLine(options, {
    at: new Date().toISOString(),
    kind: "content-filter",
    hook: HOOK_VERSION,
    protocol: ctx?.protocol ?? "",
    model: ctx?.model ?? "",
    agent: ctx?.agent ?? "",
    status,
    success,
    firstLine: line.slice(0, Number(option(options, "maxLine")) || 400),
    error: text.slice(0, 600),
  })

  if (option(options, "learn") && option(options, "mode") === "smart") {
    addLearned(options, line)
  }
}
