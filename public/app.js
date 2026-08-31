const DISCORD_SNOWFLAKE_RE = /^[0-9]{17,20}$/;
const DISCORD_LOCAL_ONLY_HINT = "Discord 参加はローカルアクセス時のみ利用できます。";
const DISCORD_ERROR_MESSAGES = Object.freeze({
  DISCORD_SETUP_REQUIRED: "Discord 設定を確認してください",
  DISCORD_ALLOWLIST_REQUIRED: "Discord サーバー許可リストを設定してください",
  DISCORD_GUILD_NOT_ALLOWED: "この Discord サーバーは許可されていません",
  DISCORD_DEPENDENCY_MISSING: "Discord 連携の依存パッケージを確認してください",
  DISCORD_UNSUPPORTED_TTS_RATE: "Discord 用の音声サンプルレートを確認してください",
  DISCORD_MUTEX_BUSY: "別の通話が動作中です",
  DISCORD_JOIN_FAILED: "Discord への参加に失敗しました",
});

function isDiscordSnowflake(value) {
  return DISCORD_SNOWFLAKE_RE.test(String(value || "").trim());
}

function discordTargetStatus(guildId, channelId) {
  const normalizedGuildId = String(guildId || "").trim();
  const normalizedChannelId = String(channelId || "").trim();
  if (!normalizedGuildId && !normalizedChannelId) {
    return { ready: false, state: "idle", text: "入力待機中...", className: "field-status" };
  }
  if (
    (normalizedGuildId && !isDiscordSnowflake(normalizedGuildId))
    || (normalizedChannelId && !isDiscordSnowflake(normalizedChannelId))
  ) {
    return {
      ready: false,
      state: "invalid",
      text: "Guild ID / Channel ID は 17-20 桁の数字で入力してください",
      className: "field-status notfound",
    };
  }
  if (!normalizedGuildId || !normalizedChannelId) {
    return {
      ready: false,
      state: "partial",
      text: "Guild ID と Channel ID を入力してください",
      className: "field-status",
    };
  }
  return {
    ready: true,
    state: "detected",
    text: `検出済み: Guild ${normalizedGuildId} / Channel ${normalizedChannelId}`,
    className: "field-status detected",
  };
}

function buildMeetJoinFormData({ meetingUrl, availableAgents, wsUrl, avatarExperiment }) {
  const selectedAgentIds = availableAgents.map((agent) => agent.id);
  const botName = availableAgents.length
    ? `${availableAgents[0].id} (${availableAgents[0].displayName})`
    : "Agent";
  const formData = new URLSearchParams({
    meetingUrl,
    botName,
    wsUrl,
    conversationMode: "group",
    agentIds: selectedAgentIds.join(","),
  });
  appendAvatarExperiment(formData, avatarExperiment);
  return formData;
}

function buildDiscordJoinBody({ guildId, channelId }) {
  return {
    guildId: String(guildId || "").trim(),
    channelId: String(channelId || "").trim(),
  };
}

function discordJoinErrorMessage(code) {
  return DISCORD_ERROR_MESSAGES[code] || code;
}

function parseDiscordJoinErrorText(text, status) {
  if (status === 404) return DISCORD_LOCAL_ONLY_HINT;
  let payload;
  try { payload = JSON.parse(String(text || "")); } catch { return discordJoinErrorMessage("DISCORD_JOIN_FAILED"); }
  const code = payload?.code || payload?.error?.code;
  if (typeof code === "string" && code) return discordJoinErrorMessage(code);
  return discordJoinErrorMessage("DISCORD_JOIN_FAILED");
}

function firstActiveSession(sessions) {
  return Array.isArray(sessions) && sessions.length > 0 ? sessions[0] : null;
}

function discordConnectionReadyValue(status) {
  if (typeof status?.connectionReady === "boolean") return status.connectionReady;
  if (typeof status?.session?.connectionReady === "boolean") return status.session.connectionReady;
  return null;
}

function formatDiscordStatusLine(status) {
  if (!status || typeof status !== "object") return "Discord 接続状態: 未確認";
  const sessionState = status.session
    ? `${status.session.state || "未取得"} / ${status.session.lifecycle || "未取得"}`
    : "なし";
  const connectionReady = discordConnectionReadyValue(status);
  const connectionText = connectionReady === true
    ? "OK"
    : connectionReady === false
      ? "未接続"
      : "未取得";
  return `Discord 接続状態: ok=${status.ok === false ? "NG" : "OK"} / configured=${status.configured ? "完了" : "未完了"} / session=${sessionState} / connectionReady=${connectionText}`;
}

function pollBannerDecision(currentState, snapshot) {
  const meetSession = firstActiveSession(snapshot?.meetSessions);
  const discordSession = snapshot?.discordAvailable === true ? snapshot?.discordStatus?.session || null : null;
  const discordKnownOrPending = currentState?.hasDiscordSession === true
    || currentState?.discordStatusExpected === true
    || currentState?.activeTransport === "discord";

  if (discordSession) return { action: "discord", clearDiscordTracking: false };
  if (meetSession) {
    return {
      action: "meet",
      clearDiscordTracking: snapshot?.discordAttempted === true && snapshot?.discordAvailable === true,
    };
  }
  if (snapshot?.discordAttempted === true && snapshot?.discordAvailable !== true && discordKnownOrPending) {
    return { action: "preserve", clearDiscordTracking: false };
  }
  if (snapshot?.discordAttempted === true && snapshot?.discordAvailable === true) {
    if (currentState?.hasActiveSession === true && currentState?.activeTransport === "meet" && snapshot?.meetAvailable !== true) {
      return { action: "preserve", clearDiscordTracking: true };
    }
    return { action: "clear", clearDiscordTracking: true };
  }
  if (snapshot?.meetAvailable === true) return { action: "clear", clearDiscordTracking: false };
  return { action: "preserve", clearDiscordTracking: false };
}

function parseJoinErrorText(text) {
  let payload;
  try { payload = JSON.parse(String(text || "")); } catch { return String(text || ""); }
  const error = payload?.error;
  if (!error || typeof error !== "object") return String(text || "");
  if (error.code === "MEETING_NOT_READY") {
    const causes = Array.isArray(error.blockers)
      ? error.blockers.map((blocker) => blocker?.message || blocker?.code).filter(Boolean)
      : [];
    return [error.message || "ミーティングの接続設定を確認してください", ...causes].join(" / ");
  }
  if (error.code === "MEETING_SETUP_REQUIRED") {
    const issues = Array.isArray(error.issues)
      ? error.issues.map((issue) => issue?.fieldId || issue?.code).filter(Boolean)
      : [];
    return [error.message || "ミーティング設定が未完了です", ...issues].join(" / ");
  }
  return error.message || String(text || "");
}

function settingsPortFromReadiness(readinessState, fallbackPort) {
  for (const value of [readinessState?.settingsPort, fallbackPort, 5005]) {
    const port = Number(value);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return String(port);
  }
  return "5005";
}

function localSettingsUrlFor(fieldId, readinessState, fallbackPort) {
  const hash = String(fieldId || "").startsWith("panel-") ? fieldId : `field-${fieldId}`;
  return `http://127.0.0.1:${settingsPortFromReadiness(readinessState, fallbackPort)}/settings#${hash}`;
}

function readinessDisplayRows(readinessState) {
  if (readinessState?.unavailable) {
    return [{ kind: "warning", text: "接続状態を取得できません" }];
  }
  const blockers = Array.isArray(readinessState?.blockers) ? readinessState.blockers : [];
  const systems = Array.isArray(readinessState?.systems) ? readinessState.systems : [];
  const rows = [];
  if (readinessState?.setupRequired && blockers.length === 0) {
    rows.push({
      kind: "setup",
      text: "初期設定が未完了です。設定画面で必須項目を保存してください",
      fieldId: "panel-connections",
    });
  }
  rows.push(...blockers.map((blocker) => ({
    kind: "blocker",
    text: blocker.message || blocker.code,
    fieldId: blocker.fieldId,
  })));
  for (const system of systems) {
    if (system.code === "PENDING") {
      rows.push({ kind: "pending", text: `${system.id}: 確認中…` });
    } else if (!system.ok && !blockers.some((blocker) => blocker.system === system.id)) {
      rows.push({ kind: "warning", text: `${system.id}: ${system.code}（一時的な問題の可能性があります。Join はブロックしません）` });
    } else if (system.stale) {
      rows.push({ kind: "warning", text: `${system.id}: 前回の接続確認結果が古くなっています` });
    }
  }
  return rows;
}

function avatarExperimentLabel(value) {
  return ({
    "": "標準（静止画）",
    "hybrid-local-l0": "2.5Dリグ",
    "hybrid-local-frames": "フレームセット",
  })[value] || "標準（静止画）";
}

function appendAvatarExperiment(parameters, selection) {
  if (selection !== "follow-settings") parameters.append("avatarExperiment", selection);
  return parameters;
}

if (typeof module !== "undefined" && module.exports) module.exports = {
  appendAvatarExperiment,
  avatarExperimentLabel,
  buildDiscordJoinBody,
  buildMeetJoinFormData,
  discordConnectionReadyValue,
  discordJoinErrorMessage,
  discordTargetStatus,
  formatDiscordStatusLine,
  firstActiveSession,
  isDiscordSnowflake,
  localSettingsUrlFor,
  pollBannerDecision,
  parseDiscordJoinErrorText,
  parseJoinErrorText,
  readinessDisplayRows,
  settingsPortFromReadiness,
};

if (typeof document !== "undefined") (function () {
  const root = document.documentElement;
  const form = document.getElementById("joinForm");
  const statusEl = document.getElementById("status");
  const submitBtn = document.getElementById("joinBtn");
  const submitLabel = submitBtn.querySelector(".btn-label");
  const transportEls = [...form.querySelectorAll('input[name="joinTransport"]')];
  const meetingLabelEl = form.querySelector('label[for="meetingText"]');
  const meetingTextEl = document.getElementById("meetingText");
  const meetingUrlStatusEl = document.getElementById("meetingUrlStatus");
  const discordJoinFieldsEl = document.getElementById("discordJoinFields");
  const discordGuildIdEl = document.getElementById("discordGuildId");
  const discordChannelIdEl = document.getElementById("discordChannelId");
  const discordTargetStatusEl = document.getElementById("discordTargetStatus");
  const discordConnectionStatusEl = document.getElementById("discordConnectionStatus");
  const activeCard = document.getElementById("activeCard");
  const activeLabelEl = document.getElementById("activeLabel");
  const activeUrlEl = document.getElementById("activeUrl");
  const activeStateEl = document.getElementById("activeState");
  const activeWsEl = document.getElementById("activeWs");
  const activeAgentsEl = document.getElementById("activeAgents");
  const elapsedTimerEl = document.getElementById("elapsedTimer");
  const leaveBtn = document.getElementById("leaveBtn");
  const agentInfoEl = document.getElementById("agentInfoDisplay");
  const calibrateLink = document.getElementById("calibrateLink");
  const modeBadge = document.getElementById("modeBadge");
  const agentNameEl = document.getElementById("agentName");
  const launchTitleEl = document.getElementById("launchTitle");
  const launchSubEl = document.getElementById("launchSub");
  const metricsSubEl = document.getElementById("metricsSub");
  const metricsStatsEl = document.getElementById("metricsStats");
  const recentSessionsEl = document.getElementById("recentSessions");
  const themeToggle = document.getElementById("themeToggle");
  const themeLabel = document.getElementById("themeLabel");
  const installBanner = document.getElementById("installBanner");
  const installTitle = document.getElementById("installTitle");
  const installMessage = document.getElementById("installMessage");
  const installButton = document.getElementById("installButton");
  const installDismiss = document.getElementById("installDismiss");
  const readinessPanel = document.getElementById("readinessPanel");
  const readinessLines = document.getElementById("readinessLines");
  const readinessRecheck = document.getElementById("readinessRecheck");
  const avatarExperimentEl = document.getElementById("avatarExperiment");
  const meetingStatusWrapEl = meetingUrlStatusEl.parentElement;
  const avatarExperimentWrapEl = avatarExperimentEl.closest(".join-option");

  const INSTALL_DISMISSED_KEY = "aiMeetParticipantInstallDismissed";

  let extractedMeetingUrl = "";
  let isSubmitting = false;
  let isLeaving = false;
  let hasActiveSession = false;
  let hasDiscordSession = false;
  let activeTransport = "meet";
  let activeSessionId = null;
  let activeStartedAtMs = null;
  let pollTimer = null;
  let elapsedTimer = null;
  let availableAgents = [];
  let currentAgentId = "default";
  let serverPublicWsUrl = "";
  let lastUrlState = "";
  let endedShownUntilMs = 0;
  let pollEpoch = 0;
  let deferredInstallPrompt = null;
  let readinessState = null;
  let readinessChecking = false;
  let lastDiscordTargetState = "";
  let lastDiscordTarget = null;
  let discordStatusExpected = false;
  let lastDiscordStatusLine = "Discord 接続状態: 未確認";

  function getStoredTheme() {
    try {
      return localStorage.getItem("theme") || "";
    } catch {
      return "";
    }
  }

  function storeTheme(theme) {
    try {
      localStorage.setItem("theme", theme);
    } catch {
      // ignore storage failures
    }
  }

  function currentIsDark() {
    const attr = root.getAttribute("data-theme");
    if (attr === "dark") return true;
    if (attr === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function applyThemeUI() {
    const dark = currentIsDark();
    root.setAttribute("data-dark", dark ? "true" : "false");
    themeLabel.textContent = dark ? "ダーク" : "ライト";
  }

  function initTheme() {
    const stored = getStoredTheme();
    if (stored === "dark" || stored === "light") {
      root.setAttribute("data-theme", stored);
    }
    applyThemeUI();

    themeToggle.addEventListener("click", () => {
      const nextTheme = currentIsDark() ? "light" : "dark";
      root.setAttribute("data-theme", nextTheme);
      storeTheme(nextTheme);
      applyThemeUI();
    });

    window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
      if (!root.getAttribute("data-theme")) applyThemeUI();
    });
  }

  function isStandaloneDisplay() {
    return window.navigator.standalone === true
      || window.matchMedia("(display-mode: standalone)").matches;
  }

  function isInstallDismissed() {
    try {
      return localStorage.getItem(INSTALL_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  }

  function rememberInstallDismissed() {
    try {
      localStorage.setItem(INSTALL_DISMISSED_KEY, "1");
    } catch {
      // ignore storage failures
    }
  }

  function isIosSafari() {
    const ua = navigator.userAgent || "";
    const platform = navigator.platform || "";
    const isIos = /iPad|iPhone|iPod/.test(platform)
      || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isSafari = /Safari/i.test(ua) && !/(CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo)/i.test(ua);
    return isIos && isSafari;
  }

  function hideInstallBanner(remember) {
    installBanner.classList.add("is-hidden");
    if (remember) rememberInstallDismissed();
  }

  function showInstallBanner(mode) {
    installTitle.textContent = "Meetmate";
    installButton.hidden = mode === "ios";
    installMessage.textContent = mode === "ios"
      ? "iOS Safari では共有ボタンをタップし、「ホーム画面に追加」を選ぶとインストールできます。"
      : "この端末にインストールして単独ウィンドウで開けます。";
    installBanner.classList.remove("is-hidden");
  }

  function initInstallPrompt() {
    if (!installBanner || !installMessage || !installButton || !installDismiss) return;
    if (isStandaloneDisplay() || isInstallDismissed()) return;

    installDismiss.addEventListener("click", () => {
      deferredInstallPrompt = null;
      hideInstallBanner(true);
    });

    if (isIosSafari()) {
      showInstallBanner("ios");
    }

    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      showInstallBanner("chromium");
    });

    installButton.addEventListener("click", async () => {
      if (!deferredInstallPrompt) return;
      const promptEvent = deferredInstallPrompt;
      deferredInstallPrompt = null;
      try {
        await promptEvent.prompt();
        const choice = await promptEvent.userChoice;
        hideInstallBanner(choice && choice.outcome === "accepted");
      } catch {
        hideInstallBanner(false);
      }
    });

    window.addEventListener("appinstalled", () => {
      deferredInstallPrompt = null;
      hideInstallBanner(true);
    });
  }

  function setStatus(type, text) {
    statusEl.className = `toast visible ${type}`;
    statusEl.textContent = text;
  }

  function clearStatus() {
    statusEl.className = "toast";
    statusEl.textContent = "";
  }

  function triggerReveal(el) {
    el.classList.remove("animate-in");
    void el.offsetWidth;
    el.classList.add("animate-in");
  }

  function selectedTransport() {
    return transportEls.find((input) => input.checked)?.value === "discord" ? "discord" : "meet";
  }

  function discordJoinReady() {
    return discordTargetStatus(discordGuildIdEl.value, discordChannelIdEl.value).ready;
  }

  function applyTransportVisibility() {
    const discordSelected = selectedTransport() === "discord";
    meetingLabelEl.hidden = discordSelected;
    meetingTextEl.hidden = discordSelected;
    meetingTextEl.disabled = discordSelected;
    meetingTextEl.required = !discordSelected;
    meetingStatusWrapEl.hidden = discordSelected;
    agentInfoEl.hidden = discordSelected;
    discordJoinFieldsEl.classList.toggle("is-hidden", !discordSelected);
    discordGuildIdEl.disabled = !discordSelected;
    discordChannelIdEl.disabled = !discordSelected;
    avatarExperimentWrapEl.hidden = discordSelected;
    readinessPanel.classList.toggle("is-hidden", discordSelected || readinessLines.children.length === 0);
  }

  function renderDiscordStatusLine(text) {
    lastDiscordStatusLine = text || lastDiscordStatusLine;
    discordConnectionStatusEl.textContent = lastDiscordStatusLine;
  }

  function updateSubmitButtonState() {
    const discordSelected = selectedTransport() === "discord";
    const canSubmit = discordSelected
      ? discordJoinReady() && !isSubmitting && !hasActiveSession
      : Boolean(extractedMeetingUrl) && readinessState?.ready === true && !isSubmitting && !hasActiveSession;
    submitBtn.disabled = !canSubmit;
    if (hasActiveSession) {
      submitLabel.textContent = "通話中（退出してから再参加）";
    } else if (isSubmitting) {
      submitLabel.textContent = discordSelected ? "参加中..." : "起動中...";
    } else {
      submitLabel.textContent = discordSelected ? "Discord に参加させる" : "Meet に参加させる";
    }
  }

  function isLoopbackView() {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname);
  }

  function localSettingsUrl(fieldId) {
    return localSettingsUrlFor(fieldId, readinessState, location.port);
  }

  function appendReadinessLine(kind, text, fieldId) {
    const line = document.createElement("p");
    line.className = `readiness-line ${kind}`;
    const linksToSettings = ["blocker", "setup"].includes(kind) && fieldId;
    if (linksToSettings && isLoopbackView()) {
      const link = document.createElement("a");
      link.href = localSettingsUrl(fieldId);
      link.textContent = text;
      line.append(link);
    } else {
      line.append(document.createTextNode(text));
      if (linksToSettings) {
        const url = localSettingsUrl(fieldId);
        const port = settingsPortFromReadiness(readinessState, location.port);
        line.append(document.createTextNode(`。同じPCで localhost:${port}/settings を開いてください`));
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "readiness-copy";
        copy.textContent = "URLをコピー";
        copy.addEventListener("click", () => navigator.clipboard?.writeText(url));
        line.append(copy);
      }
    }
    readinessLines.append(line);
  }

  function renderReadiness() {
    readinessLines.replaceChildren();
    for (const row of readinessDisplayRows(readinessState)) appendReadinessLine(row.kind, row.text, row.fieldId);
    readinessRecheck.disabled = readinessChecking;
    applyTransportVisibility();
    updateSubmitButtonState();
  }

  async function loadReadiness() {
    try {
      const response = await fetch("/readiness", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("readiness unavailable");
      readinessState = await response.json();
    } catch {
      readinessState = {
        ready: false,
        systems: [],
        blockers: [],
        unavailable: true,
        settingsPort: readinessState?.settingsPort,
      };
    }
    renderReadiness();
  }

  async function recheckReadiness() {
    if (readinessChecking) return;
    readinessChecking = true;
    renderReadiness();
    try {
      const response = await fetch("/readiness/recheck", { method: "POST", headers: { Accept: "application/json" } });
      if (response.ok) readinessState = await response.json();
      else if (response.status === 429) setStatus("loading", `再チェックは制限中です。${response.headers.get("Retry-After") || "数"}秒後にお試しください。`);
    } catch {
      // Keep the last cache snapshot visible.
    } finally {
      readinessChecking = false;
      await loadReadiness();
    }
  }

  function stateLabel(state) {
    const labels = {
      initiating: "🔄 起動中...",
      joining: "🔄 参加中...",
      active: "🟢 通話中",
      speaking: "🎙️ 発話中",
      listening: "👂 聴取中",
      unknown: "🟡 接続中...",
    };
    return labels[state] || `🟡 ${state}`;
  }

  function discordSessionLabel(state) {
    const labels = {
      initiating: "🔄 Discord に参加中...",
      "in-progress": "🟢 Discord 通話中",
      completed: "✅ Discord 通話終了",
      failed: "⚠️ Discord 接続終了",
    };
    return labels[state] || `🟡 Discord: ${state || "unknown"}`;
  }

  function discordConnectionLine(status) {
    if (status?.connectionReady === true || status?.session?.connectionReady === true) return "接続状態: ボイス接続 OK";
    if (status?.session) return "接続状態: ボイス接続を確立中";
    return `接続状態: ${status?.configured ? "設定済み" : "未設定"}`;
  }

  async function loadAgentsFromServer() {
    try {
      const res = await fetch("/agents");
      const data = await res.json();
      availableAgents = Array.isArray(data.agents) ? data.agents : [];
    } catch {
      availableAgents = [];
    }

    const agent = availableAgents[0];
    if (agent) {
      const dn = agent.displayName || agent.name || agent.id;
      agentInfoEl.textContent = `エージェント: ${dn}`;
      document.title = `Meetmate — ${dn}`;
      agentNameEl.textContent = dn;
      launchTitleEl.textContent = `${dn} を起動`;
      launchSubEl.textContent = `${dn}をGoogle Meet / Zoomに参加させる`;
      currentAgentId = agent.id;
    } else {
      agentInfoEl.textContent = "利用可能なエージェントがありません";
      agentNameEl.textContent = "Meetmate";
    }
  }

  function parseStartedAt(value) {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  function formatElapsed(startedAtMs) {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function startElapsedTimer(startedAtMs) {
    activeStartedAtMs = startedAtMs;
    elapsedTimerEl.textContent = formatElapsed(startedAtMs);
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
      elapsedTimerEl.textContent = formatElapsed(activeStartedAtMs);
    }, 1000);
  }

  function stopElapsedTimer() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
    activeStartedAtMs = null;
    elapsedTimerEl.textContent = "00:00";
  }

  function clearActiveBanner() {
    hasActiveSession = false;
    activeTransport = selectedTransport();
    activeSessionId = null;
    activeAgentsEl.textContent = "エージェント: -";
    stopElapsedTimer();
    if (Date.now() < endedShownUntilMs) return;
    activeCard.classList.add("is-hidden");
    activeCard.classList.remove("ended");
    leaveBtn.classList.remove("is-hidden");
  }

  function renderMeetActiveBanner(session) {
    const startedAtMs = parseStartedAt(session.startedAt);
    hasActiveSession = true;
    hasDiscordSession = false;
    activeTransport = "meet";
    activeSessionId = session.sessionId;
    activeLabelEl.textContent = "通話中";
    activeUrlEl.textContent = session.meetingUrl || "";
    activeStateEl.textContent = stateLabel(session.state);
    activeWsEl.textContent = session.hasConnection ? "WS 接続 OK" : "WS 未接続";
    const fallbackName = availableAgents.length ? availableAgents[0].displayName : "エージェント";
    const names = Array.isArray(session.agentDisplayNames) && session.agentDisplayNames.length
      ? session.agentDisplayNames.join(", ")
      : fallbackName;
    activeAgentsEl.textContent = `エージェント: ${names}`;
    activeCard.classList.remove("is-hidden", "ended");
    startElapsedTimer(startedAtMs);
    endedShownUntilMs = 0;
    leaveBtn.classList.remove("is-hidden");
  }

  function clearDiscordTracking() {
    hasDiscordSession = false;
    discordStatusExpected = false;
    lastDiscordTarget = null;
  }

  function renderDiscordActiveBanner(status) {
    const session = status?.session || null;
    if (!session) {
      hasDiscordSession = false;
      if (!hasActiveSession || activeTransport === "discord") clearActiveBanner();
      return;
    }
    const previousTransport = activeTransport;
    hasActiveSession = true;
    hasDiscordSession = true;
    discordStatusExpected = true;
    activeTransport = "discord";
    activeSessionId = session.sessionId || null;
    activeLabelEl.textContent = "Discord 通話中";
    activeUrlEl.textContent = lastDiscordTarget
      ? `discord://${lastDiscordTarget.guildId}/${lastDiscordTarget.channelId}`
      : "Discord ボイスセッション";
    activeStateEl.textContent = discordSessionLabel(session.state || session.lifecycle);
    activeWsEl.textContent = discordConnectionLine(status);
    activeAgentsEl.textContent = `Discord 状態: ${status?.ok === false ? "エラー" : "OK"} / 設定: ${status?.configured ? "完了" : "未完了"}`;
    activeCard.classList.remove("is-hidden", "ended");
    if (previousTransport !== "discord" || activeStartedAtMs === null) startElapsedTimer(Date.now());
    endedShownUntilMs = 0;
    leaveBtn.classList.remove("is-hidden");
  }

  function updateActiveBanner(snapshot) {
    const decision = pollBannerDecision({
      hasActiveSession,
      hasDiscordSession,
      activeTransport,
      discordStatusExpected,
    }, snapshot);
    if (decision.clearDiscordTracking) clearDiscordTracking();
    if (decision.action === "discord") {
      renderDiscordActiveBanner(snapshot.discordStatus);
    } else if (decision.action === "meet") {
      renderMeetActiveBanner(firstActiveSession(snapshot.meetSessions));
    } else if (decision.action === "clear") {
      clearActiveBanner();
    }
    updateSubmitButtonState();
  }

  async function loadDiscordStatus() {
    try {
      const response = await fetch("/api/discord/status", { headers: { Accept: "application/json" } });
      if (!response.ok) return { available: false, status: null };
      const status = await response.json();
      renderDiscordStatusLine(formatDiscordStatusLine(status));
      return { available: true, status };
    } catch {
      return { available: false, status: null };
    }
  }

  async function pollActiveSession() {
    const epoch = pollEpoch;
    let meetAvailable = false;
    let sessions = [];
    let discordAttempted = false;
    let discordAvailable = false;
    let discordStatus = null;
    try {
      const res = await fetch("/active-session");
      const data = await res.json();
      meetAvailable = true;
      sessions = Array.isArray(data.sessions) ? data.sessions : [];
    } catch {
      // ignore polling errors
    }
    if (selectedTransport() === "discord" || hasDiscordSession || discordStatusExpected) {
      discordAttempted = true;
      const discordResult = await loadDiscordStatus();
      discordAvailable = discordResult.available === true;
      discordStatus = discordResult.status;
    }
    if (epoch !== pollEpoch) return;
    updateActiveBanner({
      meetAvailable,
      meetSessions: sessions,
      discordAttempted,
      discordAvailable,
      discordStatus,
    });
    await loadReadiness();
  }

  function startPolling() {
    pollActiveSession();
    pollTimer = setInterval(pollActiveSession, 3000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function showEndedState(message) {
    endedShownUntilMs = Date.now() + 5000;
    activeCard.classList.add("ended");
    activeLabelEl.textContent = "通話終了";
    activeStateEl.textContent = message;
    activeWsEl.textContent = "";
    stopElapsedTimer();
    leaveBtn.classList.add("is-hidden");
    pollEpoch += 1;
    setTimeout(pollActiveSession, 1000);
  }

  async function leaveMeeting() {
    if (isLeaving) return;
    isLeaving = true;
    leaveBtn.disabled = true;
    leaveBtn.textContent = "退出中...";

    try {
      if (activeTransport === "discord") {
        const res = await fetch("/api/discord/leave", {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: "{}",
        });
        const text = await res.text();
        if (res.ok) {
          setStatus("success", "Discord から退出しました");
          clearDiscordTracking();
          showEndedState("Discord セッションは正常に終了しました");
        } else {
          setStatus("error", parseDiscordJoinErrorText(text, res.status));
        }
      } else {
        const body = new URLSearchParams({
          sessionId: activeSessionId || "",
        });
        const res = await fetch("/leave-meeting", { method: "POST", body });
        const text = await res.text();

        if (res.ok) {
          setStatus("success", `退出しました: ${text}`);
          showEndedState("セッションは正常に終了しました");
        } else {
          setStatus("error", `退出エラー: ${text}`);
        }
      }
    } catch (err) {
      setStatus("error", `退出エラー: ${err.message}`);
    } finally {
      isLeaving = false;
      leaveBtn.disabled = false;
      leaveBtn.textContent = "退出する";
    }
  }

  function decodeEscapedAngles(text) {
    let decoded = text || "";
    const maxPasses = 5;

    for (let i = 0; i < maxPasses; i += 1) {
      const next = decoded
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">");
      if (next === decoded) break;
      decoded = next;
    }

    return decoded;
  }

  function isValidMeetPath(pathname) {
    return /^\/[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}\/?$/i.test(pathname || "");
  }

  function normalizeMeetingUrl(rawUrl) {
    if (!rawUrl) return "";
    let value = rawUrl.trim();
    if (!/^https?:\/\//i.test(value)) {
      value = `https://${value}`;
    }
    try {
      const parsed = new URL(value);
      parsed.protocol = "https:";
      const host = parsed.hostname.toLowerCase();

      if (host === "meet.google.com" && isValidMeetPath(parsed.pathname)) {
        return parsed.toString();
      }
      if (host.endsWith("zoom.us") && /^\/(j|my)\/[a-zA-Z0-9]+/.test(parsed.pathname)) {
        return parsed.toString();
      }
      return "";
    } catch {
      return "";
    }
  }

  function extractMeetingUrl(text) {
    const decoded = decodeEscapedAngles(text || "");
    const meetRegex = /(?:https?:\/\/)?meet\.google\.com\/[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}(?:\?[^\s<>"'|)]*)?/i;
    const meetMatch = decoded.match(meetRegex);
    if (meetMatch) return normalizeMeetingUrl(meetMatch[0]);

    const zoomRegex = /(?:https?:\/\/)?[\w.-]*zoom\.us\/(j|my)\/[a-zA-Z0-9?=&._%-]+/i;
    const zoomMatch = decoded.match(zoomRegex);
    if (zoomMatch) return normalizeMeetingUrl(zoomMatch[0]);

    return "";
  }

  function updateMeetingUrlStatus() {
    const text = meetingTextEl.value.trim();
    let nextState = "idle";
    extractedMeetingUrl = extractMeetingUrl(text);

    if (!text) {
      meetingUrlStatusEl.textContent = "貼り付け待機中...";
      meetingUrlStatusEl.className = "field-status";
    } else if (extractedMeetingUrl) {
      nextState = "detected";
      meetingUrlStatusEl.textContent = `検出済み: ${extractedMeetingUrl}`;
      meetingUrlStatusEl.className = "field-status detected";
    } else {
      nextState = "notfound";
      meetingUrlStatusEl.textContent = "Meet / Zoom の URL が見つかりません";
      meetingUrlStatusEl.className = "field-status notfound";
    }

    if (nextState !== lastUrlState && (nextState === "detected" || nextState === "notfound")) {
      triggerReveal(meetingUrlStatusEl);
    }
    lastUrlState = nextState;
    updateSubmitButtonState();
  }

  function updateDiscordTargetStatus() {
    const next = discordTargetStatus(discordGuildIdEl.value, discordChannelIdEl.value);
    discordTargetStatusEl.textContent = next.text;
    discordTargetStatusEl.className = next.className;
    if (next.state !== lastDiscordTargetState && ["detected", "invalid"].includes(next.state)) {
      triggerReveal(discordTargetStatusEl);
    }
    lastDiscordTargetState = next.state;
    updateSubmitButtonState();
  }

  function getAutoWsUrl() {
    if (serverPublicWsUrl) return serverPublicWsUrl;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}`;
  }

  async function loadInfo() {
    try {
      const res = await fetch("/info");
      const info = await res.json();
      if (info.ttsProvider === "fish-audio") {
        modeBadge.textContent = "🐟 Fish Audio TTS";
      } else {
        modeBadge.textContent = "🔊 Deepgram Voice Agent";
      }
      if (info.publicWsUrl) {
        serverPublicWsUrl = info.publicWsUrl;
      }
    } catch {
      // keep default badge
    }
  }

  async function loadCalibrateStatus() {
    try {
      const res = await fetch("/calibrate/status");
      const data = res.ok ? await res.json() : { enabled: false };
      if (data.enabled) {
        calibrateLink.classList.remove("is-hidden");
      }
    } catch {
      // leave hidden
    }
  }

  function formatMetricValue(value, unit) {
    const n = Number(value || 0);
    return unit ? `${n} ${unit}` : String(n);
  }

  function formatRecentTime(startedAtMs, lastEventMs) {
    if (!startedAtMs || !lastEventMs) return "時刻不明";
    const start = new Date(startedAtMs);
    const end = new Date(lastEventMs);
    const durationMinutes = Math.max(0, Math.round((lastEventMs - startedAtMs) / 60000));
    return `${start.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} 〜 ${end.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}（${durationMinutes}分）`;
  }

  function renderMetrics(data) {
    if (!data || data.enabled === false) {
      metricsSubEl.textContent = "metrics 未記録";
      metricsStatsEl.innerHTML = `
        <div class="stat"><div class="stat-value">0 回</div><div class="stat-label">WAKE 検出</div></div>
        <div class="stat"><div class="stat-value">0 回</div><div class="stat-label">応答対象</div></div>
        <div class="stat"><div class="stat-value">0 回</div><div class="stat-label">ターン</div></div>
        <div class="stat"><div class="stat-value">0 回</div><div class="stat-label">発話回数</div></div>
      `;
      recentSessionsEl.innerHTML = `
        <div class="recent-row empty-state">
          <span>metrics 未記録</span>
          <span class="recent-time">-</span>
        </div>
      `;
      return;
    }

    const totals = data.totals || {};
    metricsSubEl.textContent = `直近 ${data.windowHours || 24} 時間`;
    metricsStatsEl.innerHTML = `
      <div class="stat"><div class="stat-value">${formatMetricValue(totals.wakeDecisions, "回")}</div><div class="stat-label">WAKE 検出</div></div>
      <div class="stat"><div class="stat-value">${formatMetricValue(totals.addressed, "回")}</div><div class="stat-label">応答対象</div></div>
      <div class="stat"><div class="stat-value">${formatMetricValue(totals.turns, "回")}</div><div class="stat-label">ターン</div></div>
      <div class="stat"><div class="stat-value">${formatMetricValue(totals.utterances, "回")}</div><div class="stat-label">発話回数</div></div>
    `;

    const sessions = Array.isArray(data.recentSessions) ? data.recentSessions : [];
    if (!sessions.length) {
      recentSessionsEl.innerHTML = `
        <div class="recent-row empty-state">
          <span>直近セッションなし</span>
          <span class="recent-time">TTS ${formatMetricValue(totals.ttsPlaybacks, "回")}</span>
        </div>
      `;
      return;
    }

    recentSessionsEl.innerHTML = sessions.map((session) => {
      const ignored = Number(session.wakeIgnored || 0);
      const addressed = Number(session.wakeAddressed || 0);
      const statusClass = ignored > addressed ? "warn" : "ok";
      const status = `応答 ${addressed} / 無視 ${ignored}`;
      return `
        <div class="recent-row">
          <span>${formatRecentTime(session.startedAtMs, session.lastEventMs)}</span>
          <span class="recent-status ${statusClass}">${status}</span>
        </div>
      `;
    }).join("");
  }

  async function loadMetrics() {
    try {
      const res = await fetch("/metrics?hours=24");
      const data = await res.json();
      renderMetrics(data);
    } catch {
      renderMetrics({ enabled: false });
    }
  }

  async function loadAvatarExperimentDefault() {
    try {
      const response = await fetch("/api/settings", { headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const settings = await response.json();
      const configured = typeof settings?.effective?.avatar_experiment === "string"
        ? settings.effective.avatar_experiment : "";
      avatarExperimentEl.options[0].textContent = `設定に従う（${avatarExperimentLabel(configured)}）`;
    } catch {
      // The explicit choices remain usable if the local settings envelope is unavailable.
    }
  }

  function setTransport(nextTransport) {
    for (const input of transportEls) input.checked = input.value === nextTransport;
    activeTransport = hasActiveSession ? activeTransport : nextTransport;
    clearStatus();
    applyTransportVisibility();
    if (nextTransport === "discord") {
      updateDiscordTargetStatus();
    } else {
      updateMeetingUrlStatus();
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const transport = selectedTransport();
    if (transport === "discord") updateDiscordTargetStatus();
    else updateMeetingUrlStatus();
    if (isSubmitting || hasActiveSession) {
      setStatus("error", "既にアクティブなセッションがあります。退出してから再参加してください。");
      return;
    }
    if (transport === "meet" && !extractedMeetingUrl) {
      setStatus("error", "Meet / Zoom URLが見つかりません");
      return;
    }
    if (transport === "meet" && readinessState?.ready !== true) {
      setStatus("error", "接続確認が完了するまでお待ちください。設定が必要な項目は上の案内を確認してください。");
      return;
    }
    if (transport === "discord" && !discordJoinReady()) {
      setStatus("error", discordTargetStatus(discordGuildIdEl.value, discordChannelIdEl.value).text);
      return;
    }
    isSubmitting = true;
    updateSubmitButtonState();
    setStatus("loading", transport === "discord" ? "Discord に参加中..." : "Botを起動中...");

    try {
      if (transport === "discord") {
        const payload = buildDiscordJoinBody({
          guildId: discordGuildIdEl.value,
          channelId: discordChannelIdEl.value,
        });
        const response = await fetch("/api/discord/join", {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const text = await response.text();
        if (response.ok) {
          lastDiscordTarget = payload;
          discordStatusExpected = true;
          setStatus("success", "参加リクエストを送信しました。Discord で Bot の参加を確認してください。");
          setTimeout(pollActiveSession, 500);
        } else {
          setStatus("error", parseDiscordJoinErrorText(text, response.status));
        }
      } else {
        const response = await fetch("/join-meeting", {
          method: "POST",
          body: buildMeetJoinFormData({
            meetingUrl: extractedMeetingUrl,
            availableAgents,
            wsUrl: getAutoWsUrl(),
            avatarExperiment: avatarExperimentEl.value,
          }),
        });
        const text = await response.text();
        if (response.ok) {
          setStatus("success", `参加リクエストを送信しました。ミーティング画面でBotの参加を確認してください。${text ? ` ${text}` : ""}`);
          setTimeout(pollActiveSession, 500);
        } else {
          setStatus("error", parseJoinErrorText(text));
        }
      }
    } catch (err) {
      setStatus("error", transport === "discord" ? "接続エラー: Discord への参加に失敗しました" : `接続エラー: ${err.message}`);
    } finally {
      isSubmitting = false;
      updateSubmitButtonState();
    }
  });

  meetingTextEl.addEventListener("input", () => {
    clearStatus();
    updateMeetingUrlStatus();
  });
  meetingTextEl.addEventListener("paste", () => {
    setTimeout(updateMeetingUrlStatus, 0);
  });
  for (const input of transportEls) {
    input.addEventListener("change", () => setTransport(input.value));
  }
  discordGuildIdEl.addEventListener("input", () => {
    clearStatus();
    updateDiscordTargetStatus();
  });
  discordChannelIdEl.addEventListener("input", () => {
    clearStatus();
    updateDiscordTargetStatus();
  });
  leaveBtn.addEventListener("click", leaveMeeting);
  readinessRecheck.addEventListener("click", recheckReadiness);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      loadReadiness();
      if (selectedTransport() === "discord" || hasDiscordSession) pollActiveSession();
    }
  });
  window.addEventListener("beforeunload", () => {
    stopPolling();
    stopElapsedTimer();
  });

  initTheme();
  initInstallPrompt();
  loadInfo();
  loadAgentsFromServer();
  loadCalibrateStatus();
  loadMetrics();
  loadAvatarExperimentDefault();
  loadReadiness();
  updateMeetingUrlStatus();
  updateDiscordTargetStatus();
  renderDiscordStatusLine(lastDiscordStatusLine);
  setTransport("meet");
  startPolling();

  window.__aiMeetParticipant = {
    decodeEscapedAngles,
    normalizeMeetingUrl,
    extractMeetingUrl,
    stateLabel,
    get currentAgentId() {
      return currentAgentId;
    },
  };
})();
