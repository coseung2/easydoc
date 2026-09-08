# Skills, HWPX generation, and bounded refactoring

Date: 2026-09-08. Status: implementation in progress.

## Basis and evidence boundary

User request: finish automatic and explicit `@skill` workflows, use the uploaded
`HWPX-SDK-조사보고서(1).md`, review the codebase, implement in staged commits,
and push only when this implementation track is complete.

The report recommends a TypeScript writer (`ownhwpx`), a separate Hancom quality
gate, and an optional future viewer. Its compatibility counts, popularity counts,
and ecosystem rankings are source claims, not measurements performed by EasyDoc.
We do not adopt its development-duration estimates or promise full HWPX editing.

Verification performed during this track:

- npm metadata: `ownhwpx@0.2.16`, Apache-2.0, Node >=18, published repository
  `https://gitlab.com/ownsoftware1/ownhwpx.git`. Runtime dependencies are `fflate`
  and `saxes`, not the report's `archiver` description. Inspect the published
  package and generated output before choosing the backend.
- npm metadata: `@ssabrojs/hwpxjs@0.4.0`, MIT; its repository documents HTML/MD
  import, data-URI images, and limited advanced controls. It is an alternative,
  not an automatic replacement for the report's preferred writer.
- Hancom package structure: https://tech.hancom.com/hwpxformat/
- Candidate sources: https://github.com/ssabro/hwpxjs and
  https://github.com/airmang/python-hwpx . Source/schema checks do not prove that
  Windows Hancom opens a generated file or lays it out correctly.

## Codebase review and boundaries

This is an architecture/seam review, not a claim that every line was audited.
The tree has five editors plus a shell, independent OOXML/PDF engines, shared
agent/provider/UI/file utilities, and the EasyDoc phone receiver packages.

1. **Git integration.** Local Rules/reasoning commits and unfinished skills had
   diverged from origin's ChatGPT OAuth/Windows work. Preserve both, including
   `ai:settings-changed` broadcasts and the rule that reading settings never
   silently changes the chosen provider. Incorporate upstream fixes by merge,
   not by replacing the fork or force-pushing.
2. **Skill loader.** The first implementation has no mention picker, reads a
   complete file before limiting length, and lets invalid `apps` metadata
   broaden availability. Its id grammar allows dots while mention parsing
   excludes them. Harden these boundaries and exercise actual UI interaction.
3. **Settings/provider integration.** Origin's allowlisted provider persistence
   can discard the newly added `reasoningEffort`. Add an explicit, validated
   preservation rule and regression tests; keep OAuth credentials main-only.
4. **Document creation.** The `docx/pdf/md` contract is repeated across tools,
   IPC, and main-process hooks. Add a shared generated-document contract and
   isolate the new HWPX mapper/writer from editor internals. Do not convert
   DOCX to HWPX or change normal DOCX round-trip saving.
5. **Large editor files.** Docs/Sheets/Slides App and main-process files are
   thousands of lines long. Extract reusable boundaries touched by this work;
   avoid a wholesale editor rewrite that increases upstream merge conflicts.
6. **Build/QA.** Renderer edits require editor builds, not just the shell build.
   New workspace imports need bundler exclusions. Add unit/contract tests,
   generated-file structural checks, and a documented Hancom manual matrix.
   Preserve existing Windows/OAuth/receiver checks and note native-toolchain
   failures separately from TypeScript regressions.

## Stages and completion criteria

### 0. Preserve and integrate the baseline

- Commit the previously uncommitted user-skill foundation after focused tests.
- Merge origin OAuth/Windows changes and upstream fixes; preserve both features.
- Commit this plan and integration regressions separately from later features.

### 1. Harden skills and settings

- One consistent id/mention grammar, including Korean and dotted ids.
- Invalid app restrictions fail closed; skip symlinks, non-files, oversized
  files, malformed metadata, duplicate ids, and unreadable entries safely.
- Bound catalog and activated instructions; unselected bodies stay out of
  model context. Rules do not grant new tools or OS execution permissions.
- Preserve reasoning settings and transient skill exclusion on settings save.
- Tests for both explicit and model-selected loading, limits, and persistence.

### 2. Complete explicit skill UX

- Shared `@` completion UI: search by id/name/description, app filtering,
  keyboard selection, mouse selection, Escape, and Korean IME safety.
- Wire all five editors; refresh local skill discovery without app restart.
- Keep ordinary email/text input and existing send/stop/paste behavior intact.
- Provide skill authoring documentation and safe starter workflows.

### 3. Implement an isolated HWPX generation engine

- Inspect the selected published SDK, license, exports, and output.
- Own the restricted-HTML mapper and isolate SDK types behind one exporter API.
- Initial scope: paragraphs/headings, inline emphasis, basic lists, alignment,
  rectangular tables, embedded images, A4 layout, explicit limitations.
- Reject unsafe/unsupported input rather than silently claiming preservation.
- Test ZIP/XML structure, style/resource references, Korean text, escaped text,
  tables/images, and deterministic structural output. No HWP5 writer, general
  DOCX conversion, or HWPX native editing in this track.

### 4. Integrate generated-document routing

- Expose `hwpx` consistently in relevant AI tool schemas and IPC validation.
- Save a new non-overwriting `.hwpx` file; return its path and verification
  status. Do not route an unsupported HWPX into the DOCX editor or overwrite
  the current source document.
- Retain existing DOCX/PDF/MD behavior and app-specific sheet export formats.
- Include bundler/package/CI wiring and integration regression tests.

### 5. Validate, document, commit, and push

- Run targeted suites, repository typechecking, lint/format/theme/license
  checks, and production builds affected by renderer/main/preload changes.
- Record exact results and environment blockers; no synthetic success claims.
- Produce a small Hancom manual-verification corpus/runbook. Mark HWPX as
  experimental until actual Hancom versions pass; schema or self-read-back is
  not the release-compatibility gate.
- Commit implementation stages; re-fetch origin, integrate any new work, then
  push normally. Confirm local HEAD equals origin/main after the push.

## Deliberately deferred

A full canonical document model replacing the DOCX editor model; HWP/HWPX
round-trip editing; rhwp preview integration; Python/JVM runtime distribution;
charts, equations, complex floating objects, exact pagination; automatic SDK
fallback; marketplace downloads or executable scripts in user skills.

These are a later product roadmap, not unfinished tasks silently hidden inside
this bounded implementation track. Actual Hancom GUI acceptance remains an
external release gate and must be reported separately.
