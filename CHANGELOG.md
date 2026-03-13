# Changelog

All notable changes to the SFTP+ extension will be documented in this file.

## [0.2.5] - 2026-03-13

### Added

- **🔍 Native Compare for tracked files** — Out-of-sync tracked files can now be opened in a native VS Code diff between the local working copy and the mounted host version.
- **🤖 Review with Agent** — When MCP is active on a host, tracked out-of-sync files now expose a dedicated `Review with Agent` action that opens the local file and asks the active agent to propose reviewable edits against the host version.

### Improved

- **🛡️ Safer sync actions in the file browser** — `Download` is now only offered when the host is newer or the file is not downloaded; `Upload` is only offered when the local tracked file is newer.
- **⚡ Immediate tracked-file refresh** — The host file tree now refreshes tracked statuses as soon as local tracked files are saved, created, or deleted under `.sftp-plus/{connection}/...`.

### Fixed

- **📝 Same-size local edits are now detected correctly** — A local modification that keeps the exact same file size no longer stays falsely `synced`; the tracking logic now detects the change and marks the file `local-newer` or `remote-newer` correctly.

## [0.2.4] - 2026-03-13

### Added

- **🖥️ Host session console** — Each host now has a persistent session console in Details with test/connect/reconnect/disconnect logs kept for the full VS Code session, including separators between runs.
- **🔄 Auto-reconnect on unattended disconnection** — New per-connection option to automatically reconnect when a mounted host drops unexpectedly.
- **⬆️ Upload action in host file browser** — Tracked files marked `local-newer` can now be uploaded directly from the SFTP+ file browser context menu.

### Improved

- **🔐 FTPS certificate recovery UX** — FTPS test/connect flows now classify certificate failures, surface them in the console, and offer an explicit UI path to enable certificate auto-accept.
- **🤖 MCP recovery guidance** — `list_connections` now exposes MCP state, autonomous reconnect availability, and explicit `recoveryAction` / `recoveryHint` fields so the agent can decide whether to reconnect immediately or ask for manual intervention.
- **📊 MCP tool availability after reload** — Language model tools are now registered eagerly at activation, improving discoverability before a host is manually resumed.

### Fixed

- **🛑 Removed hardcoded FTPS certificate bypass** — FTPS mounts no longer skip TLS validation unless `ignoreCertErrors` is explicitly enabled.
- **🔁 Autonomous reconnect after reload** — MCP reconnect can now recover using stored credentials when the in-memory session cache is gone, and temporary drive-drop errors are normalized into reconnect instructions.

## [0.2.3] - 2026-02-23

### Fixed

- **🤖 Agent autonomously reconnects without user intervention** — All `TEMPORARY:` error messages from file operation tools now include `ACTION REQUIRED: Call sftp-plus_reconnect` so the agent acts immediately instead of asking the user.
- **🔄 Reconnect kills stale rclone process first** — Mirrors the UI "Reconnect" button: kills any lingering process before mounting fresh, avoiding drive-letter conflicts.
- **🔑 Reconnect reuses cached password** — No UI password prompt during autonomous reconnection; the obscured password from the active session is reused directly.

## [0.2.2] - 2026-02-22

### Added

- **🔄 New AI Tool: `reconnect`** — Allows the AI agent to autonomously reconnect a dropped SFTP/FTP connection without user intervention, as long as credentials are already stored. The agent can detect a `TEMPORARY:` error from any file operation tool and immediately call `sftp-plus_reconnect` to restore the connection, then retry the operation — enabling fully autonomous multi-step workflows even when the connection is lost mid-task.

### Fixed

- **🔑 Autonomous reconnect actually works** — The previous `reconnect` tool called the same `connect()` path which, when the password was not in SecretStorage (e.g. entered interactively at first connect), would open a UI password prompt and block the agent indefinitely. A dedicated `reconnect()` method now reuses the **obscured password already cached in memory** from the previous session, bypassing the password lookup entirely. Falls back to the normal flow (with potential UI prompt) only if no cached password is available (e.g. after a VS Code restart).

- **🔄 Reconnect now kills stale rclone process first** — Mirrors the UI "Reconnect" button: kills any lingering rclone process before mounting fresh, avoiding drive-letter conflicts.

- **🤖 Agent now knows to call `sftp-plus_reconnect` on its own** — All `TEMPORARY:` error messages from file operation tools now include an explicit `ACTION REQUIRED: Call sftp-plus_reconnect` instruction. The tool `modelDescription` also directs the agent to call it immediately rather than asking the user. Previously the agent had no signal to trigger reconnect autonomously.

## [0.2.1] - 2026-02-11

### Added

- **💾 Original File Backup** - Server files are automatically backed up before any modification
  - Immutable snapshot stored in `.sftp-plus/originals/{connection}/`
  - Backup created on first edit only — never overwritten
  - Works across all entry points: AI tools, right-click Download, prepare_edit

- **🔄 New AI Tool: `get_sync_status`** - Returns sync status for all tracked files
  - Shows: synced / local-newer / remote-newer / not-downloaded
  - Includes file sizes, modification dates, and original backup status
  - Enables AI orchestrators to monitor batch operation progress

- **⏪ New AI Tool: `restore_original`** - Rollback to original server version
  - Restores the pre-modification backup to the local working copy
  - Original backup is preserved after restore for future reference

- **📊 File metadata in `list_files`** - Results now include `size` (bytes) and `modified` (ISO date) for each file

### Improved

- **🛡️ MCP Connection Stability**
  - Health check requires 3 consecutive failures before disconnecting (was 1)
  - Health check timeout increased from 3s to 5s
  - MCP suspend/resume: connection drops preserve AI write permissions
  - Auto-resume MCP on reconnection with all permissions intact
  - Drive accessibility retry (3 attempts × 2s) before failing
  - `TEMPORARY:` error messages guide AI agents to retry instead of abandoning
  - MCP state persisted in workspaceState across VS Code sessions

## [0.2.0] - 2026-01-29

### Added

- **🤖 GitHub Copilot Integration** - Copilot can now interact with your remote files!
  - Uses VS Code's Language Model Tools API (not an external MCP server)
  - Click the AI icon in the file browser to enable access per-host
  - **Local Mode** (green): Edit files locally with diff preview before uploading
  - **Host Mode** (red): Direct write access to remote server
  - 9 AI tools: `list_connections`, `list_files`, `read_file`, `write_file`, `prepare_edit`, `search_files`, `get_tree`, `list_writable_paths`, `request_write_access`

- **Automatic File Tracking** - Files in `.sftp-plus/` folder are automatically tracked on startup
  - No more manual Track/Untrack - the extension scans your local files automatically
  - Tracking data synced with `tracking.json`

- **Upload to Host Command** - Right-click local `.sftp-plus/` files to upload back to server
  - Available in Explorer context menu, editor context menu, and editor title
  - Automatically refreshes sync status after upload

### Changed

- **Sync Status Colors**:
  - Remote Newer: Red (`#ff0000`)
  - Local Newer: Blue (`#569cd6`)
  - Synced: Green (`#89d185`)
- **Sync Comparison Logic**: Same file size = Synced, different size = compare modification dates
- Extension display name changed to "SFTP+ MCP"

### Fixed

- FileTree now properly refreshes after download/upload operations
- Tracked files sync status updates immediately after file operations

## [0.1.5] - 2026-01-29

### Fixed

- **Critical: FTP/FTPS file sync issue** - Large files (>16KB) were not syncing to remote server
  - Root cause: FTP servers rejecting `.partial` temporary files during TLS uploads
  - Solution: Added `--inplace` flag to write directly to files without temporary files
  - This fix applies to all protocols (SFTP, FTP, FTPS)

### Added

- **Connection health monitoring** - Detects when connections are lost and updates UI automatically
  - Health check runs every 30 seconds via rclone RC API
  - Shows warning notification with "Reconnect" option when connection is lost
  - UI (tree view) updates immediately to reflect disconnected state

### Changed

- **Keep connections alive** - Changed default `idleTimeout` from `5m` to `0` (disabled)
  - Connections now stay open as long as VS Code is running
  - Can be overridden per-connection in settings if needed
- Improved FTP/FTPS connection reliability with additional rclone options:
  - `--inplace` - Write directly to files (all protocols)
  - `--low-level-retries 10` - More retries for network issues (all protocols)
  - `--ftp-disable-tls13` - Workaround for buggy TLS implementations
  - `--ftp-close-timeout 30s` - Longer timeout for data connection closure
  - `--ftp-shut-timeout 30s` - Longer timeout for connection close status

## [0.1.4] - 2026-01-12

### Fixed

- Delete button in connection settings now works (replaced blocked `confirm()` with VS Code native dialog)
- Codicons now display correctly when extension is installed from Marketplace (bundled in resources folder)
- Case-sensitivity issue with drive letter comparison on Windows
- Case-sensitivity issue with drive letter comparison on Windows

### Added

- **File Tracking System**: Track files for sync monitoring with visual status indicators
  - Context menu: Cloud Edit, Download, Track/Untrack files
  - Sync status colors: Red (not downloaded), Orange (newer version), Green (synced)
  - Tracking data stored in `.sftp-plus/tracking.json` (grouped by connection)
  - Downloaded files saved to `.sftp-plus/[connection]/` folder
- **SYNC RATE setting**: Auto-refresh interval for file browser (0 = disabled)
- **Cloud Edit indicator**: Status bar shows connection name when editing remote files
- **Refresh animation**: Spinning icon during file browser refresh
- Documentation for manual workspace configuration file (`.vscode/sftp_plus.json`)
- Documentation for password storage options

## [0.1.0] - 2026-01-09

### Added

- Initial release
- Connect/disconnect to FTPS and SFTP servers
- Mount remote filesystems as Windows drives via rclone + WinFsp
- Secure credential storage using VS Code SecretStorage
- TreeView for managing connections in the activity bar
- Status bar indicator showing active connections
- Add Connection wizard with protocol selection
- Auto-connect option for startup
- Prerequisite checker for rclone and WinFsp
- Configurable drive letters
- Support for self-signed certificates (ignoreCertErrors)
- Explicit TLS support for FTPS
- VFS caching for performance
- Keep-alive with configurable idle timeout
