// llm.js — compatibility shim. Real implementation lives in llm-openclaw.js.
// Kept so existing require("./llm") call sites (pipeline.js, config.js) and
// tests that swap require.cache entries keep working unchanged.
module.exports = require("./llm-openclaw");
