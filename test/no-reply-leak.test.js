// test/no-reply-leak.test.js — Test shouldSuppressReply and sanitizeReply from speech-policy.js
const { shouldSuppressReply, sanitizeReply } = require("../src/speech-policy");
const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

describe("NO_REPLY leak guard", () => {
  describe("shouldSuppressReply()", () => {
    it("returns true for exact 'NO_REPLY'", () => {
      assert.equal(shouldSuppressReply("NO_REPLY"), true);
    });

    it("returns true for 'no_reply' (underscore)", () => {
      assert.equal(shouldSuppressReply("no_reply"), true);
    });

    it("returns true for 'No Reply' (space)", () => {
      assert.equal(shouldSuppressReply("No Reply"), true);
    });

    it("returns true for 'NO_REPLY。' (with punctuation)", () => {
      assert.equal(shouldSuppressReply("NO_REPLY。"), true);
    });

    it("returns true for '\\nNO_REPLY\\n' (newlines)", () => {
      assert.equal(shouldSuppressReply("\nNO_REPLY\n"), true);
    });

    it("returns true for null", () => {
      assert.equal(shouldSuppressReply(null), true);
    });

    it("returns true for undefined", () => {
      assert.equal(shouldSuppressReply(undefined), true);
    });

    it("returns true for empty string", () => {
      assert.equal(shouldSuppressReply(""), true);
    });

    it("returns true for whitespace only", () => {
      assert.equal(shouldSuppressReply("   \n  \t  "), true);
    });

    it("returns false for 'NO_REPLY but with extra text' (partial match)", () => {
      assert.equal(shouldSuppressReply("NO_REPLY but with extra text"), false);
    });

    it("returns false for 'reply NO' (reverse)", () => {
      assert.equal(shouldSuppressReply("reply NO"), false);
    });

    it("returns false for normal text", () => {
      assert.equal(shouldSuppressReply("こんにちは、Catyです。"), false);
    });

    it("returns false for 'NO-REPLY' (hyphen)", () => {
      // Hyphen is not in the regex, should not match
      assert.equal(shouldSuppressReply("NO-REPLY"), false);
    });
  });

  describe("sanitizeReply()", () => {
    it("returns null for 'NO_REPLY'", () => {
      assert.equal(sanitizeReply("NO_REPLY"), null);
    });

    it("returns null for empty string", () => {
      assert.equal(sanitizeReply(""), null);
    });

    it("returns null for null", () => {
      assert.equal(sanitizeReply(null), null);
    });

    it("returns null for undefined", () => {
      assert.equal(sanitizeReply(undefined), null);
    });

    it("returns trimmed string for normal text", () => {
      assert.equal(sanitizeReply("  hello  "), "hello");
    });

    it("returns trimmed string for Japanese text", () => {
      assert.equal(sanitizeReply("　こんにちは　"), "こんにちは");
    });

    it("returns string for 'NO_REPLY extra' (not suppressed)", () => {
      assert.equal(sanitizeReply("NO_REPLY extra"), "NO_REPLY extra");
    });
  });
});