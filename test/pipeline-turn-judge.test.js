"use strict";

// #267 pipeline integration: agent.replyTrigger "jev" (opt-in trial).
// The real createPipeline runs with fake STT / LLM / TTS / metrics; the jev HTTP
// call goes through a stubbed global fetch. Hold timers (>= 1 s) are captured
// by an injected timer object and fired by hand.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const src = path.join(__dirname, "..", "src");
const SYNTHETIC_KEY = ["synthetic", "reply", "trigger", "value"].join("-");
const SPEAK = { addressed: 0.9, finished: 0.9 };
const WAIT = { addressed: 0.9, finished: 0.2 };
const IGNORE = { addressed: 0.2, finished: 0.9 };

const unhandled = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));

function cacheEntry(filename, exports) {
  return { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

function settingsState(agent = {}) {
  return { exists: true, valid: true, parsed: { agent } };
}

function speaker(id, displayName) {
  return { platform: "discord", id, isBot: false, displayName };
}

const SPEAKERS = { s1: speaker("s1", "田中"), s2: speaker("s2", "佐藤"), s3: speaker("s3", "鈴木") };

function hybridTimers() {
  const marker = Symbol("fake-timer");
  const pending = [];
  return {
    pending,
    setTimeout(fn, ms) {
      if (Number(ms) >= 1000) {
        const handle = { [marker]: true, fn, ms: Number(ms), cleared: false, fired: false, unref() { return handle; } };
        pending.push(handle);
        return handle;
      }
      return setTimeout(fn, ms);
    },
    clearTimeout(handle) {
      if (handle && handle[marker]) {
        handle.cleared = true;
        return;
      }
      clearTimeout(handle);
    },
    live() {
      return pending.filter((handle) => !handle.cleared && !handle.fired);
    },
    fire() {
      const due = pending.filter((handle) => !handle.cleared && !handle.fired);
      for (const handle of due) {
        handle.fired = true;
        handle.fn();
      }
      return due.length;
    },
  };
}

async function drain(rounds = 40) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, message, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function scoresFor(table) {
  return (body) => {
    for (const [needle, value] of Object.entries(table)) {
      if (body.state.latest_line.includes(needle)) return value;
    }
    return IGNORE;
  };
}

async function withPipeline(options, fn) {
  const env = {
    WAKE_WORDS: "ケイティ",
    POST_UTTERANCE_BUFFER_MS: "0",
    ENABLE_IMMEDIATE_ACK: "false",
    ENABLE_PROGRESS_GUARD: "false",
    TTS_LEAD_MS: "0",
    TTS_GAP_MS: "0",
    SENTENCE_PAUSE_MS: "0",
    CLAUSE_PAUSE_MS: "0",
    TTS_CACHE_PREWARM: "false",
    TYPESAFE_API_KEY: SYNTHETIC_KEY,
    ...(options.env || {}),
  };
  const previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const settingsBootstrap = require("../src/settings/bootstrap");
  const settingsResolver = require("../src/settings/resolver");
  settingsBootstrap.resetStartupForTest();
  settingsResolver.resetRuntimeForTest();

  const files = ["pipeline.js", "llm-provider.js", "stt-provider.js", "stt.js", "tts-fish.js", "metrics.js"]
    .map((name) => path.join(src, name));
  const previousCache = new Map(files.map((file) => [require.resolve(file), require.cache[require.resolve(file)]]));
  for (const file of files) delete require.cache[require.resolve(file)];

  const sttInstances = [];
  const sttExports = {
    createSTT: () => {
      const stt = Object.assign(new EventEmitter(), { send() {}, close() {} });
      sttInstances.push(stt);
      return stt;
    },
    buildKeyterms: () => [],
  };
  const llmPrompts = [];
  const streamChat = options.streamChat || (async function* () { yield "はい、承知しました。"; });
  const metrics = [];
  require.cache[require.resolve(path.join(src, "stt-provider.js"))] = cacheEntry(path.join(src, "stt-provider.js"), sttExports);
  require.cache[require.resolve(path.join(src, "stt.js"))] = cacheEntry(path.join(src, "stt.js"), sttExports);
  require.cache[require.resolve(path.join(src, "llm-provider.js"))] = cacheEntry(path.join(src, "llm-provider.js"), {
    createLlmProvider: () => ({
      name: "openclaw",
      streamChat(messages, opts) {
        llmPrompts.push(String(messages[messages.length - 1]?.content || ""));
        return streamChat(messages, opts);
      },
      VOICE_SYSTEM_ADDENDUM: "",
      buildVoiceAddendum: () => "",
    }),
  });
  require.cache[require.resolve(path.join(src, "tts-fish.js"))] = cacheEntry(path.join(src, "tts-fish.js"), {
    synthesize: async (_text, { onAudio }) => onAudio(Buffer.alloc(4)),
  });
  require.cache[require.resolve(path.join(src, "metrics.js"))] = cacheEntry(path.join(src, "metrics.js"), {
    recordEvent: (type, fields) => metrics.push({ type, ...fields }),
  });

  const fetchCalls = [];
  const responder = options.respond || scoresFor(options.scores || {});
  const previousFetch = global.fetch;
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    fetchCalls.push({ url, body, init });
    const reply = await responder(body, init);
    if (reply && typeof reply.addressed === "number") {
      return { ok: true, status: 200, json: async () => ({ answers: { addressed: { noul: reply.addressed }, finished: { noul: reply.finished } } }) };
    }
    return reply;
  };

  const originalNow = Date.now;
  let now = originalNow.call(Date);
  if (options.clock) Date.now = () => now;

  const logs = [];
  const warns = [];
  const originalConsole = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => warns.push(args.join(" "));
  console.error = (...args) => warns.push(args.join(" "));
  console.debug = () => {};

  const timers = hybridTimers();
  const unhandledBefore = unhandled.length;
  let pipeline;
  try {
    settingsResolver.initializeRuntime({ state: settingsState(options.agent || {}) });
    const { createPipeline } = require(path.join(src, "pipeline.js"));
    const session = { id: "turn-judge", conversationLog: [], config: { wakeMode: "wake" } };
    const turnState = { isAgentSpeaking: false, inputCooldownUntil: 0, droppedEchoFrames: 0 };
    const config = {
      dgKey: "x",
      fishKey: "x",
      stt: { model: "test", language: "ja", sampleRate: 16_000 },
      tts: { referenceId: null, sampleRate: 16_000, latency: "balanced", speed: 1 },
      llm: { provider: "openclaw", model: "test", responseTimeoutMs: 0, firstTokenDelegateMs: 0 },
      hub: options.floor
        ? { enabled: true, url: "ws://fake", roomCode: "room", authToken: "x", tailMs: 20 }
        : { enabled: false },
      gatewayEvents: { enabled: false },
      greeting: "",
      exitDetection: options.exitDetection === true,
      exitFarewell: "[warm] お疲れさまでした",
      echoCooldownMs: 0,
    };
    pipeline = createPipeline(session, turnState, () => {}, config, {
      transport: "discord",
      capabilities: { echoesOwnOutput: false, perSpeakerAudio: true },
      agentProfile: { agentId: "caty", displayName: "Caty", wakeWords: ["ケイティ"] },
      suppressGreeting: true,
      timers,
      ...(options.floor ? { floorClient: options.floor } : {}),
      _testExposeInternals: true,
    });
    // Attributed slots are evicted after an utterance when they are the least
    // recently used one; fresh audio re-creates the slot, as in production.
    const slots = new Map();
    const sttFor = (id) => {
      if (id === null) return sttInstances[0];
      const before = sttInstances.length;
      pipeline.sendAudio(Buffer.alloc(2), { speaker: SPEAKERS[id] });
      if (sttInstances.length > before) slots.set(id, sttInstances[sttInstances.length - 1]);
      return slots.get(id);
    };
    const ctx = {
      pipeline, session, turnState, logs, warns, metrics, fetchCalls, llmPrompts, timers,
      say: (id, text) => sttFor(id).emit("utterance_end", text),
      interim: (id, text) => sttFor(id).emit("transcript", text, false, 0.9),
      hold: () => pipeline._test.getTurnJudgeState?.().hold ?? null,
      judgeLines: () => logs.filter((line) => line.startsWith("🧭 [turn-judge] decision=")),
      advance: (ms) => { now += ms; },
      setTrigger: (value) => settingsResolver.publishState(settingsState({ ...(options.agent || {}), replyTrigger: value })),
    };
    // Prime the attributed slots so later utterances are synchronous emits.
    for (const id of options.speakers || []) sttFor(id);
    await fn(ctx);
    await drain();
    assert.deepEqual(unhandled.slice(unhandledBefore), [], "no unhandled rejection");
  } finally {
    try { pipeline?.close(); } catch { /* cleanup */ }
    await drain(5);
    Date.now = originalNow;
    global.fetch = previousFetch;
    Object.assign(console, originalConsole);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    settingsResolver.resetRuntimeForTest();
    settingsBootstrap.resetStartupForTest();
    for (const file of files) {
      const resolved = require.resolve(file);
      delete require.cache[resolved];
      if (previousCache.get(resolved)) require.cache[resolved] = previousCache.get(resolved);
    }
  }
}

const MARKERS = ["💬  [user]", "🔇  [会議音声", "🔔  ", "🚪  ", "📋  ", "🧭 "];
function markerLines(logs) {
  return logs.filter((line) => MARKERS.some((marker) => line.startsWith(marker)));
}
function decisionMetrics(metrics) {
  return metrics
    .filter((event) => ["utterance_end", "wake_decision", "turn_judge"].includes(event.type))
    .map((event) => ({ type: event.type, turn_id: event.turn_id, ...(event.type === "wake_decision" ? { addressed: event.addressed } : {}) }));
}

async function runDefaultScenario(agent) {
  let result = null;
  await withPipeline({ agent, exitDetection: true, speakers: ["s1"], scores: { "": SPEAK } }, async (ctx) => {
    ctx.say("s1", "資料もう見ました？");
    await waitFor(() => ctx.logs.some((line) => line.startsWith("🔇  [会議音声・未指名]")), "non-wake line");
    ctx.say("s1", "ケイティ、今日の議題をまとめて");
    await waitFor(() => ctx.llmPrompts.length === 1 && ctx.pipeline._test.getGateState() === "OPEN", "wake reply");
    ctx.say("s1", "退出して");
    await waitFor(() => ctx.logs.some((line) => line.startsWith("🚪  ")), "exit line");
    await drain();
    ctx.timers.fire();
    await drain();
    result = {
      markers: markerLines(ctx.logs),
      metrics: decisionMetrics(ctx.metrics),
      fetchCalls: ctx.fetchCalls.length,
      llmPrompts: ctx.llmPrompts.length,
      loaded: ctx.pipeline._test.getTurnJudgeState?.().turnJudgeLoaded ?? false,
      warns: ctx.warns.slice(),
    };
  });
  return result;
}

test("default mode: jev is never loaded or called and wake / no-wake / exit lines keep today's logs and metrics", { concurrency: false }, async () => {
  const expectedMarkers = [
    "💬  [user] [田中] 資料もう見ました？",
    '🔇  [会議音声・未指名] [田中] "資料もう見ました？..."',
    "💬  [user] [田中] ケイティ、今日の議題をまとめて",
    "🔔  Wake word detected! Gate → CLOSED",
    "📋  Injected meeting context (2 buffered entries)",
    "💬  [user] [田中] 退出して",
    "🚪  Exit command detected!",
  ];
  const expectedMetrics = [
    { type: "utterance_end", turn_id: "turn-judge-1" },
    { type: "wake_decision", turn_id: "turn-judge-1", addressed: false },
    { type: "utterance_end", turn_id: "turn-judge-2" },
    { type: "wake_decision", turn_id: "turn-judge-2", addressed: true },
    { type: "utterance_end", turn_id: "turn-judge-3" },
  ];
  const implicit = await runDefaultScenario({});
  const explicit = await runDefaultScenario({ replyTrigger: "wake" });
  for (const run of [implicit, explicit]) {
    assert.deepEqual(run.markers, expectedMarkers);
    assert.deepEqual(run.metrics, expectedMetrics);
    assert.equal(run.fetchCalls, 0, "jev is never called");
    assert.equal(run.llmPrompts, 1, "only the wake line is answered");
    assert.equal(run.loaded, false, "src/turn-judge.js is never loaded");
    assert.deepEqual(run.warns, []);
  }
});

function createFloor() {
  const floor = Object.assign(new EventEmitter(), {
    state: "READY",
    memberId: "m1",
    connectionEpoch: 1,
    members: [{ memberId: "m1", displayName: "Caty", wakeWords: ["ケイティ"] }],
    grant: null,
    latestRoundSequence: 0,
    connect() {},
    close() {},
    claimAssignment() { return null; },
    waitForReady: async () => true,
    remainingReadyGraceMs: () => 15_000,
    fallbackDelayMs: () => 20,
    hasActivePeerSpeech: () => false,
    hasUnsettledReports: () => false,
    reportWake: async () => ({ kind: "empty" }),
    reportText: async () => ({ kind: "empty" }),
    async acquire() { throw new Error("not used"); },
    fence() { return null; },
    isFenceCurrent() { return false; },
    speech() { return true; },
    release() { return true; },
  });
  return floor;
}

test("hub path: jev behaves as wake with one warning per session, and logs, metrics and decisions are unchanged", { concurrency: false }, async () => {
  const runs = {};
  for (const trigger of ["wake", "jev"]) {
    await withPipeline({ agent: { replyTrigger: trigger }, floor: createFloor(), speakers: ["s1", "s2"], scores: { "": SPEAK } }, async (ctx) => {
      ctx.say("s1", "資料もう見ました？");
      await waitFor(() => ctx.logs.filter((line) => line.startsWith("🔇  [会議音声")).length === 1, "first hub line");
      ctx.say("s2", "これ確認してもらえる？");
      await waitFor(() => ctx.logs.filter((line) => line.startsWith("🔇  [会議音声")).length === 2, "second hub line");
      await drain();
      runs[trigger] = {
        markers: markerLines(ctx.logs),
        metrics: decisionMetrics(ctx.metrics),
        fetchCalls: ctx.fetchCalls.length,
        llmPrompts: ctx.llmPrompts.length,
        loaded: ctx.pipeline._test.getTurnJudgeState().turnJudgeLoaded,
        warns: ctx.warns.slice(),
      };
    });
  }
  assert.deepEqual(runs.jev.markers, runs.wake.markers);
  assert.deepEqual(runs.jev.metrics, runs.wake.metrics);
  assert.equal(runs.jev.markers.some((line) => line.startsWith("🧭")), false);
  for (const run of Object.values(runs)) {
    assert.equal(run.fetchCalls, 0);
    assert.equal(run.llmPrompts, 0);
    assert.equal(run.loaded, false);
  }
  assert.deepEqual(runs.wake.warns, []);
  assert.equal(runs.jev.warns.length, 1);
  assert.match(runs.jev.warns[0], /replyTrigger=jev is not used while the floor hub is enabled/);
});

test("jev mode: a wake-word line makes no jev call and replies as today", { concurrency: false }, async () => {
  await withPipeline({ agent: { replyTrigger: "jev" }, speakers: ["s1"], scores: { "": SPEAK } }, async (ctx) => {
    ctx.say("s1", "ケイティ、今日の議題をまとめて");
    await waitFor(() => ctx.llmPrompts.length === 1, "wake reply");
    assert.equal(ctx.fetchCalls.length, 0);
    assert.ok(ctx.logs.includes("🔔  Wake word detected! Gate → CLOSED"));
    assert.deepEqual(ctx.judgeLines(), []);
  });
});

test("jev mode: a line without a wake word is answered only when both scores reach the thresholds", { concurrency: false }, async () => {
  await withPipeline({
    agent: { replyTrigger: "jev" },
    speakers: ["s1", "s2"],
    scores: { "予約しておいて": SPEAK, "助かったよね": { addressed: 0.62, finished: 0.91 } },
  }, async (ctx) => {
    ctx.say("s2", "あれ、ケイティがまとめてくれたから助かったよね".replace("ケイティ", "あの子"));
    await waitFor(() => ctx.judgeLines().length === 1, "ignore judgement");
    await drain();
    assert.equal(ctx.llmPrompts.length, 0);
    assert.match(ctx.judgeLines()[0], /^🧭 \[turn-judge\] decision=ignore addressed=0\.62 finished=0\.91 ms=\d+ reason=scores stage=first "/);
    assert.ok(ctx.logs.some((line) => line.startsWith('🔇  [会議音声・未指名] [佐藤]')));

    ctx.say("s1", "じゃあそれで予約しておいて");
    await waitFor(() => ctx.llmPrompts.length === 1, "speak reply");
    assert.match(ctx.judgeLines()[1], /^🧭 \[turn-judge\] decision=speak addressed=0\.90 finished=0\.90 ms=\d+ reason=scores stage=first "じゃあそれで予約しておいて"$/);
    assert.match(ctx.llmPrompts[0], /じゃあそれで予約しておいて$/);
    assert.ok(ctx.session.conversationLog.some((entry) => entry.role === "user" && entry.content === "じゃあそれで予約しておいて"));
    const judged = ctx.metrics.filter((event) => event.type === "turn_judge");
    assert.equal(judged.length, 2, "one metric per judgement");
    const lastEnd = ctx.metrics.filter((event) => event.type === "utterance_end").at(-1);
    assert.equal(judged[1].turn_id, lastEnd.turn_id, "reuses the utterance metricsTurnId");
    assert.deepEqual(
      { decision: judged[1].decision, addressed: judged[1].addressed, finished: judged[1].finished, reason: judged[1].reason, stage: judged[1].stage },
      { decision: "speak", addressed: 0.9, finished: 0.9, reason: "scores", stage: "first" },
    );
    assert.equal(Number.isInteger(judged[1].latency_ms), true);
    assert.equal(Object.values(judged[1]).some((value) => typeof value === "string" && value.includes("予約")), false, "no transcript text in the metric");
    const body = ctx.fetchCalls[1].body;
    assert.equal(body.state.latest_line, "参加者B: じゃあそれで予約しておいて");
    assert.deepEqual(body.state.recent_lines, ["参加者A: あれ、あの子がまとめてくれたから助かったよね"]);
    assert.equal(body.state.assistant_name, "Caty (ケイティ)");
    assert.equal(JSON.stringify(body).includes("田中") || JSON.stringify(body).includes("佐藤"), false, "display names are never sent");
  });
});

test("jev mode: every judge failure is silent (no key, non-OK, invalid answer, timeout, abort)", { concurrency: false }, async () => {
  const failures = [
    { name: "no_key", env: { TYPESAFE_API_KEY: undefined }, respond: () => SPEAK },
    { name: "http_503", respond: () => ({ ok: false, status: 503 }) },
    { name: "invalid_answer", respond: () => ({ ok: true, status: 200, json: async () => ({ answers: { addressed: { noul: 0.9 } } }) }) },
    { name: "timeout", agent: { replyJudge: { timeoutMs: 50 } }, respond: () => new Promise(() => {}) },
  ];
  for (const failure of failures) {
    await withPipeline({
      agent: { replyTrigger: "jev", ...(failure.agent || {}) },
      env: failure.env,
      speakers: ["s1"],
      respond: failure.respond,
    }, async (ctx) => {
      ctx.say("s1", "これ確認してもらえる？");
      await waitFor(() => ctx.judgeLines().length === 1, `${failure.name} judgement`);
      await drain();
      assert.match(ctx.judgeLines()[0], new RegExp(`decision=ignore addressed=- finished=- ms=\\d+ reason=${failure.name} `), failure.name);
      assert.equal(ctx.llmPrompts.length, 0, failure.name);
      assert.ok(ctx.logs.some((line) => line.startsWith("🔇  [会議音声・未指名]")), failure.name);
    });
  }
  await withPipeline({ agent: { replyTrigger: "jev" }, speakers: ["s1"], respond: () => new Promise(() => {}) }, async (ctx) => {
    ctx.say("s1", "これ確認してもらえる？");
    await waitFor(() => ctx.fetchCalls.length === 1, "request in flight");
    const signal = ctx.fetchCalls[0].init.signal;
    ctx.pipeline.close();
    assert.equal(signal.aborted, true, "close aborts the in-flight judge");
    await waitFor(() => ctx.judgeLines().length === 1, "aborted judgement");
    assert.match(ctx.judgeLines()[0], /decision=ignore .*reason=aborted /);
    assert.equal(ctx.llmPrompts.length, 0);
  });
});

test("hold: a same-speaker continuation merges and is judged once more; a merged speak sends the text once", { concurrency: false }, async () => {
  await withPipeline({
    agent: { replyTrigger: "jev" },
    speakers: ["s1"],
    respond: (body) => (body.state.latest_line.includes("まとめてくれる") ? SPEAK : WAIT),
  }, async (ctx) => {
    ctx.say("s1", "来月の広告予算なんだけど、");
    await waitFor(() => ctx.hold() !== null, "hold");
    assert.ok(ctx.logs.includes('🔇  [会議音声・保留] [田中] "来月の広告予算なんだけど、..."'));
    assert.match(ctx.judgeLines()[0], /decision=wait .*stage=first/);
    assert.equal(ctx.timers.live().length, 1);
    assert.equal(ctx.timers.live()[0].ms, 3000, "owner default continuationWaitMs");
    ctx.say("s1", "まとめてくれる？");
    assert.equal(ctx.hold().continuationArrived, true, "marked synchronously");
    assert.equal(ctx.timers.live().length, 0, "the deadline timer is cancelled by the continuation");
    await waitFor(() => ctx.llmPrompts.length === 1, "merged speak");
    assert.equal(ctx.hold(), null);
    assert.equal(ctx.fetchCalls[1].body.state.latest_line, "参加者A: 来月の広告予算なんだけど、 まとめてくれる？");
    assert.deepEqual(ctx.fetchCalls[1].body.state.recent_lines, [], "the held line is not repeated as context");
    assert.match(ctx.judgeLines()[1], /decision=speak .*stage=merged/);
    assert.equal(ctx.llmPrompts[0].split("来月の広告予算なんだけど、").length - 1, 1, "held text is sent once");
    assert.match(ctx.llmPrompts[0], /来月の広告予算なんだけど、 まとめてくれる？$/);
    const users = ctx.session.conversationLog.filter((entry) => entry.role === "user").map((entry) => entry.content);
    assert.deepEqual(users, ["[会議音声・保留] 来月の広告予算なんだけど、", "来月の広告予算なんだけど、 まとめてくれる？"]);
  });
});

test("hold: a second unfinished judgement on the merged text is ignored (only one wait)", { concurrency: false }, async () => {
  await withPipeline({ agent: { replyTrigger: "jev" }, speakers: ["s1"], respond: () => WAIT }, async (ctx) => {
    ctx.say("s1", "来月の広告予算なんだけど、");
    await waitFor(() => ctx.hold() !== null, "hold");
    ctx.say("s1", "その前に、");
    await waitFor(() => ctx.judgeLines().length === 2, "merged judgement");
    await drain();
    assert.match(ctx.judgeLines()[1], /decision=ignore addressed=0\.90 finished=0\.20 .*reason=second_wait stage=merged/);
    assert.equal(ctx.hold(), null);
    assert.equal(ctx.timers.live().length, 0);
    assert.equal(ctx.llmPrompts.length, 0);
  });
});

test("hold: an utterance_end from another speaker cancels synchronously and is judged with the held line in context", { concurrency: false }, async () => {
  await withPipeline({
    agent: { replyTrigger: "jev" },
    clock: true,
    speakers: ["s1", "s2"],
    respond: (body) => (body.state.latest_line.includes("予算") ? WAIT : IGNORE),
  }, async (ctx) => {
    ctx.say("s1", "来月の広告予算なんだけど、");
    await waitFor(() => ctx.hold() !== null, "hold");
    ctx.say("s2", "あ、ちょっと待って");
    assert.equal(ctx.hold(), null, "cleared before the chain runs");
    assert.ok(ctx.logs.includes("🧭 [turn-judge] hold cleared reason=other_speaker"));
    await waitFor(() => ctx.judgeLines().length === 2, "second line judged");
    assert.deepEqual(ctx.fetchCalls[1].body.state.recent_lines, ["参加者A: 来月の広告予算なんだけど、"]);
    assert.equal(ctx.fetchCalls[1].body.state.latest_line, "参加者B: あ、ちょっと待って");
    ctx.advance(10_000);
    assert.equal(ctx.timers.fire(), 0, "no deadline timer survives");
    await drain();
    assert.equal(ctx.llmPrompts.length, 0);
  });
});

test("hold: unknown or unattributed speakers never merge", { concurrency: false }, async () => {
  await withPipeline({ agent: { replyTrigger: "jev" }, respond: () => WAIT }, async (ctx) => {
    ctx.say(null, "来月の広告予算なんだけど、");
    await waitFor(() => ctx.hold() !== null, "unknown hold");
    assert.equal(ctx.hold().speakerId, null);
    ctx.say(null, "まとめてくれる？");
    assert.equal(ctx.hold(), null);
    await waitFor(() => ctx.fetchCalls.length === 2, "second judgement");
    assert.equal(ctx.fetchCalls[1].body.state.latest_line, "unknown: まとめてくれる？", "judged alone, not merged");
    assert.deepEqual(ctx.fetchCalls[1].body.state.recent_lines, ["unknown: 来月の広告予算なんだけど、"]);
    await waitFor(() => ctx.judgeLines().length === 2, "second decision");
    assert.match(ctx.judgeLines()[1], /stage=first/);
  });
});

test("hold: an interim from another attributed speaker cancels immediately", { concurrency: false }, async () => {
  await withPipeline({ agent: { replyTrigger: "jev" }, speakers: ["s1", "s2"], respond: () => WAIT }, async (ctx) => {
    ctx.say("s1", "来月の広告予算なんだけど、");
    await waitFor(() => ctx.hold() !== null, "hold");
    ctx.interim("s1", "えっと");
    assert.notEqual(ctx.hold(), null, "same-speaker interim keeps the hold");
    ctx.interim("s2", "それって");
    assert.equal(ctx.hold(), null);
    assert.ok(ctx.logs.includes("🧭 [turn-judge] hold cleared reason=other_speaker_interim"));
    assert.equal(ctx.timers.live().length, 0);
  });
});

test("hold deadline: speaks the held text only when nobody is speaking and Caty is idle", { concurrency: false }, async () => {
  await withPipeline({ agent: { replyTrigger: "jev" }, clock: true, speakers: ["s1"], respond: () => WAIT }, async (ctx) => {
    ctx.say("s1", "来月の広告予算をまとめて");
    await waitFor(() => ctx.hold() !== null, "hold");
    ctx.advance(3_500);
    assert.equal(ctx.timers.fire(), 1);
    await waitFor(() => ctx.llmPrompts.length === 1, "deadline speak");
    assert.match(ctx.judgeLines()[1], /^🧭 \[turn-judge\] decision=speak addressed=0\.90 finished=0\.20 ms=0 reason=deadline_idle stage=deadline "/);
    assert.equal(ctx.llmPrompts[0].split("来月の広告予算をまとめて").length - 1, 1, "held entry excluded from the prompt context");
    assert.equal(ctx.hold(), null);
    const judged = ctx.metrics.filter((event) => event.type === "turn_judge");
    assert.deepEqual(judged.map((event) => event.stage), ["first", "deadline"]);
    assert.equal(judged[0].turn_id, judged[1].turn_id);
  });
  await withPipeline({ agent: { replyTrigger: "jev" }, clock: true, speakers: ["s1"], respond: () => WAIT }, async (ctx) => {
    ctx.say("s1", "来月の広告予算をまとめて");
    await waitFor(() => ctx.hold() !== null, "hold");
    ctx.advance(3_500);
    ctx.turnState.isAgentSpeaking = true;
    ctx.timers.fire();
    await waitFor(() => ctx.judgeLines().length === 2, "busy deadline");
    assert.match(ctx.judgeLines()[1], /decision=ignore .*reason=busy stage=deadline/);
    assert.equal(ctx.hold(), null);
    assert.equal(ctx.llmPrompts.length, 0);
  });
});

test("hold deadline: same-speaker live speech extends to the cap, then ignores", { concurrency: false }, async () => {
  await withPipeline({ agent: { replyTrigger: "jev" }, clock: true, speakers: ["s1"], respond: () => WAIT }, async (ctx) => {
    ctx.say("s1", "来月の広告予算なんだけど、");
    await waitFor(() => ctx.hold() !== null, "hold");
    const hold = ctx.hold();
    ctx.advance(2_900);
    ctx.interim("s1", "えっとですね");
    ctx.advance(100);
    ctx.timers.fire();
    await drain();
    assert.equal(ctx.hold()?.extended, true, "continuation in flight keeps the hold");
    assert.equal(ctx.judgeLines().length, 1, "no decision while extended");
    const extension = ctx.timers.live();
    assert.equal(extension.length, 1);
    assert.equal(extension[0].ms, hold.cap - (hold.deadline), "extension ends at the hard cap");
    ctx.advance(3_000);
    ctx.timers.fire();
    await waitFor(() => ctx.judgeLines().length === 2, "cap decision");
    assert.match(ctx.judgeLines()[1], /decision=ignore .*reason=cap stage=deadline/);
    assert.equal(ctx.hold(), null);
    assert.equal(ctx.llmPrompts.length, 0);
  });
});

test("hold deadline: other (unknown) live speech means ignore", { concurrency: false }, async () => {
  await withPipeline({ agent: { replyTrigger: "jev" }, clock: true, speakers: ["s1"], respond: () => WAIT }, async (ctx) => {
    ctx.say("s1", "来月の広告予算なんだけど、");
    await waitFor(() => ctx.hold() !== null, "hold");
    ctx.advance(2_900);
    ctx.interim(null, "そうそう");
    assert.notEqual(ctx.hold(), null, "an unattributed interim does not cancel by itself");
    ctx.advance(100);
    ctx.timers.fire();
    await waitFor(() => ctx.judgeLines().length === 2, "deadline decision");
    assert.match(ctx.judgeLines()[1], /decision=ignore .*reason=other_speech stage=deadline/);
    assert.equal(ctx.hold(), null);
    assert.equal(ctx.llmPrompts.length, 0);
  });
});

test("Grok N2: a deadline job queued before another speaker's utterance_end does not speak", { concurrency: false }, async () => {
  await withPipeline({
    agent: { replyTrigger: "jev" },
    clock: true,
    speakers: ["s1", "s2"],
    respond: (body) => (body.state.latest_line.includes("予算") ? WAIT : IGNORE),
  }, async (ctx) => {
    ctx.say("s1", "来月の広告予算をまとめて");
    await waitFor(() => ctx.hold() !== null, "hold");
    ctx.advance(3_500);
    assert.equal(ctx.timers.fire(), 1, "deadline job appended to the chain");
    ctx.say("s2", "資料もう見ました？");
    await drain();
    await waitFor(() => ctx.judgeLines().length === 2, "second speaker judged");
    await drain();
    assert.equal(ctx.llmPrompts.length, 0, "the stale deadline job never speaks");
    assert.equal(ctx.judgeLines().some((line) => line.includes("decision=speak")), false);
    assert.equal(ctx.hold(), null);
  });
});

test("P1: a line that arrived during a predecessor's buffer sleep is not judged after the predecessor replies", { concurrency: false }, async () => {
  await withPipeline({
    agent: { replyTrigger: "jev" },
    env: { POST_UTTERANCE_BUFFER_MS: "40" },
    speakers: ["s1", "s2"],
    scores: { "": SPEAK },
  }, async (ctx) => {
    ctx.say("s1", "ケイティ、今日の議題をまとめて");
    ctx.say("s2", "資料もう見ました？");
    await waitFor(() => ctx.logs.some((line) => line.startsWith("🔇  [会議音声・未指名] [佐藤]")), "second line handled");
    await drain();
    assert.equal(ctx.fetchCalls.length, 0, "never judged");
    assert.equal(ctx.llmPrompts.length, 1, "only the wake line is answered");
    assert.deepEqual(ctx.judgeLines(), []);
  });
});

test("P1: a line that arrives while Caty is busy is never judged", { concurrency: false }, async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await withPipeline({
    agent: { replyTrigger: "jev" },
    speakers: ["s1", "s2"],
    scores: { "": SPEAK },
    streamChat: async function* () { await gate; yield "まとめました。"; },
  }, async (ctx) => {
    ctx.say("s1", "ケイティ、今日の議題をまとめて");
    await waitFor(() => ctx.llmPrompts.length === 1, "reply started");
    ctx.say("s2", "資料もう見ました？");
    release();
    await waitFor(() => ctx.logs.some((line) => line.startsWith("🔇  [会議音声・未指名] [佐藤]")), "busy line handled");
    await drain();
    assert.equal(ctx.fetchCalls.length, 0);
    assert.equal(ctx.llmPrompts.length, 1);
  });
});

test("P5: a jev speak never aborts a running reply", { concurrency: false }, async () => {
  let resolveJudge;
  const cancelled = [];
  await withPipeline({
    agent: { replyTrigger: "jev" },
    speakers: ["s1"],
    respond: () => new Promise((resolve) => { resolveJudge = resolve; }),
    streamChat: async function* (_messages, { signal } = {}) {
      if (signal && !signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    },
  }, async (ctx) => {
    ctx.pipeline.on("playback_cancelled", (event) => cancelled.push(event));
    ctx.say("s1", "これ確認してもらえる？");
    await waitFor(() => ctx.fetchCalls.length === 1, "judge in flight");
    const running = ctx.pipeline._test.processUserInput("別件の返答をお願い");
    await waitFor(() => ctx.pipeline._test.getCurrentAbortController() !== null, "reply running");
    const controller = ctx.pipeline._test.getCurrentAbortController();
    resolveJudge(SPEAK);
    await waitFor(() => ctx.judgeLines().length === 1, "decision landed");
    assert.match(ctx.judgeLines()[0], /decision=ignore addressed=0\.90 finished=0\.90 .*reason=busy stage=first/);
    assert.equal(controller.signal.aborted, false, "the running reply is not aborted");
    assert.deepEqual(cancelled, []);
    assert.equal(ctx.logs.some((line) => line.includes("User interrupted")), false);
    assert.equal(ctx.llmPrompts.length, 1);
    ctx.pipeline._test.abortCurrent();
    await running;
  });
});

test("P5: an exit line drops the hold, is never judged and no jev speak overlaps the farewell", { concurrency: false }, async () => {
  const exits = [];
  await withPipeline({ agent: { replyTrigger: "jev" }, clock: true, exitDetection: true, speakers: ["s1"], respond: () => WAIT }, async (ctx) => {
    ctx.pipeline.on("exit_requested", (event) => exits.push(event));
    ctx.say("s1", "来月の広告予算なんだけど、");
    await waitFor(() => ctx.hold() !== null, "hold");
    const holdTimer = ctx.timers.live()[0];
    ctx.say("s1", "退出して");
    assert.equal(ctx.hold(), null);
    assert.equal(holdTimer.cleared, true);
    await waitFor(() => ctx.logs.some((line) => line.startsWith("🚪  ")), "farewell");
    ctx.advance(10_000);
    ctx.timers.fire();
    await waitFor(() => exits.length === 1, "exit");
    await drain();
    assert.equal(ctx.fetchCalls.length, 1, "the exit line is never judged");
    assert.equal(ctx.llmPrompts.length, 0);
    assert.equal(ctx.judgeLines().some((line) => line.includes("decision=speak")), false);
  });
});

test("mid-meeting switch jev -> wake drops the hold at the deadline or at the next utterance", { concurrency: false }, async () => {
  await withPipeline({ agent: { replyTrigger: "jev" }, clock: true, speakers: ["s1"], respond: () => WAIT }, async (ctx) => {
    ctx.say("s1", "来月の広告予算をまとめて");
    await waitFor(() => ctx.hold() !== null, "hold");
    ctx.setTrigger("wake");
    ctx.advance(3_500);
    ctx.timers.fire();
    await waitFor(() => ctx.judgeLines().length === 2, "deadline decision");
    assert.match(ctx.judgeLines()[1], /decision=ignore .*reason=mode_switch stage=deadline/);
    assert.equal(ctx.hold(), null);
    assert.equal(ctx.llmPrompts.length, 0);
  });
  await withPipeline({ agent: { replyTrigger: "jev" }, speakers: ["s1"], respond: () => WAIT }, async (ctx) => {
    ctx.say("s1", "来月の広告予算なんだけど、");
    await waitFor(() => ctx.hold() !== null, "hold");
    ctx.setTrigger("wake");
    ctx.say("s1", "まとめてくれる？");
    await waitFor(() => ctx.logs.includes("🧭 [turn-judge] hold cleared reason=mode_switch"), "mode switch clears");
    await drain();
    assert.equal(ctx.hold(), null);
    assert.equal(ctx.fetchCalls.length, 1, "wake mode never calls jev again");
    assert.equal(ctx.llmPrompts.length, 0);
  });
});

test("no key, Bearer or Authorization in judge log lines or metrics", { concurrency: false }, async () => {
  const replies = [WAIT, SPEAK, { ok: false, status: 401 }];
  await withPipeline({ agent: { replyTrigger: "jev" }, clock: true, speakers: ["s1", "s2"], respond: () => replies.shift() || IGNORE }, async (ctx) => {
    ctx.say("s1", "来月の広告予算なんだけど、");
    await waitFor(() => ctx.hold() !== null, "hold");
    ctx.say("s1", "まとめてくれる？");
    await waitFor(() => ctx.llmPrompts.length === 1, "merged speak");
    ctx.say("s2", "これ確認してもらえる？");
    await waitFor(() => ctx.judgeLines().length === 3, "failure judgement");
    assert.ok(ctx.fetchCalls.every((call) => call.init.headers.Authorization === `Bearer ${SYNTHETIC_KEY}`), "the key is only in the request header");
    const surfaces = JSON.stringify({ logs: ctx.logs, warns: ctx.warns, metrics: ctx.metrics });
    assert.equal(surfaces.includes(SYNTHETIC_KEY), false);
    assert.equal(/Bearer|Authorization/i.test(surfaces), false);
    assert.equal(ctx.metrics.filter((event) => event.type === "turn_judge").length, 3);
  });
});

function deferredJudge() {
  const pending = [];
  return {
    pending,
    respond: () => new Promise((resolve) => pending.push(resolve)),
    resolveNext: (value) => pending.shift()(value),
  };
}

test("A2: speech that starts after the line ended blocks a speak commit (new_speech), attributed or not", { concurrency: false }, async () => {
  for (const who of [null, "s2"]) {
    const judge = deferredJudge();
    await withPipeline({ agent: { replyTrigger: "jev" }, speakers: ["s1", "s2"], respond: judge.respond }, async (ctx) => {
      ctx.say("s1", "これ確認してもらえる？");
      await waitFor(() => judge.pending.length === 1, "judge in flight");
      ctx.interim(who, "あ、それなんですけど");
      judge.resolveNext(SPEAK);
      await waitFor(() => ctx.judgeLines().length === 1, "decision");
      await drain();
      assert.match(ctx.judgeLines()[0], /decision=ignore addressed=0\.90 finished=0\.90 .*reason=new_speech stage=first/, String(who));
      assert.equal(ctx.llmPrompts.length, 0, "Caty does not talk over the new speaker");
    });
  }
  const judge = deferredJudge();
  await withPipeline({ agent: { replyTrigger: "jev" }, speakers: ["s1"], respond: judge.respond }, async (ctx) => {
    ctx.say("s1", "来月の広告予算なんだけど、");
    await waitFor(() => judge.pending.length === 1, "first judge");
    judge.resolveNext(WAIT);
    await waitFor(() => ctx.hold() !== null, "hold");
    ctx.say("s1", "まとめてくれる？");
    await waitFor(() => judge.pending.length === 1, "merged judge");
    ctx.interim(null, "えっと");
    judge.resolveNext(SPEAK);
    await waitFor(() => ctx.judgeLines().length === 2, "merged decision");
    await drain();
    assert.match(ctx.judgeLines()[1], /decision=ignore .*reason=new_speech stage=merged/);
    assert.equal(ctx.hold(), null);
    assert.equal(ctx.llmPrompts.length, 0);
  });
});

test("A2: the line's own interims and its utterance_end refresh never block its speak (unattributed audio)", { concurrency: false }, async () => {
  const judge = deferredJudge();
  await withPipeline({ agent: { replyTrigger: "jev" }, respond: judge.respond }, async (ctx) => {
    ctx.interim(null, "これ確認");
    ctx.interim(null, "これ確認してもらえる");
    ctx.say(null, "これ確認してもらえる？");
    await waitFor(() => judge.pending.length === 1, "judge in flight");
    judge.resolveNext(SPEAK);
    await waitFor(() => ctx.llmPrompts.length === 1, "speak");
    assert.match(ctx.judgeLines()[0], /decision=speak .*reason=scores stage=first/);
  });
});

test("A3: a superseded held line never reappears in later judge context", { concurrency: false }, async () => {
  await withPipeline({
    agent: { replyTrigger: "jev" },
    speakers: ["s1", "s2"],
    respond: (body) => (body.state.latest_line.includes("まとめてくれる") ? SPEAK
      : body.state.latest_line.includes("予算") ? WAIT : IGNORE),
  }, async (ctx) => {
    ctx.say("s1", "来月の広告予算なんだけど、");
    await waitFor(() => ctx.hold() !== null, "hold");
    ctx.say("s1", "まとめてくれる？");
    await waitFor(() => ctx.llmPrompts.length === 1 && ctx.pipeline._test.getGateState() === "OPEN", "merged speak done");
    ctx.say("s2", "資料もう見ました？");
    await waitFor(() => ctx.fetchCalls.length === 3, "next judgement");
    const recent = ctx.fetchCalls[2].body.state.recent_lines;
    assert.equal(recent.filter((line) => line.includes("来月の広告予算なんだけど、")).length, 1, JSON.stringify(recent));
    assert.ok(recent.includes("参加者A: 来月の広告予算なんだけど、 まとめてくれる？"));
  });
});

test("A4 / P7: with meeting-context injection on, a held line is not sent to the LLM twice", { concurrency: false }, async () => {
  await withPipeline({
    agent: { replyTrigger: "jev" },
    env: { ENABLE_MEETING_CONTEXT_INJECTION: "true" },
    speakers: ["s1", "s2"],
    respond: (body) => (body.state.latest_line.includes("まとめてくれる") ? SPEAK
      : body.state.latest_line.includes("予算") ? WAIT : IGNORE),
  }, async (ctx) => {
    ctx.say("s2", "資料もう見ました？");
    await waitFor(() => ctx.judgeLines().length === 1, "context line");
    ctx.say("s1", "来月の広告予算なんだけど、");
    await waitFor(() => ctx.hold() !== null, "hold");
    ctx.say("s1", "まとめてくれる？");
    await waitFor(() => ctx.llmPrompts.length === 1, "merged speak");
    const prompt = ctx.llmPrompts[0];
    assert.match(prompt, /【直近の会議の流れ】/, "injection is on, so unaddressed lines do reach the prompt");
    assert.match(prompt, /資料もう見ました？/);
    assert.equal(prompt.split("来月の広告予算なんだけど、").length - 1, 1, prompt);
  });
});

test("A5: with exit detection off, an exit-like line neither drops the hold nor skips judging", { concurrency: false }, async () => {
  await withPipeline({ agent: { replyTrigger: "jev" }, speakers: ["s1"], respond: () => IGNORE }, async (ctx) => {
    ctx.say("s1", "退出して");
    await waitFor(() => ctx.judgeLines().length === 1, "exit-like line judged");
    assert.equal(ctx.fetchCalls.length, 1);
    assert.equal(ctx.logs.some((line) => line.startsWith("🚪  ")), false);
  });
  await withPipeline({ agent: { replyTrigger: "jev" }, speakers: ["s1"], respond: () => WAIT }, async (ctx) => {
    ctx.say("s1", "来月の広告予算なんだけど、");
    await waitFor(() => ctx.hold() !== null, "hold");
    ctx.say("s1", "退出して");
    assert.equal(ctx.hold()?.continuationArrived, true, "treated as a continuation, not an exit");
    await waitFor(() => ctx.judgeLines().length === 2, "merged judgement");
    assert.equal(ctx.fetchCalls[1].body.state.latest_line, "参加者A: 来月の広告予算なんだけど、 退出して");
  });
});

test("A7: after the held speaker's slot is evicted, unattributed audio never merges and nothing is spoken over it", { concurrency: false }, async () => {
  await withPipeline({
    agent: { replyTrigger: "jev" },
    clock: true,
    speakers: ["s1"],
    respond: (body) => (body.state.latest_line.includes("予算") ? WAIT : IGNORE),
  }, async (ctx) => {
    ctx.say("s1", "来月の広告予算なんだけど、");
    await waitFor(() => ctx.hold() !== null, "hold");
    assert.equal(ctx.pipeline._test.getSttMuxState().slots.includes("s1"), false, "the held speaker's slot was evicted");
    ctx.interim(null, "まとめて");
    assert.notEqual(ctx.hold(), null);
    ctx.say(null, "まとめてくれる？");
    assert.equal(ctx.hold(), null, "unknown audio cancels instead of merging");
    await waitFor(() => ctx.judgeLines().length === 2, "judged alone");
    assert.equal(ctx.fetchCalls[1].body.state.latest_line, "unknown: まとめてくれる？");
    ctx.advance(10_000);
    assert.equal(ctx.timers.fire(), 0);
    await drain();
    assert.equal(ctx.llmPrompts.length, 0);
  });
});
