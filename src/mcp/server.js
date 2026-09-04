const { captureStartup, getStartup } = require("../settings/bootstrap");
const { scrubLogMessage } = require("../log-scrub");
const packageJson = require("../../package.json");

const DEFAULT_BASE_URL = "http://localhost:5005";
const REQUEST_TIMEOUT_MS = 15_000;
// /join-meeting can legitimately take ~50s server-side (Attendee create retries
// with backoff), so the join call gets a longer budget than the other tools.
function startupValue(name) {
  const startup = getStartup();
  const launch = typeof startup.preDotenvEnv[name] === "string" ? startup.preDotenvEnv[name].trim() : "";
  if (launch) return launch;
  return typeof startup.dotenvSeeds[name] === "string" ? startup.dotenvSeeds[name].trim() : "";
}

function joinTimeoutMs() {
  const configured = Number(startupValue("AI_MEET_JOIN_TIMEOUT_MS"));
  return Number.isFinite(configured) && configured > 0 ? configured : 60_000;
}

function normalizeBase(base) {
  return (base || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function deriveWsUrl(base, info) {
  if (info && info.publicWsUrl) return info.publicWsUrl;

  const url = new URL(normalizeBase(base));
  const protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${url.host}`;
}

function buildJoinBody({ meetingUrl, wsUrl, briefing, conversationMode, auth }) {
  const params = new URLSearchParams({
    meetingUrl,
    wsUrl,
    conversationMode: conversationMode === "group" ? "group" : "one_to_one",
  });

  if (briefing) params.set("briefing", briefing);
  if (auth) params.set("joinToken", auth);
  return params.toString();
}

async function callApi({ method, path, base, headers, body, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const url = `${normalizeBase(base)}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function resultFor(response, path, includeStatus = false) {
  const text = includeStatus ? `Status ${response.status}: ${response.text}` : response.text;
  if (response.ok) return { content: [{ type: "text", text }] };
  return {
    isError: true,
    content: [{ type: "text", text: `Request to ${path} failed with status ${response.status}: ${response.text}` }],
  };
}

function createToolHandlers({ base = startupValue("AI_MEET_BASE_URL"), auth = startupValue("AI_MEET_JOIN_TOKEN") } = {}) {
  const resolvedBase = normalizeBase(base);
  const authValue = auth || undefined;
  const guarded = (fn) => async (args) => {
    try {
      return await fn(args);
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Cannot reach Meetmate at ${resolvedBase}: ${error.message}` }],
      };
    }
  };

  return {
    joinMeeting: guarded(async ({ meetingUrl, briefing, conversationMode }) => {
      let info;
      try {
        const response = await callApi({ method: "GET", path: "/info", base: resolvedBase });
        if (response.ok) info = JSON.parse(response.text);
      } catch {
        // /info only improves the WebSocket URL; joining may still succeed without it.
      }

      const headers = { "content-type": "application/x-www-form-urlencoded" };
      if (authValue) headers["x-join-token"] = authValue;
      const body = buildJoinBody({
        meetingUrl,
        wsUrl: deriveWsUrl(resolvedBase, info),
        briefing,
        conversationMode,
        auth: authValue,
      });
      return resultFor(await callApi({
        method: "POST",
        path: "/join-meeting",
        base: resolvedBase,
        headers,
        body,
        timeoutMs: joinTimeoutMs(),
      }), "/join-meeting");
    }),

    leaveMeeting: guarded(async ({ sessionId } = {}) => {
      const body = sessionId ? new URLSearchParams({ sessionId }).toString() : "";
      return resultFor(await callApi({
        method: "POST",
        path: "/leave-meeting",
        base: resolvedBase,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }), "/leave-meeting");
    }),

    getActiveSession: guarded(async () => {
      return resultFor(await callApi({ method: "GET", path: "/active-session", base: resolvedBase }), "/active-session");
    }),

    health: guarded(async () => {
      return resultFor(await callApi({ method: "GET", path: "/health", base: resolvedBase }), "/health", true);
    }),
  };
}

async function start() {
  const [{ McpServer }, { StdioServerTransport }, { z }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("zod"),
  ]);
  const server = new McpServer({ name: "meetmate", version: packageJson.version });
  const handlers = createToolHandlers();

  server.registerTool("join_meeting", {
    description: "Join a Meetmate meeting.",
    inputSchema: {
      meetingUrl: z.string(),
      briefing: z.string().optional(),
      conversationMode: z.enum(["one_to_one", "group"]).optional(),
    },
  }, handlers.joinMeeting);
  server.registerTool("leave_meeting", {
    description: "Leave a Meetmate meeting.",
    inputSchema: { sessionId: z.string().optional() },
  }, handlers.leaveMeeting);
  server.registerTool("get_active_session", { description: "Get active Meetmate sessions." }, handlers.getActiveSession);
  server.registerTool("health", { description: "Get Meetmate service health." }, handlers.health);

  await server.connect(new StdioServerTransport());
}

function formatStartupError(error) {
  const message = scrubLogMessage((error || {}).message || error, undefined);
  return message + (error && error.code ? ` (${error.code})` : "");
}

module.exports = { buildJoinBody, callApi, createToolHandlers, deriveWsUrl, formatStartupError, start };

if (require.main === module) {
  captureStartup();
  start().catch((error) => {
    console.error(formatStartupError(error));
    process.exitCode = 1;
  });
}
