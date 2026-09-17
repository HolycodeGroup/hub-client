# Holycode Hub — Claude Code client

Install the Holycode Hub client into Claude Code with two commands. **No repo clone. No
`claude mcp add`. No access to the method.** The plugin is a thin set of `/hub:*` command
stubs plus a rule/command sync — the licensed OAuth credential is the value.

## Prerequisites

1. **Get a credential.** Your Holycode admin creates your org + a `DEVELOPER` member and
   issues you a credential (or you sign in through the Hub's OAuth flow — the consent page
   takes your member id). You do not need any Holycode source repository.

## Install (two commands)

```
/plugin marketplace add HolycodeGroup/hub-client
/plugin install holycode-hub@holycode-hub
```

Installing the plugin **auto-activates its bundled MCP server** — you never run
`claude mcp add`. On your first Hub call, Claude Code runs its native OAuth flow (the Hub
serves discovery, PKCE and dynamic registration); sign in there.

## First run

1. `/hub:init <project-id>` — join the project your owner shares with you.
2. `/hub:claim <story-id>` — claim a story; the first claim syncs the framework rules and
   command cards into the plugin.
3. **Restart Claude Code** after the first claim. Claude Code registers commands at session
   start, so the synced framework commands (`/generate-docs`, `/run-tests`, …) appear in
   the **next** session, not mid-session.

## What you get

- The `/hub:*` coordination commands: `init`, `plan`, `estimate`, `export`, `status`,
  `claim`, `sync`, `verify`, `complete`, `release`.
- The framework command cards, synced on the first `/hub:claim` (thin command surface that
  points at the synced framework rules — no orchestration steps).

## What you never get

- **No method.** The plugin ships zero orchestration — no `commands/modules/`, no method
  steps, no calibration constants. Nothing from the private method repository.
- The empty rule/command caches ship empty and are filled only at runtime, on your machine,
  from the Hub over your licensed credential.

The plugin is a bearer-of-nothing: a set of stubs, hooks, apply scripts and a URL. The value
is the credential the Hub honours, not any content on disk.

## Hub URL

This client currently talks to the Hub at `https://rd-hub-staging.up.railway.app/mcp`
(Railway staging — where the full tool surface, including claim-free command delivery, is
deployed and the database is seeded for testing). It moves to `https://hub.holycode.com/mcp`
later; when it does, a new marketplace release ships the updated URL — reinstall to pick it up.
