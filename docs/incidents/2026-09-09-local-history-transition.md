# Local history transition to GenOffice

- Date: 2026-09-09, Asia/Seoul (UTC+09:00).
- Status: Git synchronization and local startup verified.

## Symptoms and impact

`git pull --ff-only` refused to synchronize the clean local EasyDoc checkout.
No tracked local changes were lost.

## Evidence and cause

Local main was `e278fb3`; fetched origin/main was `0125027`, containing GenOffice.
`git merge-base HEAD origin/main` returned no common ancestor. The histories
cannot be fast-forwarded. The reason for the remote history replacement was
not investigated.

## Response and verification

1. Fetched origin and inspected both histories and the remote package manifest.
2. Renamed the old local main to `backup/easydoc-before-genoffice-20260909`.
3. Created main tracking origin/main at `0125027`.
4. Installed dependencies and built all editors and the native Sheets engine.
5. Verified focused tests and all five editor cards in real Electron. The Sheets
   preload issue discovered during verification is recorded separately in
   `2026-09-09-sheets-preload-dependency.md`.

## Prevention

Preserve the old branch until its contents are no longer needed. Inspect
ancestry before synchronizing checkouts across a repository history transition.
