export interface ClientConfig {
  url: string;
  token: string;
  topic: string;
  qos: 0 | 1 | 2;
  duration: number;
  clientId: number;
  publishIntervalMs: number;
}

export interface ClientMetrics {
  clientId: number;
  connectTimeMs: number;
  authSuccess: boolean;
  roundtrips: number[];
  messagesSent: number;
  messagesReceived: number;
  errors: string[];
}

export interface WorkerRequest {
  url: string;
  token: string;
  topic: string;
  qos: 0 | 1 | 2;
  connections: number;
  duration: number;
  workerIndex: number;
  publishIntervalMs: number;
}

export interface WorkerMetrics {
  workerIndex: number;
  clients: ClientMetrics[];
  totalConnections: number;
  successfulConnections: number;
  failedConnections: number;
  durationMs: number;
}

export interface OrchestratorConfig {
  serviceUrl: string;
  workers: number;
  staggerMs: number;
  workerRequest: Omit<WorkerRequest, "workerIndex">;
  onProgress?: (msg: string) => void;
}

export interface OrchestratorResult {
  metrics: WorkerMetrics[];
  errors: string[];
  durationMs: number;
}

export interface PercentileStats {
  min: number;
  avg: number;
  med: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  count: number;
}

export interface AggregatedMetrics {
  connectTime: PercentileStats;
  roundtrip: PercentileStats;
  totalMessagesSent: number;
  totalMessagesReceived: number;
  totalConnections: number;
  successfulConnections: number;
  failedConnections: number;
  workersTotal: number;
  workersOk: number;
  workersFailed: number;
  totalDurationMs: number;
  clientErrors: string[];
}

// ---- Generic Script Runtime Types ----

/** Context object passed to all lifecycle hooks */
export interface VUContext {
  /** 0-based virtual user index */
  vuId: number;
  /** Total number of VUs in this run */
  totalVUs: number;
  /** Arbitrary user state — stash connections, tokens, etc. in setup() */
  state: Record<string, unknown>;
}

/** Metrics API passed to the user's run() function */
export interface MetricsAPI {
  /** Time an async function, record duration under `name` */
  measure<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Return a high-resolution start time (ms) */
  startTimer(): number;
  /** Record elapsed ms since startTime under `name` */
  record(name: string, startTime: number): void;
  /** Increment a counter by 1 (or by `value`) */
  increment(name: string, value?: number): void;
}

/** Shape of a user test script's default export */
export interface TestScript {
  setup?(ctx: VUContext): Promise<void>;
  run(ctx: VUContext, metrics: MetricsAPI): Promise<void>;
  teardown?(ctx: VUContext): Promise<void>;
}

/** Configuration for the local runtime */
export interface RuntimeConfig {
  /** Absolute path to the user's script */
  scriptPath: string;
  /** Number of virtual users */
  vus: number;
  /** Test duration in seconds */
  duration: number;
  /** Stagger VU start by this many ms */
  staggerMs?: number;
  /** Progress callback */
  onProgress?: (msg: string) => void;
}

/** Raw collected data from a single VU */
export interface VUMetrics {
  vuId: number;
  /** Timer name -> array of duration samples (ms) */
  timers: Record<string, number[]>;
  /** Counter name -> total count */
  counters: Record<string, number>;
  /** Number of run() iterations completed */
  iterations: number;
  /** Errors encountered */
  errors: string[];
}

/** Result from the runtime */
export interface RuntimeResult {
  vus: VUMetrics[];
  totalDurationMs: number;
}

/** Aggregated output from a generic script run */
export interface GenericAggregatedMetrics {
  timers: Record<string, PercentileStats>;
  counters: Record<string, number>;
  totalIterations: number;
  totalVUs: number;
  totalDurationMs: number;
  errors: string[];
}
