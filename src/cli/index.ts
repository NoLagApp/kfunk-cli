#!/usr/bin/env node
import { program } from "commander";
import { resolve, dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { orchestrate } from "../core/orchestrator.js";
import { orchestrateGeneric } from "../core/generic-orchestrator.js";
import { aggregate, aggregateGeneric } from "../core/aggregator.js";
import { runScript } from "../core/runtime.js";
import { loadConfig, loadPlugins, PluginRegistry } from "../core/plugin-loader.js";
import { displayResults, displayGenericResults } from "./display.js";
import { execSync } from "child_process";
import type { TestRunContext } from "../core/plugin-types.js";

program.name("kfunk").description("Distributed load testing tool");

program
  .command("run")
  .description("Run a load test script (locally or distributed)")
  .argument("<script>", "Path to the test script (.js)")
  .option("--vus <n>", "Number of virtual users (local) or VUs per worker (distributed)", "10")
  .option("--duration <s>", "Test duration in seconds", "30")
  .option("--stagger <ms>", "ms between spawning each VU", "0")
  .option("--service-url <url>", "Worker URL (enables distributed mode)")
  .option("--workers <n>", "Number of workers (distributed only)", "1")
  .option("--worker-stagger <ms>", "ms between launching each worker", "0")
  .option("--config <path>", "Path to kfunk config file")
  .option("--json", "Output raw JSON instead of table", false)
  .action(async (scriptArg: string, opts) => {
    const scriptPath = resolve(scriptArg);
    const vus = parseInt(opts.vus, 10);
    const duration = parseInt(opts.duration, 10);
    const workers = parseInt(opts.workers, 10);

    // Load config and plugins
    const config = await loadConfig(dirname(scriptPath), opts.config);
    const registry = config ? await loadPlugins(config) : new PluginRegistry();
    const eventPlugins = registry.getEventPlugins();
    const infraPlugin = config?.infra ? registry.getInfraPlugin(config.infra as string) : registry.getInfraPlugin();
    const isDistributed = !!(opts.serviceUrl || infraPlugin);

    const context: TestRunContext = {
      mode: isDistributed ? "distributed" : "local",
      vus,
      duration,
      workers: isDistributed ? workers : undefined,
      scriptPath,
    };

    // Fire onTestStart on all event plugins
    for (const plugin of eventPlugins) {
      try { await plugin.onTestStart?.(context); } catch (err) {
        console.error(`Plugin ${plugin.name} onTestStart error:`, err);
      }
    }

    const onProgress = (msg: string) => {
      process.stdout.write(msg);
      for (const plugin of eventPlugins) {
        try { plugin.onProgress?.(msg); } catch { /* best-effort */ }
      }
    };

    let result;

    if (isDistributed) {
      const scriptCode = await readFile(scriptPath, "utf-8");
      const eventPluginConfigs = registry.getEventPluginConfigs();

      if (infraPlugin) {
        // Use infra plugin for distributed execution
        result = await infraPlugin.runDistributed({
          serviceUrl: opts.serviceUrl ?? "",
          script: scriptCode,
          workers,
          vusPerWorker: vus,
          duration,
          staggerMs: parseInt(opts.stagger, 10),
          workerStaggerMs: parseInt(opts.workerStagger, 10),
          eventPlugins: eventPluginConfigs.length > 0 ? eventPluginConfigs : undefined,
          onProgress,
        });
      } else {
        // Legacy distributed mode with --service-url (no infra plugin)
        result = await orchestrateGeneric({
          serviceUrl: opts.serviceUrl,
          script: scriptCode,
          workers,
          vusPerWorker: vus,
          duration,
          staggerMs: parseInt(opts.stagger, 10),
          workerStaggerMs: parseInt(opts.workerStagger, 10),
          eventPlugins: eventPluginConfigs.length > 0 ? eventPluginConfigs : undefined,
          onProgress,
        });
      }
    } else {
      // Local mode: run directly, wire VU hooks to event plugins
      result = await runScript({
        scriptPath,
        vus,
        duration,
        staggerMs: parseInt(opts.stagger, 10),
        onProgress,
        onVUStart: eventPlugins.length > 0
          ? (vuId, totalVUs) => {
              for (const plugin of eventPlugins) {
                try { plugin.onVUStart?.(vuId, totalVUs); } catch { /* best-effort */ }
              }
            }
          : undefined,
        onVUComplete: eventPlugins.length > 0
          ? (vuMetrics) => {
              for (const plugin of eventPlugins) {
                try { plugin.onVUComplete?.(vuMetrics); } catch { /* best-effort */ }
              }
            }
          : undefined,
      });
    }

    const aggregated = aggregateGeneric(result);

    // Fire onTestEnd on all event plugins
    for (const plugin of eventPlugins) {
      try { await plugin.onTestEnd?.(context, aggregated); } catch (err) {
        console.error(`Plugin ${plugin.name} onTestEnd error:`, err);
      }
    }

    if (opts.json) {
      console.log(JSON.stringify(aggregated, null, 2));
    } else {
      displayGenericResults(aggregated);
    }

    // Cleanup
    await registry.destroyAll();
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
  .description("Deploy workers using infra plugin or legacy script")
  .option("--config <path>", "Path to kfunk config file")
  .action(async (opts) => {
    const config = await loadConfig(process.cwd(), opts.config);
    const registry = config ? await loadPlugins(config) : new PluginRegistry();
    const infraPlugin = config?.infra ? registry.getInfraPlugin(config.infra as string) : registry.getInfraPlugin();

    if (infraPlugin) {
      const pluginConfig = config?.[infraPlugin.name] as Record<string, unknown> ?? {};
      const eventPluginPackages = registry.getEventPluginConfigs().map((c) => c.name);
      console.log(`Deploying via ${infraPlugin.name}...`);
      const { serviceUrl } = await infraPlugin.deploy({
        ...pluginConfig,
        eventPluginPackages: eventPluginPackages.length > 0 ? eventPluginPackages : undefined,
      });
      console.log(`\nDeployed! Service URL: ${serviceUrl}`);
      await registry.destroyAll();
    } else {
      // Fallback to legacy deploy script
      execSync("bash scripts/deploy.sh", { stdio: "inherit" });
    }
  });

program.parse();
