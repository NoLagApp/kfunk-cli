#!/usr/bin/env node
import { program } from "commander";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { orchestrate } from "../core/orchestrator.js";
import { orchestrateGeneric } from "../core/generic-orchestrator.js";
import { aggregate, aggregateGeneric } from "../core/aggregator.js";
import { runScript } from "../core/runtime.js";
import { displayResults, displayGenericResults } from "./display.js";
import { execSync } from "child_process";

program.name("kfunk").description("Distributed load testing tool");

program
  .command("run")
  .description("Run a load test script (locally or distributed)")
  .argument("<script>", "Path to the test script (.js)")
  .option("--vus <n>", "Number of virtual users (local) or VUs per worker (distributed)", "10")
  .option("--duration <s>", "Test duration in seconds", "30")
  .option("--stagger <ms>", "ms between spawning each VU", "0")
  .option("--service-url <url>", "Cloud Run worker URL (enables distributed mode)")
  .option("--workers <n>", "Number of Cloud Run workers (distributed only)", "1")
  .option("--worker-stagger <ms>", "ms between launching each worker", "0")
  .option("--json", "Output raw JSON instead of table", false)
  .action(async (scriptArg: string, opts) => {
    const scriptPath = resolve(scriptArg);

    let result;

    if (opts.serviceUrl) {
      // Distributed mode: read script file and send to Cloud Run workers
      const scriptCode = await readFile(scriptPath, "utf-8");

      result = await orchestrateGeneric({
        serviceUrl: opts.serviceUrl,
        script: scriptCode,
        workers: parseInt(opts.workers, 10),
        vusPerWorker: parseInt(opts.vus, 10),
        duration: parseInt(opts.duration, 10),
        staggerMs: parseInt(opts.stagger, 10),
        workerStaggerMs: parseInt(opts.workerStagger, 10),
        onProgress: (msg) => process.stdout.write(msg),
      });
    } else {
      // Local mode: run directly
      result = await runScript({
        scriptPath,
        vus: parseInt(opts.vus, 10),
        duration: parseInt(opts.duration, 10),
        staggerMs: parseInt(opts.stagger, 10),
        onProgress: (msg) => process.stdout.write(msg),
      });
    }

    const aggregated = aggregateGeneric(result);

    if (opts.json) {
      console.log(JSON.stringify(aggregated, null, 2));
    } else {
      displayGenericResults(aggregated);
    }
  });

program
  .command("run-nolag")
  .description("Run a distributed NoLag load test (legacy)")
  .requiredOption("--token <token>", "Access token")
  .option("--url <url>", "Broker URL")
  .option("--service-url <url>", "Cloud Run worker URL")
  .option("--workers <n>", "Number of Cloud Run workers", "10")
  .option("--connections <n>", "Connections per worker", "10")
  .option("--duration <s>", "Test duration in seconds", "30")
  .option("--topic <path>", "Full topic path", "k6-test/load-test/messages")
  .option("--qos <level>", "QoS level (0, 1, 2)", "1")
  .option("--publish-interval <ms>", "ms between publishes per connection", "500")
  .option("--stagger <ms>", "ms between launching each worker", "500")
  .option("--json", "Output raw JSON instead of table", false)
  .action(async (opts) => {
    const serviceUrl = opts.serviceUrl;
    if (!serviceUrl) {
      console.error("Error: --service-url is required. Deploy the worker first with: npm run deploy");
      process.exit(1);
    }

    const result = await orchestrate({
      serviceUrl,
      workers: parseInt(opts.workers, 10),
      staggerMs: parseInt(opts.stagger, 10),
      workerRequest: {
        url: opts.url,
        token: opts.token,
        topic: opts.topic,
        qos: parseInt(opts.qos, 10) as 0 | 1 | 2,
        connections: parseInt(opts.connections, 10),
        duration: parseInt(opts.duration, 10),
        publishIntervalMs: parseInt(opts.publishInterval, 10),
      },
      onProgress: (msg) => process.stdout.write(msg),
    });

    const aggregated = aggregate(result.metrics, result.errors, result.durationMs);

    if (opts.json) {
      console.log(JSON.stringify(aggregated, null, 2));
    } else {
      displayResults(aggregated);
    }
  });

program
  .command("deploy")
  .description("Deploy the worker to Cloud Run")
  .action(() => {
    execSync("bash scripts/deploy.sh", { stdio: "inherit" });
  });

program.parse();
