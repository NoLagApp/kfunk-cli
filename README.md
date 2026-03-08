# kFunk CLI

Distributed load testing tool. Stress-test any system with custom scripts and get detailed latency metrics.

## Install

```bash
npm install -g kfunk
```

## Quick Start

Create a test script:

```js
// my-test.js
export default {
  async setup(ctx) {
    ctx.state.url = "https://api.example.com/health"
  },

  async run(ctx, metrics) {
    await metrics.measure("http_get", async () => {
      const res = await fetch(ctx.state.url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await res.json()
    })
    metrics.increment("requests")
  },

  async teardown(ctx) {
    // clean up resources
  },
}
```

Run it:

```bash
kfunk run my-test.js --vus 10 --duration 30
```

## Test Script Format

A test script exports an object with lifecycle hooks:

| Hook | Required | Description |
|------|----------|-------------|
| `setup(ctx)` | No | Initialize state, open connections, prepare data |
| `run(ctx, metrics)` | Yes | Main test loop — called repeatedly for the duration |
| `teardown(ctx)` | No | Clean up resources |

### Context (`ctx`)

| Property | Type | Description |
|----------|------|-------------|
| `ctx.vuId` | number | Virtual user ID (0-based) |
| `ctx.state` | object | Persistent state bag for the VU |

### Metrics API

The `metrics` object passed to `run()`:

| Method | Description |
|--------|-------------|
| `metrics.measure(name, fn)` | Time an async function and record duration |
| `metrics.startTimer()` | Start a manual timer (returns timestamp) |
| `metrics.record(name, startTime)` | Record duration since `startTime` |
| `metrics.increment(name, value?)` | Increment a counter (default 1) |

## CLI Options

### `kfunk run <script>`

| Option | Description | Default |
|--------|-------------|---------|
| `--vus <n>` | Number of virtual users | 10 |
| `--duration <s>` | Test duration in seconds | 30 |
| `--stagger <ms>` | Delay between spawning each VU | 0 |
| `--json` | Output raw JSON | false |

### `kfunk run-nolag` (Distributed)

Run a distributed load test with Cloud Run workers:

| Option | Description | Default |
|--------|-------------|---------|
| `--token` | Access token | Required |
| `--service-url` | Cloud Run worker URL | Required |
| `--workers <n>` | Number of Cloud Run workers | 10 |
| `--connections <n>` | Connections per worker | 10 |
| `--duration <s>` | Test duration (seconds) | 30 |
| `--topic <path>` | Topic path | k6-test/load-test/messages |
| `--qos <level>` | QoS level (0, 1, 2) | 1 |
| `--publish-interval <ms>` | Publish interval (ms) | 500 |
| `--stagger <ms>` | ms between launching workers | 500 |
| `--json` | Output raw JSON | false |

### `kfunk deploy`

Deploy the kFunk worker to Google Cloud Run for distributed testing.

```bash
kfunk deploy
```

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `KFUNK_REGION` | GCP region to deploy to | us-central1 |
| `KFUNK_SERVICE_NAME` | Cloud Run service name | kfunk-worker |

## Examples

### HTTP Load Test

```js
// example-test.js
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
```

```bash
kfunk run example-test.js --vus 5 --duration 10
```

### NoLag Broker Test

```js
// example-nolag.js
import { NoLag } from "@nolag/js-sdk"

const TOKEN = process.env.NOLAG_TOKEN
const TOPIC = process.env.NOLAG_TOPIC || "kfunk/load-test/messages"

export default {
  async setup(ctx) {
    if (!TOKEN) throw new Error("NOLAG_TOKEN env var is required")
    const client = NoLag(TOKEN, { qos: 1, reconnect: false })
    await client.connect()
    ctx.state.client = client
    ctx.state.seq = 0
    ctx.state.pending = new Map()

    client.subscribe(TOPIC)
    client.on(TOPIC, (data) => {
      if (data._vuId === ctx.vuId) {
        const sent = ctx.state.pending.get(data._seq)
        if (sent) {
          ctx.state.lastRoundtrip = performance.now() - sent
          ctx.state.pending.delete(data._seq)
        }
      }
    })
  },

  async run(ctx, metrics) {
    const seq = ctx.state.seq++
    ctx.state.pending.set(seq, performance.now())

    await metrics.measure("publish", async () => {
      ctx.state.client.emit(TOPIC, {
        _vuId: ctx.vuId, _seq: seq, text: "kfunk"
      }, { echo: true })
    })
    metrics.increment("messages_sent")

    await new Promise(r => setTimeout(r, 100))

    if (ctx.state.lastRoundtrip !== undefined) {
      metrics.record("roundtrip", ctx.state.lastRoundtrip)
      metrics.increment("messages_received")
      ctx.state.lastRoundtrip = undefined
    }
  },

  async teardown(ctx) {
    ctx.state.client?.disconnect()
  },
}
```

```bash
NOLAG_TOKEN=your_token kfunk run example-nolag.js --vus 10 --duration 30
```

### Distributed Test with GCP Cloud Run

#### Prerequisites

1. Install the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install)
2. Authenticate and set your project:

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

3. Enable the required APIs:

```bash
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
```

#### Deploy & Run

1. Deploy the worker to Cloud Run:
   ```bash
   kfunk deploy
   ```

2. Run a distributed test using the service URL printed by deploy:
   ```bash
   kfunk run my-test.js \
     --service-url https://kfunk-worker-xxxxx.run.app \
     --workers 10 \
     --duration 30
   ```

kFunk automatically authenticates with Cloud Run via your local `gcloud` credentials.

## Output

kFunk outputs a summary table with:
- Latency percentiles: p50, p90, p95, p99
- Min / max / average latency
- Throughput and counter totals

Use `--json` for machine-readable output in CI/CD pipelines.

## Using Custom Packages

Your test scripts can import any npm package. Install them in your project directory:

```bash
npm install @nolag/js-sdk
kfunk run example-nolag.js --vus 10 --duration 30
```

kFunk resolves packages from your project's `node_modules`.

## License

MIT
