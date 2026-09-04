const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverPath = path.join(__dirname, "..", "src", "server.js");

test("server operator errors are source-pinned to the log scrubber", () => {
  const source = fs.readFileSync(serverPath, "utf8");

  assert.match(source, /const \{ scrubLogMessage \} = require\("\.\/log-scrub"\);/);
  assert.match(source, /Discord adapter bootstrap skipped: \$\{scrubErrorMessage\(error\)\}/);
  assert.match(source, /bootstrap\(\)\.catch\(\(err\) => \{[\s\S]*scrubErrorMessage\(err\)/);
  assert.match(source, /console\.error\("❌  Failed to start Meet server:"/);
  assert.doesNotMatch(source, /Discord adapter bootstrap skipped: \$\{error\.message\}/);
  for (const [, args] of source.matchAll(/console\.(?:warn|error|log)\(([\s\S]*?)\);/g)) {
    assert.doesNotMatch(args, /,\s*(?:err|error)\s*$/);
  }
});
