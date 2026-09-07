const severityRank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

export const scanbotToolchainException = Object.freeze({
  sdkPackage: "react-native-scanbot-sdk",
  sdkVersion: "9.0.2",
  reviewBy: "2026-10-07",
  vulnerablePackage: "@xmldom/xmldom",
  vulnerableVersion: "0.7.13",
  nodePath: "node_modules/react-native-scanbot-sdk/node_modules/@xmldom/xmldom",
  transitiveVersions: Object.freeze({
    "node_modules/react-native-scanbot-sdk/node_modules/@expo/config-plugins": "9.0.14",
    "node_modules/react-native-scanbot-sdk/node_modules/@expo/plist": "0.2.2",
    "node_modules/react-native-scanbot-sdk/node_modules/@xmldom/xmldom": "0.7.13",
  }),
  advisoryIds: Object.freeze([
    "GHSA-wh4c-j3r5-mjhp",
    "GHSA-2v35-w6hq-6mfw",
    "GHSA-f6ww-3ggp-fr8h",
    "GHSA-x6wf-f3px-wcqx",
    "GHSA-j759-j44w-7fr8",
    "GHSA-6gmq-8vp8-gcm6",
  ]),
});

function advisoryId(via) {
  if (!via || typeof via !== "object" || typeof via.url !== "string") return null;
  const parts = via.url.split("/");
  return parts.at(-1) || null;
}

function sameStrings(left, right) {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

export function verifyPinnedScanbotState(mobilePackage, lockfile) {
  const errors = [];
  const expected = scanbotToolchainException;
  const directSpec = mobilePackage?.dependencies?.[expected.sdkPackage];
  const lockSpec = lockfile?.packages?.["apps/mobile"]?.dependencies?.[expected.sdkPackage];
  const lockedVersion = lockfile?.packages?.[`node_modules/${expected.sdkPackage}`]?.version;

  if (directSpec !== expected.sdkVersion) errors.push(`apps/mobile/package.json must pin ${expected.sdkPackage} exactly to ${expected.sdkVersion}; found ${String(directSpec)}.`);
  if (lockSpec !== expected.sdkVersion) errors.push(`package-lock.json workspace spec must pin ${expected.sdkPackage} exactly to ${expected.sdkVersion}; found ${String(lockSpec)}.`);
  if (lockedVersion !== expected.sdkVersion) errors.push(`package-lock.json must resolve ${expected.sdkPackage} to ${expected.sdkVersion}; found ${String(lockedVersion)}.`);

  for (const [nodePath, version] of Object.entries(expected.transitiveVersions)) {
    const actual = lockfile?.packages?.[nodePath]?.version;
    if (actual !== version) errors.push(`Temporary audit exception requires ${nodePath}@${version}; found ${String(actual)}. Re-review the exception before updating.`);
  }

  return errors;
}

export function evaluateProductionAudit(report, now = new Date()) {
  const expected = scanbotToolchainException;
  const vulnerabilities = Object.values(report?.vulnerabilities ?? {});
  const blocking = vulnerabilities.filter((item) => (severityRank[item?.severity] ?? -1) >= severityRank.high);
  const errors = [];
  const accepted = [];
  const today = now.toISOString().slice(0, 10);

  if (today > expected.reviewBy) {
    errors.push(`Scanbot toolchain audit exception expired on ${expected.reviewBy}. Upgrade, patch, or explicitly re-review it.`);
  }

  const candidate = blocking.find((item) => item?.name === expected.vulnerablePackage);
  if (!candidate) {
    if (blocking.length === 0) {
      errors.push("The temporary Scanbot HIGH exception is no longer present. Remove the stale exception policy instead of carrying it forward.");
    } else {
      errors.push(`Expected temporary exception ${expected.vulnerablePackage} was not the blocking HIGH finding.`);
    }
  } else {
    const nodes = Array.isArray(candidate.nodes) ? candidate.nodes : [];
    if (!sameStrings(nodes, [expected.nodePath])) {
      errors.push(`HIGH finding moved outside the approved Scanbot build-time path. Found nodes: ${nodes.join(", ") || "none"}.`);
    }

    const ids = (Array.isArray(candidate.via) ? candidate.via : []).map(advisoryId).filter(Boolean);
    if (!sameStrings(ids, expected.advisoryIds)) {
      errors.push(`Advisory set changed for the approved Scanbot path. Found: ${ids.join(", ") || "none"}.`);
    }

    if (candidate.severity !== "high") {
      errors.push(`Approved Scanbot finding changed severity from high to ${String(candidate.severity)}; re-review required.`);
    }

    if (errors.length === 0) accepted.push(`${expected.vulnerablePackage}@${expected.vulnerableVersion} at ${expected.nodePath}`);
  }

  for (const item of blocking) {
    if (item !== candidate) errors.push(`Unexpected ${String(item?.severity).toUpperCase()} production dependency finding: ${String(item?.name)}.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    accepted,
    blockingCount: blocking.length,
    counts: report?.metadata?.vulnerabilities ?? {},
  };
}
