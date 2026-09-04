const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  readMetricsSummary,
  sendMetricsSummary,
  servePublicAsset,
} = require("../src/ui-routes");

test("readMetricsSummary aggregates supported events by session", async () => {
  const dir = tempDir();
  const now = Date.now();
  writeMetrics(dir, [
    { timestamp_ms: now - 10_000, type: "wake_decision", session_id: "s1", addressed: true },
    { timestamp_ms: now - 9_000, type: "wake_decision", session_id: "s1", addressed: false },
    { timestamp_ms: now - 8_000, type: "turn_end", session_id: "s1" },
    { timestamp_ms: now - 7_000, type: "utterance_end", session_id: "s1" },
    { timestamp_ms: now - 6_000, type: "tts_playback_start", session_id: "s1" },
    { timestamp_ms: now - 5_000, type: "turn_end", session_id: "s2" },
  ]);

  const summary = await withMetricsDir(dir, () => readMetricsSummary("24"));

  assert.equal(summary.enabled, true);
  assert.equal(summary.windowHours, 24);
  assert.deepEqual(summary.totals, {
    wakeDecisions: 2,
    addressed: 1,
    turns: 2,
    utterances: 1,
    ttsPlaybacks: 1,
  });
  assert.equal(summary.recentSessions.length, 2);
  assert.equal(summary.recentSessions[0].sessionId, "s2");
  assert.equal(summary.recentSessions[1].sessionId, "s1");
  assert.equal(summary.recentSessions[1].turns, 1);
  assert.equal(summary.recentSessions[1].wakeAddressed, 1);
  assert.equal(summary.recentSessions[1].wakeIgnored, 1);
});

test("readMetricsSummary returns disabled when the metrics file is missing", async () => {
  const dir = tempDir();

  const summary = await withMetricsDir(dir, () => readMetricsSummary("24"));

  assert.deepEqual(summary, { enabled: false });
});

test("readMetricsSummary skips invalid lines", async () => {
  const dir = tempDir();
  const now = Date.now();
  fs.writeFileSync(path.join(dir, "metrics.jsonl"), [
    JSON.stringify({ timestamp_ms: now - 1_000, type: "turn_end", session_id: "s1" }),
    "{not-json",
    JSON.stringify({ timestamp_ms: now - 500, type: "utterance_end", session_id: "s1" }),
  ].join("\n"));

  const summary = await withMetricsDir(dir, () => readMetricsSummary("24"));

  assert.equal(summary.enabled, true);
  assert.equal(summary.totals.turns, 1);
  assert.equal(summary.totals.utterances, 1);
});

test("readMetricsSummary clamps hours to 168", async () => {
  const dir = tempDir();
  const now = Date.now();
  writeMetrics(dir, [
    { timestamp_ms: now - 167 * 60 * 60 * 1000, type: "wake_decision", session_id: "included", addressed: true },
    { timestamp_ms: now - 169 * 60 * 60 * 1000, type: "wake_decision", session_id: "excluded", addressed: true },
  ]);

  const summary = await withMetricsDir(dir, () => readMetricsSummary("1000"));

  assert.equal(summary.windowHours, 168);
  assert.equal(summary.totals.wakeDecisions, 1);
  assert.equal(summary.recentSessions.length, 1);
  assert.equal(summary.recentSessions[0].sessionId, "included");
});

test("servePublicAsset serves CSS and JS with content types", async () => {
  const css = await serveAsset("/style.css");
  assert.equal(css.statusCode, 200);
  assert.match(css.headers["Content-Type"], /^text\/css/);
  assert.match(css.body, /Design tokens/);

  const js = await serveAsset("/app.js");
  assert.equal(js.statusCode, 200);
  assert.match(js.headers["Content-Type"], /^application\/javascript/);
  assert.match(js.body, /decodeEscapedAngles/);
});

test("servePublicAsset rejects traversal paths", async () => {
  const res = await serveAsset("/../style.css");
  assert.equal(res.statusCode, 404);
});

test("readMetricsSummary skips null and non-object lines while keeping valid ones", async () => {
  const dir = tempDir();
  const now = Date.now();
  fs.writeFileSync(path.join(dir, "metrics.jsonl"), [
    "null",
    JSON.stringify({ timestamp_ms: now - 1_000, type: "turn_end", session_id: "s1" }),
    "{not-json",
  ].join("\n"));

  const summary = await withMetricsDir(dir, () => readMetricsSummary("24"));

  assert.equal(summary.enabled, true);
  assert.equal(summary.totals.turns, 1);
});

test("readMetricsSummary returns empty totals for an empty metrics file", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "metrics.jsonl"), "");

  const summary = await withMetricsDir(dir, () => readMetricsSummary("24"));

  assert.equal(summary.enabled, true);
  assert.deepEqual(summary.totals, {
    wakeDecisions: 0,
    addressed: 0,
    turns: 0,
    utterances: 0,
    ttsPlaybacks: 0,
  });
  assert.deepEqual(summary.recentSessions, []);
});

test("metrics summary logs scrub labelled secrets and preserve benign messages", async (t) => {
  const value = ["ui", "184", "key"].join("");
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);

  try {
    const rows = [
      [`metrics read failed token=${value}`, "metrics read failed token=[REDACTED]"],
      ["metrics read temporarily unavailable", "metrics read temporarily unavailable"],
    ];

    for (const [message] of rows) {
      const response = await invokeMetricsSummary(message);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(JSON.parse(response.body), { enabled: false });
    }

    for (const [index, [, expected]] of rows.entries()) {
      const name = index === 0 ? "labelled secret row" : "benign row";
      await t.test(name, () => assert.deepEqual(
        warnings[index],
        ["metrics summary failed:", expected],
      ));
    }
  } finally {
    console.warn = originalWarn;
  }
});

test("servePublicAsset does not serve non-GET requests for known assets", async () => {
  const res = await serveAsset("/style.css", "POST");
  assert.equal(res, false);
});

function writeMetrics(dir, events) {
  fs.writeFileSync(path.join(dir, "metrics.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

async function withMetricsDir(dir, fn) {
  const previous = process.env.METRICS_LOG_DIR;
  process.env.METRICS_LOG_DIR = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.METRICS_LOG_DIR;
    else process.env.METRICS_LOG_DIR = previous;
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ui-routes-test-"));
}

function serveAsset(requestPath, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = { method, url: requestPath };
    const res = {
      statusCode: null,
      headers: null,
      body: "",
      writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
      },
      end(data = "") {
        this.body = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        resolve({ statusCode: this.statusCode, headers: this.headers, body: this.body });
      },
    };
    try {
      const url = new URL(requestPath, "http://localhost");
      const handled = servePublicAsset(req, res, url);
      if (!handled) {
        resolve(false);
        return;
      }
    } catch (err) {
      reject(err);
    }
  });
}

async function invokeMetricsSummary(message) {
  const req = { method: "GET", url: "/metrics" };
  const url = {
    pathname: "/metrics",
    searchParams: {
      get() { throw new Error(message); },
    },
  };
  const response = { statusCode: null, body: "" };
  const res = {
    writeHead(statusCode) { response.statusCode = statusCode; },
    end(body = "") { response.body = String(body); },
  };

  assert.equal(await sendMetricsSummary(req, res, url), true);
  return response;
}
