const { WebSocket } = require("ws");
const { createClient, AgentEvents } = require("@deepgram/sdk");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const crypto = require("crypto");
const { parse } = require("querystring");

const {
  getPipelineConfig,
  SAMPLE_RATE,
  TTS_SAMPLE_RATE,
  TTS_PROVIDER,
  loadConfig,
  resolveMessages,
} = require("../config");
const { createPipeline } = require("../pipeline");
const { deriveTransportForAuth } = require("../adapter-registry");
const { PIPELINE_TTS_PROVIDERS } = require("../tts-fish");
const { warmUpGatewaySession } = require("../gateway-warmup");
const { SessionLifecycle } = require("../session-events");
const { SlackNotifier } = require("../slack-notifier");
const { summarizeConversation } = require("../summarizer");
const { resolveAgentProfile, AgentNotFoundError } = require("../agent-profile");
const { sendAttendeeChatMessage: sendAttendeeChatMessageShared } = require("../attendee-chat");
const gatewayEvents = require("../gateway-events");
const { recordEvent } = require("../metrics");
const { scrubLogMessage } = require("../log-scrub");
const { buildDelegationResultsSection } = require("../delegation-results");
const { createGatewaySessionTracker } = require("../gateway-session-tracker");
const { servePublicAsset, serveLocalAvatar, sendMetricsSummary } = require("../ui-routes");
const { logsDir, avatarCachePath, bundledAssetPath, bundledPublicDir, resolveHome } = require("../paths");
const { warnOversizedAvatarFrames } = require("./avatar-frame-size");
const {
  AVATAR_FILE_LIMIT,
  installUrlCacheAvatar,
  readBundledAvatar,
  readManagedAvatar,
} = require("../settings/avatar-assets");
const {
  getDiagnosticValue,
  getEffectiveValue,
  getRawConfig,
  getStatus,
  meaningful,
  registerCacheInvalidator,
  resolveDynamicSlackToken,
} = require("../settings/resolver");

// Direct environment reads below are line-pinned by settings-env-inventory.json.
const ATTENDEE_API_BASE_URL = getEffectiveValue("attendee_base_url");
const SESSION_GRACE_CLOSE_MS = Number(process.env.SESSION_GRACE_CLOSE_MS || 15_000);
const ECHO_LOOP_COOLDOWN_MS = Number(process.env.ECHO_LOOP_COOLDOWN_MS || 300);
const ECHO_GATE_CLOSED_BYPASS = String(process.env.ECHO_GATE_CLOSED_BYPASS || "false").toLowerCase() === "true";
const JOIN_SHARED_TOKEN = process.env.JOIN_SHARED_TOKEN || "";
const WS_SHARED_TOKEN = process.env.WS_SHARED_TOKEN || "";
const LOCAL_AVATAR_EXPERIMENT = "hybrid-local-l0";
const LOCAL_AVATAR_FRAMES_EXPERIMENT = "hybrid-local-frames";
const LOCAL_AVATAR_EXPERIMENTS = new Set([LOCAL_AVATAR_EXPERIMENT, LOCAL_AVATAR_FRAMES_EXPERIMENT]);

const MEETING_URL_RE = /^https:\/\/(meet\.google\.com\/[a-z0-9-]+|[\w.-]*zoom\.us\/(j|my)\/[a-zA-Z0-9?=&._%-]+)(?:\?.*)?$/i;
const CONVERSATION_MODES = new Set(["one_to_one", "group"]);

function runtimeDiagnostics() {
  return {
    attendeeTimeoutMs: getDiagnosticValue("attendee_timeout_ms"),
    attendeeRetryAttempts: getDiagnosticValue("attendee_retry_attempts"),
    attendeeRetryBaseMs: getDiagnosticValue("attendee_retry_base_ms"),
    bodyLimitBytes: getDiagnosticValue("body_limit_bytes"),
  };
}

let _configJson = loadConfig();
let _resolvedMessages = resolveMessages(_configJson);
function buildConfiguredDelegationResultsSection(results) {
  return buildDelegationResultsSection(results, _resolvedMessages.delegation);
}
const DG_KEY = getEffectiveValue("deepgram_api_key");
const ATTENDEE_API_KEY = getEffectiveValue("attendee_api_key");

// Single-agent mode: resolve profile once at startup from config.json
let _agentProfile = null;
try {
  _agentProfile = resolveAgentProfile();
} catch { /* will fail later with clear error */ }
const FIXED_AGENT_ID = _agentProfile?.agentId || null;

const FALLBACK_BOT_IMAGE_URL = getEffectiveValue("agent_avatar_url") || null;

function currentAgentProfile() {
  if (_agentProfile) return _agentProfile;
  try { _agentProfile = resolveAgentProfile(); } catch { _agentProfile = null; }
  return _agentProfile;
}

registerCacheInvalidator(() => {
  _configJson = getRawConfig();
  _resolvedMessages = resolveMessages(_configJson);
  _agentProfile = null;
  meetSlackNotifier = null;
});

function getBotImageUrl() {
  const profile = currentAgentProfile();
  return profile?.avatarUrl || FALLBACK_BOT_IMAGE_URL;
}

let detectedNgrokUrl = "";
let initialized = false;
let ngrokDetectionStarted = false;
let botImageLoadStarted = false;

const meetingSessions = new Map();
const activeConnections = new Map();
const meetLifecycles = new Map();
const sessionBotIds = new Map(); // sessionId → { botId, attendeeKey }
const leavingSessionIds = new Set(); // sessions that have been requested to leave (reject reconnections)

let meetSlackNotifier = null;

function getMeetSlackNotifier() {
  if (!meetSlackNotifier) {
    const notifyEnabled = getEffectiveValue("slack_notifications_enabled");

    const notifyTarget = getEffectiveValue("slack_notifications_target") || "dm";
    const dmUserId = getEffectiveValue("slack_dm_user_id") || "";

    // Channel mode fallback (legacy env vars + config.json)
    const fallback = getEffectiveValue("slack_notify_channel") || "";
    const summaryChannel = getEffectiveValue("slack_summary_channel") || fallback;
    const statusChannel = getEffectiveValue("slack_status_channel") || summaryChannel || fallback;

    const agentSlackToken = resolveDynamicSlackToken();
    // The default-backed true value enables notifications; a saved false still disables them.

    meetSlackNotifier = new SlackNotifier(
      agentSlackToken,
      fallback,
      {
        enabled: notifyEnabled && meaningful(agentSlackToken),
        notifyTarget,
        dmUserId,
        statusChannelId: statusChannel,
        summaryChannelId: summaryChannel,
        labels: _resolvedMessages.slack,
      }
    );

    if (meetSlackNotifier.enabled) {
      if (notifyTarget === "dm") {
        console.log(`📢  Meet Slack通知有効: target=DM (user=${dmUserId})`);
      } else {
        console.log(`📢  Meet Slack通知有効: target=channel (status=${statusChannel}, summary=${summaryChannel})`);
      }
    }
  }
  return meetSlackNotifier;
}

function getGatewayConfigForProfile(profile = currentAgentProfile()) {
  const pipelineConfig = getPipelineConfig({}, null, profile, _configJson);
  return {
    ...pipelineConfig.gatewayEvents,
    name: pipelineConfig.llm.provider,
    openclawUrl: pipelineConfig.llm.gateway?.url,
    openclawToken: pipelineConfig.llm.gateway?.token,
  };
}

function appendLateDelegationResult(sessionId, evt) {
  const session = meetingSessions.get(sessionId);
  if (!session) return false;
  const item = {
    timestamp: new Date().toISOString(),
    label: evt.label || "委譲タスク",
    status: evt.status || "ok",
    resultText: String(evt.resultText || "").trim(),
  };
  session.delegationResults = session.delegationResults || [];
  session.delegationResults.push(item);
  appendLateDelegationToPersistedLogs(session, item);
  return true;
}

function deleteMeetingSession(sessionId) {
  deleteSessionAndRelease(sessionId);
}

function releaseRetainedMeetingSession(sessionId, reason) {
  if (activeConnections.has(sessionId)) return;
  deleteMeetingSession(sessionId);
  console.log(`🧹  Retained session released (${reason}): ${sessionId}`);
}

const gatewayTracker = createGatewaySessionTracker({
  gatewayEvents,
  recordEvent,
  sessions: meetingSessions,
  activeConnections,
  getGatewayConfigForProfile,
  getDefaultAgentId: () => FIXED_AGENT_ID || "agent",
  appendLateResult: appendLateDelegationResult,
  onRetentionReleased: releaseRetainedMeetingSession,
});
const { trackGatewaySession, untrackGatewaySession, findGatewayRoute } = gatewayTracker;

function taskExtractionEnabledAtBoot() {
  return getEffectiveValue("task_extraction_enabled") !== false;
}

async function handleMeetSessionEnd(lifecycle) {
  untrackGatewaySession(lifecycle.sessionId, { retainIfDelegations: true });
  const notifier = getMeetSlackNotifier();
  notifier.stopElapsedUpdates(lifecycle.sessionId);
  await notifier.postStatus(lifecycle);

  const summaryEnabled = getEffectiveValue("summary_enabled");
  if (summaryEnabled && lifecycle._conversationLog && lifecycle._conversationLog.length > 0) {
    try {
      const summary = await summarizeConversation(lifecycle._conversationLog, {
        llm: getPipelineConfig({}, null, currentAgentProfile(), _configJson).llm,
        summaryPrompt: _resolvedMessages.prompts.summary,
        taskExtractionEnabled: taskExtractionEnabledAtBoot(),
      });
      await notifier.postSummary(lifecycle, summary);
      console.log("📋  Meetサマリー投稿完了");

      await postMeetFullTranscript(notifier, lifecycle);
    } catch (err) {
      console.error("⚠️  Meetサマリー生成/投稿失敗:", scrubErrorMessage(err, undefined));
    }
  }

  // LCM ingest — capture conversation into Lossless Claw after bot has left the meeting.
  // Runs in the background cleanup phase; does not block exit experience.
  await sendLcmIngest(lifecycle);

  meetLifecycles.delete(lifecycle.sessionId);
}

/**
 * Send [[[lcm:ingest]]] tag to Gateway via Chat Completions API.
 * Uses the conversation log from the lifecycle to build messages,
 * then fires a minimal request (max_tokens=1) so Gateway's afterTurn()
 * triggers LCM ingest on the existing session.
 *
 * Non-fatal: failure is logged but does not affect session cleanup.
 */
// No hard timeout — Gateway processing time scales with conversation length.
// This runs in background cleanup after bot has already left, so no UX impact.
// Success/failure is logged for monitoring.
const _lcmIngestedSessions = new Map(); // idempotency guard — key: "agentId:meetingId" → Set of session IDs

async function sendLcmIngest(lifecycle) {
  const sid = lifecycle.sessionId;
  // Resolve agent ID for LCM key
  const agentIds = lifecycle._meta?.agentIds;
  const agentId = (Array.isArray(agentIds) && agentIds.length > 0 ? agentIds[0] : (FIXED_AGENT_ID || "unknown")).toLowerCase();
  const lcmKey = `${agentId}:${sid}`;

  const llmConfig = getPipelineConfig({}, null, currentAgentProfile(), _configJson).llm;
  const providerName = llmConfig.provider;
  if (providerName !== "openclaw") {
    console.log(`⏭️  LCM ingest skipped — LLM provider=${providerName} is not openclaw`);
    return;
  }

  if (_lcmIngestedSessions.has(lcmKey)) {
    console.log(`⏭️  LCM ingest skipped — already ingested for ${lcmKey}`);
    return;
  }
  _lcmIngestedSessions.set(lcmKey, true);

  const openclawUrl = llmConfig.gateway?.url;
  const openclawToken = llmConfig.gateway?.token;

  if (!openclawUrl || !openclawToken) {
    console.log("⏭️  LCM ingest skipped — no Gateway credentials");
    return;
  }

  const log = lifecycle._conversationLog;
  if (!log || log.length === 0) {
    console.log("⏭️  LCM ingest skipped — empty conversation log");
    return;
  }

  // Build sessionUser to match the session key used during the meeting.
  const sessionUser = sessionUserFor("meet", sid, agentId);

  const ingestStart = Date.now();
  console.log(`📝  Sending LCM ingest (background) — session=${sessionUser}, entries=${log.length}`);

  const ingestMessages = [
    ...log
      .filter(e => (e.role === "user" || e.role === "assistant") && typeof e.content === "string")
      .map(e => ({ role: e.role, content: e.content })),
    { role: "user", content: "[[[lcm:ingest]]] セッション終了。この会話を長期記憶に保存してください。" },
  ];

  new URL(openclawUrl); // Preserve the pre-refactor throw-before-try error boundary.

  try {
    const provider = require("../llm-provider").createLlmProvider();
    const { statusCode, text: responseText } = await provider.complete(ingestMessages, {
      openclawUrl,
      openclawToken,
      model: "openclaw",
      temperature: 0.3,
      maxTokens: 1,
      user: sessionUser,
    });
    if (statusCode !== 200) {
      throw new Error(`LCM ingest Gateway error (${statusCode}): ${responseText.slice(0, 200)}`);
    }
    const elapsed = Date.now() - ingestStart;
    console.log(`✅  LCM ingest completed (background) — session=${sessionUser}, id=${sid}, ${elapsed}ms`);

    // Notify success to Slack log channel for monitoring
    const notifier = getMeetSlackNotifier();
    if (notifier.enabled) {
      notifier.postTranscript(lifecycle, `✅ LCM ingest 完了 (${(elapsed / 1000).toFixed(1)}s)`).catch(() => {});
    }
  } catch (err) {
    const elapsed = Date.now() - ingestStart;
    console.warn(`⚠️  LCM ingest failed (non-fatal, ${elapsed}ms):`, scrubErrorMessage(err, undefined));

    // Notify failure to Slack log channel for monitoring
    const notifier = getMeetSlackNotifier();
    if (notifier.enabled) {
      notifier.postTranscript(lifecycle, `⚠️ LCM ingest 失敗: ${scrubErrorMessage(err, undefined)} (${(elapsed / 1000).toFixed(1)}s)`).catch(() => {});
    }
  } finally {
    // Keep in Set intentionally — prevents re-ingest on duplicate events.
    // Set is bounded by active sessions (cleaned on process restart).
  }
}

async function postMeetFullTranscript(notifier, lifecycle) {
  if (!notifier.enabled) return;
  const log = lifecycle._conversationLog;
  if (!log || log.length === 0) return;

  const lines = ["📜 全文ログ", "━━━━━━━━━━━━━━━", ""];
  for (const entry of log) {
    const speaker = entry.role === "assistant" || entry.role === "agent"
      ? `🤖 ${entry.agentId || "AI"}`
      : "👤 参加者";
    const time = entry.timestamp ? `(${new Date(entry.timestamp).toLocaleTimeString("ja-JP")})` : "";
    lines.push(`${speaker} ${time}`);
    lines.push(entry.content);
    lines.push("");
  }
  const session = meetingSessions.get(lifecycle.sessionId);
  const delegationSection = buildConfiguredDelegationResultsSection(session?.delegationResults);
  if (delegationSection) lines.push(delegationSection);

  const text = lines.join("\n");
  const MAX_CHUNK = 3800;
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if ((current + "\n" + line).length > MAX_CHUNK && current.length > 0) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current) chunks.push(current);

  try {
    for (const chunk of chunks) {
      await notifier.postTranscript(lifecycle, chunk);
    }
    console.log("📜  Meet全文ログSlack投稿完了");
  } catch (err) {
    console.error("⚠️  Meet全文ログSlack投稿失敗:", scrubErrorMessage(err, undefined));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryStatus(code) {
  return code === 429 || (code >= 500 && code <= 599);
}

function toSafeString(v) {
  if (typeof v !== "string") return "";
  return v.trim();
}

function resolveWakeMode(conversationMode) {
  return conversationMode === "group" ? "wake" : "off";
}

function parseAgentIdsInput(rawValue) {
  const raw = Array.isArray(rawValue) ? rawValue.join(",") : toSafeString(rawValue);
  if (!raw) return [];
  return [...new Set(raw.split(",").map((v) => v.trim()).filter(Boolean))];
}

function buildWsUrlWithSession(baseWsUrl, sessionId) {
  const u = new URL(baseWsUrl);
  u.searchParams.set("sid", sessionId);
  if (WS_SHARED_TOKEN) {
    u.searchParams.set("token", WS_SHARED_TOKEN);
  }
  return u.toString();
}

function checkJoinAuthorization(req, formData) {
  if (!JOIN_SHARED_TOKEN) return true;

  const headerToken = req.headers["x-join-token"];
  const bodyToken = formData.joinToken || formData.token;
  const candidate = toSafeString(Array.isArray(headerToken) ? headerToken[0] : headerToken) || toSafeString(bodyToken);
  return candidate && candidate === JOIN_SHARED_TOKEN;
}

function parseRequestBody(req) {
  const { bodyLimitBytes } = runtimeDiagnostics();
  return new Promise((resolve, reject) => {
    let body = "";
    let received = 0;

    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > bodyLimitBytes) {
        reject(new Error(`Request body too large (>${bodyLimitBytes} bytes)`));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });

    req.on("end", () => resolve(parse(body)));
    req.on("error", reject);
  });
}

function createAttendeeBot(attendeePayload, agentAttendeeKey) {
  const apiKey = agentAttendeeKey || ATTENDEE_API_KEY;
  const { attendeeTimeoutMs } = runtimeDiagnostics();
  return new Promise((resolve, reject) => {
    const options = {
      hostname: ATTENDEE_API_BASE_URL,
      port: 443,
      path: "/api/v1/bots",
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(attendeePayload),
      },
    };

    const attendeeReq = https.request(options, (attendeeRes) => {
      let responseData = "";
      attendeeRes.on("data", (chunk) => {
        responseData += chunk;
      });
      attendeeRes.on("end", () => {
        resolve({ statusCode: attendeeRes.statusCode || 0, body: responseData });
      });
    });

    attendeeReq.setTimeout(attendeeTimeoutMs, () => {
      attendeeReq.destroy(new Error(`Attendee request timeout (${attendeeTimeoutMs}ms)`));
    });

    attendeeReq.on("error", reject);
    attendeeReq.write(attendeePayload);
    attendeeReq.end();
  });
}

async function createAttendeeBotWithRetry(attendeePayload, agentAttendeeKey) {
  const { attendeeRetryAttempts, attendeeRetryBaseMs } = runtimeDiagnostics();
  let lastResult = null;
  let lastError = null;

  for (let attempt = 1; attempt <= attendeeRetryAttempts; attempt++) {
    try {
      const result = await createAttendeeBot(attendeePayload, agentAttendeeKey);
      lastResult = result;

      if (result.statusCode >= 200 && result.statusCode < 300) {
        return result;
      }

      if (!shouldRetryStatus(result.statusCode) || attempt === attendeeRetryAttempts) {
        return result;
      }

      const delay = attendeeRetryBaseMs * Math.pow(2, attempt - 1);
      console.warn(`⚠️  Attendee API retry ${attempt}/${attendeeRetryAttempts} in ${delay}ms (status=${result.statusCode})`);
      await sleep(delay);
    } catch (err) {
      lastError = err;
      if (attempt === attendeeRetryAttempts) break;
      const delay = attendeeRetryBaseMs * Math.pow(2, attempt - 1);
      console.warn(`⚠️  Attendee API network retry ${attempt}/${attendeeRetryAttempts} in ${delay}ms: ${scrubErrorMessage(err, agentAttendeeKey || ATTENDEE_API_KEY)}`);
      await sleep(delay);
    }
  }

  if (lastResult) return lastResult;
  throw lastError || new Error("Unknown attendee request error");
}

function saveConversationLog(session) {
  if (!session || !Array.isArray(session.conversationLog) || session.conversationLog.length === 0) {
    return;
  }

  const logDir = logsDir();
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = `meeting-${timestamp}-${session.id}`;

  const jsonPath = path.join(logDir, `${baseName}.json`);
  const jsonData = {
    session_id: session.id,
    meeting_url: session.hubConfig?.mode === "cloud" ? "[cloud room]" : session.meetingUrl,
    created_at: session.createdAt,
    saved_at: new Date().toISOString(),
    tts_provider: TTS_PROVIDER,
    agents: session.agents || [],
    messages: session.conversationLog,
    conversation_logs: session.conversationLogs || null,
    delegation_results: session.delegationResults || [],
  };
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
  session.conversationLogJsonPath = jsonPath;
  console.log(`📝  会話ログ保存: ${jsonPath}`);

  const mdPath = path.join(logDir, `${baseName}.md`);
  const mdContent = [
    `# Meeting Log — ${new Date().toLocaleString("ja-JP")}`,
    "",
    `- session_id: ${session.id}`,
    `- meeting_url: ${session.hubConfig?.mode === "cloud" ? "[cloud room]" : session.meetingUrl}`,
    `- tts_provider: ${TTS_PROVIDER}`,
    "",
    ...session.conversationLog.map((e) => {
      const speaker = e.role === "assistant" || e.role === "agent"
        ? (e.agentId ? `AI(${e.agentId})` : "AI")
        : "参加者";
      return `**${speaker}** (${e.timestamp}):\n${e.content}\n`;
    }),
    buildConfiguredDelegationResultsSection(session.delegationResults),
  ].join("\n");
  fs.writeFileSync(mdPath, mdContent);
  session.conversationLogMdPath = mdPath;
  console.log(`📝  会話ログ(MD)保存: ${mdPath}`);

  appendToMemory(session);
}

function appendLateDelegationToPersistedLogs(session, item) {
  try {
    const section = buildConfiguredDelegationResultsSection([item]);
    if (session.conversationLogMdPath && fs.existsSync(session.conversationLogMdPath)) {
      fs.appendFileSync(session.conversationLogMdPath, `\n${section}\n`);
    }
    if (session.memoryCallLogPath && fs.existsSync(session.memoryCallLogPath)) {
      fs.appendFileSync(session.memoryCallLogPath, `\n${section}\n`);
    }
    if (session.conversationLogJsonPath && fs.existsSync(session.conversationLogJsonPath)) {
      const data = JSON.parse(fs.readFileSync(session.conversationLogJsonPath, "utf8"));
      data.delegation_results = session.delegationResults || [];
      fs.writeFileSync(session.conversationLogJsonPath, JSON.stringify(data, null, 2));
    }
  } catch (err) {
    console.warn("⚠️  late delegation result persistence failed:", scrubErrorMessage(err, undefined));
  }
}

function appendToMemory(session) {
  try {
    const provider = getPipelineConfig({}, null, currentAgentProfile(), _configJson).llm.provider;
    const workspaceOverride = String(process.env.OPENCLAW_WORKSPACE || "").trim();
    if (provider !== "openclaw" && !workspaceOverride) {
      console.debug("🐛  Memory write skipped (LLM provider is not openclaw)");
      return;
    }
    const WORKSPACE = workspaceOverride
      || path.join(require("os").homedir(), ".openclaw", "workspace");
    const memoryDir = path.join(WORKSPACE, "memory");
    if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });

    const today = new Date().toISOString().slice(0, 10);
    const memoryFile = path.join(memoryDir, `${today}.md`);

    const msgCount = session.conversationLog.length;
    const userMsgs = session.conversationLog
      .filter((e) => e.role !== "assistant" && e.role !== "agent")
      .map((e) => e.content)
      .slice(0, 10);
    const agentMsgs = session.conversationLog
      .filter((e) => e.role === "assistant" || e.role === "agent")
      .map((e) => e.content)
      .slice(0, 10);

    const now = new Date().toLocaleString("ja-JP");
    const agentLabel = FIXED_AGENT_ID || "unknown";
    const summary = [
      "",
      `## 🎙️ Google Meet セッション (${now})`,
      `- Session ID: ${session.id}`,
      `- TTS: ${TTS_PROVIDER}`,
      `- 発話数: ${msgCount}`,
      "",
      "### 会話ハイライト",
      ...userMsgs.slice(0, 5).map((m) => `- 参加者: 「${m.slice(0, 80)}${m.length > 80 ? "..." : ""}」`),
      ...agentMsgs.slice(0, 5).map((m) => `- ${agentLabel}: 「${m.slice(0, 80)}${m.length > 80 ? "..." : ""}」`),
      "",
    ].join("\n");

    fs.appendFileSync(memoryFile, summary);
    console.log(`🧠  メモリに追記: ${memoryFile}`);

    const callsDir = path.join(memoryDir, "calls");
    if (!fs.existsSync(callsDir)) fs.mkdirSync(callsDir, { recursive: true });
    const callLogPath = path.join(callsDir, `meet-${today}-${session.id.slice(0, 12)}.md`);
    const fullLog = [
      `# Google Meet ログ — ${now}`,
      "",
      `- Session ID: ${session.id}`,
      `- Meeting URL: ${session.hubConfig?.mode === "cloud" ? "[cloud room]" : session.meetingUrl || "—"}`,
      `- 発話数: ${msgCount}`,
      "",
      "## 全文",
      "",
      ...session.conversationLog.map((e) => {
        const speaker = e.role === "assistant" || e.role === "agent"
          ? (e.agentId ? `AI(${e.agentId})` : "AI")
          : "参加者";
        return `**${speaker}**: ${e.content}\n`;
      }),
      buildConfiguredDelegationResultsSection(session.delegationResults),
    ].join("\n");
    fs.writeFileSync(callLogPath, fullLog);
    session.memoryCallLogPath = callLogPath;
    console.log(`🧠  Meetログ memory/calls/ 保存: ${callLogPath}`);
  } catch (err) {
    console.error("⚠️  メモリ追記失敗:", scrubErrorMessage(err, undefined));
  }
}

/**
 * Request bot to leave the meeting via Attendee API (POST /api/v1/bots/{id}/leave).
 * Resolves on response/error/timeout; unordered callers may ignore the fulfilled promise.
 */
function requestBotLeave(botId, reason, attendeeKey, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    let timer = null;
    const apiKey = attendeeKey || ATTENDEE_API_KEY;
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const body = JSON.stringify({});
    const options = { hostname: ATTENDEE_API_BASE_URL, port: 443, path: `/api/v1/bots/${botId}/leave`, method: "POST",
      headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } };
    timer = setTimeout(() => { const error = new Error("leave timeout"); req?.destroy?.(error); finish({ ok: false, error }); }, timeoutMs);
    timer.unref?.();
    try {
      req = https.request(options, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("error", (error) => finish({ ok: false, error }));
        res.on("end", () => { console.log(`🚪  Attendee bot leave (${reason}): ${botId} → ${res.statusCode} ${require("./local-avatar-session").redactLogValue(data).slice(0, 200)}`); finish({ ok: true, statusCode: res.statusCode }); });
      });
      req.on("error", (error) => { console.error(`❌  Attendee bot leave error (${reason}): ${scrubErrorMessage(error, apiKey)}`); finish({ ok: false, error }); });
      req.setTimeout(timeoutMs, () => { const error = new Error(`Attendee bot leave timeout after ${timeoutMs}ms`); req.destroy?.(error); finish({ ok: false, error }); });
      req.write(body);
      req.end();
    } catch (error) { console.error(`❌  Attendee bot leave error (${reason}): ${scrubErrorMessage(error, apiKey)}`); finish({ ok: false, error }); }
  });
}

function sendAttendeeChatMessage(botId, message, attendeeKey) {
  return sendAttendeeChatMessageShared(botId, message, attendeeKey || ATTENDEE_API_KEY);
}

function finalizeSessionIfInactive(sessionId) {
  const active = activeConnections.get(sessionId);
  if (active) return;

  const session = meetingSessions.get(sessionId);
  if (!session) return;

  saveConversationLog(session);
  closeLocalAvatarSession(session, "session_end");
  sessionBotIds.delete(sessionId);
  const retained = untrackGatewaySession(sessionId, { retainIfDelegations: true });
  if (!retained) deleteMeetingSession(sessionId);
  leavingSessionIds.delete(sessionId);
  console.log(`🧹  Session closed: ${sessionId}`);
}

function closeLocalAvatarSession(session, reason) {
  const localAvatarSession = session?.localAvatarSession;
  if (!localAvatarSession) return;
  session.localAvatarSession = null;
  try {
    localAvatarSession.close(reason);
  } catch {
    // The optional visual path must not affect meeting cleanup.
  }
}

function resolveLocalAvatarPublicOrigin() {
  const configuredDomain = String(getEffectiveValue("server_ngrok_domain") || "").trim();
  return publicOriginCandidates({
    publicOrigin: String(getEffectiveValue("public_origin") || "").trim(),
    ngrokDomain: configuredDomain && /^[A-Za-z0-9.-]+(?::\d+)?$/.test(configuredDomain) ? configuredDomain : "",
    publicWss: String(getDiagnosticValue("public_wss_url") || "").trim(),
    detected: detectedNgrokUrl,
  })[0] || null;
}

function scheduleFinalizeSession(sessionId) {
  const session = meetingSessions.get(sessionId);
  if (!session) return;

  if (session.closeTimer) {
    clearTimeout(session.closeTimer);
  }

  session.closeTimer = setTimeout(() => {
    finalizeSessionIfInactive(sessionId);
  }, SESSION_GRACE_CLOSE_MS);
}

function cancelFinalizeSession(sessionId) {
  const session = meetingSessions.get(sessionId);
  if (!session?.closeTimer) return;
  clearTimeout(session.closeTimer);
  session.closeTimer = undefined;
}

function createLegacyAgent(session, turnState, onAudio) {
  const deepgram = createClient(DG_KEY);
  const agent = deepgram.agent();

  function clearAgentSpeaking() {
    const wasSpeaking = turnState.isAgentSpeaking === true;
    turnState.isAgentSpeaking = false;
    if (wasSpeaking) turnState.lastTurnEndAt = Date.now();
  }

  agent.on(AgentEvents.Open, () => {
    console.log(`🟢  Deepgram Voice Agent 接続完了 (sid=${session.id})`);

    const config = getPipelineConfig({
      prompt: session.config.prompt,
      greeting: session.config.greeting,
      model: session.config.model,
      voice: session.config.voice,
    }, null, null, _configJson);
    agent.configure(config);
  });

  agent.on(AgentEvents.Audio, (raw) => onAudio(Buffer.from(raw)));
  agent.on(AgentEvents.Error, (err) => console.error(`❌  Deepgram error (sid=${session.id}):`, scrubErrorMessage(err, undefined)));
  agent.on(AgentEvents.Close, () => {
    clearAgentSpeaking();
    turnState.inputCooldownUntil = 0;
    console.log(`🔴  Deepgram Voice Agent 切断 (sid=${session.id})`);
  });
  agent.on(AgentEvents.Welcome, (w) => console.log(`🙌  Agent ready (sid=${session.id}):`, w));
  agent.on(AgentEvents.ConversationText, (m) => {
    session.conversationLog.push({
      timestamp: new Date().toISOString(),
      role: m.role,
      content: m.content,
    });
    console.log(`💬  [${m.role}] ${m.content}`);
  });
  agent.on(AgentEvents.AgentThinking, () => console.log(`🤔  [${FIXED_AGENT_ID || "agent"}] thinking… (sid=${session.id})`));
  agent.on(AgentEvents.AgentStartedSpeaking, (s) => {
    turnState.isAgentSpeaking = true;
    turnState.inputCooldownUntil = Date.now() + ECHO_LOOP_COOLDOWN_MS;
    console.log(`🗣️  [${FIXED_AGENT_ID || "agent"}] speaking (sid=${session.id}):`, s);
  });
  agent.on(AgentEvents.UserStartedSpeaking, () => console.log(`🎙️  User speaking (sid=${session.id})`));
  agent.on(AgentEvents.AgentAudioDone, () => {
    clearAgentSpeaking();
    turnState.inputCooldownUntil = Date.now() + ECHO_LOOP_COOLDOWN_MS;
    console.log(`✅  Audio done (sid=${session.id})`);
  });

  const keepAlive = setInterval(() => {
    try { agent.keepAlive?.(); } catch {
      // no-op
    }
  }, 8_000);
  agent.once(AgentEvents.Close, () => clearInterval(keepAlive));

  return { send: (buf) => agent.send(buf), close: () => agent.finish?.() };
}

function createHandler(session, turnState, onAudio) {
  if (PIPELINE_TTS_PROVIDERS.has(TTS_PROVIDER)) {
    console.log(`🎙️  ${TTS_PROVIDER} TTS パイプラインモード (sid=${session.id})`);
    const profile = currentAgentProfile();

    const config = getPipelineConfig({
      prompt: session.config.prompt,
      greeting: session.config.greeting,
      model: session.config.model,
      wakeMode: session.config.wakeMode,
    }, null, profile, _configJson);
    const pipeline = createPipeline(session, turnState, onAudio, session.hubConfig ? { ...config, hub: session.hubConfig } : config, {
      agentProfile: profile,
      onChatMessage: (text) => {
        const botInfo = sessionBotIds.get(session.id);
        if (!botInfo?.botId) {
          console.log(`💬  Bot ID未確定のためchatメッセージを破棄 (sid=${session.id})`);
          return false;
        }
        return sendAttendeeChatMessage(botInfo.botId, text, botInfo.attendeeKey);
      },
    });
    return {
      send: (buf) => pipeline.sendAudio(buf),
      close: () => pipeline.close(),
      on: pipeline.on?.bind(pipeline),
      handleGatewaySubagentSpawn: pipeline.handleGatewaySubagentSpawn,
      handleGatewaySubagentCompletion: pipeline.handleGatewaySubagentCompletion,
      handleGatewaySessionReply: pipeline.handleGatewaySessionReply,
      handleGatewayAnnounceInjected: pipeline.handleGatewayAnnounceInjected,
      getDelegationResults: pipeline.getDelegationResults, floorStatus: pipeline.floorStatus, continueWithoutArbitration: pipeline.continueWithoutArbitration,
    };
  }

  logLegacyMode(session);
  return createLegacyAgent(session, turnState, onAudio);
}

function writePlainResponse(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readEffectiveBotImage() {
  let data;
  try {
    data = readManagedAvatar(getSettingsRuntime().startup.resolvedHome);
  } catch {
    try {
      data = readBundledAvatar();
    } catch {
      return null;
    }
  }
  return { type: "image/png", data: data.toString("base64") };
}

function startBotImageLoad() {
  if (botImageLoadStarted) return;
  botImageLoadStarted = true;

  const avatarUrl = getBotImageUrl();
  const avatarCache = avatarCachePath();

  (async () => {
    try {
      if (fs.existsSync(avatarCache) || !avatarUrl) return;
    } catch {
      return;
    }

    try {
      const data = await new Promise((resolve, reject) => {
        https.get(avatarUrl, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          const chunks = [];
          let total = 0;
          let tooLarge = false;
          res.on("data", (c) => {
            total += c.length;
            if (total > AVATAR_FILE_LIMIT) tooLarge = true;
            else chunks.push(c);
          });
          res.on("end", () => tooLarge ? reject(new Error("Avatar exceeds 5 MiB")) : resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        }).on("error", reject);
      });
      if (installUrlCacheAvatar(data, getSettingsRuntime().startup.resolvedHome)) {
        console.log(`🖼️  Bot avatar downloaded and cached: ${path.basename(avatarCache)}`);
      }
    } catch (err) {
      console.warn("⚠️  Bot avatar load failed:", scrubErrorMessage(err, undefined));
    }
  })();
}

/**
 * Preserve the one-shot boot latch used by the existing /info behavior.
 * Readiness probes use a non-mutating fresh lookup instead of this latch.
 *
 * Keep this documentation expanded: direct environment reads below are
 * line-pinned by docs/settings-env-inventory.json and its contract test.
 * The implementation intentionally leaves /info resolution unchanged.
 */
function startNgrokDetection() {
  if (ngrokDetectionStarted) return;
  ngrokDetectionStarted = true;
  refreshNgrokDetection().then((url) => {
    if (url) console.log(`🌐  ngrok WSS URL 検出: ${url}`);
  }).catch(() => {});
}

async function init(options = {}) {
  if (initialized) return;

  const profile = currentAgentProfile();
  if (profile) console.log(`[${profile.agentId}] Agent profile resolved: ${profile.displayName}`);
  else console.warn("Meetmate is running in setup mode; meeting start is disabled.");
  if (options.loadAvatar !== false) {
    startBotImageLoad();
  }
  if (options.detectNgrok !== false) {
    startNgrokDetection();
  }

  readinessInstanceId = String(options.instanceId || readinessInstanceId || "");
  readinessProbeOptions = { ...readinessProbeOptions, ...(options.readinessProbeOptions || {}) };
  readiness.configure({
    probeOptions: {
      ...readinessProbeOptions,
      instanceId: readinessInstanceId,
      resolvePublicOrigin: () => resolvePublicOrigin(readinessProbeOptions),
    },
  });

  initialized = true;
}

function startReadinessBootstrap() {
  readiness.bootstrap().catch(() => {
    // Each probe settles its own cache record; this catch only protects startup.
  });
}

async function handleHttp(req, res) {
  const url = new URL(req.url || "/", "http://localhost");

  if (serveLocalAvatar(req, res, url)) return;

  if (servePublicAsset(req, res, url)) return;

  if (await sendMetricsSummary(req, res, url)) return;

  if (req.method === "GET" && url.pathname === "/") {
    fs.readFile(path.join(bundledPublicDir(), "index.html"), (err, data) => {
      if (err) {
        writePlainResponse(res, 500, "Error loading index.html");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/info") {
    let publicWsUrl = "";
    const host = req.headers.host || "";
    if (host.includes("ngrok")) {
      publicWsUrl = `wss://${host}`;
    } else if (detectedNgrokUrl) {
      publicWsUrl = detectedNgrokUrl;
    } else if (process.env.PUBLIC_WSS_URL) {
      publicWsUrl = process.env.PUBLIC_WSS_URL;
    }

    // Resolve primary agent info for single-agent mode branding
    let primaryAgent = null;
    try {
      const profile = currentAgentProfile();
      primaryAgent = {
        id: profile.agentId,
        name: profile.name,
        displayName: profile.displayName,
        greeting: profile.greeting || null,
      };
    } catch {
      // no agent configured
    }

    const info = {
      ttsProvider: TTS_PROVIDER,
      lang: getEffectiveValue("agent_language"),
      publicWsUrl,
      ready: getStatus().meetingReady,
      fixedAgentId: FIXED_AGENT_ID || null,
      primaryAgent,
    };
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(info));
    return;
  }

  if (req.method === "GET" && url.pathname === "/readiness") {
    writeJsonResponse(res, 200, readinessPayload());
    return;
  }

  if (req.method === "POST" && url.pathname === "/readiness/recheck") {
    const allowance = takePublicReadinessAllowance(req.socket?.remoteAddress);
    if (!allowance.allowed) {
      req.resume?.();
      writeJsonResponse(res, 429, {
        error: { code: "READINESS_RATE_LIMITED", message: "Readiness recheck is rate limited" },
      }, { "Retry-After": String(allowance.retryAfterSeconds) });
      return;
    }
    await readiness.recheckPublic();
    writeJsonResponse(res, 200, readinessPayload());
    return;
  }

  if (req.method === "GET" && url.pathname === "/agents") {
    let agentList = [];
    try {
      const profile = currentAgentProfile();
      agentList = [{
        id: profile.agentId,
        name: profile.name,
        displayName: profile.displayName,
        default: true,
        available: true,
        greeting: profile.greeting || "",
        wakeWords: Array.isArray(profile.wakeWords) ? profile.wakeWords : [],
      }];
    } catch {
      // no agent configured
    }
    const response = {
      agents: agentList,
      fixedAgentId: FIXED_AGENT_ID || null,
    };
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(response));
    return;
  }

  // Active session status (for Web UI polling)
  if (req.method === "GET" && url.pathname === "/active-session") {
    const sessions = [];
    for (const [sid, session] of meetingSessions) {
      const lc = meetLifecycles.get(sid);
      const floor = activeConnections.get(sid)?.handler?.floorStatus?.() || session.floorStatus || null;
      sessions.push({
        sessionId: sid,
        ...(session.hubConfig?.mode === "cloud" ? {} : { meetingUrl: session.meetingUrl }),
        startedAt: session.startedAt,
        state: lc?.state || "unknown",
        botId: sessionBotIds.get(sid)?.botId || null,
        hasConnection: activeConnections.has(sid),
        agentIds: session.config?.agentIds || [],
        agentDisplayNames: session.agents || [],
        ...(floor !== null || session.hubConfig?.mode === "cloud" ? { floor } : {}),
      });
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ active: sessions.length > 0, sessions }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/floor/continue-without-arbitration") {
    try {
      const formData = await parseRequestBody(req);
      if (!checkJoinAuthorization(req, formData)) {
        writeJsonResponse(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const requestedSid = toSafeString(formData.sessionId) || toSafeString(url.searchParams.get("sessionId"));
      if (!requestedSid) {
        writeJsonResponse(res, 400, { ok: false, error: "session_id_required" });
        return;
      }
      if (!meetingSessions.has(requestedSid)) {
        writeJsonResponse(res, 404, { ok: false, error: "session_not_found" });
        return;
      }
      const sid = requestedSid;
      const handler = activeConnections.get(sid)?.handler;
      if (typeof handler?.continueWithoutArbitration !== "function") {
        writeJsonResponse(res, 404, { ok: false, error: "floor_not_available" });
        return;
      }
      const floor = handler.continueWithoutArbitration();
      writeJsonResponse(res, 200, { ok: true, floor });
      return;
    } catch (err) {
      console.error("❌  /floor/continue-without-arbitration error:", scrubErrorMessage(err, undefined));
      writeJsonResponse(res, 500, { ok: false, error: "floor_continue_failed" });
      return;
    }
  }

  // Leave meeting (force-remove bot via Attendee API)
  if (req.method === "POST" && url.pathname === "/leave-meeting") {
    try {
      const formData = await parseRequestBody(req);
      const targetSid = toSafeString(formData.sessionId);

      if (!targetSid || !meetingSessions.has(targetSid)) {
        // If no specific session, try to leave the first active one
        const firstSid = meetingSessions.keys().next().value;
        if (!firstSid) {
          writePlainResponse(res, 404, "アクティブなセッションがありません。");
          return;
        }
        formData.sessionId = firstSid;
      }

      const sid = toSafeString(formData.sessionId);
      const botInfo = sessionBotIds.get(sid);
      const botId = botInfo?.botId;

      // Close the WebSocket connection
      const conn = activeConnections.get(sid);
      if (conn?.client) {
        try { conn.client.close(1000, "leave_requested"); } catch { /* ignore */ }
      }

      // Mark as leaving to prevent reconnection greeting
      leavingSessionIds.add(sid);

      // Call Attendee API to leave the meeting
      if (botId) {
        requestBotLeave(botId, "web_ui_leave", botInfo?.attendeeKey);
      }

      // Transition lifecycle
      const lc = meetLifecycles.get(sid);
      if (lc && !lc.isTerminal) {
        lc.transition("completed", { reason: "leave_requested" });
      }

      // Immediate cleanup (not scheduled — manual leave should be instant)
      const session = meetingSessions.get(sid);
      if (session) {
        if (session.closeTimer) clearTimeout(session.closeTimer);
        closeLocalAvatarSession(session, "leave_requested");
        saveConversationLog(session);
        sessionBotIds.delete(sid);
        const retained = untrackGatewaySession(sid, { retainIfDelegations: true });
        if (!retained) deleteMeetingSession(sid);
        console.log(`🧹  Session closed (leave): ${sid}`);
      }

      writePlainResponse(res, 200, `退出リクエスト送信: session=${sid}, bot=${botId || "unknown"}`);
      return;
    } catch (err) {
      console.error("❌  /leave-meeting error:", scrubErrorMessage(err, undefined));
      writePlainResponse(res, 500, `leave-meeting エラー: ${err.message}`);
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/join-meeting") {
    const joinTransport = deriveTransportForAuth(url.pathname);
    let localAvatarSession = null;
    let sessionId = null;
    let lease = null;
    let leaseCreated = false;
    let sessionInserted = false;
    let lifecycleCreated = false;
    let launchedBotId = null;
    let launchedBotAttendeeKey = null;
    try {
      const formData = await parseRequestBody(req);
      const hasExternalToken = req.headers["x-join-token"];
      if (hasExternalToken && !checkJoinAuthorization(req, formData)) {
        writePlainResponse(res, 401, "Unauthorized: invalid join token");
        return;
      }
      const status = getStatus({ transport: joinTransport });
      if (!status.meetingReady) {
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: { code: "MEETING_SETUP_REQUIRED", message: "Meeting setup is incomplete", issues: status.meetingIssues } }));
        return;
      }

      const meetingUrl = toSafeString(formData.meetingUrl);
      const wsUrl = toSafeString(formData.wsUrl);
      const conversationMode = toSafeString(formData.conversationMode) || "one_to_one";
      const briefing = toSafeString(formData.briefing) || null;
      const hasAvatarExperiment = Object.hasOwn(formData, "avatarExperiment");
      if (hasAvatarExperiment && typeof formData.avatarExperiment !== "string") {
        writePlainResponse(res, 400, "avatarExperiment が不正です。");
        return;
      }
      const avatarExperiment = hasAvatarExperiment
        ? toSafeString(formData.avatarExperiment)
        : getEffectiveValue("avatar_experiment");
      const isLocalAvatarExperiment = LOCAL_AVATAR_EXPERIMENTS.has(avatarExperiment);
      const profile = currentAgentProfile();

      if (avatarExperiment && !isLocalAvatarExperiment) {
        writePlainResponse(res, 400, "avatarExperiment が不正です。");
        return;
      }
      if (isLocalAvatarExperiment && !PIPELINE_TTS_PROVIDERS.has(TTS_PROVIDER)) {
        writePlainResponse(res, 400, `${avatarExperiment} はパイプライン TTS プロバイダー構成でのみ利用できます。`);
        return;
      }

      // Prevent duplicate joins — block if there's already an active session
      if (meetingSessions.size > 0) {
        const activeSids = [...meetingSessions.keys()];
        writePlainResponse(res, 409, `既にアクティブなセッションがあります（${activeSids.join(", ")}）。退出してから再度参加してください。`);
        return;
      }

      if (!meetingUrl || !wsUrl) {
        writePlainResponse(res, 400, "meetingUrl と wsUrl は必須です。");
        return;
      }
      if (!CONVERSATION_MODES.has(conversationMode)) {
        writePlainResponse(res, 400, "conversationMode は one_to_one または group を指定してください。");
        return;
      }

      if (!MEETING_URL_RE.test(meetingUrl)) {
        writePlainResponse(res, 400, "meetingUrl が Google Meet または Zoom の URL 形式ではありません。");
        return;
      }

      let parsedWs;
      try {
        parsedWs = new URL(wsUrl);
      } catch {
        writePlainResponse(res, 400, "wsUrl が不正なURLです。");
        return;
      }
      if (!["ws:", "wss:"].includes(parsedWs.protocol)) {
        writePlainResponse(res, 400, "wsUrl は ws:// または wss:// で指定してください。");
        return;
      }

      const allowance = takePublicReadinessAllowance(req.socket?.remoteAddress);
      let identity = { ok: true, code: "CONNECTED" };
      if (allowance.allowed) {
        await readiness.revalidateForJoin({ transport: joinTransport });
        identity = await readinessProbes.checkWsUrlIdentity(wsUrl, {
          ...readinessProbeOptions,
          instanceId: readinessInstanceId,
          resolvePublicOrigin: (identityOptions) => resolvePublicOrigin({ ...readinessProbeOptions, ...identityOptions }),
        });
      }
      const readinessState = readiness.getReadiness({ transport: joinTransport });
      const identityBlocker = identity.code === "MISMATCH"
        ? {
            system: "tunnel",
            code: "MISMATCH",
            fieldId: readiness.fieldFor("tunnel", "MISMATCH"),
            message: identity.message || "入力された公開URLは別のサーバーを指しています",
          }
        : null;
      const blockers = [...readinessState.blockers];
      if (identityBlocker && !blockers.some((blocker) => blocker.system === "tunnel" && blocker.code === "MISMATCH")) {
        blockers.push(identityBlocker);
      }
      if (blockers.length) {
        writeJsonResponse(res, 503, {
          error: {
            code: "MEETING_NOT_READY",
            message: "ミーティングを開始する前に接続設定を確認してください",
            blockers,
            requestId: crypto.randomUUID(),
          },
        });
        return;
      }
      if (!readinessState.ready) {
        const pending = readinessState.systems
          .filter((system) => system.code === "PENDING")
          .map((system) => system.id);
        writeJsonResponse(res, 503, {
          error: {
            code: "MEETING_NOT_READY",
            message: "接続確認中です。数秒後に再試行してください",
            blockers: [],
            pending,
            requestId: crypto.randomUUID(),
          },
        });
        return;
      }

      const sessionHubConfig = await resolveSessionHubConfig(meetingUrl);
      sessionId = crypto.randomUUID();
      const startedAt = new Date().toISOString();
      const session = {
        id: sessionId,
        createdAt: startedAt,
        startedAt,
        meetingUrl,
        ...(sessionHubConfig ? { hubConfig: sessionHubConfig } : {}),
        ...(sessionHubConfig?.reason ? {
          floorStatus: {
            mode: "cloud",
            state: "DISABLED",
            muted: false,
            reason: sessionHubConfig.reason,
            roomOccupied: null,
            continueWithoutArbitration: { available: false },
          },
        } : {}),
        config: {
          prompt: toSafeString(formData.prompt) || null,
          greeting: toSafeString(formData.greeting) || null,
          model: toSafeString(formData.model) || null,
          voice: toSafeString(formData.voice) || null,
          wakeMode: resolveWakeMode(conversationMode),
          agentIds: [profile.agentId],
          defaultAgentId: profile.agentId,
        },
        conversationLog: [],
        // Keep the agent-keyed log shape for session consumers.
        conversationLogs: { [profile.agentId]: [] },
        agents: [profile.name],
      };

      let localAvatarLaunchUrl = null;
      let localAvatarPublicOrigin = null;
      if (isLocalAvatarExperiment) {
        localAvatarPublicOrigin = resolveLocalAvatarPublicOrigin();
        if (!localAvatarPublicOrigin) {
          writePlainResponse(res, 400, `${avatarExperiment} には公開 HTTPS origin が必要です。`);
          return;
        }
      }

      if (
        !sessionCoordinator
        || typeof sessionCoordinator.active !== "function"
        || typeof sessionCoordinator.tryAcquire !== "function"
        || typeof sessionCoordinator.release !== "function"
      ) {
        writePlainResponse(res, 503, "Session coordinator unavailable: missing required methods");
        return;
      }

      const activeBeforeAcquire = sessionCoordinator.active();
      try {
        lease = sessionCoordinator.tryAcquire("meet", sessionId);
      } catch (error) {
        writePlainResponse(res, 503, `Session coordinator unavailable: ${error.message}`);
        return;
      }
      if (!lease) {
        const active = sessionCoordinator.active() || activeBeforeAcquire;
        const activeSids = active?.sessionId ? [active.sessionId] : [];
        writePlainResponse(res, 409, `既にアクティブなセッションがあります（${activeSids.join(", ")}）。退出してから再度参加してください。`);
        return;
      }
      leaseCreated = !activeBeforeAcquire;

      if (isLocalAvatarExperiment) {
        const { createLocalAvatarSession, FRAMES_HTML_ROUTE } = require("./local-avatar-session");
        const issued = createLocalAvatarSession({
          publicOrigin: localAvatarPublicOrigin,
          htmlRoute: avatarExperiment === LOCAL_AVATAR_FRAMES_EXPERIMENT ? FRAMES_HTML_ROUTE : undefined,
          background: {
            mode: getEffectiveValue("avatar_rig_background_mode"),
            color: getEffectiveValue("avatar_rig_background_color"),
          },
        });
        localAvatarSession = issued.session;
        localAvatarLaunchUrl = issued.launchUrl;
        session.localAvatarSession = localAvatarSession;
        if (avatarExperiment === LOCAL_AVATAR_FRAMES_EXPERIMENT) {
          warnOversizedAvatarFrames({
            framesDir: () => path.join(resolveHome(), "assets", "avatar-frames"),
          }).catch(() => {});
        }
      }

      session.lease = lease;
      meetingSessions.set(sessionId, session);
      sessionInserted = true;

      const lifecycle = new SessionLifecycle(sessionId, "meet", {
        ...(sessionHubConfig?.mode === "cloud" ? {} : { meetingUrl }),
        conversationMode,
        agents: [profile.name],
        agentIds: [profile.agentId],
      });
      lifecycle.on("session_end", () => handleMeetSessionEnd(lifecycle));
      lifecycle.transition("initiating");
      meetLifecycles.set(sessionId, lifecycle);
      lifecycleCreated = true;
      getMeetSlackNotifier().postStatus(lifecycle).catch(() => {});

      const warmupConfig = getPipelineConfig({
        prompt: session.config.prompt,
        model: session.config.model,
        wakeMode: session.config.wakeMode,
        exitDetection: conversationMode !== "group",
      }, null, profile, _configJson);
      // Must include the agentId — pipeline.js builds sessionUser as
      // `meet-${sessionId}-${agentId}` (see the agentState initialiser in pipeline.js).
      // Warming the bare `meet-${sessionId}` key left the agent session
      // cold and contributed to first-turn latency / timeout fallbacks.
      warmUpGatewaySession(sessionUserFor("meet", sessionId, profile.agentId), warmupConfig, briefing);

      const wsWithSession = buildWsUrlWithSession(wsUrl, sessionId);
      if (sessionHubConfig?.mode === "cloud") console.log("📹  Cloud meeting room derived");
      else console.log("📹  Meeting URL:", meetingUrl);
      console.log("🔗  WebSocket URL:", wsWithSession.replace(/token=[^&]+/, "token=***"));
      console.log("🧾  Session ID:", sessionId);
      console.log("💬  Conversation Mode:", conversationMode, `(${session.config.wakeMode})`);

      // Derive the default bot name from the single agent profile.
      const defaultBotName = `${profile.name} (AI)`;

      const botPayload = {
        meeting_url: meetingUrl,
        bot_name: toSafeString(formData.botName) || defaultBotName,
        websocket_settings: {
          audio: {
            url: wsWithSession,
            sample_rate: SAMPLE_RATE,
          },
        },
      };

      const botImage = readEffectiveBotImage();
      if (botImage) botPayload.bot_image = botImage;

      if (localAvatarLaunchUrl) {
        botPayload.voice_agent_settings = { url: localAvatarLaunchUrl };
      }

      // Use the agent's Attendee API key if available
      const agentAttendeeKey = profile.attendeeApiKey || null;

      const attendeePayload = JSON.stringify(botPayload);
      const attendeeResult = await createAttendeeBotWithRetry(attendeePayload, agentAttendeeKey);
      if (attendeeResult.statusCode >= 200 && attendeeResult.statusCode < 300) {
        launchedBotAttendeeKey = agentAttendeeKey;
        let parsedBotId = null;
        try {
          const botData = JSON.parse(attendeeResult.body);
          if (typeof botData.id === "string" || typeof botData.id === "number") parsedBotId = botData.id;
          if (botData.id) sessionBotIds.set(sessionId, { botId: botData.id, attendeeKey: agentAttendeeKey });
        } catch { /* ignore parse errors */ }
        launchedBotId = parsedBotId;
        console.log("✅  Bot起動成功:", { statusCode: attendeeResult.statusCode, botId: parsedBotId });
        writePlainResponse(
          res,
          200,
          `成功！Botが30秒以内にMeetに参加し、さらに30秒後にAIが挨拶を開始します。\nsession_id=${sessionId}`
        );
        return;
      }

      const { redactLogValue } = require("./local-avatar-session");
      console.error("❌  Bot起動失敗:", attendeeResult.statusCode, redactLogValue(attendeeResult.body));
      closeLocalAvatarSession(session, "bot_launch_failed");
      const failedLifecycle = meetLifecycles.get(sessionId);
      if (failedLifecycle && !failedLifecycle.isTerminal) {
        failedLifecycle.transition("failed", { reason: "bot_launch_failed", statusCode: attendeeResult.statusCode });
      }
      await rollbackJoinAttempt({
        sessionId,
        lease,
        leaseCreated,
        sessionInserted,
        lifecycleCreated,
      });
      writePlainResponse(
        res,
        502,
        `Bot起動エラー (upstream_status=${attendeeResult.statusCode}) [code=BOT_LAUNCH_UPSTREAM_ERROR]`
      );
      return;
    } catch (err) {
      try { localAvatarSession?.close("join_failed"); } catch { /* visual cleanup is best-effort */ }
      await rollbackJoinAttempt({
        sessionId,
        lease,
        leaseCreated,
        sessionInserted,
        lifecycleCreated,
        botId: launchedBotId,
        attendeeKey: launchedBotAttendeeKey,
      });
      console.error("❌  /join-meeting error:", scrubErrorMessage(err, undefined));
      writePlainResponse(res, 500, `join-meeting エラー: ${err.message}`);
      return;
    }
  }

  writePlainResponse(res, 404, "Not Found");
}

// Keep additions below handleHttp: direct process.env reads above are
// line-pinned by docs/settings-env-inventory.json.
function readCloudHubState() {
  const raw = getRawConfig();
  return {
    cloudUrl: readPath(raw, "hub.cloudUrl") || getEffectiveValue("hub_cloud_url") || "",
    hubToken: readPath(raw, "hub.token") || HUB_CONFIG.authToken || "",
    hubUrl: readPath(raw, "hub.cloudHubUrl") || HUB_CONFIG.url || "",
    roomSalt: readPath(raw, "hub.roomSalt") || "",
    roomSaltVersion: readPath(raw, "hub.roomSaltVersion") || "",
    configRefreshedAt: readPath(raw, "hub.configRefreshedAt") || null,
    refreshAfterSeconds: Number(readPath(raw, "hub.configRefreshAfterSeconds"))
      || DEFAULT_CONFIG_REFRESH_AFTER_S,
  };
}

function saveRefreshedHubConfig(result) {
  // Twin: src/settings/routes.js persists these refreshed cloud fields; unify both paths later.
  const configPath = getSettingsRuntime().startup.configPath;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const revision = readConfigState(configPath).revision;
    try {
      return saveCloudFields({
        configPath,
        revision,
        refreshAfterSeconds: result.refreshAfterSeconds,
        fields: {
          hub_cloud_hub_url: result.config.hub_url,
          hub_room_salt: result.config.room_salt,
          hub_room_salt_version: result.config.room_salt_version,
          hub_config_refreshed_at: result.configRefreshedAt,
        },
      });
    } catch (error) {
      if (error.code !== "SETTINGS_REVISION_CONFLICT" || attempt === 1) throw error;
    }
  }
  return null;
}

async function resolveSessionHubConfig(meetingUrl) {
  if (!HUB_CONFIG || HUB_CONFIG.mode !== "cloud") return null;
  const baseHubConfig = { ...HUB_CONFIG };
  delete baseHubConfig.roomSalt;

  let state = readCloudHubState();
  let enabled = Boolean(state.hubToken && state.hubUrl);
  if (enabled) {
    const refreshed = await refreshHubConfigIfStale({
      cloudUrl: state.cloudUrl,
      hubToken: state.hubToken,
      configRefreshedAt: state.configRefreshedAt,
      refreshAfterSeconds: state.refreshAfterSeconds,
    });
    if (refreshed.refreshed) {
      try {
        saveRefreshedHubConfig(refreshed);
        state = readCloudHubState();
      } catch {
        console.warn("⚠️  Cloud floor configuration refresh could not be saved; using the last-good configuration");
      }
    } else if (refreshed.ok === false) {
      console.warn("⚠️  Cloud floor configuration refresh failed; using the last-good configuration");
    }
  }

  enabled = Boolean(state.hubToken && state.hubUrl);
  if (!enabled || !state.roomSalt || !state.roomSaltVersion) {
    return { ...baseHubConfig, enabled: false, roomCode: null, reason: "hub_config_missing" };
  }
  return {
    ...baseHubConfig,
    enabled: true,
    url: state.hubUrl,
    roomCode: deriveRoomCode(meetingUrl, state),
    authToken: state.hubToken,
    roomSaltVersion: state.roomSaltVersion,
  };
}

const sessionCoordinator = require("../session-coordinator");
const { sessionUserFor } = require("../session-user");

function deleteSessionAndRelease(sessionId) {
  const session = meetingSessions.get(sessionId);
  if (!session) return false;
  meetingSessions.delete(sessionId);
  sessionCoordinator.release(session.lease);
  return true;
}

async function rollbackJoinAttempt({ sessionId, lease, leaseCreated, sessionInserted, lifecycleCreated, botId, attendeeKey }) {
  if (!leaseCreated) {
    if (sessionInserted) {
      sessionBotIds.delete(sessionId);
      if (lifecycleCreated) meetLifecycles.delete(sessionId);
      meetingSessions.delete(sessionId);
    }
    return;
  }
  try {
    if (botId) {
      await requestBotLeave(botId, "join_failed", attendeeKey, 2_000);
    }
  } finally {
    sessionBotIds.delete(sessionId);
    if (lifecycleCreated) meetLifecycles.delete(sessionId);
    if (sessionInserted) {
      deleteSessionAndRelease(sessionId);
    } else {
      sessionCoordinator.release(lease);
    }
  }
}

function writeJsonResponse(res, status, body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(bytes);
}

function readNgrokTunnels(options = {}) {
  return new Promise((resolve, reject) => {
    const get = options.httpGet || http.get;
    const request = get("http://127.0.0.1:4040/api/tunnels", (res) => {
      let data = "";
      res.on("data", (chunk) => {
        if (data.length <= 64 * 1024) data += chunk;
      });
      res.on("end", () => resolve(data));
      res.on("error", reject);
    });
    request.on?.("error", reject);
    request.setTimeout?.(2_000, () => request.destroy?.(new Error("ngrok detection timeout")));
  });
}

async function lookupNgrokUrl(options = {}) {
  const configuredDomain = String(getPublishedValue("server_ngrok_domain") || "").trim();
  if (configuredDomain && options.preferConfigured !== false) {
    return `wss://${configuredDomain}`;
  }
  try {
    const tunnels = JSON.parse(await readNgrokTunnels(options));
    const httpsTunnel = tunnels.tunnels?.find((tunnel) => {
      try { return new URL(tunnel.public_url).protocol === "https:"; } catch { return false; }
    });
    return httpsTunnel ? httpsTunnel.public_url.replace(/^https:/, "wss:") : "";
  } catch {
    return "";
  }
}

async function refreshNgrokDetection(options = {}) {
  detectedNgrokUrl = await lookupNgrokUrl(options);
  return detectedNgrokUrl;
}

async function resolvePublicOrigin(options = {}) {
  const publicOrigin = String(getPublishedValue("public_origin") || "").trim();
  const configuredDomain = String(getPublishedValue("server_ngrok_domain") || "").trim();
  const configuredHosts = publicOriginCandidates({ publicOrigin, ngrokDomain: configuredDomain })
    .map((origin) => new URL(origin).host.toLowerCase());
  const needsDetectedCandidate = configuredHosts.length === 0
    || (options.submittedHost && !configuredHosts.includes(String(options.submittedHost).toLowerCase()));
  const freshDetected = needsDetectedCandidate
    ? await lookupNgrokUrl({ ...options, preferConfigured: false })
    : "";
  const publicWss = String(getDiagnosticValue("public_wss_url") || "").trim();
  const origins = publicOriginCandidates({ publicOrigin, ngrokDomain: configuredDomain, publicWss, detected: freshDetected });
  const candidateHosts = new Set();
  for (const origin of origins) {
    try { candidateHosts.add(new URL(origin).host.toLowerCase()); } catch { /* validated sources only */ }
  }
  return { origin: origins[0] || "", candidateHosts };
}

function publicOriginCandidates({ publicOrigin = "", ngrokDomain = "", publicWss = "", detected = "" }) {
  return [
    publicOrigin,
    ngrokDomain ? `https://${ngrokDomain}` : "",
    publicWss.startsWith("wss://") ? `https://${publicWss.slice("wss://".length)}` : "",
    detected.startsWith("wss://") ? `https://${detected.slice("wss://".length)}` : "",
  ].filter(Boolean);
}

function handleWsConnection(client, req) {
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url || "/", "http://localhost");
  } catch {
    client.close(1008, "Bad URL");
    return;
  }

  const sid = parsedUrl.searchParams.get("sid");
  const token = parsedUrl.searchParams.get("token") || "";

  if (!sid || !meetingSessions.has(sid)) {
    client.close(1008, "Unknown session");
    return;
  }

  // Reject reconnections for sessions that are leaving
  if (leavingSessionIds.has(sid)) {
    console.log(`🚫  Rejected reconnection for leaving session (sid=${sid})`);
    client.close(1000, "Session is leaving");
    return;
  }

  if (WS_SHARED_TOKEN && token !== WS_SHARED_TOKEN) {
    client.close(1008, "Unauthorized websocket token");
    return;
  }

  const session = meetingSessions.get(sid);
  cancelFinalizeSession(sid);

  const previous = activeConnections.get(sid);
  if (previous?.client && previous.client !== client) {
    console.warn(`⚠️  Existing connection replaced (sid=${sid})`);
    try {
      previous.client.close(1012, "Superseded by a new connection");
      previous.handler?.close?.();
    } catch {
      // no-op
    }
    activeConnections.delete(sid);
  }

  console.log(`⇦  Attendee Bot 接続: ${req.socket.remoteAddress} (sid=${sid})`);

  const lifecycle = meetLifecycles.get(sid);
  if (lifecycle && lifecycle.state !== "in-progress") {
    lifecycle.transition("in-progress", { remoteAddress: req.socket.remoteAddress });
    getMeetSlackNotifier().postStatus(lifecycle).catch(() => {});
    getMeetSlackNotifier().startElapsedUpdates(lifecycle);
    lifecycle.setConversationLog(session.conversationLog);
    trackGatewaySession(session, currentAgentProfile());
  }

  const turnState = {
    isAgentSpeaking: false,
    lastTurnEndAt: null,
    inputCooldownUntil: 0,
    droppedEchoFrames: 0,
  };

  let localAvatarSourceGeneration = null;
  try {
    localAvatarSourceGeneration = session.localAvatarSession?.beginSource() ?? null;
  } catch {
    localAvatarSourceGeneration = null;
  }

  const handler = createHandler(session, turnState, (buffer, metadata) => {
    if (client.readyState !== WebSocket.OPEN) return;

    const payload = {
      trigger: "realtime_audio.bot_output",
      data: { chunk: buffer.toString("base64"), sample_rate: TTS_SAMPLE_RATE },
    };

    let audioSent = false;
    try {
      client.send(JSON.stringify(payload));
      audioSent = true;
    } catch (err) {
      console.error(`❌  Failed sending bot_output (sid=${sid}):`, scrubErrorMessage(err, undefined));
    }

    if (!audioSent) return;
    try {
      session.localAvatarSession?.publishMarker(metadata, localAvatarSourceGeneration);
    } catch {
      // Visual state is diagnostic-only and cannot affect realtime audio.
    }
  });

  if (session.localAvatarSession && handler.on) {
    handler.on("playback_cancelled", (event) => {
      try {
        session.localAvatarSession?.cancelPlayback(event, localAvatarSourceGeneration);
      } catch {
        // Visual cancellation cannot affect the authoritative audio cancellation.
      }
    });
  }

  activeConnections.set(sid, { client, handler });

  if (handler.on) {
    handler.on("exit_requested", (evt) => {
      console.log(`🚪  Exit requested for session ${sid}: ${evt.trigger}`);

      // Mark as leaving to prevent reconnection greeting
      leavingSessionIds.add(sid);
      closeLocalAvatarSession(session, "exit_requested");

      // Remove bot from meeting via Attendee API (POST /leave)
      const botInfo = sessionBotIds.get(sid);
      if (botInfo?.botId) {
        requestBotLeave(botInfo.botId, "exit_requested", botInfo.attendeeKey);
      }

      try {
        client.close(1000, "Exit requested by user");
      } catch {
        client.terminate();
      }
    });
  }

  client.isAlive = true;
  client.on("pong", () => {
    client.isAlive = true;
  });

  const heartbeat = setInterval(() => {
    if (!client.isAlive) {
      console.warn(`⚠️  WS heartbeat timeout (sid=${sid})`);
      client.terminate();
      return;
    }
    client.isAlive = false;
    try {
      client.ping();
    } catch {
      client.terminate();
    }
  }, 30_000);

  client.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.trigger === "realtime_audio.mixed" && parsed?.data?.chunk) {
        const now = Date.now();
        if (turnState.isAgentSpeaking || now < turnState.inputCooldownUntil) {
          // Optional legacy cancel-word bypass; default keeps TTS echo out of STT.
          if (ECHO_GATE_CLOSED_BYPASS && turnState.isAgentSpeaking && turnState.gateState === "CLOSED") {
            const audio = Buffer.from(parsed.data.chunk, "base64");
            handler.send(audio);
            return;
          }
          turnState.droppedEchoFrames += 1;
          if (turnState.droppedEchoFrames % 50 === 0) {
            console.log(
              `🛡️  Echo gate active (sid=${sid}): dropped ${turnState.droppedEchoFrames} frames `
              + `(isSpeaking=${turnState.isAgentSpeaking}, cooldownLeft=${Math.max(0, turnState.inputCooldownUntil - now)}ms)`
            );
          }
          return;
        }

        if (turnState.droppedEchoFrames > 0) {
          console.log(`🛡️  Echo gate released (sid=${sid}), dropped total frames: ${turnState.droppedEchoFrames}`);
          turnState.droppedEchoFrames = 0;
        }

        const audio = Buffer.from(parsed.data.chunk, "base64");
        handler.send(audio);
      } else {
        console.log("📩  Non-audio message:", parsed.trigger || parsed);
      }
    } catch (err) {
      console.error(`❌  Bad WS message (sid=${sid}):`, scrubErrorMessage(err, undefined));
    }
  });

  client.on("error", (err) => {
    console.error(`❌  WS error (sid=${sid}):`, scrubErrorMessage(err, undefined));
  });

  client.on("close", () => {
    clearInterval(heartbeat);
    console.log(`⇨  Attendee Bot 切断 (sid=${sid})`);

    const current = activeConnections.get(sid);
    if (current?.client === client) {
      activeConnections.delete(sid);
    }

    try {
      handler?.close?.();
    } catch {
      // no-op
    }

    const lc = meetLifecycles.get(sid);
    if (lc && !lc.isTerminal) {
      lc.transition("completed", { reason: "ws_close" });
    }

    scheduleFinalizeSession(sid);
  });
}

function configureReadinessForTest(probeOptions = {}) {
  readinessProbeOptions = { ...readinessProbeOptions, ...probeOptions };
  readiness.configure({
    probeOptions: {
      ...readinessProbeOptions,
      instanceId: readinessInstanceId,
      resolvePublicOrigin: () => resolvePublicOrigin(readinessProbeOptions),
    },
  });
}

function readinessPayload() {
  return { ...readiness.getReadiness(), settingsPort: getSettingsRuntime().serverPort };
}

const { getPublishedValue, getRuntime: getSettingsRuntime } = require("../settings/resolver");
const { readPath } = require("../settings/resolver");
const { DEFAULT_CONFIG_REFRESH_AFTER_S, refreshHubConfigIfStale } = require("../cloud-setup");
const { deriveRoomCode } = require("../room-code");
const { readConfigState, saveCloudFields } = require("../settings/store");
const readiness = require("../settings/readiness");
const { HUB_CONFIG } = require("../config");

function logLegacyMode(session) {
  console.log(`🔊  Deepgram Voice Agent モード (sid=${session.id})`);
  if (HUB_CONFIG.enabled) console.warn("⚠️  HUB_* is configured, but floor arbitration requires a pipeline TTS provider; disabling hub integration in legacy Deepgram Voice Agent mode.");
}

function scrubErrorMessage(err, secret) {
  return scrubLogMessage(err && err.message ? err.message : err, secret);
}

const readinessProbes = require("../settings/probes");
let readinessInstanceId = "";
let readinessProbeOptions = {};
const takePublicReadinessAllowance = readiness.createPublicRateLimiter();

module.exports = {
  init,
  startReadinessBootstrap,
  handleHttp,
  handleWsConnection,
  writePlainResponse,
  _test: {
    appendToMemory,
    appendLateDelegationToPersistedLogs,
    buildConfiguredDelegationResultsSection,
    configuredSummaryPrompt: () => _resolvedMessages.prompts.summary,
    configureReadinessForTest,
    createHandler,
    requestBotLeave,
    finalizeSessionIfInactive,
    deleteSessionAndRelease,
    rollbackJoinAttempt,
    runtimeDiagnostics,
    refreshNgrokDetection,
    resolvePublicOrigin,
    resolveLocalAvatarPublicOrigin,
    publicOriginCandidates,
    readCloudHubState,
    resolveSessionHubConfig,
    readiness,
    readEffectiveBotImage,
    checkWsUrlIdentity: readinessProbes.checkWsUrlIdentity,
    taskExtractionEnabledAtBoot,
    meetingSessions,
    activeConnections,
  },
};
