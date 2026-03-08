import { GoogleAuth } from "google-auth-library";
import type { RuntimeResult, VUMetrics } from "./types.js";
import type { GenericWorkerRequest, GenericWorkerResponse } from "../worker/generic-handler.js";

export interface DistributedConfig {
  /** Cloud Run service URL */
  serviceUrl: string;
  /** The test script source code */
  script: string;
  /** Number of Cloud Run workers to invoke */
  workers: number;
  /** VUs per worker */
  vusPerWorker: number;
  /** Test duration in seconds */
  duration: number;
  /** Stagger VU start within each worker (ms) */
  staggerMs?: number;
  /** Stagger worker launch (ms) */
  workerStaggerMs?: number;
  /** Progress callback */
  onProgress?: (msg: string) => void;
}

async function getAuthHeaders(serviceUrl: string): Promise<Record<string, string>> {
  try {
    const auth = new GoogleAuth();
    const client = await auth.getIdTokenClient(serviceUrl);
    const headers = await client.getRequestHeaders();
    return headers as Record<string, string>;
  } catch {
    return {};
  }
}

async function invokeWorker(
  serviceUrl: string,
  request: GenericWorkerRequest,
  headers: Record<string, string>,
): Promise<GenericWorkerResponse> {
  const res = await fetch(`${serviceUrl}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Worker ${request.workerIndex}: HTTP ${res.status} — ${text}`);
  }
  return (await res.json()) as GenericWorkerResponse;
}

export async function orchestrateGeneric(config: DistributedConfig): Promise<RuntimeResult> {
  const {
    serviceUrl,
    script,
    workers,
    vusPerWorker,
    duration,
    staggerMs = 0,
    workerStaggerMs = 0,
    onProgress,
  } = config;
  const log = onProgress ?? (() => {});

  const totalVUs = workers * vusPerWorker;
  log(`Authenticating with Cloud Run...\n`);
  const headers = await getAuthHeaders(serviceUrl);

  log(`Launching ${workers} workers × ${vusPerWorker} VUs = ${totalVUs} total VUs\n`);
  log(`Duration: ${duration}s\n\n`);

  const start = Date.now();
  let completed = 0;

  const promises = Array.from({ length: workers }, (_, i) => {
    const request: GenericWorkerRequest = {
      script,
      vus: vusPerWorker,
      duration,
      staggerMs,
      workerIndex: i,
    };

    const delay = i * workerStaggerMs;
    const launch = delay > 0
      ? new Promise<GenericWorkerResponse>((resolve, reject) =>
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
  log("\n\n");

  // Merge all worker VU metrics into a single RuntimeResult
  const allVUs: VUMetrics[] = [];
  const errors: string[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      // Re-number VU IDs to be globally unique
      const offset = allVUs.length;
      for (const vu of result.value.vus) {
        allVUs.push({ ...vu, vuId: offset + vu.vuId });
      }
    } else {
      errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    }
  }

  if (errors.length > 0) {
    log(`${errors.length} worker(s) failed:\n`);
    for (const err of errors.slice(0, 5)) {
      log(`  - ${err}\n`);
    }
    if (errors.length > 5) {
      log(`  ... and ${errors.length - 5} more\n`);
    }
  }

  return {
    vus: allVUs,
    totalDurationMs: Date.now() - start,
  };
}
