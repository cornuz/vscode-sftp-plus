# Changelog

All notable changes to the SFTP+ extension will be documented in this file.

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
