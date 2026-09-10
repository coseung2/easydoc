# Font detection and local installation

- Date: 2026-09-09, Asia/Seoul (UTC+09:00).
- Status: installation verified; favorite aliases updated.
- Symptoms: manually seeded favorite names did not match Windows family names.
- Evidence: pre-install Electron enumeration found 152 families / 384 faces;
  the four requested families were absent from both registry and runtime.
- Recovery: installed 30 validated font files from the user's OneDrive font
  folder plus Jua from Woowahan and AndongKaturi from the Korea Copyright
  Commission. Registered per-user files and broadcast the Windows font change.
- Download handling: the Andong ZIP response was gzip encoded and included
  AppleDouble metadata; decoded the response and excluded metadata before
  validating fonts. No invalid font was installed.
- Verification: fresh Electron enumeration found 413 faces including
  GangwonEduAll, GangwonEduPower, GangwonEduSaeeum, GangwonEduHyeonokT,
  Gmarket Sans TTF, BM JUA_TTF, and AndongKaturi.
- Prevention: resolve Korean search aliases to actual available family names;
  refresh local-font enumeration whenever the picker opens. Never interpret
  a display-name mismatch alone as proof a font is absent.
- Local file/hash installation inventory: `.task/font-install-report.json`.
