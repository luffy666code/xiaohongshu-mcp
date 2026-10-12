# Changelog

## 2.0.0

- First public release as a platform-agnostic stdio MCP server.
- 18 typed MCP tools across login, publishing (image + video), reading, interaction, and notifications.
- Reuses the locally installed browser via `playwright-core` (no browser download).
- Persistent local login state with account switching support.
- Risk-aware error handling for Xiaohongshu anti-bot interception.
- Ships 8 companion Agent Skills under `skills/`.
- Cross-platform distribution packager (`npm run pack`) and smoke test.
