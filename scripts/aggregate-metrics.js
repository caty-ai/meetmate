#!/usr/bin/env node

const fs = require("node:fs");

const MISROUTED_TRANSCRIPT_CHAR_THRESHOLD = positiveInt(
  process.env.METRICS_MISROUTE_CHAR_THRESHOLD,
  20
);

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function readEvents(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const events = [];
  let invalidLineCount = 0;
  let firstInvalidLine = null;

  raw.split(/\r?\n/).forEach((line, index) => {
    if (!line) return;
    try {
      events.push(JSON.parse(line));
    } catch {
      invalidLineCount += 1;
      if (firstInvalidLine === null) firstInvalidLine = index + 1;
    }
  });

  if (invalidLineCount > 0) {
    console.warn(`${filePath}: skipped ${invalidLineCount} invalid line(s), first at line ${firstInvalidLine}`);
  }

  return events;
}

function summarize(events) {
  const turns = new Map();
  const delegationEvents = events.filter((event) =>
    event.type === "timeout_fallback_fired" ||
    event.type === "handoff_requested" ||
    event.type === "handoff_dropped" ||
    event.type === "handoff_received" ||
    event.type === "forced_delegation_fired" ||
    event.type === "forced_delegation_skipped" ||
    event.type === "delegate_replied_no_spawn" ||
    event.type === "subagent_spawned" ||
    event.type === "spawn_detected" ||
    event.type === "delegation_completed" ||
    event.type === "auto_announce_injected" ||
    event.type === "parent_compact" ||
    event.type === "circuit_breaker"
  );
  const eventTypeCounts = {};
  for (const event of events) {
    eventTypeCounts[event.type] = (eventTypeCounts[event.type] || 0) + 1;
  }
  const forcedDelegationCount = events.filter((event) => event.type === "forced_delegation_fired").length;
  const spawnDetectedCount = events.filter((event) => event.type === "spawn_detected").length;
  const subagentSpawnedCount = events.filter((event) => event.type === "subagent_spawned").length;
  const delegationCompletedCount = events.filter((event) => event.type === "delegation_completed").length;
  const delegateReplyFreshCount = events.filter((event) => event.type === "delegate_replied_no_spawn" && event.fresh === true).length;
  const delegateReplyStaleCount = events.filter((event) => event.type === "delegate_replied_no_spawn" && event.fresh === false).length;
  const circuitBreakerOpenCount = events.filter((event) => event.type === "circuit_breaker" && event.state === "open").length;
  const abortRequestedCount = events.filter((event) => event.type === "abort_requested").length;
  const abortRequestedOkCount = events.filter((event) => event.type === "abort_requested" && event.ok === true).length;
  const reportPostedChatCount = events.filter((event) => event.type === "report_posted" && event.channel === "chat").length;
  const reportPostedVoiceCount = events.filter((event) => event.type === "report_posted" && event.channel === "voice").length;
  const handoffDroppedTtlCount = events.filter((event) => event.type === "handoff_dropped" && event.reason === "ttl").length;
  const handoffDroppedQueueFullCount = events.filter((event) => event.type === "handoff_dropped" && event.reason === "queue_full").length;
  const suspectedMisroutedTurnIds = new Set();

  for (const event of events) {
    const turnId = event.turn_id;
    if (!turnId) continue;
    if (!turns.has(turnId)) {
      turns.set(turnId, {
        utteranceEndMs: null,
        audibleStartMs: null,
        ackStartMs: null,
        hasWakeDecision: false,
        wakeAddressed: false,
      });
    }

    const turn = turns.get(turnId);
    if (event.type === "utterance_end") {
      turn.utteranceEndMs = event.timestamp_ms;
    }
    if (event.type === "wake_decision") {
      turn.hasWakeDecision = true;
      if (event.addressed === true) turn.wakeAddressed = true;
    }
    if (event.type === "ack_playback_start") {
      turn.ackStartMs = event.timestamp_ms;
    }
    if (
      event.type === "ack_playback_start" ||
      event.type === "tts_playback_start" ||
      event.type === "timeout_fallback_fired"
    ) {
      if (turn.audibleStartMs === null || event.timestamp_ms < turn.audibleStartMs) {
        turn.audibleStartMs = event.timestamp_ms;
      }
    }
    if (
      event.type === "handoff_requested" &&
      Number(event.transcript_char_count) <= MISROUTED_TRANSCRIPT_CHAR_THRESHOLD
    ) {
      suspectedMisroutedTurnIds.add(turnId);
    }
  }

  const observedTurns = [...turns.values()].filter((turn) => turn.utteranceEndMs !== null);
  const addressedTurns = observedTurns.filter((turn) => !turn.hasWakeDecision || turn.wakeAddressed);
  const responseTimes = [];
  let ackTurns = 0;
  for (const turn of addressedTurns) {
    if (turn.ackStartMs !== null) ackTurns += 1;
    if (turn.utteranceEndMs !== null && turn.audibleStartMs !== null) {
      responseTimes.push(turn.audibleStartMs - turn.utteranceEndMs);
    }
  }

  return {
    utterancesObserved: observedTurns.length,
    turnCount: addressedTurns.length,
    responseTimes,
    p50: percentile(responseTimes, 50),
    p90: percentile(responseTimes, 90),
    max: responseTimes.length > 0 ? Math.max(...responseTimes) : null,
    ackTurns,
    ackRate: addressedTurns.length > 0 ? ackTurns / addressedTurns.length : 0,
    eventTypeCounts,
    delegationCount: delegationEvents.length,
    forcedDelegationCount,
    spawnDetectedCount,
    subagentSpawnedCount,
    delegationCompletedCount,
    delegateReplyFreshCount,
    delegateReplyStaleCount,
    circuitBreakerOpenCount,
    abortRequestedCount,
    abortRequestedOkCount,
    reportPostedChatCount,
    reportPostedVoiceCount,
    handoffDroppedTtlCount,
    handoffDroppedQueueFullCount,
    suspectedMisroutedCount: suspectedMisroutedTurnIds.size,
  };
}

function formatMs(value) {
  return value === null ? "n/a" : `${value}ms`;
}

function printSummary(filePath, summary) {
  console.log(`Metrics summary: ${filePath}`);
  console.log(`Utterances observed (incl. unaddressed): ${summary.utterancesObserved}`);
  console.log(`Turn count: ${summary.turnCount}`);
  console.log(`Perceived response time samples: ${summary.responseTimes.length}`);
  console.log(`Perceived response time p50/p90/max: ${formatMs(summary.p50)} / ${formatMs(summary.p90)} / ${formatMs(summary.max)}`);
  console.log(`Ack immediacy rate: ${summary.ackTurns}/${summary.turnCount} (${(summary.ackRate * 100).toFixed(1)}%)`);
  console.log("Ack immediacy definition: fraction of turns with any ack_playback_start event.");
  console.log(`Delegation events: ${summary.delegationCount}`);
  console.log(`Forced delegations (Timer A): ${summary.forcedDelegationCount}`);
  console.log(`Delegate no-spawn replies: fresh=${summary.delegateReplyFreshCount}, stale_or_dropped=${summary.delegateReplyStaleCount}`);
  console.log(`Circuit breaker opens: ${summary.circuitBreakerOpenCount}`);
  console.log(`Gateway subagents spawned: ${summary.subagentSpawnedCount}`);
  console.log(`Gateway spawns detected: ${summary.spawnDetectedCount}`);
  console.log(`Gateway delegations completed: ${summary.delegationCompletedCount}`);
  console.log(`Gateway abort requests: ${summary.abortRequestedOkCount}/${summary.abortRequestedCount} ok`);
  console.log(`Gateway reports posted: chat=${summary.reportPostedChatCount}, voice=${summary.reportPostedVoiceCount}`);
  console.log(`Gateway handoffs dropped: ttl=${summary.handoffDroppedTtlCount}, queue_full=${summary.handoffDroppedQueueFullCount}`);
  console.log(`Suspected misrouted turns: ${summary.suspectedMisroutedCount}`);
  console.log(`Suspected misroute heuristic: handoff_requested with transcript_char_count <= ${MISROUTED_TRANSCRIPT_CHAR_THRESHOLD} (METRICS_MISROUTE_CHAR_THRESHOLD).`);
  console.log("Note: self-initiated LLM delegations via sessions_spawn are not counted because they are not observable at the REST boundary.");
}

function main(argv) {
  const filePath = argv[2];
  if (!filePath) {
    console.error("Usage: node scripts/aggregate-metrics.js <path-to-jsonl>");
    process.exitCode = 1;
    return;
  }

  const summary = summarize(readEvents(filePath));
  printSummary(filePath, summary);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = {
  MISROUTED_TRANSCRIPT_CHAR_THRESHOLD,
  readEvents,
  summarize,
};
