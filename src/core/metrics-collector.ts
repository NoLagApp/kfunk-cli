import type { MetricsAPI, VUMetrics } from "./types.js";

export class MetricsCollector implements MetricsAPI {
  private timers: Record<string, number[]> = {};
  private counters: Record<string, number> = {};
  public iterations = 0;
  public errors: string[] = [];

  constructor(public readonly vuId: number) {}

  async measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.recordRaw(name, performance.now() - start);
    }
  }

  startTimer(): number {
    return performance.now();
  }

  record(name: string, startTime: number): void {
    this.recordRaw(name, performance.now() - startTime);
  }

  increment(name: string, value = 1): void {
    this.counters[name] = (this.counters[name] ?? 0) + value;
  }

  private recordRaw(name: string, durationMs: number): void {
    if (!this.timers[name]) this.timers[name] = [];
    this.timers[name].push(Math.round(durationMs * 100) / 100);
  }

  toVUMetrics(): VUMetrics {
    return {
      vuId: this.vuId,
      timers: { ...this.timers },
      counters: { ...this.counters },
      iterations: this.iterations,
      errors: [...this.errors],
    };
  }
}
