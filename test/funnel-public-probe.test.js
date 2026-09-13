"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function probe(t, args, { answer = "8.8.4.4", dnsExit = 0, http = "200", curlExit = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "funnel-probe-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = path.join(dir, "calls");
  const common = 'printf "%s\\n" "$0" "$@" >> "$PROBE_CALLS"\n';
  fs.writeFileSync(path.join(dir, "dig"), '#!/bin/bash\n' + common + 'printf "%s\\n" "$PROBE_DNS"\nexit "$PROBE_DNS_EXIT"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "curl"), '#!/bin/bash\n' + common + 'printf "%s" "$PROBE_HTTP"\nexit "$PROBE_CURL_EXIT"\n', { mode: 0o755 });
  const result = spawnSync("/bin/bash", [path.join(__dirname, "../scripts/check-funnel-public.sh"), ...args], {
    encoding: "utf8", timeout: 5000,
    env: { PATH: dir + ":/usr/bin:/bin", PROBE_CALLS: calls, PROBE_DNS: answer,
      PROBE_DNS_EXIT: String(dnsExit), PROBE_HTTP: http, PROBE_CURL_EXIT: String(curlExit) },
  });
  assert.ifError(result.error);
  return { ...result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "" };
}
test("Funnel probe requires explicit run and validates arguments before any network command", t => {
  for (const args of [[], ["--help"], ["bad.ts.net"], ["--run", "https://host.ts.net"], ["--run", "host.ts.net", "80"]]) {
    const r = probe(t, args);
    assert.equal(r.calls, "");
    assert.equal(r.status, args.length === 0 || args[0] === "--help" ? 0 : 2);
  }
});
test("Funnel probe pins every public A answer, bypasses proxy and curlrc, and keeps HTTPS identity", t => {
  const r = probe(t, ["--run", "host.ts.net", "8443"], { answer: "ingress.example.\n8.8.4.4\n1.1.1.1" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /@8\.8\.8\.8\nhost\.ts\.net\nA\n\+short/);
  assert.equal((r.calls.match(/\/curl\n-q\n--noproxy\n\*/g) || []).length, 2);
  for (const ip of ["8.8.4.4", "1.1.1.1"]) assert.ok(r.calls.includes(`--resolve\nhost.ts.net:8443:${ip}\nhttps://host.ts.net:8443/health`));
  assert.match(r.calls, /--connect-timeout\n5\n--max-time\n15/);
  assert.doesNotMatch(r.calls, /\n(?:-k|--insecure|-L|--location)\n/);
  assert.match(r.stdout, /Checked 2 public IPv4/);
});
test("Funnel probe rejects tailnet/private/malformed answers and fails closed on empty DNS", t => {
  for (const answer of ["", "100.100.1.1\n127.0.0.1\n10.1.2.3\n192.168.1.1\n169.254.1.1\n172.16.1.1", "999.1.1.1\n01.2.3.4\n192.0.2.1\n::1"]) {
    const r = probe(t, ["--run", "host.ts.net"], { answer });
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.calls, /\/curl\n/);
    assert.match(r.stderr, /INCONCLUSIVE/);
  }
});
test("Funnel probe does not use partial output from failed DNS", t => {
  const r = probe(t, ["--run", "host.ts.net"], { dnsExit: 9 });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.calls, /\/curl\n/);
});
test("Funnel probe distinguishes HTTP errors and redirects from TLS/connect failure", t => {
  for (const http of ["302", "403", "502"]) {
    const r = probe(t, ["--run", "host.ts.net"], { http });
    assert.equal(r.status, 1);
    assert.match(r.stdout, new RegExp(`TLS/HTTP reachable.*HTTP ${http}`));
  }
  const r = probe(t, ["--run", "host.ts.net"], { http: "000", curlExit: 60 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /HTTPS request failed/);
  assert.doesNotMatch(r.stdout, /PASS/);
});
