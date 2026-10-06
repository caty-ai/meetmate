"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildDiscordJoinBody,
  buildMeetJoinFormData,
  requestJoinMeeting,
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
  assert.equal(parseDiscordJoinErrorText('{"code":"DISCORD_LEAVE_FAILED"}', 500), "Discord からの退出に失敗しました");
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

test("Discord readiness gate uses granular per-system readiness and ignores only attendee/tunnel systems", () => {
  assert.equal(discordReadinessAllowsJoin({
    ready: false,
    systems: [
      { id: "soniox", ok: false, code: "PENDING" },
      { id: "fish-audio", ok: true, code: "CONNECTED" },
      { id: "attendee", ok: false, code: "NOT_CONFIGURED" },
      { id: "llm", ok: true, code: "CONNECTED" },
      { id: "tunnel", ok: true, code: "CONNECTED" },
    ],
    blockers: [{ system: "attendee", code: "NOT_CONFIGURED" }],
  }), false);

  assert.equal(discordReadinessAllowsJoin({
    ready: false,
    systems: [
      { id: "soniox", ok: true, code: "CONNECTED" },
      { id: "fish-audio", ok: true, code: "CONNECTED" },
      { id: "attendee", ok: false, code: "PENDING" },
      { id: "llm", ok: true, code: "CONNECTED" },
      { id: "tunnel", ok: false, code: "PENDING" },
    ],
    blockers: [{ system: "attendee", code: "NOT_CONFIGURED" }],
  }), true);

  assert.equal(discordReadinessAllowsJoin({
    ready: false,
    systems: [
      { id: "soniox", ok: true, code: "CONNECTED" },
      { id: "fish-audio", ok: false, code: "TIMEOUT" },
      { id: "attendee", ok: false, code: "PENDING" },
      { id: "llm", ok: true, code: "CONNECTED" },
      { id: "tunnel", ok: false, code: "UNREACHABLE" },
    ],
    blockers: [],
  }), true);

  assert.equal(discordReadinessAllowsJoin({
    ready: false,
    systems: [
      { id: "soniox", ok: true, code: "CONNECTED" },
      { id: "fish-audio", ok: false, code: "AUTH_FAILED" },
      { id: "attendee", ok: false, code: "PENDING" },
      { id: "llm", ok: true, code: "CONNECTED" },
      { id: "tunnel", ok: false, code: "UNREACHABLE" },
    ],
    blockers: [{ system: "fish-audio", code: "AUTH_FAILED" }],
  }), false);

  assert.equal(discordReadinessAllowsJoin({
    ready: false,
    systems: [],
    blockers: [],
  }), false);

  assert.equal(discordReadinessAllowsJoin({
    ready: true,
    systems: [],
    blockers: [],
  }), true);

  assert.equal(discordReadinessAllowsJoin({ ready: true, blockers: [] }), true);
  assert.equal(discordReadinessAllowsJoin({ ready: false, blockers: [] }), false);
  assert.equal(discordReadinessAllowsJoin({
    ready: false,
    systems: [
      { id: "soniox", ok: true, code: "CONNECTED" },
      { id: "fish-audio", ok: true, code: "CONNECTED" },
      { id: "llm", ok: true, code: "CONNECTED" },
    ],
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

test("#197 join error causes prefix supplied diagnostic IDs and preserve legacy text", () => {
  const { parseJoinErrorText } = require("../public/app.js");
  const blockers = [{ message: "認証情報を確認してください", code: "AUTH_FAILED" }, { code: "NOT_ENABLED" }, null];
  const text = () => JSON.stringify({ error: { code: "MEETING_NOT_READY", message: "接続設定を確認してください", blockers } });
  assert.equal(parseJoinErrorText(text()), "接続設定を確認してください / 認証情報を確認してください / NOT_ENABLED");
  blockers[0].diagnosticId = "MM-STT-100";
  blockers[1].diagnosticId = "MM-LLM-103";
  assert.equal(parseJoinErrorText(text()), "接続設定を確認してください / [MM-STT-100] 認証情報を確認してください / [MM-LLM-103] NOT_ENABLED");
});


test("#279 non-loopback settings hint names the local settings page and copies its URL", () => {
  const { localSettingsHint } = require("../public/app.js");
  assert.equal(localSettingsHint.length, 1, "only the readiness payload can supply a port");
  assert.deepEqual(localSettingsHint({ settingsPort: 5030 }), {
    text: "設定画面は、meetmate を動かしている PC でだけ開けます。その PC で localhost:5030/settings を開いてください",
    url: "http://127.0.0.1:5030/settings",
  });
  assert.equal(localSettingsHint({ settingsPort: "6123" }).url, "http://127.0.0.1:6123/settings");
  // Without a server-reported port the hint names no address: no default, and a second argument
  // (the tunnel's or proxy's location.port on such a view) is ignored.
  for (const state of [null, undefined, {}, { settingsPort: "invalid" }, { settingsPort: "" }, { settingsPort: null },
    { settingsPort: 0 }, { settingsPort: -1 }, { settingsPort: 5005.5 }, { settingsPort: 65536 }, { settingsPort: 70000 }]) {
    for (const hint of [localSettingsHint(state), localSettingsHint(state, "8453")]) {
      assert.deepEqual(hint, {
        text: "設定画面は、meetmate を動かしている PC でだけ開けます。その PC で、起動時に表示される「Settings UI」の URL を開いてください",
        url: null,
      }, JSON.stringify(state));
      assert.doesNotMatch(hint.text, /\d/);
    }
  }

  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /<a class="settings-link" href="\/settings">⚙ 設定<\/a>/, "the loopback view keeps the plain link");
  assert.match(html, /<p class="settings-hint" id="settingsHint" hidden><\/p>/, "the hint starts hidden and empty");
});

test("#279 the 設定 entry toggles the hint on a non-loopback view and stays a link on loopback", () => {
  const { localSettingsHint } = require("../public/app.js");
  const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
  const init = source.match(/function initSettingsEntry\(\) \{[\s\S]*?\n  }/)[0];
  assert.doesNotMatch(init, /innerHTML|insertAdjacentHTML|location\.(?:href|assign|replace)|window\.open/);
  // The page must actually run it: exactly one call, in the top-level init sequence. Without it
  // the non-loopback view silently falls back to the link that answers 404.
  assert.equal((source.match(/(?<!function )\binitSettingsEntry\(/g) || []).length, 1, "one call besides the definition");
  assert.match(source, /\n  initTheme\(\);\n  initSettingsEntry\(\);\n/);

  function element(tag) {
    const listeners = {};
    return {
      tag, type: "", className: "", textContent: "", hidden: false, attributes: {}, children: [],
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, listener) { listeners[name] = listener; },
      replaceChildren(...nodes) { this.children = nodes; },
      click() { listeners.click(); },
    };
  }
  // The context has no `location`: reading location.port would throw here.
  function run(loopback) {
    const settingsLink = Object.assign(element("a"), {
      className: "settings-link", textContent: "⚙ 設定", replacement: null,
      replaceWith(node) { this.replacement = node; },
    });
    const settingsHintEl = Object.assign(element("p"), { id: "settingsHint", hidden: true });
    const copied = [];
    const context = {
      settingsLink, settingsHintEl, localSettingsHint,
      readinessState: null,
      isLoopbackView: () => loopback,
      navigator: { clipboard: { writeText: (value) => copied.push(value) } },
      document: { createElement: element, createTextNode: (text) => ({ text }) },
    };
    require("node:vm").runInNewContext(`${init}; initSettingsEntry()`, context);
    return { settingsLink, settingsHintEl, copied, context };
  }

  const local = run(true);
  assert.equal(local.settingsLink.replacement, null);
  assert.equal(local.settingsHintEl.hidden, true);
  assert.deepEqual(local.settingsHintEl.children, []);

  const remote = run(false);
  const toggle = remote.settingsLink.replacement;
  assert.equal(toggle.tag, "button");
  assert.equal(toggle.type, "button");
  assert.equal(toggle.className, "settings-link");
  assert.equal(toggle.textContent, "⚙ 設定");
  assert.equal(Object.hasOwn(toggle, "href"), false);
  assert.deepEqual(toggle.attributes, { "aria-expanded": "false", "aria-controls": "settingsHint" });
  assert.equal(remote.settingsHintEl.hidden, true);

  // Readiness has not reported a port yet: the text alone, no address and no copy button.
  toggle.click();
  assert.equal(remote.settingsHintEl.hidden, false);
  assert.equal(toggle.attributes["aria-expanded"], "true");
  assert.deepEqual(remote.settingsHintEl.children, [
    { text: "設定画面は、meetmate を動かしている PC でだけ開けます。その PC で、起動時に表示される「Settings UI」の URL を開いてください" },
  ]);
  toggle.click();
  assert.equal(remote.settingsHintEl.hidden, true);
  assert.equal(toggle.attributes["aria-expanded"], "false");

  // A later readiness load is picked up the next time the hint is opened.
  remote.context.readinessState = { settingsPort: 5030 };
  toggle.click();
  assert.equal(remote.settingsHintEl.hidden, false);
  assert.equal(toggle.attributes["aria-expanded"], "true");
  const [text, copy] = remote.settingsHintEl.children;
  assert.equal(remote.settingsHintEl.children.length, 2);
  assert.deepEqual(text, { text: "設定画面は、meetmate を動かしている PC でだけ開けます。その PC で localhost:5030/settings を開いてください" });
  assert.equal(copy.tag, "button");
  assert.equal(copy.type, "button");
  assert.equal(copy.textContent, "URLをコピー");
  copy.click();
  assert.deepEqual(remote.copied, ["http://127.0.0.1:5030/settings"]);

  toggle.click();
  assert.equal(remote.settingsHintEl.hidden, true);
  assert.equal(toggle.attributes["aria-expanded"], "false");
});

test("#279 a stale readiness result is an informational row, not a warning", () => {
  const { readinessDisplayRows } = require("../public/app.js");
  const stale = { id: "attendee", code: "CONNECTED", ok: true, stale: true, diagnosticId: null };
  assert.deepEqual(readinessDisplayRows({ systems: [stale] }), [
    { kind: "info", text: "attendee: 前回の確認から時間が経っています（参加時に自動で確認し直します）" },
  ]);
  // Only the stale notice changed kind: blocker, pending and failure rows keep theirs. A blocked
  // system that is also stale keeps its blocker row and, as before, adds the stale notice.
  assert.deepEqual(readinessDisplayRows({
    blockers: [{ system: "soniox", code: "AUTH_FAILED", message: "認証情報を確認してください", fieldId: "soniox_api_key" }],
    systems: [
      { id: "soniox", code: "AUTH_FAILED", ok: false, stale: true },
      { id: "llm", code: "PENDING", ok: false, stale: true },
      { id: "tunnel", code: "TIMEOUT", ok: false, stale: true },
      { id: "fish-audio", code: "CONNECTED", ok: true, stale: false },
      stale,
    ],
  }).map((row) => row.kind), ["blocker", "info", "pending", "warning", "info"]);

  const css = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");
  assert.match(css, /\.readiness-line\.info \{ color: var\(--ink-muted\); \}/);
});

test("#283 T10 the face status line renders each alarm state and clears when the state leaves the alarm set", () => {
  const { faceStatusLine } = require("../public/app.js");
  const alarms = [
    [{ state: "missing", reason: "page_not_requested" }, "顔のページが届いていません。会議では静止画になっています（配信用の箱が動いていない可能性があります）。"],
    [{ state: "missing", reason: "page_expired" }, "顔の準備が時間内に終わらず、この参加では顔を出せなくなりました。会議では静止画のままです。"],
    [{ state: "stalled", reason: "not_ready" }, "顔の準備が終わりません。会議では静止画のままです。"],
    [{ state: "lost", reason: "page_stopped" }, "顔のページが途中で止まりました。会議では静止画になっています。"],
    [{ state: "unavailable", reason: "package_load_failed" }, "顔パッケージを読み込めませんでした。静止画で参加しています。"],
  ];
  const quiet = [undefined, null, "missing", { state: "pending", reason: null }, { state: "loading", reason: null },
    { state: "connected", reason: null }, { state: "missing", reason: "unknown" }, { state: "constructor", reason: "x" }];
  for (const [face, text] of alarms) assert.equal(faceStatusLine({ ...face, since: "2026-10-06T00:00:00.000Z" }), text, face.reason);
  for (const face of quiet) assert.equal(faceStatusLine(face), "", JSON.stringify(face));

  // The banner function itself, run against a fake line element: shown for alarms, hidden on recovery.
  const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
  const render = source.match(/function renderFaceStatus\(face\) \{[\s\S]*?\n  }/)[0];
  assert.match(source, /renderFloorStatus\(session\.floor\);\n    renderFaceStatus\(session\.face\);/);
  assert.doesNotMatch(render, /innerHTML|insertAdjacentHTML/);
  const classes = new Set(["active-url", "is-hidden"]);
  const activeFaceEl = {
    textContent: "",
    classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } },
  };
  const context = { activeFaceEl, faceStatusLine };
  require("node:vm").runInNewContext(render, context);
  for (const [face, text] of alarms) {
    context.renderFaceStatus(face);
    assert.equal(activeFaceEl.textContent, text);
    assert.equal(classes.has("is-hidden"), false);
    context.renderFaceStatus({ state: "connected", reason: null });
    assert.equal(activeFaceEl.textContent, "");
    assert.equal(classes.has("is-hidden"), true, `${face.reason} clears on recovery`);
  }
  context.renderFaceStatus(alarms[0][0]);
  context.renderFaceStatus(undefined); // an out-of-scope payload has no face key
  assert.equal(classes.has("is-hidden"), true);
});

test("#215 dashboard join reuses the join-token credential path", async () => {
  const cases = [
    { statuses: [200], expectedTokens: [undefined], prompts: 0, stored: [] },
    { statuses: [401, 200], prompted: "  operator-token  ", expectedTokens: [undefined, "operator-token"], prompts: 1, stored: ["operator-token"] },
    { joinToken: " stale-token ", statuses: [401, 401], prompted: "operator-token", expectedTokens: ["stale-token", "operator-token"], prompts: 1, stored: ["operator-token"] },
    { statuses: [401], prompted: "  ", expectedTokens: [undefined], prompts: 1, stored: [] },
    { statuses: [401], prompted: null, expectedTokens: [undefined], prompts: 1, stored: [] },
    { joinToken: " operator-token ", statuses: [200], expectedTokens: ["operator-token"], prompts: 0, stored: [] },
  ];
  for (const scenario of cases) {
    const body = buildMeetJoinFormData({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      availableAgents: [{ id: "caty", displayName: "Caty" }],
      wsUrl: "wss://meetmate.example/realtime",
      avatarExperiment: "follow-settings",
    });
    const originalEntries = [...body.entries()];
    const responses = scenario.statuses.map((status) => ({ status }));
    const requests = [];
    const stored = [];
    let prompts = 0;
    const response = await requestJoinMeeting({
      body,
      joinToken: scenario.joinToken,
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return responses[requests.length - 1];
      },
      promptImpl: (message) => {
        assert.equal(message, "参加トークン（JOIN_SHARED_TOKEN）を入力してください");
        prompts += 1;
        return scenario.prompted;
      },
      storeToken: (token) => stored.push(token),
    });
    assert.equal(response, responses.at(-1));
    assert.equal(prompts, scenario.prompts);
    assert.deepEqual(stored, scenario.stored);
    assert.equal(requests.length, scenario.statuses.length);
    requests.forEach(({ url, init }, index) => {
      assert.equal(url, "/join-meeting");
      assert.equal(init.method, "POST");
      assert.equal(init.body, body);
      assert.deepEqual([...init.body.entries()], originalEntries);
      const token = scenario.expectedTokens[index];
      assert.deepEqual(init.headers, token ? { "x-join-token": token } : undefined);
    });
  }
});

test("#230 dashboard leave and discord join/leave reuse the join-token credential path", async () => {
  const { requestLeaveMeeting, requestDiscordJoin, requestDiscordLeave, parseDiscordJoinErrorText } = require("../public/app.js");
  const payload = { guildId: "123", channelId: "456" };
  const jsonHeaders = { Accept: "application/json", "Content-Type": "application/json" };
  const helpers = [
    { request: requestLeaveMeeting, path: "/leave-meeting", args: { sessionId: "session-abc" } },
    { request: requestDiscordJoin, path: "/api/discord/join", args: { payload }, headers: jsonHeaders, body: JSON.stringify(payload) },
    { request: requestDiscordLeave, path: "/api/discord/leave", args: {}, headers: jsonHeaders, body: "{}" },
  ];
  const cases = [
    { statuses: [200], expectedTokens: [undefined], prompts: 0, stored: [] },
    { statuses: [401, 200], prompted: "  operator-token  ", expectedTokens: [undefined, "operator-token"], prompts: 1, stored: ["operator-token"] },
    { joinToken: " stale-token ", statuses: [401, 401], prompted: "operator-token", expectedTokens: ["stale-token", "operator-token"], prompts: 1, stored: ["operator-token"] },
    { statuses: [401], prompted: "  ", expectedTokens: [undefined], prompts: 1, stored: [] },
    { statuses: [401], prompted: null, expectedTokens: [undefined], prompts: 1, stored: [] },
    { joinToken: " operator-token ", statuses: [200], expectedTokens: ["operator-token"], prompts: 0, stored: [] },
  ];
  for (const helper of helpers) {
    for (const scenario of cases) {
      const responses = scenario.statuses.map((status) => ({ status }));
      const requests = [];
      const stored = [];
      let prompts = 0;
      const response = await helper.request({
        ...helper.args,
        joinToken: scenario.joinToken,
        fetchImpl: async (url, init) => {
          requests.push({ url, init });
          return responses[requests.length - 1];
        },
        promptImpl: (message) => {
          assert.equal(message, "参加トークン（JOIN_SHARED_TOKEN）を入力してください");
          prompts += 1;
          return scenario.prompted;
        },
        storeToken: (token) => stored.push(token),
      });
      assert.equal(response, responses.at(-1));
      assert.equal(prompts, scenario.prompts);
      assert.deepEqual(stored, scenario.stored);
      assert.equal(requests.length, scenario.statuses.length);
      requests.forEach(({ url, init }, index) => {
        assert.equal(url, helper.path);
        assert.equal(init.method, "POST");
        if (helper.body !== undefined) {
          assert.equal(init.body, helper.body);
          assert.equal(Object.hasOwn(JSON.parse(init.body), "joinToken"), false);
          assert.equal(Object.hasOwn(JSON.parse(init.body), "token"), false);
        } else {
          assert.ok(init.body instanceof URLSearchParams);
          assert.deepEqual([...init.body.entries()], [["sessionId", "session-abc"]]);
        }
        const token = scenario.expectedTokens[index];
        assert.deepEqual(init.headers, token ? { ...helper.headers, "x-join-token": token } : helper.headers);
      });
    }
  }
  assert.equal(parseDiscordJoinErrorText(JSON.stringify({ ok: false, code: "DISCORD_UNAUTHORIZED" }), 401), "参加トークンが無効です");
});
