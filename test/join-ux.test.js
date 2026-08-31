"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildDiscordJoinBody,
  buildMeetJoinFormData,
  discordReadinessAllowsJoin,
  discordStatusFetchLine,
  discordTargetStatus,
  formatDiscordStatusLine,
  discordJoinErrorMessage,
  isDiscordSnowflake,
  pollBannerDecision,
  parseDiscordJoinErrorText,
} = require("../public/app.js");

test("Discord snowflake validation accepts 17-20 digits and rejects non-snowflakes", () => {
  for (const value of ["12345678901234567", "123456789012345678", "12345678901234567890"]) {
    assert.equal(isDiscordSnowflake(value), true, value);
  }
  for (const value of ["", "1234567890123456", "123456789012345678901", "1234abc89012345678", " 12345678901234567x "]) {
    assert.equal(isDiscordSnowflake(value), false, value);
  }
});

test("Discord join helper emits the exact guild/channel request shape", () => {
  assert.deepEqual(
    buildDiscordJoinBody({ guildId: " 12345678901234567 ", channelId: "23456789012345678 " }),
    { guildId: "12345678901234567", channelId: "23456789012345678" },
  );
});

test("Discord target helper reports idle, invalid, partial, and detected states", () => {
  assert.deepEqual(
    discordTargetStatus("", ""),
    { ready: false, state: "idle", text: "入力待機中...", className: "field-status" },
  );
  assert.deepEqual(
    discordTargetStatus("bad", ""),
    {
      ready: false,
      state: "invalid",
      text: "Guild ID / Channel ID は 17-20 桁の数字で入力してください",
      className: "field-status notfound",
    },
  );
  assert.deepEqual(
    discordTargetStatus("12345678901234567", ""),
    {
      ready: false,
      state: "partial",
      text: "Guild ID と Channel ID を入力してください",
      className: "field-status",
    },
  );
  assert.deepEqual(
    discordTargetStatus("12345678901234567", "23456789012345678"),
    {
      ready: true,
      state: "detected",
      text: "検出済み: Guild 12345678901234567 / Channel 23456789012345678",
      className: "field-status detected",
    },
  );
});

test("Discord join errors map known codes, preserve unknown codes, and distinguish JSON 404 envelopes from local-only 404s", () => {
  assert.equal(discordJoinErrorMessage("DISCORD_SETUP_REQUIRED"), "Discord 設定を確認してください");
  assert.equal(discordJoinErrorMessage("DISCORD_JOIN_UNKNOWN"), "DISCORD_JOIN_UNKNOWN");
  assert.equal(parseDiscordJoinErrorText('{"code":"DISCORD_MUTEX_BUSY"}', 409), "別の通話が動作中です");
  assert.equal(parseDiscordJoinErrorText('{"code":"DISCORD_SOMETHING_NEW"}', 500), "DISCORD_SOMETHING_NEW");
  assert.equal(
    parseDiscordJoinErrorText('{"code":"DISCORD_SESSION_NOT_FOUND","message":"Discord セッションはありません"}', 404),
    "Discord セッションはありません",
  );
  assert.equal(parseDiscordJoinErrorText("Not Found", 404), "Discord 参加はローカルアクセス時のみ利用できます。");
  assert.equal(parseDiscordJoinErrorText('{"message":"vendor detail"}', 500), "vendor detail");
  assert.equal(parseDiscordJoinErrorText('{"error":{"message":"vendor detail"}}', 500), "vendor detail");
  assert.equal(parseDiscordJoinErrorText("plain text upstream failure", 500), "Discord への参加に失敗しました");
});

test("Discord status poll failure lines distinguish local-only 404s from generic fetch failures", () => {
  assert.equal(discordStatusFetchLine(404), "Discord 参加はローカルアクセス時のみ利用できます。");
  assert.equal(discordStatusFetchLine(503), "Discord 接続状態: 取得失敗");
  assert.equal(discordStatusFetchLine(0), "Discord 接続状態: 取得失敗");
});

test("Discord readiness gate ignores only attendee/tunnel blockers and otherwise fails closed", () => {
  assert.equal(discordReadinessAllowsJoin({ ready: true, blockers: [] }), true);
  assert.equal(discordReadinessAllowsJoin({
    ready: false,
    blockers: [{ system: "attendee", code: "NOT_CONFIGURED" }, { system: "tunnel", code: "UNREACHABLE" }],
  }), true);
  assert.equal(discordReadinessAllowsJoin({
    ready: false,
    blockers: [{ system: "stt", code: "AUTH_FAILED" }],
  }), false);
  assert.equal(discordReadinessAllowsJoin({
    ready: false,
    blockers: [{ fieldId: "soniox_api_key", code: "AUTH_FAILED" }],
  }), false);
});

test("Meet default join payload preserves the pre-Discord parameter set and ordering", () => {
  const body = buildMeetJoinFormData({
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    availableAgents: [{ id: "caty", displayName: "Caty" }],
    wsUrl: "ws://127.0.0.1:5005",
    avatarExperiment: "follow-settings",
  });
  assert.equal(
    body.toString(),
    "meetingUrl=https%3A%2F%2Fmeet.google.com%2Fabc-defg-hij&botName=caty+%28Caty%29&wsUrl=ws%3A%2F%2F127.0.0.1%3A5005&conversationMode=group&agentIds=caty",
  );

  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /id="joinForm"/);
  assert.match(html, /id="meetingText"[\s\S]*name="meetingText"/);
  assert.match(html, /<input type="radio" name="joinTransport" value="meet" checked>/);
});

test("poll decision preserves an existing Meet banner on transient /active-session failure", () => {
  assert.deepEqual(
    pollBannerDecision(
      { hasActiveSession: true, hasDiscordSession: false, activeTransport: "meet", discordStatusExpected: false },
      { meetAvailable: false, meetSessions: [], discordAttempted: false, discordAvailable: false, discordStatus: null },
    ),
    { action: "preserve", clearDiscordTracking: false },
  );
});

test("poll decision preserves a known or pending Discord session on transient Discord status failure", () => {
  assert.deepEqual(
    pollBannerDecision(
      { hasActiveSession: false, hasDiscordSession: false, activeTransport: "meet", discordStatusExpected: true },
      { meetAvailable: true, meetSessions: [], discordAttempted: true, discordAvailable: false, discordStatus: null },
    ),
    { action: "preserve", clearDiscordTracking: false },
  );
});

test("poll decision clears Discord tracking only after confirmed absence", () => {
  assert.deepEqual(
    pollBannerDecision(
      { hasActiveSession: true, hasDiscordSession: true, activeTransport: "discord", discordStatusExpected: true },
      { meetAvailable: true, meetSessions: [], discordAttempted: true, discordAvailable: true, discordStatus: { ok: true, configured: true, session: null } },
    ),
    { action: "clear", clearDiscordTracking: true },
  );
});

test("Discord status formatter shows configured no-session state concisely", () => {
  assert.equal(
    formatDiscordStatusLine({ ok: true, configured: true, session: null }),
    "Discord 接続状態: ok=OK / configured=完了 / session=なし / connectionReady=未取得",
  );
});

test("Discord status formatter shows active session and explicit connectionReady states", () => {
  assert.equal(
    formatDiscordStatusLine({
      ok: true,
      configured: true,
      session: { state: "in-progress", lifecycle: "in-progress", connectionReady: true },
    }),
    "Discord 接続状態: ok=OK / configured=完了 / session=in-progress / in-progress / connectionReady=OK",
  );
  assert.equal(
    formatDiscordStatusLine({
      ok: true,
      configured: true,
      session: { state: "initiating", lifecycle: "initiating", connectionReady: false },
    }),
    "Discord 接続状態: ok=OK / configured=完了 / session=initiating / initiating / connectionReady=未接続",
  );
});

test("Discord status formatter reports missing connectionReady as 未取得", () => {
  assert.equal(
    formatDiscordStatusLine({
      ok: true,
      configured: false,
      session: { state: "initiating", lifecycle: "initiating" },
    }),
    "Discord 接続状態: ok=OK / configured=未完了 / session=initiating / initiating / connectionReady=未取得",
  );
});
