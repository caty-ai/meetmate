const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { serveLocalAvatar } = require("../src/ui-routes");
const { createLocalAvatarSession } = require("../src/transport-meet/local-avatar-session");

const PUBLIC_DIR = path.join(__dirname, "..", "public", "local-avatar");
const GUARD_ROUTE = "/local-avatar/attendee-overlay-guard.js";
const GUARD_FILE = path.join(PUBLIC_DIR, "attendee-overlay-guard.js");
const GUARD_TAG = '<script src="/local-avatar/attendee-overlay-guard.js" defer></script>';

test("both hosted avatar pages load the guard and remain style-free", () => {
  for (const filename of ["frames.html", "index.html"]) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, filename), "utf8");
    assert.ok(html.includes(GUARD_TAG), `${filename} must load the overlay guard`);
    assert.doesNotMatch(html, /<style\b/i, `${filename} must remain style-free under its CSP`);
  }
});

test("guard removes existing and repeated overlays without touching unrelated nodes", () => {
  const page = createPage();
  const first = page.createElement("div");
  first.id = "attendee-audio-error";
  const unrelated = page.createElement("div");
  unrelated.id = "unrelated";
  page.append(first);
  page.append(unrelated);

  runGuard(page);
  assert.equal(first.removed, true);
  assert.equal(unrelated.removed, false);

  const second = page.createElement("div");
  second.id = "attendee-audio-error";
  page.append(second);
  page.notifyMutation(second);
  assert.equal(second.removed, true);
  assert.equal(unrelated.removed, false);

  const third = page.createElement("div");
  third.id = "attendee-audio-error";
  page.append(third);
  page.notifyMutation(third);
  assert.equal(third.removed, true);
  assert.equal(unrelated.removed, false);
  assert.equal(page.disconnectCalls, 0);
});

test("guard starts before body exists and observes it when it appears", () => {
  const page = createPage({ body: null });
  runGuard(page);
  assert.equal(page.observations[0].target, page.document.documentElement);

  page.installBody();
  page.notifyMutation(page.document.body);
  assert.equal(page.observations[1].target, page.document.body);

  const overlay = page.createElement("div");
  overlay.id = "attendee-audio-error";
  page.append(overlay);
  page.notifyMutation(overlay);
  assert.equal(overlay.removed, true);
  assert.equal(page.disconnectCalls, 0);
});

test("local avatar route serves the guard with JavaScript content type", async () => {
  const session = createLocalAvatarSession({ publicOrigin: "https://meetmate.example" });
  try {
    const response = await requestGuard();
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["Content-Type"], "application/javascript; charset=utf-8");
    assert.equal(response.body, fs.readFileSync(GUARD_FILE, "utf8"));
  } finally {
    session.session.close();
  }
});

test("guard source preserves the hosted-page capability lockdown", () => {
  const source = fs.readFileSync(GUARD_FILE, "utf8");
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
    "WebSocket",
    "EventSource",
    "sendBeacon",
  ];

  for (const token of forbidden) {
    assert.equal(source.includes(token), false, `forbidden browser capability found: ${token}`);
  }
  assert.equal(source.includes("://"), false, "absolute URLs are forbidden");
  assert.doesNotMatch(source, /(^|[^:])\/\//, "protocol-relative URLs are forbidden");
});

function createPage(options = {}) {
  const observations = [];
  const nodes = [];
  let mutationCallback = null;
  let disconnectCalls = 0;

  function createElement(tagName) {
    const element = {
      id: "",
      tagName: tagName.toUpperCase(),
      removed: false,
      remove() {
        element.removed = true;
        const index = nodes.indexOf(element);
        if (index !== -1) nodes.splice(index, 1);
      },
    };
    return element;
  }

  const document = {
    body: options.body === null ? null : { children: nodes },
    documentElement: { children: [] },
    createElement,
    getElementById(id) {
      return nodes.find((node) => !node.removed && node.id === id) || null;
    },
  };

  class MutationObserverStub {
    constructor(callback) {
      mutationCallback = callback;
    }

    observe(target, observerOptions) {
      observations.push({ target, options: observerOptions });
    }

    disconnect() {
      disconnectCalls += 1;
    }
  }

  return {
    document,
    MutationObserver: MutationObserverStub,
    observations,
    createElement,
    installBody() {
      document.body = { children: nodes };
    },
    append(node) {
      nodes.push(node);
    },
    notifyMutation(node) {
      mutationCallback([{ addedNodes: [node] }]);
    },
    get disconnectCalls() {
      return disconnectCalls;
    },
  };
}

function runGuard(page) {
  const sandbox = {
    document: page.document,
    MutationObserver: page.MutationObserver,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(GUARD_FILE, "utf8"), sandbox, { filename: GUARD_FILE });
}

function requestGuard() {
  return new Promise((resolve) => {
    const response = {
      statusCode: null,
      headers: null,
      writeHead(statusCode, headers) {
        response.statusCode = statusCode;
        response.headers = headers;
      },
      end(body) {
        response.body = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
        resolve(response);
      },
    };
    const request = { method: "GET", url: GUARD_ROUTE, headers: {} };
    assert.equal(serveLocalAvatar(request, response), true);
  });
}
