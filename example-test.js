export default {
  async setup(ctx) {
    ctx.state.url = "https://jsonplaceholder.typicode.com/posts/1"
  },

  async run(ctx, metrics) {
    await metrics.measure("http_get", async () => {
      const res = await fetch(ctx.state.url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await res.json()
    })
    metrics.increment("requests")
  },
}
