# AI model selection appeared to reset

- Date: 2026-09-08, Asia/Seoul (UTC+09:00).
- Status: corrected and verified in the built Electron application.

## Symptoms and impact

A saved OpenAI model appeared to revert to Genspark when settings were reopened.
Editors already open could continue sending requests with their previous provider.
This prevented the selected ChatGPT account model from being applied reliably.

## Confirmed causes

- The saved OpenAI configuration had a model but no API key or explicit auth mode.
  Its encrypted account file was present. No token contents were inspected.
- Main-process settings getters replaced the persisted provider with the
  `activeProvider` fallback when credentials appeared incomplete. The chosen model
  remained on disk, but the returned selection appeared reset.
- Docs, Slides, and Sheets loaded AI settings only when mounted. Embedded tabs
  do not reliably regain window focus on activation, so focus-only reloads were
  insufficient.
- Sheets' renderer readiness check accepted API keys and Genspark but rejected
  keyless OAuth settings before reaching the main process.

## Correction

- Return the saved provider instead of replacing it during settings reads.
- Normalize legacy OpenAI settings without a key, custom endpoint, or explicit
  auth mode to OAuth. Explicit API-key choices and custom endpoints remain intact.
- After saving, send a payload-free notification to editor preloads. Docs, Slides,
  and Sheets reload settings through their existing IPC bridge. Stale replies and
  replies after disposal are ignored; focus provides a retry opportunity.
- Accept OpenAI OAuth in Sheets' configuration check.
- Rebuilt the shell and all three affected editor/preload bundles.

## Verification

- AI provider suite: 253 tests passed, including migration and refresh ordering.
- Real Electron, isolated profile: legacy keyless OpenAI selection opens as OAuth;
  selecting Astra survives closing/reopening settings and a full app restart.
- Real Electron, already-open Docs, Slides, and Sheets: change the saved model,
  return to the editor, and submit a prompt. Intercepted requests carry OpenAI,
  `gpt-6-astra`, and OAuth. Network calls were replaced with synthetic responses;
  no real account quota was used.
- Shell, Docs, Slides, and Sheets TypeScript checks passed.

## Follow-up

Settings persistence checks must include reopening and restarting, and provider
application checks must cover editors opened before settings changed. Do not
equate a saved model name or a successful settings-only test with live model use.
