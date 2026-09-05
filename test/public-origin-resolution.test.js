"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const dotenv = require("dotenv");
const resolver = require("../src/settings/resolver");
const readiness = require("../src/settings/readiness");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-public-origin-"));
const previousHome = process.env.AI_MEET_HOME;
process.env.AI_MEET_HOME = home;
const routesPath = require.resolve("../src/transport-meet/meet-routes");

function initialize({ server = {}, preDotenvEnv = {}, dotenvSeed = "" } = {}) {
  fs.writeFileSync(path.join(home, ".env"), dotenvSeed);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ server }));
  resolver.resetRuntimeForTest();
  resolver.initializeRuntime({
    state: {
      exists: true, valid: true, revision: "a".repeat(64), fingerprint: "a".repeat(64),
      parsed: JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")),
    },
    startup: Object.freeze({
      preDotenvEnv: Object.freeze({ ...preDotenvEnv }),
      dotenvSeeds: Object.freeze(dotenv.parse(fs.readFileSync(path.join(home, ".env")))),
      resolvedHome: home,
      configPath: path.join(home, "config.json"),
      connection: Object.freeze({ openclawUrl: "", openclawToken: "", openaiApiKey: "" }),
    }),
    serverPort: 5005,
  });
}

initialize();
const { publicOriginCandidates, resolveLocalAvatarPublicOrigin, resolvePublicOrigin, refreshNgrokDetection } = require(routesPath)._test;

test.after(() => {
  readiness.reset();
  resolver.resetRuntimeForTest();
  delete require.cache[routesPath];
  if (previousHome === undefined) delete process.env.AI_MEET_HOME;
  else process.env.AI_MEET_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function ngrokLookup(publicUrl = "") {
  let calls = 0;
  return {
    get calls() { return calls; },
    httpGet(url, callback) {
      assert.equal(url, "http://127.0.0.1:4040/api/tunnels");
      calls += 1;
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.destroy = () => {};
      queueMicrotask(() => {
        const response = new EventEmitter();
        callback(response);
        response.emit("data", JSON.stringify({ tunnels: publicUrl ? [{ proto: "https", public_url: publicUrl }] : [] }));
        response.emit("end");
      });
      return request;
    },
  };
}

test("publicOriginCandidates locks every adjacent priority and filters absent sources", () => {
  const inputs = { publicOrigin: "https://public.example:8443", ngrokDomain: "domain.example", publicWss: "wss://legacy.example", detected: "wss://detected.example" };
  const expected = ["https://public.example:8443", "https://domain.example", "https://legacy.example", "https://detected.example"];
  for (const key of Object.keys(inputs)) {
    assert.deepEqual(publicOriginCandidates(inputs), expected);
    delete inputs[key];
    expected.shift();
  }
  assert.deepEqual(publicOriginCandidates(inputs), []);
  assert.deepEqual(publicOriginCandidates({ publicWss: "https://legacy.example", detected: "http://detected.example" }), []);
});

const cases = [
  { name: "stored public origin beats env seed, domain, legacy and detected origins", server: { publicOrigin: "https://stored.example:8443", ngrokDomain: "domain.example" }, dotenvSeed: "PUBLIC_ORIGIN=https://seed.example\n", preDotenvEnv: { PUBLIC_WSS_URL: "wss://legacy.example" }, expected: "https://stored.example:8443" },
  { name: ".env public origin beats ngrok domain", server: { ngrokDomain: "domain.example" }, dotenvSeed: "PUBLIC_ORIGIN=https://seed.example\n", expected: "https://seed.example" },
  { name: "OS public origin beats ngrok domain", server: { ngrokDomain: "domain.example" }, preDotenvEnv: { PUBLIC_ORIGIN: "https://os.example" }, expected: "https://os.example" },
  // Section 3 keeps OS overrides above config; config is above the .env seed.
  { name: "OS override retains section 3 priority over stored public origin", server: { publicOrigin: "https://stored.example", ngrokDomain: "domain.example" }, preDotenvEnv: { PUBLIC_ORIGIN: "https://os.example" }, dotenvSeed: "PUBLIC_ORIGIN=https://seed.example\n", expected: "https://os.example" },
  { name: "empty public origin falls back to domain before legacy env", server: { publicOrigin: "", ngrokDomain: "domain.example" }, preDotenvEnv: { PUBLIC_WSS_URL: "wss://legacy.example" }, expected: "https://domain.example" },
  { name: "empty configured origins fall back to legacy env before autodetect", server: { publicOrigin: "", ngrokDomain: "" }, preDotenvEnv: { PUBLIC_WSS_URL: "wss://legacy.example" }, expected: "https://legacy.example" },
  { name: "all configured origins empty falls back to autodetect", server: { publicOrigin: "", ngrokDomain: "" }, expected: "https://detected.example" },
  { name: "no origin returns the function-specific empty result", detected: "", expected: "" },
];

for (const fixture of cases) {
  test(fixture.name, { concurrency: false }, async () => {
    initialize(fixture);
    const lookup = ngrokLookup(fixture.detected ?? "https://detected.example");
    await refreshNgrokDetection({ httpGet: lookup.httpGet, preferConfigured: false });
    assert.equal(resolveLocalAvatarPublicOrigin(), fixture.expected || null);
    // An unmatched submitted host includes the detected candidate even with config set.
    const result = await resolvePublicOrigin({ httpGet: lookup.httpGet, submittedHost: "submitted.example" });
    assert.equal(result.origin, fixture.expected);
    if (fixture.expected) assert.ok(result.candidateHosts.has(new URL(fixture.expected).host));
    else assert.equal(result.candidateHosts.size, 0);
    assert.equal(lookup.calls, 2);
  });
}

test("public origin host with a port satisfies identity candidates without ngrok lookup", async () => {
  initialize({ server: { publicOrigin: "https://a.example:8443", ngrokDomain: "domain.example" } });
  let calls = 0;
  const result = await resolvePublicOrigin({
    submittedHost: "a.example:8443",
    httpGet() { calls += 1; throw new Error("unexpected ngrok lookup"); },
  });
  assert.equal(result.origin, "https://a.example:8443");
  assert.ok(result.candidateHosts.has("a.example:8443"));
  assert.equal(calls, 0);
});
