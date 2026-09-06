# PC name save report

- Date/timezone: 2026-09-06, Asia/Seoul.
- Symptom: User reports that changing the top-level PC name does not save.
- Impact: PC naming cannot be relied upon by the user; scope not yet reproduced.
- Timeline: After the 0.2.0 build and installation, user identified the affected control as the top-level PC name field. Read-only inspection followed.
- Evidence: Two installed EasyDoc processes, each with a main window, were running concurrently. Installed binary metadata reports 0.2.0. The frontend invokes `set_desktop_alias` with `desktopAlias`; the Rust command is registered and writes settings followed by pairings. Both processes use the same settings path but maintain independent in-memory settings. The frontend has no save-success indicator.
- Cause: Unresolved. Concurrent instances can show stale names and write shared settings independently; this is a confirmed risk, not proof of the reported failure. Missing success feedback is another possible explanation.
- Response: Inspected source, process metadata, and settings metadata without changing user settings or closing applications.
- Recovery: User confirmed duplicate windows and requested single-instance behavior. Registered the single-instance plugin before other plugins and moved shared-state loading into app setup so rejected launches do not read/write shared state. Updated the installed executable and Desktop installer.
- Recovery verification: Release build and six desktop JS tests passed. `scripts/verify-desktop-single-instance.ps1` verified visible, minimized, and close-to-tray launches against the installed binary: the original PID remained, each duplicate exited with code 0, and the original window became visible, non-minimized, and foreground. Desktop installer hash matches its build source. The installed executable hash differs from the loose build executable; the reason was not established, so no binary-equivalence claim is made. Actual behavior was verified on the installed executable. App remains open.
- Verification correction: Initial checks selected a helper window during startup and externally overrode visibility. The probe now waits for the actual EasyDoc main window and uses its real close-to-tray event; all three checks passed after a fresh launch. No user settings were changed for testing.
- Follow-up: Duplicate-instance behavior is resolved for the updated binary. Name-save persistence itself was not independently exercised. Explicit save feedback remains outside this fix.
