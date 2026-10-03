import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const target = new URL(process.argv[2] || "http://127.0.0.1:43118/");
const totalRequests = Number(process.argv[3] || 1000);
const concurrency = Number(process.argv[4] || 25);

assert.ok(["127.0.0.1", "localhost", "::1"].includes(target.hostname), "load tests are restricted to a local server");
assert.ok(Number.isInteger(totalRequests) && totalRequests > 0 && totalRequests <= 10000, "request count must be 1-10,000");
assert.ok(Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 100, "concurrency must be 1-100");

let nextRequest = 0;
let failures = 0;
let bytes = 0;
const durations = [];
const failureReasons = new Map();
const startedAt = performance.now();

async function worker() {
  while (true) {
    const requestNumber = nextRequest;
    nextRequest += 1;
    if (requestNumber >= totalRequests) return;
    const requestStartedAt = performance.now();
    try {
      const response = await fetch(target, { cache: "no-store" });
      const body = await response.arrayBuffer();
      bytes += body.byteLength;
      if (!response.ok) {
        failures += 1;
        const reason = `http_${response.status}`;
        failureReasons.set(reason, (failureReasons.get(reason) || 0) + 1);
      }
    } catch (error) {
      failures += 1;
      const reason = error?.cause?.code || error?.name || "request_error";
      failureReasons.set(reason, (failureReasons.get(reason) || 0) + 1);
    }
    durations.push(performance.now() - requestStartedAt);
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
const elapsedMilliseconds = performance.now() - startedAt;
durations.sort((a, b) => a - b);
const percentile = (value) => durations[Math.min(durations.length - 1, Math.floor(durations.length * value))];
const result = {
  target: target.href,
  requests: totalRequests,
  concurrency,
  failures,
  failureReasons: Object.fromEntries(failureReasons),
  megabytesRead: Number((bytes / 1024 / 1024).toFixed(2)),
  requestsPerSecond: Number((totalRequests / (elapsedMilliseconds / 1000)).toFixed(1)),
  latencyMilliseconds: {
    p50: Number(percentile(0.5).toFixed(2)),
    p95: Number(percentile(0.95).toFixed(2)),
    p99: Number(percentile(0.99).toFixed(2)),
  },
};
console.log(JSON.stringify(result, null, 2));
assert.equal(failures, 0, "all local requests must succeed");
