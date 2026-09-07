import test from "node:test";
import assert from "node:assert/strict";
import { evaluateProductionAudit, scanbotToolchainException } from "../scripts/dependency-audit-policy.mjs";

function currentReport() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      "@xmldom/xmldom": {
        name: "@xmldom/xmldom",
        severity: "high",
        nodes: [scanbotToolchainException.nodePath],
        via: scanbotToolchainException.advisoryIds.map((id) => ({ url: `https://github.com/advisories/${id}` })),
      },
      uuid: { name: "uuid", severity: "moderate", nodes: ["node_modules/uuid"], via: [] },
    },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 5, high: 1, critical: 0, total: 6 } },
  };
}

test("production audit accepts only the reviewed Scanbot build-time HIGH finding", () => {
  const result = evaluateProductionAudit(currentReport(), new Date("2026-09-07T00:00:00Z"));
  assert.equal(result.ok, true);
  assert.equal(result.blockingCount, 1);
});

test("production audit rejects any new HIGH finding", () => {
  const report = currentReport();
  report.vulnerabilities.other = { name: "other", severity: "high", nodes: ["node_modules/other"], via: [] };
  const result = evaluateProductionAudit(report, new Date("2026-09-07T00:00:00Z"));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Unexpected HIGH/);
});

test("production audit rejects path or advisory drift", () => {
  const report = currentReport();
  report.vulnerabilities["@xmldom/xmldom"].nodes = ["node_modules/@xmldom/xmldom"];
  report.vulnerabilities["@xmldom/xmldom"].via.push({ url: "https://github.com/advisories/GHSA-new-advisory" });
  const result = evaluateProductionAudit(report, new Date("2026-09-07T00:00:00Z"));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /moved outside|Advisory set changed/);
});

test("production audit exception expires and stale exceptions do not silently pass", () => {
  const expired = evaluateProductionAudit(currentReport(), new Date("2026-10-08T00:00:00Z"));
  assert.equal(expired.ok, false);
  assert.match(expired.errors.join("\n"), /expired/);

  const clean = currentReport();
  clean.vulnerabilities = { uuid: clean.vulnerabilities.uuid };
  clean.metadata.vulnerabilities.high = 0;
  const stale = evaluateProductionAudit(clean, new Date("2026-09-07T00:00:00Z"));
  assert.equal(stale.ok, false);
  assert.match(stale.errors.join("\n"), /no longer present/);
});
