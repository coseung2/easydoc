# Production dependency audit policy

This repository treats production dependency auditing as a blocking verification step through `npm run audit:prod`.

## Blocking rule

- Any new `critical` or `high` production dependency finding fails the check.
- Moderate and lower findings remain visible in the audit output but do not fail this policy by themselves.
- Temporary exceptions must be exact: package version, dependency path, advisory set, and review deadline are all pinned in `scripts/dependency-audit-policy.mjs`.
- A temporary exception also fails when the underlying finding disappears. This forces removal of stale exception code instead of allowing it to remain indefinitely.
- Do not use `npm audit fix --force` to clear native/Expo findings without re-validating the Expo and native-module compatibility matrix.

## Temporary Scanbot build-tool exception

Status: **temporary / accepted for development and current release validation**  
Review deadline: **2026-10-07**

Direct package:

- `react-native-scanbot-sdk@9.0.2` — exact-pinned in the mobile workspace.

Affected build-time dependency chain:

```text
react-native-scanbot-sdk@9.0.2
└─ @expo/config-plugins@9.0.14
   └─ @expo/plist@0.2.2
      └─ @xmldom/xmldom@0.7.13
```

Approved vulnerable node path:

```text
node_modules/react-native-scanbot-sdk/node_modules/@xmldom/xmldom
```

The current audit entry contains these advisories and no others:

- `GHSA-wh4c-j3r5-mjhp`
- `GHSA-2v35-w6hq-6mfw`
- `GHSA-f6ww-3ggp-fr8h`
- `GHSA-x6wf-f3px-wcqx`
- `GHSA-j759-j44w-7fr8`
- `GHSA-6gmq-8vp8-gcm6`

### Why this is temporarily accepted

The vulnerable dependency is reached through Scanbot's Expo config plugin. Repository inspection shows the affected `@expo/config-plugins` APIs are used under Scanbot's `plugin/` implementation for Expo prebuild/config processing. The scanner camera/runtime implementation does not import this XML/plist toolchain.

This reduces the exposure to the trusted build/prebuild environment rather than end-user document processing. The exception does **not** mean the advisory is considered fixed.

Build mitigation while the exception is active:

- Build/prebuild only from trusted repository inputs and reviewed configuration changes.
- Do not feed untrusted external plist/XML documents into build configuration steps.
- Keep the package lockfile committed and use reproducible installs in CI/release builds.
- Keep `react-native-scanbot-sdk` exact-pinned at `9.0.2`; dependency drift requires review.
- Continue to fail on every unrelated HIGH/CRITICAL finding.

### Removal or re-review triggers

Remove the exception immediately when any of the following occurs:

1. Scanbot releases a compatible SDK that no longer resolves the vulnerable `xmldom` version.
2. The vulnerable node disappears from `npm audit --omit=dev`.
3. The dependency path, transitive versions, severity, or advisory set changes.
4. A tested vendor-supported fix becomes available.
5. The review deadline of 2026-10-07 is reached.

If a manual dependency override or patch is considered before an upstream fix, it must pass Expo config/prebuild validation and native Android/iOS build validation before replacing this exception.

## Existing moderate findings

The production audit currently also reports moderate Expo/Xcode tooling findings, including the `xcode -> uuid` chain. They are not part of the HIGH exception above and remain visible in audit output. The repository security threshold is HIGH/CRITICAL; moderate findings are reviewed during dependency modernization rather than hidden by the exception mechanism.
