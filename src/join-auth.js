"use strict";

function toSafeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function checkJoinAuthorization(req, formData) {
  const sharedToken = process.env.JOIN_SHARED_TOKEN || "";
  if (!sharedToken) return true;

  const headerToken = req.headers?.["x-join-token"];
  const body = formData || {};
  const bodyToken = body.joinToken || body.token;
  const candidate = toSafeString(Array.isArray(headerToken) ? headerToken[0] : headerToken) || toSafeString(bodyToken);
  return candidate && candidate === sharedToken;
}

module.exports = { checkJoinAuthorization };
