import chalk from "chalk";
import Table from "cli-table3";
import type { AggregatedMetrics, GenericAggregatedMetrics, PercentileStats } from "../core/types.js";

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statsRow(label: string, stats: PercentileStats): string[] {
  return [
    label,
    fmtMs(stats.avg),
    fmtMs(stats.min),
    fmtMs(stats.med),
    fmtMs(stats.p90),
    fmtMs(stats.p95),
    fmtMs(stats.p99),
    fmtMs(stats.max),
  ];
}

export function displayResults(metrics: AggregatedMetrics): void {
  console.log();
  console.log(chalk.bold.cyan("  LATENCY"));

  const table = new Table({
    chars: {
      top: "", "top-mid": "", "top-left": "", "top-right": "",
      bottom: "", "bottom-mid": "", "bottom-left": "", "bottom-right": "",
      left: "  ", "left-mid": "", mid: "", "mid-mid": "",
      right: "", "right-mid": "", middle: "  ",
    },
    style: { "padding-left": 0, "padding-right": 0 },
    head: ["metric", "avg", "min", "med", "p90", "p95", "p99", "max"].map((h) =>
      chalk.gray(h),
    ),
  });

  table.push(statsRow("ws_connect_time", metrics.connectTime));
  table.push(statsRow("msg_roundtrip", metrics.roundtrip));

  console.log(table.toString());
  console.log();
  console.log(chalk.bold.cyan("  SUMMARY"));
  console.log(`  messages_sent ....... ${chalk.white(metrics.totalMessagesSent)}`);
  console.log(`  messages_received ... ${chalk.white(metrics.totalMessagesReceived)}`);
  console.log(
    `  connections ......... ${chalk.white(metrics.totalConnections)} (${chalk.green(metrics.successfulConnections + " ok")}, ${chalk.red(metrics.failedConnections + " failed")})`,
  );
  console.log(
    `  workers ............. ${chalk.white(metrics.workersTotal)} (${chalk.green(metrics.workersOk + " ok")}, ${chalk.red(metrics.workersFailed + " failed")})`,
  );
  console.log(`  total_duration ...... ${chalk.white(fmtMs(metrics.totalDurationMs))}`);

  if (metrics.clientErrors.length > 0) {
    console.log();
    console.log(chalk.bold.red("  ERRORS"));
    for (const err of metrics.clientErrors.slice(0, 10)) {
      console.log(chalk.red(`  - ${err}`));
    }
    if (metrics.clientErrors.length > 10) {
      console.log(chalk.red(`  ... and ${metrics.clientErrors.length - 10} more`));
    }
  }
  console.log();
}

const tableChars = {
  top: "", "top-mid": "", "top-left": "", "top-right": "",
  bottom: "", "bottom-mid": "", "bottom-left": "", "bottom-right": "",
  left: "  ", "left-mid": "", mid: "", "mid-mid": "",
  right: "", "right-mid": "", middle: "  ",
};

export function displayGenericResults(metrics: GenericAggregatedMetrics): void {
  console.log();

  const timerNames = Object.keys(metrics.timers);
  if (timerNames.length > 0) {
    console.log(chalk.bold.cyan("  TIMERS"));
    const table = new Table({
      chars: tableChars,
      style: { "padding-left": 0, "padding-right": 0 },
      head: ["metric", "avg", "min", "med", "p90", "p95", "p99", "max"].map((h) =>
        chalk.gray(h),
      ),
    });
    for (const name of timerNames.sort()) {
      table.push(statsRow(name, metrics.timers[name]));
    }
    console.log(table.toString());
    console.log();
  }

  const counterNames = Object.keys(metrics.counters);
  if (counterNames.length > 0) {
    console.log(chalk.bold.cyan("  COUNTERS"));
    for (const name of counterNames.sort()) {
      console.log(`  ${name} ....... ${chalk.white(metrics.counters[name])}`);
    }
    console.log();
  }

  console.log(chalk.bold.cyan("  SUMMARY"));
  console.log(`  virtual_users ....... ${chalk.white(metrics.totalVUs)}`);
  console.log(`  iterations .......... ${chalk.white(metrics.totalIterations)}`);
  console.log(`  total_duration ...... ${chalk.white(fmtMs(metrics.totalDurationMs))}`);

  if (metrics.errors.length > 0) {
    console.log();
    console.log(chalk.bold.red("  ERRORS"));
    for (const err of metrics.errors.slice(0, 10)) {
      console.log(chalk.red(`  - ${err}`));
    }
    if (metrics.errors.length > 10) {
      console.log(chalk.red(`  ... and ${metrics.errors.length - 10} more`));
    }
  }
  console.log();
}
