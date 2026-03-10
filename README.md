# kFunk CLI

Distributed load testing tool. Stress-test any system with custom scripts and get detailed latency metrics.

## Install

```bash
npm install -g @kfunk-load/cli
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
| `ctx.totalVUs` | number | Total number of VUs in this run |
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
| `--vus <n>` | Number of virtual users (or VUs per worker in distributed mode) | 10 |
| `--duration <s>` | Test duration in seconds | 30 |
| `--stagger <ms>` | Delay between spawning each VU | 0 |
| `--service-url <url>` | Worker URL (enables distributed mode without an infra plugin) | — |
| `--workers <n>` | Number of workers (distributed only) | 1 |
| `--worker-stagger <ms>` | Delay between launching each worker | 0 |
| `--config <path>` | Path to kfunk config file | auto-detected |
| `--json` | Output raw JSON | false |

### `kfunk deploy`

Deploy workers using an infrastructure plugin, or fall back to the legacy `scripts/deploy.sh` script.

```bash
kfunk deploy
```

If no infra plugin is configured, the deploy command falls back to the legacy GCP Cloud Run deploy script:

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

## Plugin System

kFunk supports plugins to extend its functionality. There are two plugin types:

- **Event plugins** stream test lifecycle events in real-time (from both the CLI and distributed workers)
- **Infrastructure plugins** manage distributed workers on any cloud provider

### Configuration

Create a `kfunk.config.js` file in your project root:

```js
// kfunk.config.js
export default {
  plugins: [
    "@kfunk-load/plugin-gcp",
    { name: "@kfunk-load/plugin-nolag", config: { apiKey: process.env.NOLAG_KEY } },
  ],
  infra: "@kfunk-load/plugin-gcp",
  "@kfunk-load/plugin-gcp": {
    region: "us-central1",
    serviceName: "kfunk-worker",
  },
}
```

- `plugins` — list of plugin package names, or `{ name, config }` objects for inline config
- `infra` — which plugin to use for infrastructure (must be listed in `plugins`)
- Top-level keys matching a plugin name provide plugin-specific configuration

No config file is required — without one, kFunk runs tests locally with no plugins.

### Event Plugins

Event plugins observe the test lifecycle. Their hooks fire on the CLI and inside distributed workers:

| Hook | Where | Description |
|------|-------|-------------|
| `onTestStart(context)` | CLI | Test is starting |
| `onVUStart(vuId, totalVUs)` | CLI + Workers | A VU is about to start |
| `onVUComplete(vuMetrics)` | CLI + Workers | A VU finished |
| `onProgress(message)` | CLI | Progress update |
| `onTestEnd(context, results)` | CLI | Test complete with aggregated results |

In distributed mode, event plugin configs are serialized and sent to workers. Workers load the event plugins locally and fire `onVUStart`/`onVUComplete` hooks in real-time during VU execution. This means the event plugin npm packages must be installed on the worker image — the infra plugin's `deploy()` handles this automatically.

### Infrastructure Plugins

Infrastructure plugins manage distributed workers on any cloud:

| Method | Description |
|--------|-------------|
| `deploy(options)` | Deploy workers (builds image with event plugin deps), returns `{ serviceUrl }` |
| `runDistributed(options)` | Run a distributed test, returns `RuntimeResult` |
| `getAuthHeaders(serviceUrl)` | Get auth headers for worker requests |
| `teardown(options)` | Destroy deployed workers |

When an infra plugin is configured, `kfunk deploy` delegates to it and `kfunk run` uses it for distributed execution automatically (no `--service-url` needed).

### Writing a Plugin

A plugin package exports a factory function as its default export:

```js
// Event plugin example
export default function(config) {
  return {
    name: "my-event-plugin",
    type: "event",
    async onTestStart(context) { /* ... */ },
    async onVUComplete(vuMetrics) { /* ... */ },
    async onTestEnd(context, results) { /* ... */ },
    async destroy() { /* cleanup */ },
  }
}
```

```js
// Infrastructure plugin example
export default function(config) {
  return {
    name: "my-infra-plugin",
    type: "infra",
    async deploy(options) { /* ... */ return { serviceUrl } },
    async runDistributed(options) { /* ... */ return runtimeResult },
    async getAuthHeaders(serviceUrl) { /* ... */ return headers },
    async destroy() { /* cleanup */ },
  }
}
```

### Available Plugins

| Package | Type | Description |
|---------|------|-------------|
| `@kfunk-load/plugin-gcp` | Infrastructure | Deploy and run distributed tests on Google Cloud Run |
| `@kfunk-load/plugin-nolag` | Event | Stream test events to a NoLag real-time broker |

### Distributed Testing with Plugins

With an infra plugin configured, distributed testing is seamless:

```bash
# Deploy workers (infra plugin builds the image and deploys)
kfunk deploy

# Run distributed — no --service-url needed, the plugin handles it
kfunk run my-test.js --workers 10 --vus 20 --duration 60
```

### Distributed Test with GCP Cloud Run (Legacy)

You can also use `--service-url` directly without an infra plugin. This uses the legacy orchestrator (no automatic auth — workers must be publicly accessible or you must handle auth separately).

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

## Output

kFunk outputs a summary table with:
- Latency stats: min, avg, median, p90, p95, p99, max
- Counter totals
- VU count, total iterations, and duration

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
