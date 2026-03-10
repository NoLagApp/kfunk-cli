import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { MetricsCollector } from "./metrics-collector.js";
import type { TestScript, RuntimeConfig, RuntimeResult, VUContext } from "./types.js";

async function loadScript(scriptPath: string): Promise<TestScript> {
  const abs = resolve(scriptPath);
  const url = pathToFileURL(abs).href;
  const mod = await import(url);
  const script: TestScript = mod.default ?? mod;

  if (typeof script.run !== "function") {
    throw new Error(`Script must export a run() function: ${scriptPath}`);
  }
  return script;
}

async function runVU(
  script: TestScript,
  vuId: number,
  totalVUs: number,
  durationMs: number,
): Promise<MetricsCollector> {
  const collector = new MetricsCollector(vuId);
  const ctx: VUContext = { vuId, totalVUs, state: {} };

  // Setup
  if (script.setup) {
    try {
      await script.setup(ctx);
    } catch (err) {
      collector.errors.push(`setup: ${err instanceof Error ? err.message : String(err)}`);
      return collector;
    }
  }

  // Run loop
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    try {
      await script.run(ctx, collector);
      collector.iterations++;
    } catch (err) {
      collector.errors.push(`run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Teardown
  if (script.teardown) {
    try {
      await script.teardown(ctx);
    } catch (err) {
      collector.errors.push(`teardown: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return collector;
}

export async function runScript(config: RuntimeConfig): Promise<RuntimeResult> {
  const { scriptPath, vus, duration, staggerMs = 0, onProgress, onVUStart, onVUComplete } = config;
  const log = onProgress ?? (() => {});
  const durationMs = duration * 1000;

  log(`Loading script: ${scriptPath}\n`);
  const script = await loadScript(scriptPath);

  log(`Spawning ${vus} virtual users for ${duration}s\n`);
  const start = Date.now();

  let completed = 0;
  const promises = Array.from({ length: vus }, (_, i) => {
    const launchVU = async () => {
      onVUStart?.(i, vus);
      return runVU(script, i, vus, durationMs);
    };

    const delay = i * staggerMs;
    const launch = delay > 0
      ? new Promise<MetricsCollector>((resolve, reject) =>
          setTimeout(() => launchVU().then(resolve, reject), delay),
        )
      : launchVU();

    return launch.then((collector) => {
      completed++;
      log(`\r  ${completed}/${vus} VUs complete`);
      onVUComplete?.(collector.toVUMetrics());
      return collector;
    });
  });

  const results = await Promise.allSettled(promises);
  log("\n");

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

  return {
    vus: vuMetrics,
    totalDurationMs: Date.now() - start,
  };
}
