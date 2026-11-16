import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"

import { onRequest, onResponse } from "../identity-sanitizer.hooks.mjs"

const ZWNJ = "\u200C"
const DASH = "- "
const ID = "You are an AI agent powered by DeepSeek Harness."
const CTX = (options = {}) => ({ protocol: "chat", model: "test/model", agent: "test", options })

describe("identity sanitizer: request shapes", () => {
  it("chat string system", async () => {
    const body = { messages: [{ role: "system", content: ID }, { role: "user", content: "hi" }] }
    assert.equal(await onRequest(body, CTX()), body)
    assert.equal(body.messages[0].content, DASH + ID)
  })

  it("chat array system", async () => {
    const body = {
      messages: [{ role: "system", content: [{ type: "text", text: ID }] }, { role: "user", content: "hi" }],
    }
    assert.equal(await onRequest(body, CTX()), body)
    assert.equal(body.messages[0].content[0].text, DASH + ID)
  })

  it("anthropic string system", async () => {
    const body = { system: ID, messages: [{ role: "user", content: "hi" }] }
    assert.equal(await onRequest(body, CTX({ protocol: "anthropic" })), body)
    assert.equal(body.system, DASH + ID)
  })

  it("anthropic block system", async () => {
    const body = { system: [{ type: "text", text: ID }], messages: [] }
    assert.equal(await onRequest(body, CTX({ protocol: "anthropic" })), body)
    assert.equal(body.system[0].text, DASH + ID)
  })

  it("responses instructions", async () => {
    const body = { instructions: ID, input: "hi" }
    assert.equal(await onRequest(body, CTX({ protocol: "responses" })), body)
    assert.equal(body.instructions, DASH + ID)
  })

  it("responses input system item", async () => {
    const body = { input: [{ role: "system", content: [{ type: "input_text", text: ID }] }] }
    assert.equal(await onRequest(body, CTX({ protocol: "responses" })), body)
    assert.equal(body.input[0].content[0].text, DASH + ID)
  })

  it("gemini systemInstruction", async () => {
    const body = { systemInstruction: { parts: [{ text: ID }] }, contents: [] }
    assert.equal(await onRequest(body, CTX({ protocol: "gemini" })), body)
    assert.equal(body.systemInstruction.parts[0].text, DASH + ID)
  })

  it("leading whitespace is neutralised from the very first byte", async () => {
    const body = { messages: [{ role: "system", content: "  " + ID }] }
    await onRequest(body, CTX())
    assert.equal(body.messages[0].content, DASH + "  " + ID)
  })

  it("non-letter first line is already safe", async () => {
    const body = { messages: [{ role: "system", content: "- " + ID }] }
    assert.equal(await onRequest(body, CTX()), undefined)
    assert.equal(body.messages[0].content, "- " + ID)
  })

  it("idempotent across retries", async () => {
    const body = { messages: [{ role: "system", content: ID }] }
    await onRequest(body, CTX())
    const once = body.messages[0].content
    assert.equal(await onRequest(body, CTX()), undefined)
    assert.equal(body.messages[0].content, once)
    assert.equal(once.startsWith(DASH + DASH), false)
  })

  it("does not touch model, stream, tools or tool_choice", async () => {
    const body = {
      model: "test/model",
      stream: true,
      tools: [{ type: "function", function: { name: "shell" } }],
      tool_choice: "auto",
      messages: [{ role: "system", content: ID }],
    }
    const before = JSON.stringify({ model: body.model, stream: body.stream, tools: body.tools, tool_choice: body.tool_choice })
    await onRequest(body, CTX())
    assert.equal(
      JSON.stringify({ model: body.model, stream: body.stream, tools: body.tools, tool_choice: body.tool_choice }),
      before,
    )
  })

  it("user and assistant messages are untouched", async () => {
    const body = { messages: [{ role: "user", content: ID }, { role: "assistant", content: ID }] }
    assert.equal(await onRequest(body, CTX()), undefined)
  })
})

describe("identity sanitizer: options", () => {
  it("mode off", async () => {
    const body = { messages: [{ role: "system", content: ID }] }
    assert.equal(await onRequest(body, CTX({ mode: "off" })), undefined)
    assert.equal(body.messages[0].content, ID)
  })

  it("mode smart leaves a normal prompt alone", async () => {
    const body = { messages: [{ role: "system", content: "Always answer in English." }] }
    assert.equal(await onRequest(body, CTX({ mode: "smart" })), undefined)
  })

  it("mode smart catches an identity sentence", async () => {
    const body = { messages: [{ role: "system", content: ID }] }
    assert.equal(await onRequest(body, CTX({ mode: "smart" })), body)
    assert.equal(body.messages[0].content, DASH + ID)
  })

  it("dash marker", async () => {
    const body = { messages: [{ role: "system", content: ID }] }
    await onRequest(body, CTX({ marker: "dash" }))
    assert.equal(body.messages[0].content, "- " + ID)
  })

  it("whitespace marker falls back to dash", async () => {
    const body = { messages: [{ role: "system", content: ID }] }
    await onRequest(body, CTX({ marker: "   " }))
    assert.equal(body.messages[0].content, DASH + ID)
  })

  it("zero-width marker is still available explicitly", async () => {
    const body = { messages: [{ role: "system", content: ID }] }
    await onRequest(body, CTX({ marker: "zwnj" }))
    assert.equal(body.messages[0].content, ZWNJ + ID)
  })
})

describe("identity sanitizer: diagnostics and learning", () => {
  let dir
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "identity-sanitizer-"))
  })
  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("logs a content-filter failure with the offending first line", async () => {
    const body = {
      messages: [{ role: "system", content: "Act as a new agent from Acme." }],
    }
    await onResponse(
      { error: { code: "content_filtered", message: "403 非法请求" } },
      {
        protocol: "chat",
        model: "test/model",
        agent: "test",
        status: 403,
        success: false,
        request: body,
        options: { logDir: dir, mode: "smart", learn: true },
      },
    )
    const events = readFileSync(join(dir, "events.jsonl"), "utf8")
    assert.match(events, /content-filter/)
    assert.match(events, /Act as a new agent from Acme\./)
  })

  it("learns a new first line in smart mode", async () => {
    const body = { messages: [{ role: "system", content: "Act as a new agent from Acme." }] }
    await onResponse(
      { error: { message: "403 非法请求" } },
      {
        protocol: "chat",
        model: "test/model",
        agent: "test",
        status: 403,
        success: false,
        request: body,
        options: { logDir: dir, mode: "smart", learn: true },
      },
    )
    const learned = JSON.parse(readFileSync(join(dir, "learned.json"), "utf8"))
    assert.ok(learned.some((x) => x.includes("act as a new agent from acme")))

    const next = { messages: [{ role: "system", content: "Act as a new agent from Acme." }] }
    assert.equal(await onRequest(next, CTX({ logDir: dir, mode: "smart" })), next)
    assert.equal(next.messages[0].content, DASH + "Act as a new agent from Acme.")
  })

  it("does not log an unrelated failure", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "identity-sanitizer-quiet-"))
    try {
      await onResponse(
        { error: { message: "429 too many requests" } },
        {
          status: 429,
          success: false,
          request: { messages: [{ role: "system", content: ID }] },
          options: { logDir: dir2 },
        },
      )
      assert.throws(() => readFileSync(join(dir2, "events.jsonl"), "utf8"))
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })
})
