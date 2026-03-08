// Example: Load test a NoLag broker using the new kFunk script runtime
// Usage: node dist/cli/index.js run example-nolag.js --vus 10 --duration 30
//
// Requires: @nolag/js-sdk (already in kfunk's dependencies)
// Set these environment variables:
//   NOLAG_TOKEN  - your NoLag access token
//   NOLAG_URL    - broker URL (optional)
//   NOLAG_TOPIC  - topic path (optional, defaults to "kfunk/load-test/messages")

import { NoLag } from "@nolag/js-sdk"

const TOKEN = process.env.NOLAG_TOKEN
const URL = process.env.NOLAG_URL
const TOPIC = process.env.NOLAG_TOPIC || "kfunk/load-test/messages"

export default {
  async setup(ctx) {
    if (!TOKEN) throw new Error("NOLAG_TOKEN env var is required")

    const client = NoLag(TOKEN, {
      url: URL,
      qos: 1,
      reconnect: false,
      heartbeatInterval: 25000,
    })

    const t = ctx.metrics?.startTimer?.() ?? performance.now()
    await client.connect()
    ctx.state.connectTime = performance.now() - t
    ctx.state.client = client
    ctx.state.seq = 0

    // Subscribe and listen for echoes
    ctx.state.pending = new Map()
    client.subscribe(TOPIC)
    client.on(TOPIC, (data) => {
      const msg = data
      if (msg._vuId === ctx.vuId && typeof msg._seq === "number") {
        const sent = ctx.state.pending.get(msg._seq)
        if (sent !== undefined) {
          ctx.state.lastRoundtrip = performance.now() - sent
          ctx.state.pending.delete(msg._seq)
        }
      }
    })
  },

  async run(ctx, metrics) {
    const seq = ctx.state.seq++
    const now = performance.now()
    ctx.state.pending.set(seq, now)

    await metrics.measure("publish", async () => {
      ctx.state.client.emit(
        TOPIC,
        { _vuId: ctx.vuId, _seq: seq, _ts: now, text: "kfunk" },
        { echo: true },
      )
    })

    metrics.increment("messages_sent")

    // Small delay to allow echo to arrive
    await new Promise((r) => setTimeout(r, 100))

    if (ctx.state.lastRoundtrip !== undefined) {
      metrics.record("roundtrip", performance.now() - ctx.state.lastRoundtrip)
      metrics.increment("messages_received")
      ctx.state.lastRoundtrip = undefined
    }
  },

  async teardown(ctx) {
    try {
      ctx.state.client?.disconnect()
    } catch {
      // ignore
    }
  },
}
