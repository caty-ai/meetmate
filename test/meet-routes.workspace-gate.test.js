const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const routesPath = require.resolve("../src/transport-meet/meet-routes");
const configPath = require.resolve("../src/config");

function setEnv(values) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function freshRoutes() {
  delete require.cache[routesPath];
  return require("../src/transport-meet/meet-routes");
}

test("meeting memory writes require OpenClaw or an explicit workspace override", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "meet-memory-"));
  const restore = setEnv({ LLM_PROVIDER: "openai-compatible", OPENCLAW_WORKSPACE: undefined });
  const originalDebug = console.debug;
  const originalConfig = require.cache[configPath];
  const originalFs = {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    appendFileSync: fs.appendFileSync,
    writeFileSync: fs.writeFileSync,
  };
  const debug = [];
  console.debug = (...args) => debug.push(args.join(" "));
  try {
    const config = require("../src/config");
    require.cache[configPath] = {
      ...originalConfig,
      exports: { ...config, getPipelineConfig: () => ({ llm: { provider: "openai-compatible" } }) },
    };
    const writes = [];
    fs.existsSync = () => false;
    fs.mkdirSync = (...args) => writes.push(["mkdir", ...args]);
    fs.appendFileSync = (...args) => writes.push(["append", ...args]);
    fs.writeFileSync = (...args) => writes.push(["write", ...args]);
    freshRoutes()._test.appendToMemory({ id: "session", conversationLog: [] });
    assert.deepEqual(writes, []);
    assert.equal(debug.some((line) => line.includes("Memory write skipped")), true);

    Object.assign(fs, originalFs);
    process.env.OPENCLAW_WORKSPACE = workspace;
    freshRoutes()._test.appendToMemory({ id: "session", conversationLog: [] });
    assert.equal(fs.existsSync(path.join(workspace, "memory")), true);
  } finally {
    console.debug = originalDebug;
    Object.assign(fs, originalFs);
    restore();
    delete require.cache[routesPath];
    if (originalConfig === undefined) delete require.cache[configPath];
    else require.cache[configPath] = originalConfig;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
