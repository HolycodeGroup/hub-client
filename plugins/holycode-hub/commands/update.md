---
description: Update this plugin to the published version in one step — refreshes the marketplace and updates the plugin through the Claude Code CLI, then says to restart
---
1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/update-plugin.mjs"` and show the developer its report as printed. It refreshes the holycode-hub marketplace, then updates this plugin through the Claude Code CLI (`claude plugin update`), each step with a timeout.
2. When it reports an update (`updated <old> → <new>`), tell the developer to restart Claude Code: plugins load only at startup, so the new version and its commands appear after the restart. When it reports the plugin is already current, say so — nothing needs a restart.
3. On a non-zero exit, relay the failed step, its reason and the manual steps the script printed. Never retry in a loop, never edit Claude Code's settings or the plugin cache yourself, and never accept a marketplace-declared install command on the developer's behalf. This command makes no Hub call. Make no further Hub calls for this step.
