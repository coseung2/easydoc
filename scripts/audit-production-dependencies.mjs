import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { evaluateProductionAudit, scanbotToolchainException, verifyPinnedScanbotState } from "./dependency-audit-policy.mjs";

function readJson(path) {
  return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

const mobilePackage = readJson("apps/mobile/package.json");
const lockfile = readJson("package-lock.json");
const pinErrors = verifyPinnedScanbotState(mobilePackage, lockfile);

if (pinErrors.length > 0) {
  console.error("Dependency audit policy pin check failed:");
  for (const error of pinErrors) console.error(`- ${error}`);
  process.exit(1);
}

// npm.cmd cannot be spawned directly on Windows. Under npm run, invoke its
// JavaScript entry point without a shell; retain a direct-run fallback.
const npmEntry = process.env.npm_execpath;
const npmCommand = npmEntry ? process.execPath : process.platform === "win32" ? "cmd.exe" : "npm";
const npmArgs = npmEntry
  ? [npmEntry, "audit", "--omit=dev", "--json"]
  : process.platform === "win32"
    ? ["/d", "/s", "/c", "npm audit --omit=dev --json"]
    : ["audit", "--omit=dev", "--json"];
const audit = spawnSync(npmCommand, npmArgs, {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});

if (audit.error) {
  console.error(`Unable to run npm audit: ${audit.error.message}`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(audit.stdout || "");
} catch {
  console.error("npm audit did not return parseable JSON.");
  if (audit.stderr) console.error(audit.stderr.trim());
  process.exit(1);
}

if (report?.auditReportVersion !== 2 || !report?.vulnerabilities) {
  console.error("npm audit returned an unexpected report format; refusing to apply the exception policy.");
  process.exit(1);
}

const result = evaluateProductionAudit(report);
const counts = result.counts;
console.log(`Production dependency audit: ${counts.total ?? "?"} findings (${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate).`);

if (!result.ok) {
  console.error("Dependency audit policy failed:");
  for (const error of result.errors) console.error(`- ${error}`);
  process.exit(1);
}

for (const accepted of result.accepted) {
  console.log(`Accepted temporary build-time exception: ${accepted}`);
}
console.log(`Exception review deadline: ${scanbotToolchainException.reviewBy}. Any new HIGH/CRITICAL finding, path/version change, advisory-set change, or expiry fails this check.`);
