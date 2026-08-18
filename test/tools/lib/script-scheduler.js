"use strict";

const fs = require("node:fs");
const path = require("node:path");

class ScriptScheduler {
  constructor(dependencies = {}) {
    this.now = dependencies.now || Date.now;
    this.sleep = dependencies.sleep || null;
    this.playAsset = dependencies.playAsset || (async () => {});
    this.playTone = dependencies.playTone || (async () => {});
    this.sendChat = dependencies.sendChat || (async () => {});
    this.onEvent = dependencies.onEvent || (() => {});
    this.waitSignalDir = dependencies.waitSignalDir || null;
    this.onBlockStart = dependencies.onBlockStart || (() => {});
    this.onBlockEnd = dependencies.onBlockEnd || (() => {});
    this.signalPollMs = Math.min(1000, dependencies.signalPollMs || 500);
    this.midBargeDelayMs = dependencies.midBargeDelayMs || 2500;
    this.lateBargeDelayMs = dependencies.lateBargeDelayMs || 6000;
    this.exitSilenceMs = dependencies.exitSilenceMs || 5000;
    this.currentBlockId = null;
    this.currentStepIndex = null;
    this.waiters = new Set();
    this.abortWaiters = new Set();
    this.aborted = null;
    this.subjectSpeaking = false;
    this.lastSubjectOnsetMs = null;
    this.lastSubjectOffsetMs = null;
    this.lastSubjectOffsetObservedMs = null;
    this.abortController = new AbortController();
  }

  _emit(type, fields = {}) {
    this.onEvent({
      type,
      ...(this.currentBlockId == null ? {} : { blockId: this.currentBlockId }),
      ...(this.currentStepIndex == null ? {} : { stepIndex: this.currentStepIndex }),
      ...fields,
    });
  }

  abort(reason = "aborted") {
    if (this.aborted) return;
    this.aborted = new Error(String(reason));
    this.abortController.abort(this.aborted);
    for (const waiter of this.abortWaiters) waiter(this.aborted);
    this.abortWaiters.clear();
    for (const waiter of this.waiters) waiter.reject(this.aborted);
    this.waiters.clear();
  }

  _throwIfAborted() {
    if (this.aborted) throw this.aborted;
  }

  async _sleep(ms) {
    this._throwIfAborted();
    if (!this.sleep) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.abortWaiters.delete(onAbort);
          resolve();
        }, Math.max(0, ms));
        const onAbort = (error) => {
          clearTimeout(timer);
          this.abortWaiters.delete(onAbort);
          reject(error);
        };
        this.abortWaiters.add(onAbort);
      });
      this._throwIfAborted();
      return;
    }
    let abortReject;
    const aborted = new Promise((resolve, reject) => {
      abortReject = reject;
      this.abortWaiters.add(abortReject);
    });
    try {
      await Promise.race([this.sleep(Math.max(0, ms)), aborted]);
    } finally {
      this.abortWaiters.delete(abortReject);
    }
    this._throwIfAborted();
  }

  handleDetectorEvent(event) {
    if (event.type === "onset") {
      this.subjectSpeaking = true;
      this.lastSubjectOnsetMs = event.tMs;
    } else if (event.type === "offset") {
      if (event.censored) return;
      this.subjectSpeaking = false;
      this.lastSubjectOffsetMs = event.tMs;
      this.lastSubjectOffsetObservedMs = this.now();
    } else {
      return;
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.type !== event.type) continue;
      this.waiters.delete(waiter);
      waiter.resolve(event);
    }
  }

  async _waitForSpeechEvent(type, timeoutMs, timeoutEvent = "wait_speech_timeout") {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`${type} wait requires timeoutMs`);
    let waiter;
    let timer = null;
    const observed = new Promise((resolve, reject) => {
      waiter = { type, resolve, reject };
      this.waiters.add(waiter);
    });
    const timeout = this.sleep
      ? Promise.resolve(this.sleep(timeoutMs)).then(() => null)
      : new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    let result;
    try {
      result = await Promise.race([observed, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      this.waiters.delete(waiter);
    }
    this._throwIfAborted();
    if (!result && timeoutEvent) this._emit(timeoutEvent, { awaited: type, timeoutMs });
    return result;
  }

  async _waitForSubjectSpeech(timeoutMs) {
    if (this.subjectSpeaking) {
      const event = { type: "onset", tMs: this.lastSubjectOnsetMs, already_speaking: true };
      this._emit("wait_speech_observed", { already_speaking: true, subjectOnsetMs: event.tMs });
      return event;
    }
    const event = await this._waitForSpeechEvent("onset", timeoutMs);
    if (event) this._emit("wait_speech_observed", { already_speaking: false, subjectOnsetMs: event.tMs });
    return event;
  }

  async _waitForSubjectOffset(timeoutMs) {
    if (!this.subjectSpeaking) {
      this._emit("wait_offset_observed", { already_quiet: true });
      return { type: "offset", tMs: this.now(), already_quiet: true };
    }
    const event = await this._waitForSpeechEvent("offset", timeoutMs, "wait_offset_timeout");
    if (event) this._emit("wait_offset_observed", { already_quiet: false, subjectOffsetMs: event.tMs });
    return event;
  }

  async _delayUntil(targetMs) {
    const remaining = targetMs - this.now();
    if (remaining > 0) await this._sleep(remaining);
  }

  async _runBargeIn(step) {
    const timeoutMs = step.timeoutMs;
    const onset = await this._waitForSpeechEvent("onset", timeoutMs);
    if (!onset) return;

    let targetMs;
    if (step.position === "start") {
      targetMs = onset.tMs + (step.offsetMs ?? 300);
      await this._delayUntil(targetMs);
    } else if (step.position === "mid") {
      targetMs = onset.tMs + (step.offsetMs ?? this.midBargeDelayMs);
      await this._delayUntil(targetMs);
    } else if (step.position === "late") {
      const lateAfterMs = step.lateAfterMs ?? this.lateBargeDelayMs;
      if (!Number.isFinite(lateAfterMs) || lateAfterMs < 0) throw new Error("late bargeIn requires a finite non-negative lateAfterMs");
      targetMs = onset.tMs + lateAfterMs;
      await this._delayUntil(targetMs);
      if (!this.subjectSpeaking) {
        this._emit("barge_in_skipped", {
          position: step.position,
          assetId: step.assetId,
          subjectOnsetMs: onset.tMs,
          targetPlayMs: targetMs,
          reason: "subject_finished_before_late_fire",
        });
        return;
      }
    } else {
      throw new Error(`unsupported bargeIn position: ${step.position}`);
    }

    const actualPlayMs = this.now();
    this._emit("barge_in_attempt", {
      position: step.position,
      assetId: step.assetId,
      subjectOnsetMs: onset.tMs,
      targetPlayMs: targetMs,
      actualPlayMs,
      latenessMs: actualPlayMs - targetMs,
    });
    await this.playAsset(step.assetId, {
      blockId: this.currentBlockId,
      stepIndex: this.currentStepIndex,
      interjection: true,
    }, this.abortController.signal);
  }

  async _waitForSignal(step) {
    if (!this.waitSignalDir) throw new Error("waitSignalDir is required for waitForSignal");
    if (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0) throw new Error("waitForSignal requires timeoutMs");
    const file = path.join(this.waitSignalDir, step.name);
    const deadline = this.now() + step.timeoutMs;
    while (this.now() < deadline) {
      if (fs.existsSync(file)) {
        this._emit("signal_received", { name: step.name, path: file });
        return;
      }
      await this._sleep(Math.min(this.signalPollMs, deadline - this.now()));
    }
    this._emit("signal_timeout", { name: step.name, timeoutMs: step.timeoutMs });
  }

  async _expectSubjectExit(step) {
    if (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0) throw new Error("expectSubjectExit requires timeoutMs");
    const silenceMs = step.silenceMs ?? this.exitSilenceMs;
    const started = this.now();
    let quietSince = this.subjectSpeaking ? null : started;

    while (this.now() - started < step.timeoutMs) {
      if (this.subjectSpeaking) {
        quietSince = null;
      } else if (quietSince == null) {
        quietSince = this.lastSubjectOffsetObservedMs != null && this.lastSubjectOffsetObservedMs >= started
          ? this.lastSubjectOffsetObservedMs
          : this.now();
      }
      if (quietSince != null && this.now() - quietSince >= silenceMs) {
        this._emit("voice_exit_observed", { silenceMs });
        return;
      }
      await this._sleep(Math.min(100, step.timeoutMs - (this.now() - started)));
    }
    this._emit("voice_exit_timeout", { timeoutMs: step.timeoutMs, silenceMs });
  }

  async _runStep(step) {
    switch (step.type) {
      case "play":
        await this.playAsset(step.assetId, {
          blockId: this.currentBlockId,
          stepIndex: this.currentStepIndex,
        }, this.abortController.signal);
        break;
      case "waitMs":
        if (!Number.isFinite(step.ms) || step.ms < 0) throw new Error("waitMs requires a finite non-negative ms");
        await this._sleep(step.ms);
        break;
      case "waitForSubjectSpeech":
        await this._waitForSubjectSpeech(step.timeoutMs);
        break;
      case "waitForSubjectOffset":
        await this._waitForSubjectOffset(step.timeoutMs);
        break;
      case "bargeIn":
        await this._runBargeIn(step);
        break;
      case "anchorTone":
        this._emit("anchor", { frequencyHz: 1000, durationMs: 500, repetitions: 3, gapMs: 500 });
        for (let i = 0; i < 3; i += 1) {
          await this.playTone(1000, 500, { repetition: i + 1, blockId: this.currentBlockId }, this.abortController.signal);
          if (i < 2) await this._sleep(500);
        }
        break;
      case "chatMarker":
        try {
          const sent = await this.sendChat(step.text);
          if (sent === false) this._emit("chat_marker_error", { text: step.text, reason: "sender_returned_false" });
          else this._emit("chat_marker", { text: step.text });
        } catch (error) {
          this._emit("chat_marker_error", { text: step.text, message: error.message });
        }
        break;
      case "waitForSignal":
        await this._waitForSignal(step);
        break;
      case "expectSubjectExit":
        await this._expectSubjectExit(step);
        break;
      default:
        throw new Error(`unsupported script step type: ${step.type}`);
    }
  }

  async run(script) {
    if (!script || !Array.isArray(script.blocks)) throw new Error("script.blocks must be an array");
    for (const block of script.blocks) {
      this._throwIfAborted();
      if (!block.id || !Array.isArray(block.steps)) throw new Error("each block requires id and steps");
      this.currentBlockId = block.id;
      this.currentStepIndex = null;
      this._emit("block_start", { title: block.title || null });
      await this.onBlockStart(block);
      for (let index = 0; index < block.steps.length; index += 1) {
        this.currentStepIndex = index;
        this._emit("step_start", { stepType: block.steps[index].type });
        await this._runStep(block.steps[index]);
        this._emit("step_end", { stepType: block.steps[index].type });
      }
      this.currentStepIndex = null;
      await this.onBlockEnd(block);
      this._emit("block_end", { title: block.title || null });
    }
    this.currentBlockId = null;
  }
}

module.exports = { ScriptScheduler };
