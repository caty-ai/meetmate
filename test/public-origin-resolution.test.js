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
const {
  ngrokTunnelTargetsPort, publicOriginCandidates, publicOriginWsUrl,
  resolveLocalAvatarPublicOrigin, resolvePublicOrigin, refreshNgrokDetection,
} = require(routesPath)._test;

test.after(() => {
  readiness.reset();
  resolver.resetRuntimeForTest();
  delete require.cache[routesPath];
  if (previousHome === undefined) delete process.env.AI_MEET_HOME;
  else process.env.AI_MEET_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

// `tunnels: null` models a host without an ngrok agent (the request errors).
function ngrokTunnels(tunnels) {
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
        if (tunnels === null) {
          request.emit("error", Object.assign(new Error("ngrok unavailable in test"), { code: "ECONNREFUSED" }));
          return;
        }
        const response = new EventEmitter();
        callback(response);
        response.emit("data", JSON.stringify({ tunnels }));
        response.emit("end");
      });
      return request;
    },
  };
}

function tunnel(publicUrl, addr) {
  return { proto: "https", public_url: publicUrl, ...(addr === undefined ? {} : { config: { addr } }) };
}

// The agent forwards to this server's listen port (5005 in these fixtures), as #279 requires.
function ngrokLookup(publicUrl = "") {
  return ngrokTunnels(publicUrl ? [tunnel(publicUrl, "http://localhost:5005")] : []);
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

const OWN_ADDR = "http://localhost:5005";
const OTHER_APP_ADDR = "http://localhost:8081";

test("#279 ngrokTunnelTargetsPort accepts only a loopback target on exactly this server's port", () => {
  const targets = (addr, port = 5005) => ngrokTunnelTargetsPort({ config: { addr } }, port);

  for (const addr of [
    "http://localhost:5005", "https://127.0.0.1:5005", "http://[::1]:5005",
    "localhost:5005", "127.0.0.1:5005", "[::1]:5005", "5005",
    "HTTP://LocalHost:5005", "LOCALHOST:5005", "http://localhost:5005/",
  ]) assert.equal(targets(addr), true, addr);

  // A URL without a port means the scheme default.
  assert.equal(targets("http://localhost", 80), true);
  assert.equal(targets("https://127.0.0.1", 443), true);
  assert.equal(targets("https://[::1]/", 443), true);
  assert.equal(targets("http://localhost", 443), false);
  assert.equal(targets("https://localhost", 80), false);
  assert.equal(targets("http://localhost"), false);
  assert.equal(targets("localhost"), false);

  for (const addr of [
    // another app on the same host (the #279 measurement)
    "http://localhost:8081", "localhost:8081", "8081",
    // not a loopback host
    "http://192.168.1.10:5005", "192.168.1.10:5005", "http://0.0.0.0:5005", "0.0.0.0:5005",
    "http://host.docker.internal:5005", "host.docker.internal:5005", "http://example.com:5005",
    "http://127.0.0.2:5005", "http://[::2]:5005", "::1:5005", "http://::1:5005",
    "http://[::ffff:127.0.0.1]:5005", "http://127.0.0.1.evil.example:5005",
    // other schemes
    "file:///srv/www", "file://localhost:5005", "tcp://localhost:5005", "ws://localhost:5005", "//localhost:5005", "http:/localhost:5005",
    // userinfo and suffix tricks
    "http://localhost:5005@evil.example", "http://localhost@evil.example:5005", "http://evil.example@localhost:5005",
    "localhost:5005@evil.example", "localhost:5005.evil.example", "localhost.evil.example:5005",
    "http://localhost.evil.example:5005", "http://localhost:5005.evil.example",
    "http://evil.example/localhost:5005", "http://evil.example/?localhost:5005", "http://evil.example#localhost:5005",
    "http://localhost:5005/path", "http://localhost:5005?x=1", "http://localhost:5005#x", "http://localhost:5005//",
    // port prefix / suffix / look-alikes
    "50050", "505", "15005", "localhost:50050", "localhost:505", "http://localhost:50050", "http://127.0.0.1:505",
    "http://localhost:5005:5005", "localhost:5005:5005",
    // non-numeric or non-canonical ports
    "localhost:port", "http://localhost:abc", "localhost:", "http://localhost:", "localhost:-5005", "localhost:5005x",
    "5005x", "x5005", "0x138D", "5005.0", "+5005", " 5005", "5005 ", "5005\n", "http://localhost:5005\n", "05005", "localhost:05005",
    "", " ",
  ]) assert.equal(targets(addr), false, JSON.stringify(addr));

  // Out-of-range ports never match, even against an equally out-of-range expectation.
  for (const port of [0, 65536, 99999]) {
    for (const addr of [String(port), `localhost:${port}`, `http://localhost:${port}`]) assert.equal(targets(addr, port), false, addr);
  }
  assert.equal(targets("65535", 65535), true);
  assert.equal(targets("5005", "5005"), false, "the expected port is compared as a number");
  assert.equal(targets("5005", Number.NaN), false);

  for (const addr of [undefined, null, 5005, ["5005"], { port: 5005 }, true]) assert.equal(targets(addr), false, JSON.stringify(addr));
  for (const value of [undefined, null, "5005", 5005, {}, { config: null }, { config: "5005" }, { addr: "5005" }, { public_url: "https://x.example" }]) {
    assert.equal(ngrokTunnelTargetsPort(value, 5005), false, JSON.stringify(value));
  }
});

const lookupCases = [
  { name: "a tunnel that forwards to this server is detected", tunnels: [tunnel("https://own.example", OWN_ADDR)], expected: "wss://own.example", unrelated: [] },
  { name: "another app's tunnel is not this server's address", tunnels: [tunnel("https://other.example", OTHER_APP_ADDR)], expected: "", unrelated: [5005] },
  { name: "a tunnel without config.addr is not assumed to be this server's", tunnels: [tunnel("https://other.example")], expected: "", unrelated: [5005] },
  { name: "another app's tunnel listed first does not shadow this server's tunnel", tunnels: [tunnel("https://other.example", OTHER_APP_ADDR), tunnel("https://own.example", OWN_ADDR)], expected: "wss://own.example", unrelated: [] },
  { name: "a non-https tunnel that forwards here stays ignored", tunnels: [tunnel("http://other.example", OWN_ADDR)], expected: "", unrelated: [] },
  { name: "an agent without tunnels yields nothing", tunnels: [], expected: "", unrelated: [] },
  { name: "no ngrok agent yields nothing", tunnels: null, expected: "", unrelated: [] },
  { name: "the listen port comes from server_port, not a fixed 5005", server: { port: 5030 }, tunnels: [tunnel("https://other.example", OWN_ADDR), tunnel("https://own.example", "localhost:5030")], expected: "wss://own.example", unrelated: [] },
  { name: "a 5005 tunnel is another app's when this server listens on 5030", server: { port: 5030 }, tunnels: [tunnel("https://other.example", OWN_ADDR)], expected: "", unrelated: [5030] },
];

for (const fixture of lookupCases) {
  test(`#279 ngrok autodetect: ${fixture.name}`, { concurrency: false }, async () => {
    initialize({ server: fixture.server });
    const lookup = ngrokTunnels(fixture.tunnels);
    const unrelated = [];
    const detected = await refreshNgrokDetection({ httpGet: lookup.httpGet, preferConfigured: false, onUnrelatedTunnels: (port) => unrelated.push(port) });
    assert.equal(detected, fixture.expected);
    assert.deepEqual(unrelated, fixture.unrelated);
    assert.equal(resolveLocalAvatarPublicOrigin(), fixture.expected ? fixture.expected.replace("wss:", "https:") : null);
    // Submitting the other app's host must not turn it into an identity candidate.
    const result = await resolvePublicOrigin({ httpGet: lookup.httpGet, submittedHost: "other.example" });
    assert.equal(result.origin, fixture.expected.replace("wss:", "https:"));
    assert.deepEqual([...result.candidateHosts], fixture.expected ? ["own.example"] : []);
    assert.equal(lookup.calls, 2);
  });
}

test("#279 a configured ngrok domain is returned without a lookup or a target check", { concurrency: false }, async () => {
  initialize({ server: { ngrokDomain: "domain.example" } });
  const lookup = ngrokTunnels([tunnel("https://other.example", OTHER_APP_ADDR)]);
  const unrelated = [];
  assert.equal(await refreshNgrokDetection({ httpGet: lookup.httpGet, onUnrelatedTunnels: (port) => unrelated.push(port) }), "wss://domain.example");
  assert.equal(lookup.calls, 0);
  assert.deepEqual(unrelated, []);
});

test("#279 publicOriginWsUrl maps only a parseable https origin to wss://host", () => {
  for (const [value, expected] of [
    ["https://public.example", "wss://public.example"],
    ["https://public.example:8443", "wss://public.example:8443"],
    ["https://public.example:443", "wss://public.example"],
    ["  https://Public.Example:8443/  ", "wss://public.example:8443"],
    ["https://[::1]:8443", "wss://[::1]:8443"],
    ["https://public.example/path?x=1#y", "wss://public.example"],
    ["https://user:pass@public.example", "wss://public.example"],
    ["http://public.example", ""],
    ["wss://public.example", ""],
    ["file:///srv/www", ""],
    ["public.example", ""],
    ["public.example:8443", ""],
    ["https://", ""],
    ["not a url", ""],
    ["", ""],
    ["   ", ""],
    [undefined, ""],
    [null, ""],
    [8443, ""],
    [{}, ""],
  ]) assert.equal(publicOriginWsUrl(value), expected, JSON.stringify(value));
});
