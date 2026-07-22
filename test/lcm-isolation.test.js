// test/lcm-isolation.test.js — Test LCM Map isolation (agentId:meetingId key pattern)
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("LCM session isolation (Map<agentId:meetingId, boolean>)", () => {
  // Simulate the _lcmIngestedSessions Map from meet-routes.js
  /** @type {Map<string, boolean>} */
  let lcmMap;

  function buildKey(agentId, meetingId) {
    return `${agentId}:${meetingId}`;
  }

  it("different agents with same meetingId are isolated", () => {
    lcmMap = new Map();
    const meetingId = "session-abc123";

    const keyCaty = buildKey("caty", meetingId);
    const keyAlec = buildKey("alec", meetingId);

    lcmMap.set(keyCaty, true);

    assert.equal(lcmMap.has(keyCaty), true, "caty should be ingested");
    assert.equal(lcmMap.has(keyAlec), false, "alec should NOT be ingested yet");

    lcmMap.set(keyAlec, true);
    assert.equal(lcmMap.has(keyCaty), true, "caty still ingested");
    assert.equal(lcmMap.has(keyAlec), true, "alec now ingested");
    assert.equal(lcmMap.size, 2, "two separate entries");
  });

  it("same agent with different meetingIds are isolated", () => {
    lcmMap = new Map();
    const agent = "zoe";

    const key1 = buildKey(agent, "meeting-001");
    const key2 = buildKey(agent, "meeting-002");

    lcmMap.set(key1, true);
    assert.equal(lcmMap.has(key1), true);
    assert.equal(lcmMap.has(key2), false);
  });

  it("no cross-contamination between agents", () => {
    lcmMap = new Map();
    const agents = ["caty", "alec", "zoe", "eidra", "mira", "theo"];
    const meetingId = "session-xyz";

    // Only caty and eidra ingested
    lcmMap.set(buildKey("caty", meetingId), true);
    lcmMap.set(buildKey("eidra", meetingId), true);

    for (const agent of agents) {
      const key = buildKey(agent, meetingId);
      if (agent === "caty" || agent === "eidra") {
        assert.equal(lcmMap.has(key), true, `${agent} should be ingested`);
      } else {
        assert.equal(lcmMap.has(key), false, `${agent} should NOT be ingested`);
      }
    }
  });

  it("idempotent: setting same key twice doesn't create duplicate", () => {
    lcmMap = new Map();
    const key = buildKey("caty", "session-dup");

    lcmMap.set(key, true);
    lcmMap.set(key, true);
    assert.equal(lcmMap.size, 1, "no duplicate entries");
  });

  it("key format is agentId:meetingId", () => {
    const key = buildKey("alec", "meeting-123");
    assert.equal(key, "alec:meeting-123");
  });
});