"use strict";

// #267 src/turn-judge.js unit tests. fetch is always injected; nothing here
// reaches the network.

const test = require("node:test");
const assert = require("node:assert/strict");
const { ENDPOINT, MODEL, buildQuestions, buildJudgeState, judgeTurn } = require("../src/turn-judge");

const SYNTHETIC_KEY = ["synthetic", "turn", "judge", "value"].join("-");
const THRESHOLDS = { addressedMin: 0.75, finishedMin: 0.75 };
const STATE = { assistant_name: "Caty (ケイティ)", recent_lines: [], latest_line: "参加者A: これ見てもらえる？" };

function withKey(value, fn) {
  const previous = process.env.TYPESAFE_API_KEY;
  if (value === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = value;
  return Promise.resolve().then(fn).finally(() => {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  });
}

function answering(addressed, finished, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ answers: { addressed: { noul: addressed }, finished: { noul: finished } } }) };
  };
}

function trackUnhandled() {
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  return { seen, stop: () => process.removeListener("unhandledRejection", onUnhandled) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("decisions follow both thresholds: speak, wait, ignore", async () => {
  await withKey(SYNTHETIC_KEY, async () => {
    const cases = [
      [0.9, 0.9, "speak"],
      [0.75, 0.75, "speak"],
      [0.9, 0.2, "wait"],
      [0.74, 0.99, "ignore"],
      [0.2, 0.2, "ignore"],
    ];
    for (const [addressed, finished, expected] of cases) {
      const result = await judgeTurn({ state: STATE, ...THRESHOLDS, fetch: answering(addressed, finished) });
      assert.equal(result.decision, expected, `${addressed}/${finished}`);
      assert.equal(result.reason, "scores");
      assert.equal(result.addressed, addressed);
      assert.equal(result.finished, finished);
      assert.equal(Number.isInteger(result.latencyMs) && result.latencyMs >= 0, true);
    }
    const tight = await judgeTurn({ state: STATE, addressedMin: 0.95, finishedMin: 0.5, fetch: answering(0.9, 0.9) });
    assert.equal(tight.decision, "ignore", "thresholds come from the caller");
  });
});

test("the request is one systemone call with jev-latest, the given state and two noul questions", async () => {
  await withKey(SYNTHETIC_KEY, async () => {
    const calls = [];
    const questions = buildQuestions("Caty");
    await judgeTurn({ state: STATE, questions, ...THRESHOLDS, fetch: answering(0.9, 0.9, calls) });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, ENDPOINT);
    assert.equal(ENDPOINT, "https://api.typesafe.ai/v1/systemone");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.signal instanceof AbortSignal, true);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, MODEL);
    assert.equal(MODEL, "jev-latest");
    assert.deepEqual(body.state, STATE);
    assert.deepEqual(Object.keys(body.questions).sort(), ["addressed", "finished"]);
    assert.equal(body.questions.addressed.type, "noul");
    assert.equal(body.questions.finished.type, "noul");
    assert.match(body.questions.addressed.instructions, /spoken to Caty/);
    assert.equal(calls[0].init.body.includes(SYNTHETIC_KEY), false, "the key travels only in the header");
  });
});

test("the key is read lazily per call; without it the judge is silent and makes no request", async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; return { ok: true, json: async () => ({}) }; };
  await withKey(undefined, async () => {
    const result = await judgeTurn({ state: STATE, ...THRESHOLDS, fetch });
    assert.deepEqual({ decision: result.decision, reason: result.reason }, { decision: "ignore", reason: "no_key" });
  });
  await withKey("", async () => {
    assert.equal((await judgeTurn({ state: STATE, ...THRESHOLDS, fetch })).reason, "no_key");
  });
  assert.equal(calls, 0);
  await withKey(SYNTHETIC_KEY, async () => {
    assert.equal((await judgeTurn({ state: STATE, ...THRESHOLDS, fetch: answering(0.9, 0.9) })).decision, "speak");
  });
});

test("every failure resolves to ignore with a reason and never rejects", async () => {
  const unhandled = trackUnhandled();
  try {
    await withKey(SYNTHETIC_KEY, async () => {
      const failures = [
        [async () => ({ ok: false, status: 500, json: async () => ({}) }), "http_500"],
        [async () => ({ ok: false, json: async () => ({}) }), "http_error"],
        [async () => null, "http_error"],
        [async () => { throw new Error("network down"); }, "error"],
        [() => { throw new Error("sync throw"); }, "error"],
        [async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }), "error"],
        [async () => ({ ok: true, json: async () => ({}) }), "invalid_answer"],
        [async () => ({ ok: true, json: async () => ({ answers: { addressed: { noul: 0.9 } } }) }), "invalid_answer"],
        [async () => ({ ok: true, json: async () => ({ answers: { addressed: { noul: "0.9" }, finished: { noul: 0.9 } } }) }), "invalid_answer"],
        [async () => ({ ok: true, json: async () => ({ answers: { addressed: { noul: Number.NaN }, finished: { noul: 0.9 } } }) }), "invalid_answer"],
        [async () => ({ ok: true, json: async () => ({ answers: { addressed: { noul: Infinity }, finished: { noul: 0.9 } } }) }), "invalid_answer"],
        ["not a function", "no_fetch"],
      ];
      for (const [fetch, reason] of failures) {
        const result = await judgeTurn({ state: STATE, ...THRESHOLDS, fetch });
        assert.equal(result.decision, "ignore", reason);
        assert.equal(result.reason, reason);
        assert.equal(result.addressed, null);
        assert.equal(result.finished, null);
      }
      const noThreshold = await judgeTurn({ state: STATE, addressedMin: undefined, finishedMin: 0.75, fetch: answering(0.9, 0.9) });
      assert.equal(noThreshold.reason, "invalid_threshold");
      assert.equal((await judgeTurn()).decision, "ignore", "no options at all");
    });
    await settle();
    assert.deepEqual(unhandled.seen, []);
  } finally {
    unhandled.stop();
  }
});

test("timeout aborts the request and a late rejection is swallowed", async () => {
  const unhandled = trackUnhandled();
  try {
    await withKey(SYNTHETIC_KEY, async () => {
      let seenSignal = null;
      const fetch = (_url, init) => {
        seenSignal = init.signal;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => setTimeout(() => reject(new Error("AbortError")), 5), { once: true });
        });
      };
      const result = await judgeTurn({ state: STATE, ...THRESHOLDS, timeoutMs: 20, fetch });
      assert.deepEqual({ decision: result.decision, reason: result.reason }, { decision: "ignore", reason: "timeout" });
      assert.equal(seenSignal.aborted, true);
      assert.ok(result.latencyMs >= 15, `latency ${result.latencyMs}`);
      const slowJson = await judgeTurn({
        state: STATE, ...THRESHOLDS, timeoutMs: 20,
        fetch: async () => ({ ok: true, json: () => new Promise(() => {}) }),
      });
      assert.equal(slowJson.reason, "timeout");
    });
    await settle();
    assert.deepEqual(unhandled.seen, []);
  } finally {
    unhandled.stop();
  }
});

test("an abort signal cancels before or during the request", async () => {
  const unhandled = trackUnhandled();
  try {
    await withKey(SYNTHETIC_KEY, async () => {
      let calls = 0;
      const pre = new AbortController();
      pre.abort();
      const early = await judgeTurn({ state: STATE, ...THRESHOLDS, signal: pre.signal, fetch: async () => { calls += 1; } });
      assert.equal(early.reason, "aborted");
      assert.equal(calls, 0);

      const controller = new AbortController();
      let requestSignal = null;
      const pending = judgeTurn({
        state: STATE, ...THRESHOLDS, timeoutMs: 5000, signal: controller.signal,
        fetch: (_url, init) => {
          requestSignal = init.signal;
          return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("AbortError")), { once: true }));
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
      const result = await pending;
      assert.deepEqual({ decision: result.decision, reason: result.reason }, { decision: "ignore", reason: "aborted" });
      assert.equal(requestSignal.aborted, true);
    });
    await settle();
    assert.deepEqual(unhandled.seen, []);
  } finally {
    unhandled.stop();
  }
});

test("no key material appears in any result", async () => {
  await withKey(SYNTHETIC_KEY, async () => {
    const results = [
      await judgeTurn({ state: STATE, ...THRESHOLDS, fetch: answering(0.9, 0.9) }),
      await judgeTurn({ state: STATE, ...THRESHOLDS, fetch: async () => ({ ok: false, status: 401 }) }),
      await judgeTurn({ state: STATE, ...THRESHOLDS, fetch: async () => { throw new Error(`Bearer ${SYNTHETIC_KEY}`); } }),
    ];
    const text = JSON.stringify(results);
    assert.equal(text.includes(SYNTHETIC_KEY), false);
    assert.equal(/Bearer|Authorization/i.test(text), false);
  });
});

test("the state uses stable pseudonyms, labels unattributed lines unknown and never sends display names", () => {
  const state = buildJudgeState({
    assistantName: "Caty (ケイティ)",
    assistantLabel: "Caty",
    lines: [
      { speakerKey: "user-9", text: "次の議題に行きましょう" },
      { assistant: true, text: "火曜の午後が空いています" },
      { speakerKey: null, text: "えっと" },
      { speakerKey: "unknown", text: "はい" },
      { speakerKey: "user-3", text: "了解です" },
      { speakerKey: "user-9", text: " " },
    ],
    latest: { speakerKey: "user-9", text: "じゃあそれで予約しておいて" },
  });
  assert.deepEqual(state, {
    assistant_name: "Caty (ケイティ)",
    recent_lines: [
      "参加者A: 次の議題に行きましょう",
      "Caty: 火曜の午後が空いています",
      "unknown: えっと",
      "unknown: はい",
      "参加者B: 了解です",
    ],
    latest_line: "参加者A: じゃあそれで予約しておいて",
  });
  const unlabelled = buildJudgeState({ assistantName: "Caty", lines: [], latest: { speakerKey: null, text: "よろしく" } });
  assert.equal(unlabelled.latest_line, "unknown: よろしく");
  assert.deepEqual(unlabelled.recent_lines, []);
});
