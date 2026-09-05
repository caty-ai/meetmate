const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const serverPath = path.join(__dirname, "..", "src", "server.js");
const FIXTURE = ["srvfix", "ture", String(process.pid)].join("-");

function supportsLoopbackListen() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", (error) => {
      if (["EACCES", "EPERM"].includes(error.code)) resolve(false);
      else reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function stopChild(child, timeoutMs = 750) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGINT");
  });
}

test("server operator errors are source-pinned to the log scrubber", () => {
  const source = fs.readFileSync(serverPath, "utf8");

  assert.match(source, /const \{ scrubLogMessage \} = require\("\.\/log-scrub"\);/);
  assert.match(source, /Discord adapter bootstrap skipped: \$\{scrubErrorMessage\(error\)\}/);
  assert.match(source, /bootstrap\(\)\.catch\(\(err\) => \{[\s\S]*scrubErrorMessage\(err\)/);
  assert.match(source, /console\.error\("❌  Failed to start Meet server:"/);
  assert.doesNotMatch(source, /Discord adapter bootstrap skipped: \$\{error\.message\}/);
  for (const [, args] of source.matchAll(/console\.(?:warn|error|log)\(([\s\S]*?)\);/g)) {
    assert.doesNotMatch(args, /,\s*(?:err|error)\s*$/);
  }
});

test("server startup failure log scrubs secrets carried by the error (observed from the child process)", async (t) => {
  if (!(await supportsLoopbackListen())) {
    t.skip("loopback listen not permitted");
    return;
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "meetmate-server-log-scrub-"));
  const preloadPath = path.join(home, "throw-listener-bootstrap.js");
  let child;

  try {
    fs.writeFileSync(path.join(home, "config.json"), "{}\n");
    fs.writeFileSync(preloadPath, `
      const http = require("node:http");
      const secret = process.env.MEETMATE_TEST_FIXTURE_SECRET;
      http.createServer = () => {
        const error = new Error("Meet listener bootstrap failed: token=" + secret + " Authorization: Bearer " + secret);
        error.code = "E_TEST_BOOTSTRAP";
        throw error;
      };
    `);

    const env = {
      ...process.env,
      AI_MEET_HOME: home,
      MEETMATE_TEST_FIXTURE_SECRET: FIXTURE,
    };
    delete env.NODE_OPTIONS;
    delete env.PORT;
    delete env.DISCORD_BOT_TOKEN;

    child = spawn(process.execPath, ["--require", preloadPath, serverPath], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const { code, signal } = await new Promise((resolve, reject) => {
      let timeout;
      const detach = () => {
        clearTimeout(timeout);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const onError = (error) => {
        detach();
        reject(error);
      };
      const onExit = (exitCode, exitSignal) => {
        detach();
        resolve({ code: exitCode, signal: exitSignal });
      };
      timeout = setTimeout(async () => {
        detach();
        await stopChild(child);
        reject(new Error(`Timed out waiting for the server startup failure:\n${stdout}${stderr}`));
      }, 15_000);
      child.once("error", onError);
      child.once("exit", onExit);
    });

    const combined = stdout + stderr;
    assert.equal(code, 1, `unexpected child exit (${code ?? signal}):\n${combined}`);
    assert.match(combined, /❌  Failed to start Meet server:/);
    assert.match(combined, /token=\[REDACTED\]/);
    assert.match(combined, /Authorization: Bearer \[REDACTED\]/);
    assert.match(combined, /\(code=E_TEST_BOOTSTRAP\)\s*$/);
    assert.equal(combined.includes(FIXTURE), false);
    assert.equal(stdout.includes(FIXTURE), false);
  } finally {
    if (child) await stopChild(child);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
