const { DEFAULT_MESSAGES } = require("./messages");

function statusLabel(status, labels = DEFAULT_MESSAGES.delegation) {
  return status === "ok" || status === "completed" || status === "end" ? labels.statusComplete : labels.statusIncomplete;
}

function excerpt(text, max = 500) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}...`;
}

function normalizeResults(results) {
  return Array.isArray(results) ? results.filter(Boolean) : [];
}

function buildDelegationResultsSection(results, labels = DEFAULT_MESSAGES.delegation) {
  const items = normalizeResults(results);
  if (items.length === 0) return "";
  const lines = ["", labels.sectionHeading, ""];
  for (const item of items) {
    const label = String(item.label || labels.defaultLabel).trim();
    lines.push(`- ${label} (${statusLabel(item.status, labels)}): ${excerpt(item.resultText) || labels.emptyResult}`);
  }
  return lines.join("\n");
}

module.exports = {
  buildDelegationResultsSection,
  excerpt,
  statusLabel,
};
