import type { WorkerMetrics, AggregatedMetrics, PercentileStats, RuntimeResult, GenericAggregatedMetrics } from "./types.js";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function computeStats(values: number[]): PercentileStats {
  if (values.length === 0) {
    return { min: 0, avg: 0, med: 0, p90: 0, p95: 0, p99: 0, max: 0, count: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    avg: Math.round(sum / sorted.length),
    med: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    count: sorted.length,
  };
}

export function aggregate(
  results: WorkerMetrics[],
  errors: string[],
  totalDurationMs: number,
): AggregatedMetrics {
  const allConnectTimes: number[] = [];
  const allRoundtrips: number[] = [];
  const clientErrors: string[] = [];
  let totalSent = 0;
  let totalReceived = 0;
  let totalConns = 0;
  let successConns = 0;
  let failedConns = 0;

  for (const worker of results) {
    totalConns += worker.totalConnections;
    successConns += worker.successfulConnections;
    failedConns += worker.failedConnections;

    for (const client of worker.clients) {
      if (client.authSuccess) {
        allConnectTimes.push(client.connectTimeMs);
      }
      allRoundtrips.push(...client.roundtrips);
      totalSent += client.messagesSent;
      totalReceived += client.messagesReceived;
      if (client.errors.length > 0) {
        clientErrors.push(...client.errors.map((e) => `worker${worker.workerIndex}/client${client.clientId}: ${e}`));
      }
    }
  }

  return {
    connectTime: computeStats(allConnectTimes),
    roundtrip: computeStats(allRoundtrips),
    totalMessagesSent: totalSent,
    totalMessagesReceived: totalReceived,
    totalConnections: totalConns,
    successfulConnections: successConns,
    failedConnections: failedConns,
    workersTotal: results.length + errors.length,
    workersOk: results.length,
    workersFailed: errors.length,
    totalDurationMs,
    clientErrors,
  };
}

export function aggregateGeneric(result: RuntimeResult): GenericAggregatedMetrics {
  const allTimers: Record<string, number[]> = {};
  const allCounters: Record<string, number> = {};
  const allErrors: string[] = [];
  let totalIterations = 0;

  for (const vu of result.vus) {
    totalIterations += vu.iterations;

    for (const [name, samples] of Object.entries(vu.timers)) {
      if (!allTimers[name]) allTimers[name] = [];
      allTimers[name].push(...samples);
    }

    for (const [name, count] of Object.entries(vu.counters)) {
      allCounters[name] = (allCounters[name] ?? 0) + count;
    }

    for (const err of vu.errors) {
      allErrors.push(`vu${vu.vuId}: ${err}`);
    }
  }

  const timerStats: Record<string, PercentileStats> = {};
  for (const [name, samples] of Object.entries(allTimers)) {
    timerStats[name] = computeStats(samples);
  }

  return {
    timers: timerStats,
    counters: allCounters,
    totalIterations,
    totalVUs: result.vus.length,
    totalDurationMs: result.totalDurationMs,
    errors: allErrors,
  };
}
