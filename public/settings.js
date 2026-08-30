"use strict";

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]));
  }
  return false;
}

function diffFields(loadedFields, currentFields) {
  const changed = {};
  for (const [id, value] of Object.entries(currentFields || {})) {
    if (!Object.prototype.hasOwnProperty.call(loadedFields || {}, id) || !sameValue(loadedFields[id], value)) {
      changed[id] = value;
    }
  }
  return changed;
}

const OPENAI_FIELDS = new Set([
  "openai_base_url", "openai_empty_response_retry", "openai_trusted_agent_tools",
]);
const SONIOX_FIELDS = new Set([
  "soniox_api_key", "soniox_model", "soniox_ws_url", "soniox_endpoint_sensitivity",
  "soniox_max_endpoint_delay_ms", "soniox_endpoint_latency_level",
]);
const DEEPGRAM_FIELDS = new Set(["deepgram_api_key"]);
const ARRAY_FIELDS = new Set([
  "agent_wake_words", "agent_keyterms", "agent_stt_wake_variants", "agent_ack_variants", "agent_progress_pings",
]);
const BOOLEAN_FIELDS = new Set([
  "agent_emotion_tags", "openai_empty_response_retry", "openai_trusted_agent_tools",
  "tts_cache_enabled", "tts_cache_prewarm", "slack_notifications_enabled", "summary_enabled",
  "task_extraction_enabled", "streaming_equivalent_enabled",
]);
const NUMBER_FIELDS = new Set([
  "llm_temperature", "llm_max_tokens", "llm_history_max_turns", "soniox_endpoint_sensitivity",
  "soniox_max_endpoint_delay_ms", "soniox_endpoint_latency_level", "listen_endpointing_ms",
  "listen_utterance_end_ms", "fish_audio_speed", "tts_sample_rate", "gateway_warmup_timeout_ms",
]);
const NULLABLE_NUMBER_FIELDS = new Set([
  "soniox_endpoint_sensitivity", "soniox_max_endpoint_delay_ms", "soniox_endpoint_latency_level",
]);
const TEXTAREA_FIELDS = new Set([
  "agent_greeting", "agent_ack_variants", "agent_progress_pings", "agent_exit_farewell",
  "agent_cancel_ack", "agent_timeout_fallback", "llm_system_prompt",
]);
const AVATAR_FIELDS = new Set(["avatar_experiment"]);
const VOICE_FIELDS = new Set([
  "agent_emotion_tags", "agent_greeting", "agent_ack_variants", "agent_progress_pings",
  "agent_exit_farewell", "agent_cancel_ack", "agent_timeout_fallback",
]);

function fieldContainerId(entry) {
  if (AVATAR_FIELDS.has(entry.id)) return "avatarFields";
  if (VOICE_FIELDS.has(entry.id)) return "voiceFields";
  return entry.ux === "basic" ? "basicFields" : "detailFields";
}

function shownValue(entry, nextEnvelope) {
  if (Object.prototype.hasOwnProperty.call(nextEnvelope.fields || {}, entry.id)) return nextEnvelope.fields[entry.id];
  if (Object.prototype.hasOwnProperty.call(nextEnvelope.effective || {}, entry.id)) return nextEnvelope.effective[entry.id];
  if (Object.prototype.hasOwnProperty.call(entry, "defaultValue")) return entry.defaultValue;
  if (BOOLEAN_FIELDS.has(entry.id)) return false;
  if (ARRAY_FIELDS.has(entry.id)) return [];
  return "";
}

function prefillValues(manifest, envelope) {
  return Object.fromEntries((manifest || []).map((entry) => [entry.id, shownValue(entry, envelope)]));
}

function pendingChangesForValues(loadedValues, currentValues) {
  return diffFields(loadedValues, currentValues);
}

function clipMatchesCurrentText(clip, fields = {}) {
  const values = {
    ack: fields.agent_ack_variants || [],
    progress: fields.agent_progress_pings || [],
    greeting: [fields.agent_greeting],
    farewell: [fields.agent_exit_farewell],
    timeout: [fields.agent_timeout_fallback],
  };
  return Array.isArray(values[clip?.role]) && values[clip.role].some((text) => text === clip.text);
}

function readinessSummary(data) {
  const systems = Array.isArray(data?.systems) ? data.systems : [];
  return systems.map((system) => `${system.id}: ${system.code}`).join(" / ");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CLIENT_FIELD_SETS: {
      OPENAI_FIELDS, SONIOX_FIELDS, DEEPGRAM_FIELDS, NULLABLE_NUMBER_FIELDS, TEXTAREA_FIELDS, AVATAR_FIELDS, VOICE_FIELDS,
    },
    clipMatchesCurrentText,
    diffFields,
    fieldContainerId,
    pendingChangesForValues,
    prefillValues,
    readinessSummary,
    shownValue,
  };
}

if (typeof document !== "undefined") {
  (function initializeSettingsUi() {
    const MASK = "••••••••";
    const LABELS = {
      agent_id: "エージェント ID", agent_name: "エージェント名", agent_display_name: "表示名",
      agent_language: "言語", agent_greeting: "あいさつ", agent_emotion_tags: "感情タグ",
      agent_wake_words: "Wake Words", agent_keyterms: "音声認識キーターム",
      agent_stt_wake_variants: "Wake Word の認識候補", agent_ack_variants: "応答確認",
      agent_progress_pings: "進捗 Ping", agent_exit_farewell: "退出あいさつ",
      agent_cancel_ack: "キャンセル確認", agent_timeout_fallback: "タイムアウト",
      agent_avatar_url: "アイコン URL", avatar_experiment: "アバター表示",
      llm_provider: "LLM プロバイダー", llm_model: "LLM モデル",
      llm_temperature: "Temperature", llm_max_tokens: "最大トークン数",
      llm_history_max_turns: "会話履歴の最大ターン数", llm_system_prompt: "システムプロンプト",
      openai_base_url: "OpenAI-compatible Base URL", openai_empty_response_retry: "空レスポンスを再試行",
      openai_trusted_agent_tools: "信頼済みエージェントツール", soniox_api_key: "Soniox API key",
      deepgram_api_key: "Deepgram API key", stt_provider: "音声認識プロバイダー",
      soniox_model: "Soniox モデル", soniox_ws_url: "Soniox WebSocket URL",
      soniox_endpoint_sensitivity: "Soniox endpoint sensitivity",
      soniox_max_endpoint_delay_ms: "Soniox 最大 endpoint delay (ms)",
      soniox_endpoint_latency_level: "Soniox endpoint latency level",
      listen_endpointing_ms: "Endpointing (ms)", listen_utterance_end_ms: "発話終了待機 (ms)",
      fish_audio_api_key: "Fish Audio API key", fish_audio_voice_id: "Fish Audio Voice ID",
      tts_provider: "音声合成プロバイダー", fish_audio_model: "Fish Audio モデル",
      fish_audio_speed: "音声速度", fish_audio_latency: "音声生成レイテンシー",
      tts_sample_rate: "サンプルレート", tts_cache_enabled: "音声キャッシュ",
      tts_cache_prewarm: "音声キャッシュの事前生成", attendee_api_key: "Attendee API key",
      attendee_base_url: "Attendee ホスト名", slack_bot_token: "Slack Bot token",
      slack_notifications_enabled: "Slack 通知", slack_notifications_target: "Slack 通知先",
      slack_dm_user_id: "Slack User ID", slack_notify_channel: "Slack 通知チャンネル",
      slack_summary_channel: "Slack サマリーチャンネル", slack_status_channel: "Slack ステータスチャンネル",
      summary_enabled: "会議サマリー", gateway_warmup_timeout_ms: "Gateway warmup timeout (ms)",
      gateway_display_name: "Gateway 表示名", server_ngrok_domain: "ngrok ドメイン",
      task_extraction_enabled: "タスク抽出", streaming_equivalent_enabled: "ストリーミング相当",
    };
    const HELP = {
      agent_wake_words: "1行に1件入力します。カンマ区切りも利用できます。",
      agent_keyterms: "音声認識へ渡す固有名詞などを1行に1件入力します。",
      agent_stt_wake_variants: "認識されやすい表記の候補を1行に1件入力します。",
      agent_ack_variants: "ランダムに使う文言を1行に1件入力します。",
      agent_progress_pings: "処理中に使う文言を1行に1件入力します。",
      agent_emotion_tags: "Fish Audio の固定タグをプロンプトへ含めます。",
      avatar_experiment: "次回の会議参加から反映されます",
      task_extraction_enabled: "会議終了時に TODO を抽出します。",
      streaming_equivalent_enabled: "OpenAI-compatible の互換ストリーミング動作を使います。",
    };
    const ISSUE_LABELS = {
      VALUE_REQUIRED: "必須値が未設定です", VALUE_INVALID: "保存値が無効です",
      PROVIDER_DEPENDENCY_REQUIRED: "選択中のプロバイダーに必要な値が不足しています",
      CONFIG_DOCUMENT_INVALID: "設定ファイルを読み取れません。保存すると復旧用の設定を作成します",
      AGENT_ID_RECONCILIATION_REQUIRED: "エージェント ID の整合を確認してください",
      LLM_CONNECTION_ENV_REQUIRED: "LLM 接続情報が不足しています",
      LEGACY_CONNECTION_CONFIG_PRESENT: "従来形式の接続設定を整理してください",
    };
    const SOURCE_LABELS = {
      config: "保存値", ".env-seed": ".env seed", default: "既定値", unset: "未設定", "os-env": "os-env",
    };
    const CONNECTIONS = [
      ["soniox", "Soniox"], ["deepgram", "Deepgram"], ["fish-audio", "Fish Audio"],
      ["attendee", "Attendee"], ["llm", "LLM"], ["tunnel", "Tunnel"], ["slack", "Slack"],
    ];
    const CONNECTION_EXPLANATIONS = {
      CONNECTED: "接続できました。", NOT_CONFIGURED: "キーが未設定です。", AUTH_FAILED: "キーが不正です。",
      UNREACHABLE: "プロバイダーへ到達できません。", TIMEOUT: "接続がタイムアウトしました。",
      RATE_LIMITED: "プロバイダー側のレート制限に達しました。", PROVIDER_ERROR: "プロバイダーでエラーが発生しました。",
      PAYMENT_REQUIRED: "支払い状態を確認してください。", NOT_ENABLED: "OpenClaw 側で chatCompletions endpoint を有効にしてください。",
      MISMATCH: "公開URLが別の meetmate を指しています。", RESTART_REQUIRED: "meetmate の再起動が必要です。",
    };
    const AUDIO_ROLE_LABELS = {
      ack: "応答確認", progress: "進捗", greeting: "あいさつ", farewell: "退出", timeout: "タイムアウト",
    };
    const AVATAR_OPTION_LABELS = {
      "": "標準（静止画）",
      "hybrid-local-l0": "2.5Dリグ",
      "hybrid-local-frames": "フレームセット",
    };
    const AVATAR_SOURCE_LABELS = {
      uploaded: "アップロード済み", "url-cache": "URL キャッシュ", bundled: "既定",
    };
    const AVATAR_FRAME_NAMES = ["idle", "talk1", "talk2", "talk3", "blink", "talk_blink"];

    const form = document.getElementById("settingsForm");
    const toast = document.getElementById("settingsToast");
    const loadStatus = document.getElementById("loadStatus");
    const saveButton = document.getElementById("saveSettings");
    const dirtyStatus = document.getElementById("dirtyStatus");
    const importFile = document.getElementById("importFile");
    const audioRole = document.getElementById("audioRole");
    const audioText = document.getElementById("audioText");
    const audioFile = document.getElementById("audioFile");
    const uploadAudioButton = document.getElementById("uploadAudio");
    const ttsPreviewText = document.getElementById("ttsPreviewText");
    const playTtsPreviewButton = document.getElementById("playTtsPreview");
    const ttsPreviewPlayer = document.getElementById("ttsPreviewPlayer");
    const avatarStaticFile = document.getElementById("avatarStaticFile");
    const uploadStaticAvatarButton = document.getElementById("uploadStaticAvatar");
    const avatarStaticPreview = document.getElementById("avatarStaticPreview");
    let manifest = [];
    let envelope = null;
    let loadedValues = {};
    let credentialChanges = {};
    let toastTimer = null;
    let previewObjectUrl = null;

    function readInjectedJson(id) {
      const node = document.getElementById(id);
      if (!node) throw new Error(`Missing injected data: ${id}`);
      return JSON.parse(node.textContent);
    }

    function normalizeManifest(value) {
      const fields = Array.isArray(value) ? value : Array.isArray(value?.fields) ? value.fields : [];
      return fields.filter((entry) => entry && typeof entry.id === "string"
        && entry.writeSurface !== "none" && entry.writeSurface !== "audio-only"
        && (entry.ux === "basic" || entry.ux === "detail"));
    }

    function labelFor(id) {
      return LABELS[id] || id.replaceAll("_", " ");
    }

    function controlFor(entry) {
      if (entry.credential && entry.credential !== "none") return "credential";
      const supplied = String(entry.control || "").toLowerCase();
      if (["checkbox", "toggle", "boolean"].includes(supplied)) return "checkbox";
      if (["select", "enum"].includes(supplied)) return "select";
      if (["textarea", "text-area", "multiline"].includes(supplied)) return "textarea";
      if (["array", "string-array", "string-list", "list"].includes(supplied)) return "array";
      if (["number", "integer"].includes(supplied)) return "number";
      if (BOOLEAN_FIELDS.has(entry.id)) return "checkbox";
      if (ARRAY_FIELDS.has(entry.id)) return "array";
      if (TEXTAREA_FIELDS.has(entry.id)) return "textarea";
      if (NUMBER_FIELDS.has(entry.id)) return "number";
      if (Array.isArray(entry.options) && entry.options.length) return "select";
      return "text";
    }

    function optionParts(option) {
      if (option && typeof option === "object") {
        return { value: String(option.value), label: String(option.labelJa || option.label || option.value) };
      }
      return { value: String(option), label: String(option) };
    }

    function optionLabel(entry, value, fallback) {
      return entry.id === "avatar_experiment" ? AVATAR_OPTION_LABELS[value] : fallback;
    }

    function sourceElement(entry) {
      const source = envelope?.sources?.[entry.id];
      if (!source) return null;
      const wrapper = document.createElement("div");
      wrapper.className = "field-source";
      const badge = document.createElement("span");
      badge.className = `source-badge${source === "os-env" ? " override" : ""}`;
      badge.textContent = source === "os-env" && entry.envAlias ? `${entry.envAlias} · os-env` : (SOURCE_LABELS[source] || source);
      wrapper.append(badge);
      if (source === "os-env") {
        const explanation = document.createElement("small");
        explanation.textContent = entry.envAlias
          ? `${entry.envAlias} が現在の実行値を上書きしています。保存した値を反映するには、この環境変数を外して再起動してください。`
          : "起動環境が現在の実行値を上書きしています。保存した値の反映には再起動が必要です。";
        wrapper.append(explanation);
      }
      return wrapper;
    }

    function applyMetadata(input, entry) {
      input.id = `setting-${entry.id}`;
      input.name = entry.id;
      input.dataset.settingId = entry.id;
      input.dataset.control = controlFor(entry);
      if (entry.min !== undefined) input.min = String(entry.min);
      if (entry.max !== undefined) input.max = String(entry.max);
      if (entry.step !== undefined) input.step = String(entry.step);
      if (entry.placeholder) input.placeholder = String(entry.placeholder);
    }

    function createCredential(entry, value) {
      const item = document.createElement("div");
      item.className = "credential-item span-2";
      item.dataset.fieldId = entry.id;
      const state = value && typeof value === "object" ? value.state : "unset";
      const summary = document.createElement("div");
      summary.className = "credential-summary";
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = labelFor(entry.id);
      const meta = document.createElement("span");
      meta.className = "credential-meta";
      meta.textContent = state === "overridden" ? "起動環境から設定済み" : state === "set" ? "保存済み" : "未設定";
      copy.append(title, meta);
      const mask = document.createElement("code");
      mask.className = "credential-mask";
      mask.textContent = value?.value === MASK ? MASK : "未設定";
      mask.setAttribute("aria-label", state === "unset" ? "未設定" : "値は非表示");
      const change = document.createElement("button");
      change.type = "button";
      change.className = "btn-quiet";
      change.textContent = "変更";
      change.setAttribute("aria-expanded", "false");
      summary.append(copy, mask, change);

      const editor = document.createElement("div");
      editor.className = "credential-editor is-hidden";
      const field = document.createElement("label");
      const fieldLabel = document.createElement("span");
      fieldLabel.textContent = "新しい値";
      const input = document.createElement("input");
      input.type = "password";
      input.autocomplete = "new-password";
      input.placeholder = "新しい値を入力";
      input.dataset.credentialId = entry.id;
      field.append(fieldLabel, input);
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "btn-text danger-text";
      clear.textContent = "保存値をクリア";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn-text";
      cancel.textContent = "キャンセル";
      const editState = document.createElement("span");
      editState.className = "credential-edit-state";
      editState.textContent = "未変更";
      editor.append(field, editState, clear, cancel);
      const provenance = sourceElement(entry);
      item.append(summary, editor);
      if (provenance) item.append(provenance);

      function resetEditor() {
        delete credentialChanges[entry.id];
        input.value = "";
        editState.textContent = "未変更";
        editor.classList.add("is-hidden");
        change.setAttribute("aria-expanded", "false");
        change.textContent = "変更";
        updateDirtyState();
      }
      change.addEventListener("click", () => {
        const opening = editor.classList.contains("is-hidden");
        if (opening) {
          editor.classList.remove("is-hidden");
          change.setAttribute("aria-expanded", "true");
          change.textContent = "閉じる";
          input.focus();
        } else resetEditor();
      });
      input.addEventListener("input", () => {
        const replacement = input.value.trim();
        if (replacement) {
          credentialChanges[entry.id] = replacement;
          editState.textContent = "新しい値を入力済み";
        } else {
          delete credentialChanges[entry.id];
          editState.textContent = "未変更（空欄は送信しません）";
        }
        updateDirtyState();
      });
      clear.addEventListener("click", () => {
        input.value = "";
        credentialChanges[entry.id] = null;
        editState.textContent = "保存時に明示的にクリアします";
        updateDirtyState();
      });
      cancel.addEventListener("click", resetEditor);
      return item;
    }

    function createField(entry, value) {
      if (controlFor(entry) === "credential") return createCredential(entry, value);
      const wrapper = document.createElement(controlFor(entry) === "checkbox" ? "div" : "label");
      wrapper.className = `${controlFor(entry) === "checkbox" ? "toggle-field" : "field"}${VOICE_FIELDS.has(entry.id) ? " preset-field" : ""}`;
      wrapper.dataset.fieldId = entry.id;
      const title = document.createElement("span");
      title.className = "field-label";
      title.textContent = labelFor(entry.id);
      let input;
      const control = controlFor(entry);
      if (control === "checkbox") {
        const toggle = document.createElement("label");
        toggle.className = "toggle-row";
        const copy = document.createElement("span");
        const strong = document.createElement("strong");
        strong.textContent = labelFor(entry.id);
        const help = document.createElement("small");
        help.textContent = HELP[entry.id] || (entry.apply === "live" ? "保存後すぐに反映" : "再起動後に反映");
        copy.append(strong, help);
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = Boolean(value);
        applyMetadata(input, entry);
        const visual = document.createElement("span");
        visual.className = "toggle-ui";
        visual.setAttribute("aria-hidden", "true");
        toggle.append(copy, input, visual);
        wrapper.append(toggle);
      } else {
        wrapper.append(title);
        if (control === "select") {
          input = document.createElement("select");
          for (const rawOption of entry.options || []) {
            const optionData = optionParts(rawOption);
            const option = document.createElement("option");
            option.value = optionData.value;
            option.textContent = optionLabel(entry, optionData.value, optionData.label);
            input.append(option);
          }
          if (![...input.options].some((option) => option.value === String(value ?? ""))) {
            const option = document.createElement("option");
            option.value = String(value ?? "");
            option.textContent = String(value ?? "");
            input.append(option);
          }
          input.value = String(value ?? "");
        } else if (control === "textarea" || control === "array") {
          input = document.createElement("textarea");
          input.rows = VOICE_FIELDS.has(entry.id) ? 4 : 3;
          input.value = control === "array" ? (Array.isArray(value) ? value.join("\n") : "") : String(value ?? "");
        } else {
          input = document.createElement("input");
          input.type = control === "number" ? "number" : "text";
          if (control === "number") input.step = entry.step === undefined ? "any" : String(entry.step);
          input.value = value === null || value === undefined ? "" : String(value);
        }
        applyMetadata(input, entry);
        wrapper.append(input);
        if (HELP[entry.id]) {
          const help = document.createElement("small");
          help.textContent = HELP[entry.id];
          wrapper.append(help);
        }
      }
      const provenance = sourceElement(entry);
      if (provenance) wrapper.append(provenance);
      const apply = document.createElement("span");
      apply.className = `apply-badge${entry.apply === "live" ? " live" : ""}`;
      apply.textContent = entry.apply === "live" ? "すぐに反映" : "次回起動時に反映";
      wrapper.append(apply);
      return wrapper;
    }

    function renderFields() {
      for (const id of ["basicFields", "avatarFields", "voiceFields", "detailFields"]) document.getElementById(id).replaceChildren();
      loadedValues = {};
      credentialChanges = {};
      for (const entry of manifest) {
        const value = shownValue(entry, envelope);
        loadedValues[entry.id] = value;
        const target = document.getElementById(fieldContainerId(entry));
        target.append(createField(entry, value));
      }
      renderEmotionHelp();
      renderAudioClips();
      updateConditionalVisibility();
      updateDirtyState();
    }

    function currentSavedFields() {
      return { ...(envelope?.effective || {}), ...(envelope?.fields || {}) };
    }

    function renderAudioClips() {
      const list = document.getElementById("audioClipList");
      list.replaceChildren();
      const clips = Array.isArray(envelope?.fields?.audio_clips) ? envelope.fields.audio_clips : [];
      for (const clip of clips) {
        const row = document.createElement("article");
        row.className = "audio-row";
        const icon = document.createElement("span");
        icon.className = "audio-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = "♪";
        const copy = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = `${AUDIO_ROLE_LABELS[clip.role] || clip.role}: ${clip.text}`;
        const created = document.createElement("small");
        const date = new Date(clip.createdAt);
        created.textContent = Number.isNaN(date.getTime()) ? clip.createdAt : date.toLocaleString("ja-JP");
        copy.append(title, created);
        const badges = document.createElement("div");
        badges.className = "audio-badges";
        const stale = document.createElement("span");
        stale.className = `status-badge ${clip.stale ? "mismatch" : "match"}`;
        stale.textContent = clip.stale ? "stale" : "current";
        const playable = document.createElement("span");
        playable.className = `status-badge ${clip.playable ? "match" : "pending"}`;
        playable.textContent = clip.playable ? "playable" : "unplayable";
        badges.append(stale, playable);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "btn-text danger-text";
        remove.textContent = "削除";
        remove.addEventListener("click", () => deleteAudioClip(clip.id, remove));
        row.append(icon, copy, badges, remove);

        const matches = clipMatchesCurrentText(clip, currentSavedFields());
        if (clip.stale || !clip.playable || !matches) {
          const warning = document.createElement("p");
          warning.className = "audio-warning";
          warning.textContent = !matches
            ? "警告: クリップの文言が現在の設定文と一致しないため、自動再生されません。"
            : clip.stale
              ? "警告: 現在の音声設定と一致しない stale クリップのため、自動再生されません。"
              : "警告: 音声ファイルを再生できないため、自動再生されません。";
          row.append(warning);
        } else {
          const active = document.createElement("p");
          active.className = "audio-active";
          active.textContent = "この定型文の自動再生に使用されます。";
          row.append(active);
        }
        list.append(row);
      }
      if (!clips.length) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "登録済みの音声クリップはありません。";
        list.append(empty);
      }
      updateAudioUploadState();
    }

    function updateAudioUploadState() {
      uploadAudioButton.disabled = !envelope || !audioText.value.trim() || !audioFile.files?.length;
    }

    function renderEmotionHelp() {
      const help = document.getElementById("emotionHelp");
      const list = document.getElementById("emotionTagsList");
      list.replaceChildren();
      let tags;
      try { tags = readInjectedJson("emotionTagsData"); } catch { tags = []; }
      if (!Array.isArray(tags) || !tags.length || !manifest.some((entry) => entry.id === "agent_emotion_tags")) {
        help.classList.add("is-hidden");
        return;
      }
      for (const entry of tags) {
        if (!entry || typeof entry.tag !== "string" || typeof entry.labelJa !== "string") continue;
        const item = document.createElement("li");
        const code = document.createElement("code");
        code.textContent = entry.tag;
        const label = document.createElement("span");
        label.textContent = entry.labelJa;
        item.append(code, label);
        list.append(item);
      }
      help.classList.toggle("is-hidden", !list.children.length);
    }

    function readControlValue(entry) {
      const input = document.querySelector(`[data-setting-id="${entry.id}"]`);
      if (!input) return undefined;
      const control = controlFor(entry);
      if (control === "checkbox") return input.checked;
      if (control === "number") {
        if (input.value === "") return NULLABLE_NUMBER_FIELDS.has(entry.id) ? null : "";
        return Number(input.value);
      }
      if (control === "array") {
        return [...new Set(input.value.split(/[\n,]/).map((part) => part.trim()).filter(Boolean))];
      }
      return input.value;
    }

    function currentValues() {
      const current = {};
      for (const entry of manifest) {
        if (controlFor(entry) === "credential") continue;
        current[entry.id] = readControlValue(entry);
      }
      return { ...current, ...credentialChanges };
    }

    function pendingChanges() {
      return pendingChangesForValues(loadedValues, currentValues());
    }

    function updateDirtyState() {
      const count = Object.keys(pendingChanges()).length;
      saveButton.disabled = !envelope || count === 0;
      dirtyStatus.textContent = !envelope ? "設定を読み込んでいます。" : count ? `${count} 件の未保存の変更があります。` : "変更はありません。";
    }

    function currentProvider(id, fallback) {
      const input = document.querySelector(`[data-setting-id="${id}"]`);
      return input ? readControlValue(manifest.find((entry) => entry.id === id)) : fallback;
    }

    function updateConditionalVisibility() {
      const llm = currentProvider("llm_provider", loadedValues.llm_provider);
      const stt = currentProvider("stt_provider", loadedValues.stt_provider);
      for (const entry of manifest) {
        const field = document.querySelector(`[data-field-id="${entry.id}"]`);
        if (!field) continue;
        const hidden = (OPENAI_FIELDS.has(entry.id) && llm !== "openai-compatible")
          || (SONIOX_FIELDS.has(entry.id) && stt !== "soniox")
          || (DEEPGRAM_FIELDS.has(entry.id) && stt !== "deepgram");
        field.classList.toggle("is-hidden", hidden);
      }
    }

    function renderState() {
      const stack = document.getElementById("settingsState");
      stack.replaceChildren();
      if (envelope.setupMode) {
        stack.append(notice("warning", "setup mode", "必須設定を入力して保存し、meetmate を再起動してから Join してください（保存 → 再起動 → Join）。"));
      }
      if (Array.isArray(envelope.issues) && envelope.issues.length) {
        const text = envelope.issues.map((issue) => `${labelFor(issue.fieldId)}: ${ISSUE_LABELS[issue.code] || issue.code}`).join(" / ");
        stack.append(notice("warning", "設定の確認が必要です", text));
      }
      if (Array.isArray(envelope.restartRequired) && envelope.restartRequired.length) {
        stack.append(notice("warning", "保存済み・再起動待ち", `meetmate を再起動してから Join してください: ${envelope.restartRequired.join(", ")}`));
      }
      if (!stack.children.length) stack.append(notice("success", "設定は読み込み済みです", "現在、追加の対応が必要な設定項目はありません。"));
    }

    function notice(kind, title, message) {
      const box = document.createElement("div");
      box.className = `settings-notice ${kind}`;
      const icon = document.createElement("span");
      icon.className = "notice-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = kind === "warning" ? "!" : "✓";
      const copy = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = title;
      const paragraph = document.createElement("p");
      paragraph.textContent = message;
      copy.append(strong, paragraph);
      box.append(icon, copy);
      return box;
    }

    function renderDiagnostics() {
      const list = document.getElementById("diagnosticsList");
      list.replaceChildren();
      const diagnostics = envelope.diagnostics || {};
      for (const id of Object.keys(diagnostics).sort()) {
        const row = document.createElement("div");
        const name = document.createElement("span");
        name.textContent = id.replaceAll("_", " ");
        const value = document.createElement("code");
        const raw = diagnostics[id]?.value;
        value.textContent = raw === null || raw === undefined ? "—" : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
        const source = document.createElement("small");
        source.textContent = diagnostics[id]?.source || "—";
        row.append(name, value, source);
        list.append(row);
      }
      if (!list.children.length) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "診断値はありません。";
        list.append(empty);
      }
    }

    function showToast(message) {
      window.clearTimeout(toastTimer);
      toast.textContent = message;
      toast.classList.add("visible");
      toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3500);
    }

    async function responseJson(response) {
      try { return await response.json(); } catch { return null; }
    }

    function errorMessage(body, fallback) {
      const code = body?.error?.code;
      if (code === "TEST_NOT_IMPLEMENTED") return "この接続テストは現在未実装です。";
      if (code === "SETTINGS_CONNECTION_RATE_LIMITED") return "接続テストの間隔が短すぎます。少し待ってから再試行してください。";
      if (code === "SETTINGS_PREVIEW_RATE_LIMITED") return "音声プレビューの間隔が短すぎます。少し待ってから再試行してください。";
      if (code === "SETTINGS_PREVIEW_TIMEOUT") return "音声プレビューがタイムアウトしました。";
      if (code === "SETTINGS_AVATAR_RATE_LIMITED") return "アップロードの間隔が短すぎます。少し待ってから再試行してください。";
      if (code === "SETTINGS_AVATAR_FILE_TOO_LARGE") return "画像のファイルサイズが上限を超えています。";
      if (code === "SETTINGS_AVATAR_TOTAL_LIMIT") return "アバター素材の合計 64 MiB 上限を超えています。";
      if (code === "SETTINGS_REVISION_CONFLICT") return "設定が別の操作で更新されました。";
      const details = Array.isArray(body?.error?.details)
        ? body.error.details.map((detail) => detail.path).filter(Boolean).join(", ") : "";
      return details ? `${fallback} (${details})` : body?.error?.message || fallback;
    }

    async function loadSettings(conflict = false) {
      loadStatus.textContent = "読み込み中";
      loadStatus.className = "status-badge loading";
      try {
        const response = await fetch("/api/settings", { headers: { Accept: "application/json" } });
        const body = await responseJson(response);
        if (!response.ok || !body) throw new Error(errorMessage(body, "設定を読み込めませんでした。"));
        envelope = body;
        renderFields();
        renderState();
        renderDiagnostics();
        await loadAvatarAssets();
        applyHashDeepLink();
        loadStatus.textContent = envelope.setupMode ? "セットアップ中" : "読み込み済み";
        loadStatus.className = `status-badge ${envelope.setupMode ? "pending" : "match"}`;
        if (conflict) showToast("設定が別の操作で更新されました。最新の内容を再読み込みしました。もう一度変更してください。");
      } catch (error) {
        loadStatus.textContent = "読み込み失敗";
        loadStatus.className = "status-badge mismatch";
        dirtyStatus.textContent = error.message;
      }
    }

    async function jsonRequest(url, options) {
      const response = await fetch(url, {
        ...options,
        headers: { Accept: "application/json", "Content-Type": "application/json", ...(options.headers || {}) },
      });
      const body = await responseJson(response);
      if (response.status === 409) {
        await loadSettings(true);
        const conflict = new Error("conflict");
        conflict.handled = true;
        throw conflict;
      }
      if (!response.ok) {
        const failure = new Error(errorMessage(body, "操作に失敗しました。"));
        failure.status = response.status;
        throw failure;
      }
      return body;
    }

    async function audioRequest(url, options) {
      const response = await fetch(url, { ...options, headers: { Accept: "application/json", ...(options.headers || {}) } });
      const body = await responseJson(response);
      if (response.status === 409) {
        await loadSettings(true);
        const conflict = new Error("conflict");
        conflict.handled = true;
        throw conflict;
      }
      if (!response.ok) {
        const failure = new Error(errorMessage(body, "音声クリップの操作に失敗しました。"));
        failure.status = response.status;
        throw failure;
      }
      return body;
    }

    async function assetRequest(url, options) {
      const response = await fetch(url, { ...options, headers: { Accept: "application/json", ...(options.headers || {}) } });
      const body = await responseJson(response);
      if (!response.ok) {
        const failure = new Error(errorMessage(body, "アバター素材の操作に失敗しました。"));
        failure.status = response.status;
        throw failure;
      }
      return body;
    }

    function formatBytes(value) {
      const bytes = Number(value);
      if (!Number.isFinite(bytes) || bytes < 0) return "—";
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
      return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
    }

    function avatarFileProblem(file, maxBytes) {
      if (!file) return "PNG ファイルを選択してください。";
      if (!file.name.toLowerCase().endsWith(".png")) return ".png ファイルを選択してください。";
      if (file.size > maxBytes) return `PNG は ${maxBytes / (1024 * 1024)} MiB 以下にしてください。`;
      return "";
    }

    function setObjectPreview(image, file) {
      const url = URL.createObjectURL(file);
      image.src = url;
      image.onload = () => URL.revokeObjectURL(url);
    }

    async function uploadAvatarFile(url, file, result, button) {
      button.disabled = true;
      const previous = button.textContent;
      button.textContent = "アップロード中…";
      result.textContent = "PNG を検証しています…";
      try {
        const formData = new FormData();
        formData.append("image", new Blob([file], { type: "image/png" }), file.name);
        await assetRequest(url, { method: "POST", body: formData });
        result.textContent = "PNG を登録しました。次回の会議参加から使用されます。";
        await loadAvatarAssets();
      } catch (error) {
        result.textContent = error.message;
      } finally {
        button.textContent = previous;
        button.disabled = false;
      }
    }

    function renderAvatarFrames(assets) {
      const list = document.getElementById("avatarFrameList");
      const result = document.getElementById("avatarFrameResult");
      const byName = new Map((assets.frames || []).map((frame) => [frame.name, frame]));
      list.replaceChildren();
      for (const name of AVATAR_FRAME_NAMES) {
        const frame = byName.get(name) || { name, present: false };
        const row = document.createElement("div");
        row.className = "avatar-frame-row";
        const preview = document.createElement("img");
        preview.className = `avatar-frame-preview${frame.present ? "" : " empty"}`;
        if (frame.present) {
          preview.alt = `${name} のプレビュー`;
          preview.src = `${frame.previewUrl}?sha=${encodeURIComponent(frame.sha256)}`;
        } else {
          preview.alt = `${name} は未登録`;
        }
        const copy = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = name;
        const detail = document.createElement("small");
        detail.textContent = frame.present ? `${frame.width}×${frame.height} · ${formatBytes(frame.bytes)}` : "PNG を登録してください";
        copy.append(title, detail);
        const badge = document.createElement("span");
        badge.className = `status-badge ${frame.present ? "match" : "pending"}`;
        badge.textContent = frame.present ? "登録済み" : "未登録";
        const picker = document.createElement("label");
        picker.className = "file-picker compact";
        const pickerText = document.createElement("span");
        pickerText.textContent = "PNG を選択";
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/png,.png";
        const uploadButton = document.createElement("button");
        uploadButton.type = "button";
        uploadButton.className = "btn-secondary";
        uploadButton.textContent = "登録";
        uploadButton.disabled = true;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "btn-text danger-text";
        remove.textContent = "削除";
        remove.disabled = !frame.present;
        input.addEventListener("change", () => {
          const file = input.files?.[0];
          const problem = avatarFileProblem(file, 10 * 1024 * 1024);
          uploadButton.disabled = Boolean(problem);
          if (problem) result.textContent = problem;
          else setObjectPreview(preview, file);
        });
        uploadButton.addEventListener("click", async () => {
          const file = input.files?.[0];
          const problem = avatarFileProblem(file, 10 * 1024 * 1024);
          if (problem) { result.textContent = problem; return; }
          await uploadAvatarFile(`/api/settings/avatar/frames/${encodeURIComponent(name)}`, file, result, uploadButton);
        });
        remove.addEventListener("click", async () => {
          remove.disabled = true;
          try {
            await jsonRequest(`/api/settings/avatar/frames/${encodeURIComponent(name)}`, { method: "DELETE" });
            result.textContent = `${name} を削除しました。`;
            await loadAvatarAssets();
          } catch (error) { result.textContent = error.message; }
          finally { remove.disabled = false; }
        });
        picker.append(pickerText, input);
        row.append(preview, copy, badge, picker, uploadButton, remove);
        list.append(row);
      }
    }

    function renderAvatarAssets(assets) {
      const source = document.getElementById("avatarStaticSource");
      source.className = `status-badge ${assets.static?.source === "bundled" ? "pending" : "match"}`;
      source.textContent = AVATAR_SOURCE_LABELS[assets.static?.source] || "不明";
      avatarStaticPreview.src = `${assets.static.previewUrl}?sha=${encodeURIComponent(assets.static.sha256 || "bundled")}`;
      document.getElementById("avatarStaticUrlNotice").classList.toggle(
        "is-hidden",
        !String(currentSavedFields().agent_avatar_url || "").trim(),
      );
      const rig = assets.rig || {};
      document.getElementById("avatarRigProvenance").textContent = rig.provenance || "unknown";
      document.getElementById("avatarRigBytes").textContent = formatBytes(rig.scriptBytes);
      const rigStatus = document.getElementById("avatarRigStatus");
      rigStatus.className = `status-badge ${rig.scriptBytes > 0 ? "match" : "mismatch"}`;
      rigStatus.textContent = rig.scriptBytes > 0 ? "利用可能" : "利用不可";
      renderAvatarFrames(assets);
    }

    async function loadAvatarAssets() {
      try {
        const response = await fetch("/api/settings/avatar", { headers: { Accept: "application/json" } });
        const body = await responseJson(response);
        if (!response.ok || !body) throw new Error(errorMessage(body, "アバター素材を読み込めませんでした。"));
        renderAvatarAssets(body);
      } catch (error) {
        document.getElementById("avatarStaticResult").textContent = error.message;
      }
    }

    async function uploadStaticAvatar() {
      const result = document.getElementById("avatarStaticResult");
      const file = avatarStaticFile.files?.[0];
      const problem = avatarFileProblem(file, 5 * 1024 * 1024);
      if (problem) { result.textContent = problem; return; }
      await uploadAvatarFile("/api/settings/avatar/static", file, result, uploadStaticAvatarButton);
      avatarStaticFile.value = "";
      uploadStaticAvatarButton.disabled = true;
    }

    async function deleteStaticAvatar() {
      if (!window.confirm("アップロードした静止画を削除しますか？")) return;
      const result = document.getElementById("avatarStaticResult");
      try {
        await jsonRequest("/api/settings/avatar/static", { method: "DELETE" });
        result.textContent = "静止画を削除しました。次回の会議参加では既定画像を使用します。";
        await loadAvatarAssets();
      } catch (error) { result.textContent = error.message; }
    }

    async function deleteAllAvatarFrames() {
      if (!window.confirm("登録済みのフレームをすべて削除しますか？")) return;
      const result = document.getElementById("avatarFrameResult");
      try {
        await jsonRequest("/api/settings/avatar/frames", { method: "DELETE" });
        result.textContent = "フレームセットを削除しました。";
        await loadAvatarAssets();
      } catch (error) { result.textContent = error.message; }
    }

    async function uploadAudioClip() {
      const result = document.getElementById("audioResult");
      const file = audioFile.files?.[0];
      const text = audioText.value.trim();
      if (!file || !text) return;
      if (!file.name.toLowerCase().endsWith(".mp3")) {
        result.textContent = ".mp3 ファイルを選択してください。";
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        result.textContent = "MP3 は 10 MiB 以下にしてください。";
        return;
      }
      uploadAudioButton.disabled = true;
      uploadAudioButton.textContent = "変換中…";
      result.textContent = "MP3 を検証・変換しています…";
      try {
        const formData = new FormData();
        formData.append("metadata", JSON.stringify({ role: audioRole.value, text, revision: envelope.revision }));
        formData.append("audio", new Blob([file], { type: "audio/mpeg" }), file.name);
        const body = await audioRequest("/api/settings/audio", { method: "POST", body: formData });
        envelope.revision = body.revision;
        audioText.value = "";
        audioFile.value = "";
        result.textContent = "音声クリップを登録しました。";
        await loadSettings();
      } catch (error) {
        if (!error.handled) result.textContent = error.message;
      } finally {
        uploadAudioButton.textContent = "アップロード";
        updateAudioUploadState();
      }
    }

    async function deleteAudioClip(id, button) {
      const result = document.getElementById("audioResult");
      button.disabled = true;
      try {
        const body = await jsonRequest(`/api/settings/audio/${encodeURIComponent(id)}`, {
          method: "DELETE", body: JSON.stringify({ revision: envelope.revision }),
        });
        envelope.revision = body.revision;
        result.textContent = "音声クリップを削除しました。";
        await loadSettings();
      } catch (error) {
        if (!error.handled) result.textContent = error.message;
      } finally { button.disabled = false; }
    }

    async function saveSettings(event) {
      event.preventDefault();
      const fields = pendingChanges();
      if (!Object.keys(fields).length) return;
      saveButton.disabled = true;
      saveButton.textContent = "保存中…";
      try {
        envelope = await jsonRequest("/api/settings", {
          method: "PUT",
          body: JSON.stringify({ schemaVersion: 1, revision: envelope.revision, fields }),
        });
        renderFields();
        renderState();
        renderDiagnostics();
        await renderCachedReadiness();
        showToast("設定を保存しました。");
      } catch (error) {
        if (!error.handled) showToast(error.message);
      } finally {
        saveButton.textContent = "変更を保存";
        updateDirtyState();
      }
    }

    function renderConnectionButtons() {
      const container = document.getElementById("connectionTests");
      for (const [provider, label] of CONNECTIONS) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn-secondary";
        button.textContent = `${label} テスト`;
        button.addEventListener("click", async () => {
          const result = document.getElementById("connectionResult");
          button.disabled = true;
          result.className = "action-result";
          result.textContent = `${label} の接続を確認しています…`;
          try {
            const body = await jsonRequest(`/api/settings/connections/${provider}/test`, {
              method: "POST", body: JSON.stringify({ revision: envelope.revision }),
            });
            const explanation = CONNECTION_EXPLANATIONS[body.code] || "接続結果を確認できませんでした。";
            result.textContent = `${label}: ${body.code} — ${explanation} (${body.durationMs} ms)`;
            result.className = `action-result ${body.ok ? "success-text" : "danger-text"}`;
          } catch (error) {
            if (error.handled) {
              result.textContent = "設定を再読み込みしました。もう一度接続テストをお試しください。";
              result.className = "action-result danger-text";
            } else {
              result.textContent = `${label}: ${error.message}`;
              result.className = "action-result danger-text";
            }
          } finally { button.disabled = false; }
        });
        container.append(button);
      }
    }

    async function renderCachedReadiness() {
      const result = document.getElementById("connectionResult");
      try {
        const response = await fetch("/readiness", { headers: { Accept: "application/json" } });
        const body = await responseJson(response);
        if (!response.ok || !body) return;
        result.textContent = readinessSummary(body) || "接続結果はまだありません。";
        result.className = `action-result ${body.ready ? "success-text" : "danger-text"}`;
      } catch {
        // The per-provider test buttons remain usable if the cache read fails.
      }
    }

    function updateTtsPreviewState() {
      const text = ttsPreviewText.value.trim();
      playTtsPreviewButton.disabled = !envelope || !text || [...text].length > 500;
    }

    async function playTtsPreview() {
      const result = document.getElementById("ttsPreviewResult");
      const text = ttsPreviewText.value.trim();
      if (!text || [...text].length > 500 || !envelope) return;
      playTtsPreviewButton.disabled = true;
      playTtsPreviewButton.textContent = "生成中…";
      result.className = "action-result";
      result.textContent = "Fish Audio でプレビューを生成しています…";
      try {
        const response = await fetch("/api/settings/tts-preview", {
          method: "POST",
          headers: { Accept: "audio/wav, application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ revision: envelope.revision, text }),
        });
        if (response.status === 409) {
          await loadSettings(true);
          result.textContent = "設定を再読み込みしました。もう一度お試しください。";
          return;
        }
        if (!response.ok) {
          const body = await responseJson(response);
          throw new Error(errorMessage(body, "音声プレビューを生成できませんでした。"));
        }
        const blob = await response.blob();
        if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
        previewObjectUrl = URL.createObjectURL(blob);
        ttsPreviewPlayer.src = previewObjectUrl;
        await ttsPreviewPlayer.play();
        result.textContent = "プレビューを再生しています。";
        result.className = "action-result success-text";
      } catch (error) {
        result.textContent = error.message || "音声プレビューを再生できませんでした。";
        result.className = "action-result danger-text";
      } finally {
        playTtsPreviewButton.textContent = "プレビューを再生";
        updateTtsPreviewState();
      }
    }

    async function exportSettings() {
      const result = document.getElementById("transferResult");
      try {
        const response = await fetch("/api/settings/export", { headers: { Accept: "application/json" } });
        if (!response.ok) {
          const body = await responseJson(response);
          result.textContent = response.status === 501 ? "エクスポートは #33 で実装予定です。" : errorMessage(body, "エクスポートに失敗しました。");
          return;
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "meetmate-settings.json";
        document.body.append(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        result.textContent = "設定をエクスポートしました。";
      } catch { result.textContent = "エクスポートに失敗しました。"; }
    }

    async function importSettings() {
      const result = document.getElementById("transferResult");
      const file = importFile.files?.[0];
      if (!file) return;
      try {
        const documentValue = JSON.parse(await file.text());
        const body = await jsonRequest("/api/settings/import", {
          method: "POST", body: JSON.stringify({ revision: envelope.revision, document: documentValue }),
        });
        envelope = body;
        renderFields();
        renderState();
        renderDiagnostics();
        const imported = body.import?.imported?.length ? body.import.imported.map(labelFor).join(", ") : "なし";
        const skipped = body.import?.skipped?.length ? body.import.skipped.map(labelFor).join(", ") : "なし";
        result.textContent = `インポート済み: ${imported} / スキップ: ${skipped}`;
      } catch (error) {
        if (!error.handled) result.textContent = error instanceof SyntaxError ? "JSON ファイルを読み取れませんでした。" : error.message;
      }
    }

    async function migrateVendorSettings() {
      const result = document.getElementById("transferResult");
      try {
        const body = await jsonRequest("/api/settings/migrate-env-class1", {
          method: "POST", body: JSON.stringify({ revision: envelope.revision }),
        });
        result.textContent = "Migrated legacy `.env` vendor values; those legacy lines are no longer needed.";
        await loadSettings();
      } catch (error) { if (!error.handled) result.textContent = error.message; }
    }

    function activateTab(nextTab, focus) {
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      for (const tab of tabs) {
        const selected = tab === nextTab;
        const panel = document.getElementById(tab.getAttribute("aria-controls"));
        tab.setAttribute("aria-selected", selected ? "true" : "false");
        tab.tabIndex = selected ? 0 : -1;
        if (panel) panel.hidden = !selected;
      }
      if (focus) nextTab.focus();
    }

    function initTabs() {
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      tabs.forEach((tab, index) => {
        tab.addEventListener("click", () => activateTab(tab, false));
        tab.addEventListener("keydown", (event) => {
          let next = null;
          if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % tabs.length;
          if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + tabs.length) % tabs.length;
          if (event.key === "Home") next = 0;
          if (event.key === "End") next = tabs.length - 1;
          if (next === null) return;
          event.preventDefault();
          activateTab(tabs[next], true);
        });
      });
    }

    function applyHashDeepLink() {
      const hash = decodeURIComponent(location.hash || "").replace(/^#/, "");
      if (!hash) return;
      const target = hash.startsWith("field-")
        ? document.querySelector(`[data-field-id="${CSS.escape(hash.slice("field-".length))}"]`)
        : hash === "panel-connections" ? document.getElementById(hash) : null;
      if (!target) return;
      const panel = target.classList.contains("tab-panel") ? target : target.closest(".tab-panel");
      const tab = panel && document.querySelector(`[role="tab"][aria-controls="${CSS.escape(panel.id)}"]`);
      if (tab) activateTab(tab, false);
      if (target.classList.contains("is-hidden")) return;
      target.classList.remove("deep-link-highlight");
      void target.offsetWidth;
      target.classList.add("deep-link-highlight");
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => target.classList.remove("deep-link-highlight"), 2_500);
    }

    form.addEventListener("submit", saveSettings);
    form.addEventListener("input", (event) => {
      if (event.target.dataset.settingId) {
        updateConditionalVisibility();
        updateDirtyState();
      }
    });
    form.addEventListener("change", (event) => {
      if (event.target.dataset.settingId) {
        updateConditionalVisibility();
        updateDirtyState();
      }
    });
    importFile.addEventListener("change", () => { document.getElementById("importSettings").disabled = !importFile.files?.length; });
    audioText.addEventListener("input", updateAudioUploadState);
    audioFile.addEventListener("change", updateAudioUploadState);
    avatarStaticFile.addEventListener("change", () => {
      const file = avatarStaticFile.files?.[0];
      const problem = avatarFileProblem(file, 5 * 1024 * 1024);
      uploadStaticAvatarButton.disabled = Boolean(problem);
      const result = document.getElementById("avatarStaticResult");
      result.textContent = problem;
      if (!problem) setObjectPreview(avatarStaticPreview, file);
    });
    ttsPreviewText.addEventListener("input", updateTtsPreviewState);
    playTtsPreviewButton.addEventListener("click", playTtsPreview);
    uploadAudioButton.addEventListener("click", uploadAudioClip);
    uploadStaticAvatarButton.addEventListener("click", uploadStaticAvatar);
    document.getElementById("deleteStaticAvatar").addEventListener("click", deleteStaticAvatar);
    document.getElementById("deleteAvatarFrames").addEventListener("click", deleteAllAvatarFrames);
    document.getElementById("exportSettings").addEventListener("click", exportSettings);
    document.getElementById("importSettings").addEventListener("click", importSettings);
    document.getElementById("migrateVendorSettings").addEventListener("click", migrateVendorSettings);
    window.addEventListener("hashchange", applyHashDeepLink);

    initTabs();
    renderConnectionButtons();
    try {
      manifest = normalizeManifest(readInjectedJson("settingsUiManifest"));
      if (!manifest.length) throw new Error("設定項目の定義を読み込めませんでした。");
      loadSettings();
    } catch (error) {
      loadStatus.textContent = "定義エラー";
      loadStatus.className = "status-badge mismatch";
      dirtyStatus.textContent = error.message;
    }
  })();
}
