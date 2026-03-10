import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { MetricsCollector } from "../core/metrics-collector.js";
import { loadEventPluginsFromConfigs } from "../core/plugin-loader.js";
import type { TestScript, VUContext, VUMetrics } from "../core/types.js";
import type { EventPlugin, EventPluginConfig } from "../core/plugin-types.js";

export interface GenericWorkerRequest {
  /** The test script source code as a string */
  script: string;
  /** Number of virtual users to run on this worker */
  vus: number;
  /** Test duration in seconds */
  duration: number;
  /** Stagger VU start by this many ms */
  staggerMs?: number;
  /** Worker index (for logging/identification) */
  workerIndex?: number;
  /** Event plugin configs to load on the worker */
  eventPlugins?: EventPluginConfig[];
}

export interface GenericWorkerResponse {
  workerIndex: number;
  vus: VUMetrics[];
  totalDurationMs: number;
}

async function loadScriptFromString(code: string): Promise<{ script: TestScript; cleanup: () => Promise<void> }> {
  const dir = join(tmpdir(), "kfunk-scripts");
  await mkdir(dir, { recursive: true });
  const filename = `script-${randomUUID()}.mjs`;
  const filepath = join(dir, filename);

  await writeFile(filepath, code, "utf-8");

  const url = pathToFileURL(filepath).href;
  const mod = await import(url);
  const script: TestScript = mod.default ?? mod;

  if (typeof script.run !== "function") {
    await unlink(filepath).catch(() => {});
    throw new Error("Script must export a run() function");
  }

  const cleanup = async () => {
    await unlink(filepath).catch(() => {});
  };

  return { script, cleanup };
}

async function runVU(
  script: TestScript,
  vuId: number,
  totalVUs: number,
  durationMs: number,
): Promise<MetricsCollector> {
  const collector = new MetricsCollector(vuId);
  const ctx: VUContext = { vuId, totalVUs, state: {} };

  if (script.setup) {
    try {
      await script.setup(ctx);
    } catch (err) {
      collector.errors.push(`setup: ${err instanceof Error ? err.message : String(err)}`);
      return collector;
    }
  }

  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    try {
      await script.run(ctx, collector);
      collector.iterations++;
    } catch (err) {
      collector.errors.push(`run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (script.teardown) {
    try {
      await script.teardown(ctx);
    } catch (err) {
      collector.errors.push(`teardown: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return collector;
}

export async function handleGenericRun(req: GenericWorkerRequest): Promise<GenericWorkerResponse> {
  const { script: code, vus, duration, staggerMs = 0, workerIndex = 0, eventPlugins: eventPluginConfigs } = req;
  const durationMs = duration * 1000;

  console.log(`Worker ${workerIndex}: loading script, ${vus} VUs for ${duration}s`);

  const { script, cleanup } = await loadScriptFromString(code);

  // Load event plugins if configs were provided
  let loadedEventPlugins: EventPlugin[] = [];
  if (eventPluginConfigs && eventPluginConfigs.length > 0) {
    try {
      console.log(`Worker ${workerIndex}: loading ${eventPluginConfigs.length} event plugin(s)`);
      loadedEventPlugins = await loadEventPluginsFromConfigs(eventPluginConfigs);
    } catch (err) {
      console.error(`Worker ${workerIndex}: failed to load event plugins:`, err);
    }
  }

  try {
    const start = Date.now();

    const promises = Array.from({ length: vus }, (_, i) => {
      const launchVU = async () => {
        // Fire onVUStart on all event plugins
        for (const plugin of loadedEventPlugins) {
          try { await plugin.onVUStart?.(i, vus); } catch { /* best-effort */ }
        }
        return runVU(script, i, vus, durationMs);
      };

      const delay = i * staggerMs;
      const launch = delay > 0
        ? new Promise<MetricsCollector>((resolve, reject) =>
            setTimeout(() => launchVU().then(resolve, reject), delay),
          )
        : launchVU();

      return launch.then(async (collector) => {
        const metrics = collector.toVUMetrics();
        // Fire onVUComplete on all event plugins
        for (const plugin of loadedEventPlugins) {
          try { await plugin.onVUComplete?.(metrics); } catch { /* best-effort */ }
        }
        return collector;
      });
    });

    const results = await Promise.allSettled(promises);

    const vuMetrics = results.map((r, i) => {
      if (r.status === "fulfilled") return r.value.toVUMetrics();
      return {
        vuId: i,
        timers: {},
        counters: {},
        iterations: 0,
        errors: [r.reason instanceof Error ? r.reason.message : String(r.reason)],
      };
    });

    const totalDurationMs = Date.now() - start;
    console.log(`Worker ${workerIndex}: done. ${vus} VUs, ${totalDurationMs}ms`);

    return { workerIndex, vus: vuMetrics, totalDurationMs };
  } finally {
    // Cleanup event plugins
    await Promise.allSettled(loadedEventPlugins.map((p) => p.destroy?.()));
    await cleanup();
  }
}
