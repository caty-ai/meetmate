const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");

// End-to-end smoke over the real stdio transport: proves the bin entrypoint,
// the dynamic SDK/zod imports, and registerTool schema conversion all work —
// unit tests alone never load @modelcontextprotocol/sdk.
test("meetmate mcp registers the four tools over real stdio", async () => {
  const repoRoot = path.join(__dirname, "..");
  const child = spawn(process.execPath, ["bin/ai-meet.js", "mcp"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const toolNames = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP handshake timed out. stderr: ${stderr}`)), 15_000);
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          clearTimeout(timer);
          return reject(new Error(`Non-JSON on stdout (protocol corrupted): ${line}`));
        }
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        } else if (message.id === 2) {
          clearTimeout(timer);
          resolve(message.result.tools.map((tool) => tool.name).sort());
        }
      }
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stdio-test", version: "0" } },
    });
  }).finally(() => { child.kill(); });

  assert.deepEqual(toolNames, ["get_active_session", "health", "join_meeting", "leave_meeting"]);
});
