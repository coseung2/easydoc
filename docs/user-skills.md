# User skills

## Use a skill

Open Settings → AI Model → AI Skills → Open skills folder. The folder is
`agent-skills` under the application's own user-data directory. Opening it creates
an authoring README; it does not download plugins or execute anything.

Copy a skill folder from `docs/skill-examples/` into that directory, or create your
own. Focus the AI chat input again to refresh discovery. Type `@` to open the
picker; search by id, title, or description. Select with the mouse, Enter, or Tab;
use the arrow keys to move and Escape to dismiss. Korean IME Enter does not submit
an unfinished composition.

For example:

```text
@official-letter 아래 내용을 협조 요청 공문으로 작성해줘.
@report @meeting-minutes 이 회의 기록을 보고서로 정리해줘.
```

The exact folder name is the invocation id. The picker inserts that id, even when
you found it by its Korean display name. Explicit selections attach their full
instructions to the first request. Without `@`, the model sees only the catalog
and may call `load_skill` for a matching workflow. This is an instruction/tool
mechanism, not a guarantee that every model will choose the best workflow.

All five editors use the same mention parser and picker. Email addresses, URLs,
and fenced/inline code examples are not treated as skill invocations. A missing
or app-incompatible explicit id is reported to the model as not loaded; it must
not pretend the workflow was applied.

## Authoring format

```text
agent-skills/
  official-letter/
    SKILL.md
```

```markdown
---
name: 공문 작성
description: 공공기관 협조 요청과 기안문 작성
apps: [docs, markdown]
---

# Workflow

Preserve the supplied facts. Identify missing dates and recipients instead of
inventing them. Draft the content, check it against the source, then summarize
what was actually changed.
```

`apps` may be omitted to allow all editors. Supported values are `docs`, `sheets`,
`slides`, `pdf`, and `markdown`. Comma-separated values, inline arrays, and
indented YAML block lists are accepted. Empty or misspelled restrictions disable
the file rather than accidentally allowing it everywhere.

The supported frontmatter subset includes quoted scalar names/descriptions and
`>`/`|` description blocks. Other metadata is ignored; arbitrary YAML constructs
are not supported. The body is Markdown instructions, not executable code.

Ids contain letters (Korean included), digits, dots, underscores, or hyphens,
start with a letter/digit, and must not end with a full stop. Flat `<id>.md` files
are also accepted. Folder skills take precedence over same-id flat files.

## Limits and privacy

Each UTF-8 file is limited to 64,000 bytes, checked before reading. Discovery is
limited to 50 valid skills and 1,024,000 bytes in deterministic order. Symlinks,
non-files, malformed frontmatter, duplicate ids, and unreadable entries are
skipped. `README.md` is not a skill. At most eight skills may be explicitly
selected, with a 64,000-character total instruction budget per request; automatic
loads share that budget. Exceeded selections are reported, not silently applied.

Skill bodies are runtime data and are excluded from `ai-settings.json`. Unselected
bodies are not sent to the model. Selected bodies are sent to the configured AI
provider just like the document context, so never include passwords or secrets.
Install only instructions you trust. Skills cannot add tools, bypass tool
permissions, or execute bundled scripts. Existing document-integrity and tool
rules remain authoritative.

A skill catalog is snapshotted for each agent request. Editing files while a run
is in progress does not change that run. Refresh input focus before the next run
to pick up changes. Previous conversation text can still mention a formerly
loaded skill; the prompt marks workflows as scoped to the request that loaded
them rather than as permanent Rules.

## Rules versus skills

AI Rules apply to all requests and belong in Settings. Skills hold task-specific
procedures loaded only when needed. Neither adds a document format by itself:
HWPX generation requires the separate exporter, not a skill that invents XML.
