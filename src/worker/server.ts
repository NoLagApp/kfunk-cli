import WebSocket from "ws";
// @ts-expect-error polyfill WebSocket for Node.js
globalThis.WebSocket = WebSocket;

import express from "express";
import { runClient } from "../core/load-client.js";
import { handleGenericRun, type GenericWorkerRequest } from "./generic-handler.js";
import type { WorkerRequest, WorkerMetrics, ClientConfig, ClientMetrics } from "../core/types.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/", async (req, res) => {
  const body = req.body as WorkerRequest;
  const {
    url,
    token,
    topic,
    qos = 1,
    connections = 10,
    duration = 30,
    workerIndex = 0,
    publishIntervalMs = 500,
  } = body;

  if (!token || !topic) {
    res.status(400).json({ error: "token and topic are required" });
    return;
  }

  const workerStart = Date.now();
  console.log(
    `Worker ${workerIndex}: starting ${connections} connections for ${duration}s`,
  );

  const configs: ClientConfig[] = Array.from(
    { length: connections },
    (_, i) => ({
      url,
      token,
      topic,
      qos: qos as 0 | 1 | 2,
      duration,
      clientId: workerIndex * 10000 + i,
      publishIntervalMs,
    }),
  );

  // Stagger connection starts 500ms apart, but run all in parallel
  const results = await Promise.allSettled(
    configs.map(
      (config, i) =>
        new Promise<ClientMetrics>((resolve, reject) => {
          setTimeout(() => runClient(config).then(resolve, reject), i * 500);
        }),
    ),
  );

  const clients = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      clientId: configs[i].clientId,
      connectTimeMs: 0,
      authSuccess: false,
      roundtrips: [],
      messagesSent: 0,
      messagesReceived: 0,
      errors: [r.reason instanceof Error ? r.reason.message : String(r.reason)],
    };
  });

  const metrics: WorkerMetrics = {
    workerIndex,
    clients,
    totalConnections: connections,
    successfulConnections: clients.filter((c) => c.authSuccess).length,
    failedConnections: clients.filter((c) => !c.authSuccess).length,
    durationMs: Date.now() - workerStart,
  };

  console.log(
    `Worker ${workerIndex}: done. ${metrics.successfulConnections}/${connections} ok`,
  );

  res.json(metrics);
});

// ---- Generic script runner endpoint ----
app.post("/run", async (req, res) => {
  const body = req.body as GenericWorkerRequest;

  if (!body.script || typeof body.script !== "string") {
    res.status(400).json({ error: "script (string) is required" });
    return;
  }

  try {
    const result = await handleGenericRun({
      script: body.script,
      vus: body.vus ?? 1,
      duration: body.duration ?? 30,
      staggerMs: body.staggerMs ?? 0,
      workerIndex: body.workerIndex ?? 0,
      eventPlugins: body.eventPlugins,
    });
    res.json(result);
  } catch (err) {
    console.error("Generic run failed:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

const port = parseInt(process.env.PORT || "8080", 10);
app.listen(port, () => {
  console.log(`kfunk worker listening on port ${port}`);
});
