// test/exit-immediate.test.js — Test detectExitIntent from exit-handler.js
const { detectExitIntent, getExitCommands } = require("../src/exit-handler");
const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

describe("Exit immediate detection", () => {
  describe("getExitCommands()", () => {
    it("returns default commands when no agent profile", () => {
      const cmds = getExitCommands();
      assert(Array.isArray(cmds));
      assert(cmds.length > 0);
      assert(cmds.includes("退出して"));
      assert(cmds.includes("退室して"));
    });

    it("returns agent-specific commands when provided", () => {
      const agentProfile = { exitCommands: ["テスト退出", "終了"] };
      const cmds = getExitCommands(agentProfile);
      assert.deepEqual(cmds, ["テスト退出", "終了"]);
    });

    it("returns defaults when agent profile has empty exitCommands", () => {
      const agentProfile = { exitCommands: [] };
      const cmds = getExitCommands(agentProfile);
      // Should fall back to defaults
      assert(Array.isArray(cmds));
      assert(cmds.length > 0);
    });
  });

  describe("detectExitIntent()", () => {
    const agentProfile = null;

    it("detects exact match '退出して'", () => {
      assert.equal(detectExitIntent("退出して", null, null, null, agentProfile), true);
    });

    it("detects exact match '退室して'", () => {
      assert.equal(detectExitIntent("退室して", null, null, null, agentProfile), true);
    });

    it("detects '退出していいよ'", () => {
      assert.equal(detectExitIntent("退出していいよ", null, null, null, agentProfile), true);
    });

    it("detects '退室していいよ'", () => {
      assert.equal(detectExitIntent("退室していいよ", null, null, null, agentProfile), true);
    });

    it("detects with extra text 'それでは退出していいよ'", () => {
      assert.equal(detectExitIntent("それでは退出していいよ", null, null, null, agentProfile), true);
    });

    it("detects with extra text 'もう退室して大丈夫'", () => {
      assert.equal(detectExitIntent("もう退室して大丈夫", null, null, null, agentProfile), true);
    });

    it("detects '退出口' (includes 退出)", () => {
      // '退出口' contains '退出' — current includes() behavior matches
      assert.equal(detectExitIntent("退出口", null, null, null, agentProfile), true);
    });

    it("detects '退室する予定' (includes 退室)", () => {
      // '退室する予定' contains '退室' — current includes() behavior matches
      assert.equal(detectExitIntent("退室する予定", null, null, null, agentProfile), true);
    });

    it("does NOT detect 'こんにちは' (non-exit)", () => {
      assert.equal(detectExitIntent("こんにちは", null, null, null, agentProfile), false);
    });

    it("does NOT detect '今日の天気' (non-exit)", () => {
      assert.equal(detectExitIntent("今日の天気", null, null, null, agentProfile), false);
    });

    it("detects with agent-specific exit command", () => {
      const customAgentProfile = { exitCommands: ["バイバイ", "さようなら"] };
      assert.equal(detectExitIntent("バイバイ", null, null, null, customAgentProfile), true);
      assert.equal(detectExitIntent("さようなら", null, null, null, customAgentProfile), true);
      assert.equal(detectExitIntent("退出して", null, null, null, customAgentProfile), false); // default not included
    });

    it("does NOT detect pure katakana 'タイシュツシテ' (different script)", () => {
      // Kanji exit commands are not matched by katakana — different character sets
      assert.equal(detectExitIntent("タイシュツシテ", null, null, null, agentProfile), false);
    });

    it("normalizes long vowel marks in custom commands", () => {
      // If a custom exit command uses katakana with long vowels, normalizeKana strips them
      const customProfile = { exitCommands: ["バーイバーイ"] };
      assert.equal(detectExitIntent("バイバイ", null, null, null, customProfile), true);
    });
  });
});