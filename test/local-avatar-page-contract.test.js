const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { serveLocalAvatar, _test: uiTest } = require("../src/ui-routes");
const { createLocalAvatarSession } = require("../src/transport-meet/local-avatar-session");
const { LEVEL_ONE_THRESHOLD, LEVEL_TWO_THRESHOLD } = require("../src/audio-envelope");

const PUBLIC_DIR = path.join(__dirname, "..", "public", "local-avatar");
const HTML_FILE = path.join(PUBLIC_DIR, "index.html");
const SCRIPT_FILE = path.join(PUBLIC_DIR, "local-avatar.js");

test("shipped local avatar page is a dependency-free 1280x720 Canvas surface", () => {
  const html = fs.readFileSync(HTML_FILE, "utf8");
  const script = fs.readFileSync(SCRIPT_FILE, "utf8");
  const shipped = `${html}\n${script}`;

  assert.match(html, /<canvas\b[^>]*\bwidth="1280"[^>]*\bheight="720"/i);
  assert.match(html, /<script src="\/local-avatar\/local-avatar\.js" defer><\/script>/i);
  assert.equal(/<script(?!\s+src=)[^>]*>\s*\S/i.test(html), false, "inline executable script is forbidden");
  assert.equal(/\b(?:https?:)?\/\//i.test(shipped), false, "third-party URL is forbidden");
  assert.equal(/\b(?:WebSocket|EventSource|sendBeacon)\b/.test(shipped), false);

  const forbidden = [
    "AudioContext",
    "<audio",
    "<video",
    "mediaDevices",
    "getUserMedia",
    "captureStream",
    "MediaStream",
    "serviceWorker",
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "document.cookie",
  ];
  for (const token of forbidden) {
    assert.equal(shipped.includes(token), false, `forbidden browser capability found: ${token}`);
  }

  assert.deepEqual([...script.matchAll(/fetch\(([^,]+)/g)].map((match) => match[1].trim()), ["stateUrl(parameters)"]);
  assert.match(script, /const STATE_ROUTE = "\/local-avatar\/state"/);
  assert.doesNotMatch(script, /(?:src|href)\s*=\s*["'](?!\/local-avatar\/)/i);
});

test("local avatar exact routes use strict CSP and no-store, including auth failures", async () => {
  const absent = await requestRoute("GET", "/local-avatar/index.html");
  assertLocalHeaders(absent, 404);

  const issued = createLocalAvatarSession({ publicOrigin: "https://meetmate.example" });
  try {
    const htmlPath = `/local-avatar/index.html?v=${encodeURIComponent(issued.session.visualId)}`;
    const html = await requestRoute("GET", htmlPath);
    assertLocalHeaders(html, 200);
    assert.equal(html.body, fs.readFileSync(HTML_FILE, "utf8"));

    const script = await requestRoute("GET", "/local-avatar/local-avatar.js");
    assertLocalHeaders(script, 200);
    assert.equal(script.body, fs.readFileSync(SCRIPT_FILE, "utf8"));

    for (const requestPath of [
      "/local-avatar/",
      "/local-avatar/index.html",
      `${htmlPath}&extra=1`,
      "/local-avatar/index.html/extra",
      "/local-avatar/local-avatar.js.map",
      "/local-avatar/other.js",
    ]) {
      assertLocalHeaders(await requestRoute("GET", requestPath), 404);
    }

    const connectPath = `/local-avatar/state?connect=1&v=${encodeURIComponent(issued.session.visualId)}`;
    assertLocalHeaders(await requestRoute("GET", connectPath, authHeaders(issued.capability)), 404);
    assertLocalHeaders(await requestRoute("POST", connectPath, {
      origin: "https://meetmate.example",
    }), 404);
    assertLocalHeaders(await requestRoute("POST", connectPath, authHeaders(tamperCapability(issued.capability))), 404);
    assertLocalHeaders(await requestRoute("POST", connectPath, authHeaders(issued.capability, "https://wrong.example")), 404);

    const connected = await requestRoute("POST", connectPath, authHeaders(issued.capability));
    assertLocalHeaders(connected, 200);
    const initial = JSON.parse(connected.body);
    assert.equal(initial.kind, "idle");
    assert.ok(initial.generation > 0);

    const source = issued.session.beginSource();
    issued.session.publishMarker({
      outputEpoch: 0,
      firstSampleIndex: 480,
      sampleRate: 24_000,
      envelopeSegments: [{ s: 480, v: [0.375] }],
    }, source);
    const statePath = `/local-avatar/state?after=${initial.sequence}&generation=${initial.generation}&v=${encodeURIComponent(issued.session.visualId)}`;
    const state = await requestRoute("POST", statePath, authHeaders(issued.capability));
    assertLocalHeaders(state, 200);
    assert.deepEqual(JSON.parse(state.body), {
      kind: "marker",
      generation: initial.generation,
      cancelEpoch: initial.cancelEpoch + 1,
      sequence: initial.sequence + 2,
      outputEpoch: 0,
      sampleIndex: 480,
      sampleRate: 24_000,
      envelopes: [{ s: 480, v: [0.375] }],
    });
  } finally {
    issued.session.close();
  }
});

test("page rejects stale generation, epoch, sequence, and replay after cancel", async () => {
  const script = fs.readFileSync(SCRIPT_FILE, "utf8");
  const drawCalls = [];
  const initial = {
    kind: "idle",
    generation: 1,
    cancelEpoch: 0,
    sequence: 1,
    outputEpoch: -1,
    sampleIndex: null,
    sampleRate: null,
  };
  const sandbox = {
    URLSearchParams,
    location: {
      pathname: "/local-avatar/index.html",
      search: "?v=abcdefghijklmnop",
      hash: "#cap=secret",
    },
    history: { replaceState: (...args) => { sandbox.replaced = args; } },
    document: {
      getElementById: () => ({
        width: 1280,
        height: 720,
        getContext: () => ({
          fillRect: (...args) => drawCalls.push(["rect", ...args]),
          fillText: (...args) => drawCalls.push(["text", ...args]),
          set fillStyle(_value) {},
          set font(_value) {},
          set textAlign(_value) {},
        }),
      }),
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => initial }),
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: SCRIPT_FILE });
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  const contract = sandbox.__localAvatarContract;
  assert.deepEqual(sandbox.replaced, [null, "", "/local-avatar/index.html?v=abcdefghijklmnop"]);
  assert.equal(contract.limits.maxReconnects, 6);
  assert.equal(contract.limits.maxBackoffMs, 4000);
  assert.equal(contract.getState().generation, 1);

  const marker = {
    kind: "marker",
    generation: 1,
    cancelEpoch: 0,
    sequence: 2,
    outputEpoch: 0,
    sampleIndex: 480,
    sampleRate: 24_000,
  };
  assert.equal(contract.acceptState({ ...marker, futureField: { ignored: true } }), true);
  assert.equal(contract.acceptState({ ...marker, generation: 0, sequence: 3 }), false);
  assert.equal(contract.acceptState({ ...marker, sequence: 2, sampleIndex: 960 }), false);
  assert.equal(contract.acceptState({ ...marker, sequence: 3, sampleIndex: 240 }), false);

  const cancel = { ...marker, kind: "cancel", cancelEpoch: 1, sequence: 3, sampleIndex: null };
  assert.equal(contract.acceptState(cancel), true);
  assert.equal(contract.getState().sampleIndex, -1);
  assert.equal(contract.acceptState({ ...marker, sequence: 4, sampleIndex: 960 }), false);
  assert.equal(contract.acceptState({ ...marker, cancelEpoch: 1, sequence: 4, outputEpoch: 1, sampleIndex: 0 }), true);
  assert.equal(contract.getState().sampleIndex, 0);
  assert.ok(drawCalls.length > 0);
});

test("frame threshold literals match the server mapping and both pages share the schedule core", () => {
  const framesScript = fs.readFileSync(path.join(PUBLIC_DIR, "frames.js"), "utf8");
  const rigScript = fs.readFileSync(SCRIPT_FILE, "utf8");
  assert.match(framesScript, new RegExp(`LEVEL_ONE_THRESHOLD = ${LEVEL_ONE_THRESHOLD}`));
  assert.match(framesScript, new RegExp(`LEVEL_TWO_THRESHOLD = ${LEVEL_TWO_THRESHOLD}`));
  assert.equal(extractScheduleCore(framesScript, "\n\n  let framesLoaded"), extractScheduleCore(rigScript, "\n\n  function closeRigMouth"));
  assert.equal(extractConstDeclaration(framesScript, "ENVELOPE_END_GRACE_MS"), extractConstDeclaration(rigScript, "ENVELOPE_END_GRACE_MS"));
  assert.equal(extractConstDeclaration(framesScript, "FORWARD_REANCHOR_MS"), extractConstDeclaration(rigScript, "FORWARD_REANCHOR_MS"));
  assert.equal(
    extractOffsetParsingBlock(framesScript),
    extractOffsetParsingBlock(rigScript),
  );
});

function authHeaders(capability, origin = "https://meetmate.example") {
  return { authorization: `Bearer ${capability}`, origin };
}

function tamperCapability(value) {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

function assertLocalHeaders(result, statusCode) {
  assert.equal(result.statusCode, statusCode);
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(result.headers["Content-Security-Policy"], uiTest.LOCAL_AVATAR_CSP);
  assert.match(result.headers["Content-Security-Policy"], /default-src 'none'/);
  assert.match(result.headers["Content-Security-Policy"], /script-src 'self'/);
  assert.match(result.headers["Content-Security-Policy"], /connect-src 'self'/);
  assert.doesNotMatch(result.headers["Content-Security-Policy"], /unsafe-inline|unsafe-eval/);
}

function requestRoute(method, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, url: requestPath, headers };
    const result = { statusCode: null, headers: null, body: "" };
    const res = {
      writeHead(statusCode, responseHeaders) {
        result.statusCode = statusCode;
        result.headers = responseHeaders;
      },
      end(body = "") {
        result.body = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
        resolve(result);
      },
    };
    try {
      const handled = serveLocalAvatar(req, res, new URL(requestPath, "http://localhost"));
      if (!handled) reject(new Error(`route was not handled: ${requestPath}`));
    } catch (err) {
      reject(err);
    }
  });
}

function extractScheduleCore(source, endMarker) {
  return extractBlock(source, "  function createEnvelopeSchedule(now) {", endMarker);
}

function extractConstDeclaration(source, name) {
  const marker = `  const ${name} = `;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing const declaration: ${name}`);
  const end = source.indexOf(";\n", start);
  assert.notEqual(end, -1, `unterminated const declaration: ${name}`);
  return source.slice(start, end + 2);
}

function extractOffsetParsingBlock(source) {
  return extractBlock(
    source,
    "  const query = new URLSearchParams(location.search);",
    "\n  const visualId = query.get(\"v\") || \"\";",
  );
}

function extractBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing block start: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing block end: ${endMarker}`);
  return source.slice(start, end);
}
