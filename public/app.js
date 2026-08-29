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

if (typeof module !== "undefined" && module.exports) module.exports = {
  localSettingsUrlFor,
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
  const meetingTextEl = document.getElementById("meetingText");
  const meetingUrlStatusEl = document.getElementById("meetingUrlStatus");
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

  const INSTALL_DISMISSED_KEY = "aiMeetParticipantInstallDismissed";

  let extractedMeetingUrl = "";
  let isSubmitting = false;
  let isLeaving = false;
  let hasActiveSession = false;
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

  function updateSubmitButtonState() {
    const canSubmit = Boolean(extractedMeetingUrl) && readinessState?.ready === true && !isSubmitting && !hasActiveSession;
    submitBtn.disabled = !canSubmit;
    if (hasActiveSession) {
      submitLabel.textContent = "通話中（退出してから再参加）";
    } else if (isSubmitting) {
      submitLabel.textContent = "起動中...";
    } else {
      submitLabel.textContent = "Meet に参加させる";
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
    readinessPanel.classList.toggle("is-hidden", readinessLines.children.length === 0);
    readinessRecheck.disabled = readinessChecking;
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

  function updateActiveBanner(sessions) {
    if (sessions && sessions.length > 0) {
      const s = sessions[0];
      const startedAtMs = parseStartedAt(s.startedAt);
      hasActiveSession = true;
      activeSessionId = s.sessionId;
      activeLabelEl.textContent = "通話中";
      activeUrlEl.textContent = s.meetingUrl || "";
      activeStateEl.textContent = stateLabel(s.state);
      activeWsEl.textContent = s.hasConnection ? "WS 接続 OK" : "WS 未接続";
      const fallbackName = availableAgents.length ? availableAgents[0].displayName : "エージェント";
      const names = Array.isArray(s.agentDisplayNames) && s.agentDisplayNames.length
        ? s.agentDisplayNames.join(", ")
        : fallbackName;
      activeAgentsEl.textContent = `エージェント: ${names}`;
      activeCard.classList.remove("is-hidden", "ended");
      startElapsedTimer(startedAtMs);
      endedShownUntilMs = 0;
      leaveBtn.classList.remove("is-hidden");
    } else {
      hasActiveSession = false;
      activeSessionId = null;
      activeAgentsEl.textContent = "エージェント: -";
      stopElapsedTimer();
      if (Date.now() < endedShownUntilMs) {
        // keep showing the "call ended" state until the timeout expires
      } else {
        activeCard.classList.add("is-hidden");
        activeCard.classList.remove("ended");
        leaveBtn.classList.remove("is-hidden");
      }
    }
    updateSubmitButtonState();
  }

  async function pollActiveSession() {
    const epoch = pollEpoch;
    try {
      const res = await fetch("/active-session");
      const data = await res.json();
      if (epoch !== pollEpoch) return;
      updateActiveBanner(data.sessions);
    } catch {
      // ignore polling errors
    }
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

  async function leaveMeeting() {
    if (isLeaving) return;
    isLeaving = true;
    leaveBtn.disabled = true;
    leaveBtn.textContent = "退出中...";

    try {
      const body = new URLSearchParams({
        sessionId: activeSessionId || "",
      });
      const res = await fetch("/leave-meeting", { method: "POST", body });
      const text = await res.text();

      if (res.ok) {
        setStatus("success", `退出しました: ${text}`);
        endedShownUntilMs = Date.now() + 5000;
        activeCard.classList.add("ended");
        activeLabelEl.textContent = "通話終了";
        activeStateEl.textContent = "セッションは正常に終了しました";
        activeWsEl.textContent = "";
        stopElapsedTimer();
        leaveBtn.classList.add("is-hidden");
        pollEpoch += 1;
        setTimeout(pollActiveSession, 1000);
      } else {
        setStatus("error", `退出エラー: ${text}`);
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

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    updateMeetingUrlStatus();
    if (!extractedMeetingUrl || readinessState?.ready !== true || isSubmitting || hasActiveSession) {
      if (hasActiveSession) {
        setStatus("error", "既にアクティブなセッションがあります。退出してから再参加してください。");
      } else if (!extractedMeetingUrl) {
        setStatus("error", "Meet / Zoom URLが見つかりません");
      } else if (readinessState?.ready !== true) {
        setStatus("error", "接続確認が完了するまでお待ちください。設定が必要な項目は上の案内を確認してください。");
      }
      return;
    }

    isSubmitting = true;
    updateSubmitButtonState();
    setStatus("loading", "Botを起動中...");

    try {
      const wsUrl = getAutoWsUrl();
      const conversationMode = "group";
      const selectedAgentIds = availableAgents.map((a) => a.id);
      const botName = availableAgents.length
        ? `${availableAgents[0].id} (${availableAgents[0].displayName})`
        : "Agent";

      const formData = new URLSearchParams({
        meetingUrl: extractedMeetingUrl,
        botName,
        wsUrl,
        conversationMode,
        agentIds: selectedAgentIds.join(","),
      });

      const response = await fetch("/join-meeting", {
        method: "POST",
        body: formData,
      });

      const text = await response.text();
      if (response.ok) {
        setStatus("success", `参加リクエストを送信しました。ミーティング画面でBotの参加を確認してください。${text ? ` ${text}` : ""}`);
        setTimeout(pollActiveSession, 500);
      } else {
        setStatus("error", parseJoinErrorText(text));
      }
    } catch (err) {
      setStatus("error", `接続エラー: ${err.message}`);
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
  leaveBtn.addEventListener("click", leaveMeeting);
  readinessRecheck.addEventListener("click", recheckReadiness);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadReadiness();
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
  loadReadiness();
  updateMeetingUrlStatus();
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
