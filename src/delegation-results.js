function statusLabel(status) {
  return status === "ok" || status === "completed" || status === "end" ? "完了" : "未完";
}

function excerpt(text, max = 500) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}...`;
}

function normalizeResults(results) {
  return Array.isArray(results) ? results.filter(Boolean) : [];
}

function buildDelegationResultsSection(results) {
  const items = normalizeResults(results);
  if (items.length === 0) return "";
  const lines = ["", "## 委譲タスク結果", ""];
  for (const item of items) {
    const label = String(item.label || "委譲タスク").trim();
    lines.push(`- ${label} (${statusLabel(item.status)}): ${excerpt(item.resultText) || "結果本文なし"}`);
  }
  return lines.join("\n");
}

module.exports = {
  buildDelegationResultsSection,
  excerpt,
  statusLabel,
};
