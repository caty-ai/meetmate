// slack-notifier.js — Slack message management for call/meeting status
// Uses raw HTTPS (no @slack/web-api dependency)

const https = require("https");

const STATE_EMOJI = {
  idle:           "⬜ 待機",
  initiating:     "⏳ 受付",
  ringing:        "🔔 発信中",
  "in-progress":  "🟢 通話中",
  ending:         "🔄 終了処理中",
  completed:      "✅ 完了",
  failed:         "❌ 失敗",
};

const TRANSPORT_LABEL = {
  twilio: "📞 Twilio 通話",
  meet:   "🎥 Google Meet",
};

/**
 * Slack notifier — creates and updates status messages, posts summaries.
 */
class SlackNotifier {
  /**
   * @param {string} botToken — Slack bot token (xoxb-...)
   * @param {string} channelId — Channel ID to post to
   */
  constructor(botToken, channelId) {
    this._botToken = botToken || "";
    this._channelId = channelId || "";
    this._messageTs = new Map(); // sessionId → message ts
    this._updateTimers = new Map(); // sessionId → interval
  }

  /** Returns false if token or channel is missing. */
  get enabled() {
    return !!(this._botToken && this._channelId);
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
      const existingTs = this._messageTs.get(sessionId);
      if (existingTs) {
        // Update existing message
        await this._slackApi("chat.update", {
          channel: this._channelId,
          ts: existingTs,
          text,
        });
      } else {
        // Post new message
        const result = await this._slackApi("chat.postMessage", {
          channel: this._channelId,
          text,
        });
        if (result?.ts) {
          this._messageTs.set(sessionId, result.ts);
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
      // Post as thread reply to the status message if available
      const threadTs = this._messageTs.get(lifecycle.sessionId);
      await this._slackApi("chat.postMessage", {
        channel: this._channelId,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    } catch (err) {
      console.error(`⚠️  Slack postSummary error (session=${lifecycle.sessionId}):`, err.message);
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
    const transport = TRANSPORT_LABEL[lifecycle.transport] || lifecycle.transport;
    const state = STATE_EMOJI[lifecycle.state] || lifecycle.state;
    const to = lifecycle.meta.to || lifecycle.meta.meetingUrl || "—";
    const elapsed = lifecycle.state === "in-progress"
      ? lifecycle.durationFormatted
      : lifecycle.isTerminal
        ? lifecycle.durationFormatted
        : "—";

    const header = lifecycle.isTerminal && lifecycle.state === "completed"
      ? `${transport} 完了`
      : `${transport} ステータス`;

    const lines = [
      header,
      "━━━━━━━━━━━━━━━",
    ];

    if (lifecycle.transport === "twilio") {
      lines.push(`📱 発信先: ${to}`);
    } else {
      lines.push(`🔗 ミーティング: ${to}`);
    }

    lines.push(`📊 状態: ${state}`);

    if (lifecycle.isTerminal) {
      lines.push(`⏱️ ${lifecycle.transport === "twilio" ? "通話" : "会議"}時間: ${elapsed}`);
    } else if (lifecycle.state === "in-progress") {
      lines.push(`⏱️ 経過: ${elapsed}`);
    } else {
      lines.push(`⏱️ 経過: —`);
    }

    return lines.join("\n");
  }

  _buildSummaryText(lifecycle, summary) {
    const transport = TRANSPORT_LABEL[lifecycle.transport] || lifecycle.transport;
    const lines = [
      `📋 ${transport} サマリー`,
      "━━━━━━━━━━━━━━━",
      `⏱️ ${lifecycle.transport === "twilio" ? "通話" : "会議"}時間: ${lifecycle.durationFormatted}`,
      "",
    ];

    if (summary.summary && summary.summary.length > 0) {
      lines.push("📝 要約");
      for (const item of summary.summary) {
        lines.push(`• ${item}`);
      }
      lines.push("");
    }

    if (summary.decisions && summary.decisions.length > 0) {
      lines.push("✅ 決定事項");
      for (const item of summary.decisions) {
        lines.push(`• ${item}`);
      }
      lines.push("");
    }

    if (summary.todos && summary.todos.length > 0) {
      lines.push("📌 TODO");
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
    const catyMsgs = log.filter(
      (e) => e.role === "assistant" || e.role === "agent"
    ).length;
    lines.push(`💬 発話数: ${log.length}（ユーザー: ${userMsgs}, Caty: ${catyMsgs}）`);

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
          res.on("data", (chunk) => { responseBody += chunk; });
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
