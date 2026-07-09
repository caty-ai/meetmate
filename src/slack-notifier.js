// slack-notifier.js — Slack message management for call/meeting status
// Uses raw HTTPS (no @slack/web-api dependency)

const https = require("https");
const { DEFAULT_MESSAGES } = require("./messages");

const STATE_EMOJI = DEFAULT_MESSAGES.slack.stateEmoji;

const TRANSPORT_LABEL = DEFAULT_MESSAGES.slack.transportLabel;

function detectMeetingPlatform(meetingUrl) {
  if (!meetingUrl) return "meet";
  if (/zoom\.us/i.test(meetingUrl)) return "zoom";
  return "meet";
}

/**
 * Slack notifier — creates and updates status messages, posts summaries.
 *
 * Supports two notification targets:
 *   - "channel" (legacy default): posts to a Slack channel by ID
 *   - "dm": opens a DM with a Slack user and posts there
 *
 * DM mode uses conversations.open to lazily resolve the DM channel ID.
 * Once resolved, the DM channel is cached for the process lifetime.
 */
class SlackNotifier {
  /**
   * @param {string} botToken — Slack bot token (xoxb-...)
   * @param {string} channelId — Default channel ID (fallback for channel mode)
   * @param {object} [options]
   * @param {boolean} [options.enabled=true] — Master enable switch (SLACK_NOTIFY_ENABLED)
   * @param {string} [options.statusChannelId] — Status post channel (channel mode)
   * @param {string} [options.summaryChannelId] — Summary/transcript post channel (channel mode)
   * @param {string} [options.notifyTarget="channel"] — "dm" or "channel"
   * @param {string} [options.dmUserId] — Slack user ID for DM mode (required when notifyTarget="dm")
   */
  constructor(botToken, channelId, options = {}) {
    this._botToken = botToken || "";
    this._defaultChannelId = channelId || "";
    this._masterEnabled = options.enabled !== false; // default true

    // Notification target: "dm" or "channel" (default)
    this._notifyTarget = (options.notifyTarget || "channel").toLowerCase();
    this._dmUserId = options.dmUserId || "";
    this._dmChannelId = ""; // lazily resolved via conversations.open

    // Channel resolution (channel mode):
    // status: explicit statusChannel -> summaryChannel -> default
    // summary/transcript: explicit summaryChannel -> default
    this._summaryChannelId =
      options.summaryChannelId || this._defaultChannelId;
    this._statusChannelId =
      options.statusChannelId || this._summaryChannelId || this._defaultChannelId;
    this._labels = { ...DEFAULT_MESSAGES.slack, ...(options.labels || {}) };
    this._labels.stateEmoji = { ...STATE_EMOJI, ...(options.labels?.stateEmoji || {}) };
    this._labels.transportLabel = { ...TRANSPORT_LABEL, ...(options.labels?.transportLabel || {}) };

    /** @type {Map<string, {ts: string, channel: string}>} */
    this._statusMessageRef = new Map();
    this._updateTimers = new Map(); // sessionId → interval
  }

  /** Returns false if disabled, or required credentials are missing. */
  get enabled() {
    if (!this._masterEnabled || !this._botToken) return false;
    if (this._notifyTarget === "dm") {
      return !!this._dmUserId;
    }
    return !!this._statusChannelId;
  }

  /**
   * Resolve the target channel ID (DM or channel mode).
   * In DM mode, calls conversations.open once and caches the result.
   * @returns {Promise<string>} resolved channel ID
   */
  async _resolveTargetChannel() {
    if (this._notifyTarget !== "dm") {
      return this._statusChannelId;
    }

    // DM mode: return cached channel or open a new DM
    if (this._dmChannelId) return this._dmChannelId;

    const result = await this._slackApi("conversations.open", {
      users: this._dmUserId,
    });

    if (result?.channel?.id) {
      this._dmChannelId = result.channel.id;
      console.log(`📩  Slack DM channel opened: ${this._dmChannelId} (user=${this._dmUserId})`);
      return this._dmChannelId;
    }

    throw new Error(`conversations.open failed for user ${this._dmUserId}: ${JSON.stringify(result?.error || "unknown")}`);
  }

  /**
   * Resolve the summary channel (DM → same DM, channel → summaryChannel).
   * @returns {Promise<string>}
   */
  async _resolveSummaryChannel() {
    if (this._notifyTarget === "dm") {
      return this._resolveTargetChannel();
    }
    return this._summaryChannelId || this._statusChannelId;
  }

  get statusChannelId() {
    return this._statusChannelId;
  }

  get summaryChannelId() {
    return this._summaryChannelId || this._statusChannelId;
  }

  /**
   * Post or update a status message for a session lifecycle.
   * @param {import("./session-events").SessionLifecycle} lifecycle
   */
  async postStatus(lifecycle) {
    if (!this.enabled) return;

    const text = this._buildStatusText(lifecycle);
    const sessionId = lifecycle.sessionId;

    try {
      const targetChannel = await this._resolveTargetChannel();
      const existing = this._statusMessageRef.get(sessionId);
      if (existing && existing.channel === targetChannel) {
        // Update existing message
        await this._slackApi("chat.update", {
          channel: existing.channel,
          ts: existing.ts,
          text,
        });
      } else {
        // Post new message
        const result = await this._slackApi("chat.postMessage", {
          channel: targetChannel,
          text,
        });
        if (result?.ts) {
          this._statusMessageRef.set(sessionId, { ts: result.ts, channel: targetChannel });
        }
      }
    } catch (err) {
      console.error(`⚠️  Slack postStatus error (session=${sessionId}):`, err.message);
    }
  }

  /**
   * Start periodic elapsed-time updates during in-progress.
   * @param {import("./session-events").SessionLifecycle} lifecycle
   * @param {number} [intervalMs=30000]
   */
  startElapsedUpdates(lifecycle, intervalMs = 30_000) {
    if (!this.enabled) return;
    this.stopElapsedUpdates(lifecycle.sessionId);

    const timer = setInterval(() => {
      if (lifecycle.isTerminal) {
        this.stopElapsedUpdates(lifecycle.sessionId);
        return;
      }
      this.postStatus(lifecycle).catch(() => {});
    }, intervalMs);

    this._updateTimers.set(lifecycle.sessionId, timer);
  }

  /** Stop elapsed-time updates. */
  stopElapsedUpdates(sessionId) {
    const timer = this._updateTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this._updateTimers.delete(sessionId);
    }
  }

  /**
   * Post a conversation summary after session ends.
   * @param {import("./session-events").SessionLifecycle} lifecycle
   * @param {{ summary: string[], decisions: string[], todos: string[] }} summary
   */
  async postSummary(lifecycle, summary) {
    if (!this.enabled) return;
    if (!summary) return;

    const text = this._buildSummaryText(lifecycle, summary);

    try {
      const summaryChannel = await this._resolveSummaryChannel();
      const statusRef = this._statusMessageRef.get(lifecycle.sessionId);
      const sameChannel = statusRef && statusRef.channel === summaryChannel;

      // Post as thread reply only when status & summary channels are same
      await this._slackApi("chat.postMessage", {
        channel: summaryChannel,
        text,
        ...(sameChannel ? { thread_ts: statusRef.ts } : {}),
      });
    } catch (err) {
      console.error(`⚠️  Slack postSummary error (session=${lifecycle.sessionId}):`, err.message);
    }
  }

  /**
   * Post a full transcript as thread reply.
   * @param {import("./session-events").SessionLifecycle} lifecycle
   * @param {string} text — transcript text (may be a chunk)
   */
  async postTranscript(lifecycle, text) {
    if (!this.enabled) return;
    if (!text) return;

    try {
      const summaryChannel = await this._resolveSummaryChannel();
      const statusRef = this._statusMessageRef.get(lifecycle.sessionId);
      const sameChannel = statusRef && statusRef.channel === summaryChannel;

      await this._slackApi("chat.postMessage", {
        channel: summaryChannel,
        text,
        ...(sameChannel ? { thread_ts: statusRef.ts } : {}),
      });
    } catch (err) {
      console.error(`⚠️  Slack postTranscript error (session=${lifecycle.sessionId}):`, err.message);
    }
  }

  /** Cleanup all timers. */
  destroy() {
    for (const timer of this._updateTimers.values()) {
      clearInterval(timer);
    }
    this._updateTimers.clear();
  }

  // ── Internal ──────────────────────────────────────────────────

  _buildStatusText(lifecycle) {
    let transportKey = lifecycle.transport;
    if (transportKey === "meet") {
      transportKey = detectMeetingPlatform(lifecycle.meta.meetingUrl);
    }
    const labels = this._labels;
    const transport = labels.transportLabel[transportKey] || lifecycle.transport;
    const state = labels.stateEmoji[lifecycle.state] || lifecycle.state;
    const to = lifecycle.meta.to || lifecycle.meta.meetingUrl || labels.emptyValue;
    const elapsed = lifecycle.state === "in-progress"
      ? lifecycle.durationFormatted
      : lifecycle.isTerminal
        ? lifecycle.durationFormatted
        : labels.emptyValue;

    const agentNames = Array.isArray(lifecycle.meta.agents) && lifecycle.meta.agents.length
      ? lifecycle.meta.agents.join(", ")
      : null;

    const header = lifecycle.isTerminal && lifecycle.state === "completed"
      ? `${transport} ${labels.statusCompleteSuffix}`
      : `${transport} ${labels.statusSuffix}`;

    const lines = [
      header,
      labels.separator,
    ];

    if (agentNames) {
      lines.push(`${labels.agentLinePrefix}: ${agentNames}`);
    }

    lines.push(`${labels.meetingLinePrefix}: ${to}`);

    lines.push(`${labels.stateLinePrefix}: ${state}`);

    if (lifecycle.isTerminal) {
      lines.push(`${labels.durationLinePrefix}: ${elapsed}`);
    } else if (lifecycle.state === "in-progress") {
      lines.push(`${labels.elapsedLinePrefix}: ${elapsed}`);
    } else {
      lines.push(`${labels.elapsedLinePrefix}: ${labels.emptyValue}`);
    }

    return lines.join("\n");
  }

  _buildSummaryText(lifecycle, summary) {
    let transportKey = lifecycle.transport;
    if (transportKey === "meet") {
      transportKey = detectMeetingPlatform(lifecycle.meta.meetingUrl);
    }
    const labels = this._labels;
    const transport = labels.transportLabel[transportKey] || lifecycle.transport;
    const lines = [
      `${labels.summaryTitlePrefix} ${transport} ${labels.summaryTitleSuffix}`,
      labels.separator,
      `${labels.durationLinePrefix}: ${lifecycle.durationFormatted}`,
      "",
    ];

    if (summary.summary && summary.summary.length > 0) {
      lines.push(labels.summarySection);
      for (const item of summary.summary) {
        lines.push(`• ${item}`);
      }
      lines.push("");
    }

    if (summary.decisions && summary.decisions.length > 0) {
      lines.push(labels.decisionsSection);
      for (const item of summary.decisions) {
        lines.push(`• ${item}`);
      }
      lines.push("");
    }

    if (summary.todos && summary.todos.length > 0) {
      lines.push(labels.todosSection);
      for (const item of summary.todos) {
        lines.push(`• ${item}`);
      }
      lines.push("");
    }

    // Conversation stats
    const log = lifecycle._conversationLog || [];
    const userMsgs = log.filter(
      (e) => e.role !== "assistant" && e.role !== "agent"
    ).length;
    const agentMsgs = log.filter(
      (e) => e.role === "assistant" || e.role === "agent"
    ).length;
    const agentNames = Array.isArray(lifecycle.meta.agents) && lifecycle.meta.agents.length
      ? lifecycle.meta.agents.join("/")
      : labels.defaultAgentLabel;
    lines.push(`${labels.utteranceStatsPrefix}: ${log.length}（${labels.userLabel}: ${userMsgs}, ${agentNames}: ${agentMsgs}）`);

    return lines.join("\n");
  }

  /**
   * Call Slack Web API.
   * @param {string} method — e.g. "chat.postMessage"
   * @param {object} body
   * @returns {Promise<object>}
   */
  _slackApi(method, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = https.request(
        {
          hostname: "slack.com",
          port: 443,
          path: `/api/${method}`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${this._botToken}`,
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(data),
          },
        },
        (res) => {
          let responseBody = "";
          res.on("data", (chunk) => {
            responseBody += chunk;
          });
          res.on("end", () => {
            try {
              const parsed = JSON.parse(responseBody);
              if (!parsed.ok) {
                reject(new Error(`Slack API ${method}: ${parsed.error || "unknown error"}`));
                return;
              }
              resolve(parsed);
            } catch {
              reject(new Error(`Slack API ${method}: invalid JSON response`));
            }
          });
        }
      );

      req.on("error", reject);
      req.setTimeout(10_000, () => {
        req.destroy(new Error(`Slack API ${method} timeout`));
      });

      req.write(data);
      req.end();
    });
  }
}

module.exports = { SlackNotifier, STATE_EMOJI, TRANSPORT_LABEL };
