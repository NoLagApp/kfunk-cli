import type { RuntimeResult, VUMetrics, GenericAggregatedMetrics } from "./types.js";

// ---- Serializable config sent to workers ----

export interface EventPluginConfig {
  /** npm package name of the event plugin */
  name: string;
  /** Plugin-specific config (must be JSON-serializable) */
  config: Record<string, unknown>;
}

// ---- Base plugin ----

export interface KfunkPlugin {
  name: string;
  version?: string;
  destroy?(): Promise<void> | void;
}

// ---- Event plugin ----

export interface TestRunContext {
  mode: "local" | "distributed";
  vus: number;
  duration: number;
  workers?: number;
  scriptPath?: string;
}

export interface EventPlugin extends KfunkPlugin {
  type: "event";
  /** Called when the test starts (CLI only) */
  onTestStart?(context: TestRunContext): Promise<void> | void;
  /** Called before a VU launches (CLI local + workers) */
  onVUStart?(vuId: number, totalVUs: number): Promise<void> | void;
  /** Called after a VU completes (CLI local + workers) */
  onVUComplete?(vuMetrics: VUMetrics): Promise<void> | void;
  /** Called on progress updates (CLI only) */
  onProgress?(message: string): Promise<void> | void;
  /** Called when the test ends with aggregated results (CLI only) */
  onTestEnd?(context: TestRunContext, aggregatedResults: GenericAggregatedMetrics): Promise<void> | void;
}

// ---- Infrastructure plugin ----

export interface InfraDeployOptions {
  /** Event plugin packages to bake into the worker image */
  eventPluginPackages?: string[];
  /** Plugin-specific deploy config (region, service name, etc.) */
  [key: string]: unknown;
}

export interface InfraRunOptions {
  serviceUrl: string;
  script: string;
  workers: number;
  vusPerWorker: number;
  duration: number;
  staggerMs?: number;
  workerStaggerMs?: number;
  /** Serialized event plugin configs to send to workers */
  eventPlugins?: EventPluginConfig[];
  onProgress?: (msg: string) => void;
}

export interface InfraTeardownOptions {
  [key: string]: unknown;
}

export interface InfraPlugin extends KfunkPlugin {
  type: "infra";
  /** Deploy workers, returns service URL */
  deploy(options: InfraDeployOptions): Promise<{ serviceUrl: string }>;
  /** Run a distributed test, returns RuntimeResult */
  runDistributed(options: InfraRunOptions): Promise<RuntimeResult>;
  /** Get auth headers for worker requests */
  getAuthHeaders(serviceUrl: string): Promise<Record<string, string>>;
  /** Teardown deployed workers */
  teardown?(options: InfraTeardownOptions): Promise<void> | void;
}

// ---- Union type ----

export type AnyPlugin = EventPlugin | InfraPlugin;

// ---- Plugin factory ----

export type PluginFactory = (config: Record<string, unknown>) => AnyPlugin | Promise<AnyPlugin>;

// ---- Config file shape ----

export interface KfunkConfig {
  /** Plugin declarations: package name or { name, config } */
  plugins?: Array<string | { name: string; config?: Record<string, unknown> }>;
  /** Which plugin to use for infrastructure (must be in plugins list) */
  infra?: string;
  /** Per-plugin config keyed by package name */
  [key: string]: unknown;
}
