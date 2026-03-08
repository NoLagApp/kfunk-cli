import { NoLag } from "@nolag/js-sdk";
import type { ClientConfig, ClientMetrics } from "./types.js";

export async function runClient(config: ClientConfig): Promise<ClientMetrics> {
  const metrics: ClientMetrics = {
    clientId: config.clientId,
    connectTimeMs: 0,
    authSuccess: false,
    roundtrips: [],
    messagesSent: 0,
    messagesReceived: 0,
    errors: [],
  };

  const client = NoLag(config.token, {
    url: config.url,
    qos: config.qos,
    reconnect: false,
    heartbeatInterval: 25000,
  });

  // Measure connect + auth
  const connectStart = Date.now();
  try {
    await client.connect();
    metrics.connectTimeMs = Date.now() - connectStart;
    metrics.authSuccess = true;
  } catch (err: unknown) {
    metrics.connectTimeMs = Date.now() - connectStart;
    metrics.errors.push(`connect: ${err instanceof Error ? err.message : String(err)}`);
    return metrics;
  }

  // Subscribe to topic
  const pendingTimestamps = new Map<number, number>();

  client.subscribe(config.topic);

  // Listen for messages, measure roundtrip on echo
  client.on(config.topic, (data: unknown) => {
    metrics.messagesReceived++;
    const msg = data as Record<string, unknown>;
    if (msg._cid === config.clientId && typeof msg._seq === "number") {
      const sent = pendingTimestamps.get(msg._seq);
      if (sent !== undefined) {
        metrics.roundtrips.push(Date.now() - sent);
        pendingTimestamps.delete(msg._seq);
      }
    }
  });

  client.on("error", (err: Error) => {
    metrics.errors.push(`runtime: ${err.message}`);
  });

  // Publish loop
  let seq = 0;
  const interval = setInterval(() => {
    const now = Date.now();
    pendingTimestamps.set(seq, now);
    client.emit(
      config.topic,
      { _cid: config.clientId, _seq: seq++, _ts: now, text: "kfunk" },
      { echo: true },
    );
    metrics.messagesSent++;
  }, config.publishIntervalMs);

  // Wait for test duration
  await new Promise((r) => setTimeout(r, config.duration * 1000));

  clearInterval(interval);

  try {
    client.disconnect();
  } catch {
    // ignore disconnect errors
  }

  return metrics;
}
