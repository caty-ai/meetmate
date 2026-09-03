const { sessionUserFor } = require("./session-user");

const LATE_ROUTE_TTL_MS = 10 * 60 * 1000;

function createGatewaySessionTracker({
  gatewayEvents,
  recordEvent,
  sessions,
  activeConnections,
  getGatewayConfigForProfile,
  getDefaultAgentId,
  appendLateResult,
  onRetentionReleased,
}) {
  const routes = new Map();
  let listenersRegistered = false;

  function registerGatewayListeners() {
    if (listenersRegistered) return;
    listenersRegistered = true;

    gatewayEvents.onSubagentSpawn((evt) => {
      const route = findGatewayRoute(evt.parentSessionKey);
      if (!route) return false;
      const parentKind = route.parentKind;
      const source = parentKind === "delegate" ? "delegate" : "self";
      const routedEvt = { ...evt, source, parentKind };
      const entry = routes.get(route.sessionId);
      if (entry && evt.childKey && !entry.children.has(evt.childKey)) {
        entry.children.add(evt.childKey);
      }
      const active = activeConnections.get(route.sessionId);
      if (!entry?.ended && active?.handler?.handleGatewaySubagentSpawn) {
        active.handler.handleGatewaySubagentSpawn(routedEvt);
      }
      recordEvent("subagent_spawned", {
        meeting_id: route.sessionId,
        session_id: route.sessionId,
        agent_id: route.agentId,
        source,
        child_key: evt.childKey || "",
        parent_kind: parentKind,
        label: evt.label || "委譲タスク",
      });
      recordEvent("spawn_detected", {
        meeting_id: route.sessionId,
        session_id: route.sessionId,
        agent_id: route.agentId,
        source,
        child_key: evt.childKey || "",
        parent_kind: parentKind,
        label: evt.label || "委譲タスク",
        deprecated: true,
      });
      return true;
    });

    gatewayEvents.onSubagentCompletion((evt) => {
      const route = findGatewayRoute(evt.parentSessionKey);
      if (!route) return false;
      const entry = routes.get(route.sessionId);
      if (entry?.children && evt.childKey) entry.children.delete(evt.childKey);
      const active = activeConnections.get(route.sessionId);
      if (!entry?.ended && active?.handler?.handleGatewaySubagentCompletion) {
        const handled = active.handler.handleGatewaySubagentCompletion(evt);
        return handled !== false;
      }
      const handled = appendLateResult(route.sessionId, evt) !== false;
      if (entry?.ended && entry.children.size === 0) {
        releaseRetainedRoute(route.sessionId, "settled");
      }
      return handled;
    });

    gatewayEvents.onSessionReply?.((evt) => {
      const route = findGatewayRoute(evt.sessionKey);
      if (!route || route.parentKind !== "delegate") return false;
      const entry = routes.get(route.sessionId);
      const active = activeConnections.get(route.sessionId);
      const routedEvt = { ...evt, parentKind: "delegate", source: "delegate" };
      if (!entry?.ended && active?.handler?.handleGatewaySessionReply) {
        const handled = active.handler.handleGatewaySessionReply(routedEvt);
        return handled !== false;
      }
      const handled = appendLateResult(route.sessionId, {
        label: "委譲応答",
        status: "ok",
        resultText: String(evt.resultText || "").trim(),
        runId: evt.runId || "",
      }) !== false;
      if (entry?.ended && entry.children.size === 0) {
        releaseRetainedRoute(route.sessionId, "settled");
      }
      return handled;
    });

    gatewayEvents.onAnnounceInjected?.((evt) => {
      const route = findGatewayRoute(evt.sessionKey);
      if (!route || route.parentKind !== "parent") return false;
      const entry = routes.get(route.sessionId);
      const active = activeConnections.get(route.sessionId);
      if (!entry?.ended && active?.handler?.handleGatewayAnnounceInjected) {
        const handled = active.handler.handleGatewayAnnounceInjected(evt);
        return handled !== false;
      }
      return false;
    });
  }

  function findGatewayRoute(parentSessionKey) {
    for (const [sessionId, entry] of routes) {
      if (entry.parentKey === parentSessionKey) {
        return { sessionId, agentId: entry.agentId, parentKind: "parent" };
      }
      if (entry.delegateKey === parentSessionKey) {
        return { sessionId, agentId: entry.agentId, parentKind: "delegate" };
      }
    }
    return null;
  }

  function trackGatewaySession(session, profile, transport = "meet") {
    const gwCfg = getGatewayConfigForProfile(profile);
    if (!gwCfg.enabled) return false;

    registerGatewayListeners();
    gatewayEvents.start(gwCfg);

    const agentId = profile?.agentId || session.config?.defaultAgentId || getDefaultAgentId?.() || "agent";
    const parentUser = sessionUserFor(transport, session.id, agentId);
    const delegateUser = `${parentUser}-delegate`;
    const parentKey = gatewayEvents.buildSessionKey(parentUser, gwCfg.agentId);
    const delegateKey = gatewayEvents.buildSessionKey(delegateUser, gwCfg.agentId);
    const timers = [];
    const previous = routes.get(session.id);
    if (previous?.retainTimer) clearTimeout(previous.retainTimer);
    routes.set(session.id, {
      parentKey,
      delegateKey,
      agentId,
      timers,
      children: previous?.children || new Set(),
      ended: false,
      retainTimer: null,
    });

    for (const delay of [1000, 3000, 10_000]) {
      const timer = setTimeout(() => {
        Promise.allSettled([
          gatewayEvents.verifySessionKey(parentUser),
          gatewayEvents.verifySessionKey(delegateUser),
        ]).then((results) => {
          const failed = results.filter((r) => r.status === "rejected");
          if (failed.length > 0) {
            console.warn(`⚠️  gateway session resolve incomplete (sid=${session.id}, delay=${delay}ms)`);
          }
        }).catch(() => {});
      }, delay);
      timer.unref?.();
      timers.push(timer);
    }
    return true;
  }

  function untrackGatewaySession(sessionId, options = {}) {
    const entry = routes.get(sessionId);
    if (!entry) return false;
    for (const timer of entry.timers || []) clearTimeout(timer);
    entry.timers = [];

    if (options.retainIfDelegations && hasOpenDelegations(sessionId, entry)) {
      entry.ended = true;
      if (!entry.retainTimer) {
        entry.retainTimer = setTimeout(() => {
          releaseRetainedRoute(sessionId, "ttl");
        }, options.ttlMs || LATE_ROUTE_TTL_MS);
        entry.retainTimer.unref?.();
      }
      return true;
    }

    hardUntrackGatewaySession(sessionId);
    return false;
  }

  function releaseRetainedRoute(sessionId, reason) {
    const entry = routes.get(sessionId);
    if (!entry?.ended) return false;
    hardUntrackGatewaySession(sessionId);
    onRetentionReleased?.(sessionId, reason);
    return true;
  }

  function hardUntrackGatewaySession(sessionId) {
    const entry = routes.get(sessionId);
    if (entry?.retainTimer) clearTimeout(entry.retainTimer);
    for (const timer of entry?.timers || []) clearTimeout(timer);
    routes.delete(sessionId);
    if (routes.size === 0) gatewayEvents.stop();
  }

  function close() {
    for (const sessionId of [...routes.keys()]) {
      hardUntrackGatewaySession(sessionId);
    }
  }

  function hasOpenDelegations(sessionId, entry) {
    const session = sessions.get(sessionId);
    const state = session?.gatewayDelegationState || {};
    return (entry.children?.size || 0) > 0
      || Number(state.inFlightCount || 0) > 0
      || Number(state.pendingQueueCount || 0) > 0;
  }

  return {
    trackGatewaySession,
    untrackGatewaySession,
    close,
    findGatewayRoute,
    _test: {
      routes,
      hardUntrackGatewaySession,
      hasOpenDelegations,
    },
  };
}

module.exports = {
  createGatewaySessionTracker,
  LATE_ROUTE_TTL_MS,
};
