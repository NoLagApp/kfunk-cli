import { GoogleAuth } from "google-auth-library";
import type { WorkerRequest, WorkerMetrics, OrchestratorConfig, OrchestratorResult } from "./types.js";

async function getAuthHeaders(
  serviceUrl: string,
): Promise<Record<string, string>> {
  try {
    const auth = new GoogleAuth();
    const client = await auth.getIdTokenClient(serviceUrl);
    const headers = await client.getRequestHeaders();
    return headers as Record<string, string>;
  } catch {
    // Fall back to no auth (e.g., local testing with --allow-unauthenticated)
    return {};
  }
}

async function invokeWorker(
  serviceUrl: string,
  request: WorkerRequest,
  headers: Record<string, string>,
): Promise<WorkerMetrics> {
  const res = await fetch(serviceUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Worker ${request.workerIndex}: HTTP ${res.status} — ${text}`);
  }
  return (await res.json()) as WorkerMetrics;
}

export async function orchestrate(
  config: OrchestratorConfig,
): Promise<OrchestratorResult> {
  const { serviceUrl, workers, staggerMs, workerRequest, onProgress } = config;
  const log = onProgress ?? (() => {});

  log(`Authenticating with Cloud Run...`);
  const headers = await getAuthHeaders(serviceUrl);

  log(
    `Launching ${workers} workers × ${workerRequest.connections} connections = ${workers * workerRequest.connections} total connections`,
  );
  log(
    `Duration: ${workerRequest.duration}s, publish interval: ${workerRequest.publishIntervalMs}ms`,
  );
  log(``);

  const start = Date.now();
  let completed = 0;

  const promises = Array.from({ length: workers }, (_, i) => {
    const request: WorkerRequest = { ...workerRequest, workerIndex: i };
    const delay = i * staggerMs;
    const launch = delay > 0
      ? new Promise<WorkerMetrics>((resolve, reject) =>
          setTimeout(() => invokeWorker(serviceUrl, request, headers).then(resolve, reject), delay),
        )
      : invokeWorker(serviceUrl, request, headers);
    return launch.then((result) => {
      completed++;
      log(`\r  ${completed}/${workers} workers complete`);
      return result;
    });
  });

  const results = await Promise.allSettled(promises);
  log(``);

  const metrics: WorkerMetrics[] = [];
  const errors: string[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      metrics.push(result.value);
    } else {
      errors.push(
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
      );
    }
  }

  if (errors.length > 0) {
    log(``);
    log(`${errors.length} worker(s) failed:`);
    for (const err of errors.slice(0, 5)) {
      log(`  - ${err}`);
    }
    if (errors.length > 5) {
      log(`  ... and ${errors.length - 5} more`);
    }
  }

  return { metrics, errors, durationMs: Date.now() - start };
}
