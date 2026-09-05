#!/usr/bin/env node
"use strict";

// Run from the repository (Node >= 18; the application requires Node >= 26):
//   npm i --no-save playwright
//   npx playwright install chromium
//   node scripts/capture-settings-ui.js [--out docs/images] [--only name,...] [--keep-home]
// No credentials or developer environment are inherited by the application.
// Vendor responses are local fixtures; application readiness and UI logic run unchanged.

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const os = require("node:os");
const assert = require("node:assert/strict");

// Loaded before application code. Redirect vendors before DNS, then enforce
// exact local socket destinations as a backstop. HTTP redirects are not followed.
function installEgressGuard() {
  const net = require("node:net");
  const tls = require("node:tls");
  const mock = new URL(process.env.MEETMATE_CAPTURE_MOCK);
  const server = new URL(process.env.MEETMATE_CAPTURE_SERVER);
  function redirected(url) {
    if ([mock.origin, server.origin].includes(url.origin)) return url;
    const target = new URL(url.pathname + url.search, url.hostname === "meetmate.example.invalid" ? server : mock);
    console.log(`[redirect] ${url.origin}${url.pathname}${url.search} -> ${target}`);
    return target;
  }
  function denied(target) {
    console.log(`[blocked] ${target}`);
    return Object.assign(new Error("Screenshot capture blocks non-mock network access"), { code: "ENETUNREACH" });
  }
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = typeof first === "object" ? first : { port: first, host: args[1] };
    if (options.host !== "127.0.0.1" || ![mock.port, server.port].includes(String(options.port)) || options.path) {
      throw denied(`socket ${options.host || "localhost"}:${options.port || "unknown"}`);
    }
    return connect.apply(this, args);
  };
  tls.connect = () => { throw denied("TLS"); };
  // Bot creation uses https.request (not fetch). Preserve method, body and
  // headers while routing this HTTP client through the same local fixtures.
  const https = require("node:https");
  const request = http.request;
  https.request = function (input, options, callback) {
    const isUrl = typeof input === "string" || input instanceof URL;
    const opts = isUrl ? (typeof options === "object" ? options : {}) : input;
    const cb = typeof options === "function" ? options : callback;
    const url = isUrl ? new URL(input) : new URL(`https://${opts.hostname || opts.host}${opts.port ? `:${opts.port}` : ""}${opts.path || "/"}`);
    const target = redirected(url);
    return request.call(http, target, { ...opts, protocol: target.protocol, hostname: target.hostname, host: target.hostname, port: target.port, path: target.pathname + target.search, agent: false }, cb);
  };
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const target = redirected(url);
    const request = input instanceof Request ? new Request(target, input) : target;
    return fetch(request, { ...options, redirect: "error" });
  };
}

const shots = {
  "setup-mode-settings": ["setup", "basic", 900],
  "settings-page-basic": ["ready", "basic", 900],
  "settings-ui-idle": ["ready", "idle", 600],
  "settings-ui-invite-pasted": ["ready", "invite", 600],
  "settings-voice-presets": ["ready", "voice", 900],
  "settings-transfer": ["ready", "transfer", 790],
  "settings-ui-joining": ["ready", "joining", 600],
};

async function main() {
  const repo = path.resolve(__dirname, "..");
  let out = path.join(repo, "docs/images");
  let selected = Object.keys(shots);
  let keepHome = false;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--keep-home") keepHome = true;
    else if (arg === "--out" && process.argv[i + 1]) out = path.resolve(process.argv[++i]);
    else if (arg === "--only" && process.argv[i + 1]) selected = process.argv[++i].split(",").map((name) => name.replace(/\.png$/, ""));
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  for (const name of selected) assert(shots[name], `Unknown screenshot: ${name}`);
  let chromium;
  try { ({ chromium } = require(require.resolve("playwright", { paths: [repo] }))); }
  catch { throw new Error("Install capture dependencies: npm i --no-save playwright && npx playwright install chromium"); }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-capture-"));
  let child;
  let browser;
  let mock;
  let cleaning;
  let interrupted = false;
  function checkInterrupted() {
    if (interrupted) throw new Error("Screenshot capture interrupted");
  }
  async function stopChild() {
    if (!child) return;
    const current = child;
    child = null;
    if (current.exitCode !== null || current.signalCode !== null) return;
    const exited = once(current, "exit");
    current.kill("SIGTERM");
    const timer = setTimeout(() => current.kill("SIGKILL"), 3000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  function cleanup() {
    if (!cleaning) cleaning = (async () => {
      try { await browser?.close(); }
      finally {
        try { await stopChild(); }
        finally {
          if (mock?.listening) {
            mock.closeAllConnections();
            await new Promise((resolve) => mock.close(resolve));
          }
          if (keepHome) console.log(`[home retained] ${home}`);
          else fs.rmSync(home, { recursive: true, force: true });
        }
      }
    })();
    return cleaning;
  }
  const handlers = new Map([ ["SIGINT", 130], ["SIGTERM", 143] ].map(([signal, code]) => {
    const handler = () => {
      interrupted = true;
      process.exitCode = code;
      // Unblock page operations; only the main finally removes the home, so
      // the next state cannot recreate it concurrently with cleanup.
      browser?.close().catch(() => {});
    };
    process.on(signal, handler);
    return [signal, handler];
  }));
  try {
    mock = http.createServer((req, res) => {
      console.log(`[mock] ${req.method} ${req.url}`);
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(req.url === "/v1/models" ? { data: [] } : { id: "capture-bot-0001", choices: [{ message: { content: "OK" } }] }));
    });
    await new Promise((resolve, reject) => { mock.once("error", reject); mock.listen(0, "127.0.0.1", resolve); });
    const mockUrl = `http://127.0.0.1:${mock.address().port}`;
    console.log(`[bases] OPENCLAW_GATEWAY_URL=${mockUrl}; vendors redirected to mock; meetmate.example.invalid redirected to capture server`);
    browser = await chromium.launch({ headless: true });
    checkInterrupted();
    fs.mkdirSync(out, { recursive: true });
    for (const state of ["setup", "ready"]) {
      checkInterrupted();
      const names = selected.filter((name) => shots[name][0] === state);
      if (!names.length) continue;
      await stopChild();
      const reservation = http.createServer();
      await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
      const port = reservation.address().port;
      await new Promise((resolve) => reservation.close(resolve));
      checkInterrupted();
      if (state === "ready") {
        const config = JSON.parse(fs.readFileSync(path.join(repo, "config.json.example"), "utf8"));
        delete config._comments;
        Object.assign(config.agent, { id: "meetmate", name: "Meetmate", displayName: "Meetmate", wakeWords: ["Meetmate"], keyterms: ["Meetmate"] });
        Object.assign(config.llm, { provider: "openclaw", model: "openclaw" });
        config.gateway.displayName = "Meetmate";
        config.attendee = { apiKey: "dummy-token", baseUrl: "attendee.example.invalid" };
        config.stt.sonioxApiKey = "dummy-token";
        config.stt.soniox.wsUrl = "wss://127.0.0.1";
        config.tts.provider = "fish-audio";
        config.tts.apiKey = "dummy-token";
        config.tts.voiceId = "dummy-voice";
        config.server.ngrokDomain = "meetmate.example.invalid";
        config.tts.cache = { enabled: false, prewarm: false };
        config.slack.notifications.enabled = false;
        delete config.discord.botToken;
        fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config, null, 2));
        const overrides = { LLM_PROVIDER: "openclaw", TTS_PROVIDER: "fish-audio", OPENCLAW_GATEWAY_URL: mockUrl, OPENCLAW_GATEWAY_TOKEN: "dummy-token", PORT: String(port) };
        const env = fs.readFileSync(path.join(repo, ".env.example"), "utf8").replace(/^([A-Z_]+)=.*$/gm, (line, key) => key in overrides ? `${key}=${overrides[key]}` : line);
        fs.writeFileSync(path.join(home, ".env"), env);
      }
      let logs = "";
      child = spawn(process.execPath, ["--require", __filename, path.join(repo, "src/server.js")], {
        cwd: home,
        env: { PATH: path.dirname(process.execPath), HOME: home, TMPDIR: home, AI_MEET_HOME: home, PORT: String(port), MEETMATE_CAPTURE_MOCK: mockUrl, MEETMATE_CAPTURE_SERVER: `http://127.0.0.1:${port}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.on("error", (error) => { logs += error.message; });
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => {
        const text = data.toString();
        logs = (logs + text).slice(-16000);
        for (const line of text.split("\n")) if (/^\[(blocked|redirect)\]/.test(line)) console.log(line);
      });
      const origin = `http://127.0.0.1:${port}`;
      let listening = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        checkInterrupted();
        if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
        try { const response = await fetch(origin, { signal: AbortSignal.timeout(500) }); await response.arrayBuffer(); if (response.status === 200) { listening = true; break; } } catch { /* retry until bound */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert(listening, `Server did not listen: ${logs}`);
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", locale: "ja-JP", serviceWorkers: "block" });
      await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort("blockedbyclient"));
      const page = await context.newPage();
      for (const name of names) {
        checkInterrupted();
        const [, screen, height] = shots[name];
        await page.setViewportSize({ width: 1280, height });
        const dashboard = ["idle", "invite", "joining"].includes(screen);
        await page.goto(`${origin}${dashboard ? "/" : "/settings"}`);
        if (state === "ready") {
          await page.waitForFunction(async () => {
            const state = await (await fetch("/readiness")).json();
            return state.ready === true;
          });
          const readiness = await (await context.request.get(`${origin}/readiness`)).json();
          console.log(`[readiness] ${JSON.stringify(readiness.systems.map(({ id, code }) => ({ id, code })))}`);
          for (const id of ["llm", "soniox", "attendee", "fish-audio", "tunnel"]) {
            assert.equal(readiness.systems.find((system) => system.id === id)?.code, "CONNECTED", `${id}: local mock probe must succeed`);
          }
        }
        if (dashboard) {
          if (screen !== "idle") {
            await page.locator("#meetingText").fill("Meetmate デモ会議\n日時: 2026年9月5日 10:00〜10:30\n議題: セットアップの確認\n参加方法: Google Meet\nビデオ通話のリンク: https://meet.google.com/abc-defg-hij\n上記リンクからご参加ください。");
            await page.locator("#meetingUrlStatus.detected").waitFor();
            await page.locator("#meetingText").evaluate((input) => { input.scrollTop = 0; });
          }
          await page.waitForFunction((idle) => document.querySelector("#joinBtn").disabled === idle && document.querySelector("#readinessPanel").classList.contains("is-hidden"), screen === "idle");
          if (screen === "joining") {
            const [joined] = await Promise.all([
              page.waitForResponse((response) => response.url() === `${origin}/join-meeting` && response.request().method() === "POST"),
              page.locator("#joinBtn").click(),
            ]);
            assert.equal(joined.status(), 200, "Mock Attendee bot creation must succeed");
            await page.locator("#activeCard").waitFor();
            await page.waitForFunction(() => document.querySelector("#activeCard").textContent.includes("Meetmate") && document.querySelector("#activeWs").textContent === "WS 未接続" && document.querySelector("#elapsedTimer").textContent !== "00:00");
          }
        } else {
          await page.waitForFunction((expected) => document.querySelector("#loadStatus").textContent === expected, state === "setup" ? "セットアップ中" : "読み込み済み");
          await page.locator(`#tab-${screen}`).click();
          if (screen === "voice") {
            assert(await page.locator("#setting-agent_emotion_tags").isChecked());
            assert((await page.locator("#setting-agent_greeting").inputValue()).includes("[warm]"));
          }
        }
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400); // Finish CSS reveal transitions, not network readiness.
        await page.evaluate(() => window.scrollTo(0, 0));
        if (screen === "voice") await page.locator("#setting-agent_greeting").scrollIntoViewIfNeeded();
        if (screen === "transfer") await page.locator("#migrateVendorSettings").scrollIntoViewIfNeeded();
        const scrollY = await page.evaluate(() => window.scrollY);
        const captureOptions = { path: path.join(out, `${name}.png`), animations: "disabled" };
        if (screen === "joining") await page.locator("#activeCard").screenshot(captureOptions);
        else await page.screenshot({ ...captureOptions, fullPage: false });
        const bytes = fs.statSync(path.join(out, `${name}.png`)).size;
        assert(bytes > 20000, `${name}: unexpectedly small screenshot`);
        console.log(`${name}.png ${bytes} bytes ${state}/${screen}${dashboard ? `; readiness ready; Join ${screen === "invite" ? "enabled" : "disabled"}; Fish Audio TTS` : (state === "setup" ? "; setup mode; two warning banners" : "; settings loaded")}; scrollY=${scrollY}`);
      }
      await context.close();
    }
  } finally {
    await cleanup();
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
}

if (process.env.MEETMATE_CAPTURE_MOCK && require.main !== module) installEgressGuard();
else if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode ||= 1; });
