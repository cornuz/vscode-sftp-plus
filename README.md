# SFTP+ MCP

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/cornuz-design.sftp-plus?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=cornuz-design.sftp-plus)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub](https://img.shields.io/github/stars/cornuz/vscode-sftp-plus?style=social)](https://github.com/cornuz/vscode-sftp-plus)

**Full read/write access to SFTP/FTPS servers in VS Code with AI/Copilot integration**

SFTP+ solves the read-only limitation of existing SFTP extensions by mounting remote servers as native Windows drives using [rclone](https://rclone.org/) and [WinFsp](https://winfsp.dev/). **NEW in v0.2.7**: the Host Details panel now keeps a stable tab order, switches more reliably between `Settings`, `Console`, and `Files`, and recovers more cleanly when a mounted drive becomes unreadable.

## Features

- 🤖 **Copilot Integration** - Give GitHub Copilot read/write access to remote files
- 🔌 **Connect/Disconnect** - Mount FTPS/SFTP servers as Windows drives
- 📁 **Full Read/Write** - Edit files directly, changes sync automatically
- 🖥️ **Session Console** - Inspect test/connect/reconnect logs per host in the Details view
- 🔐 **FTPS Certificate Recovery** - Detect certificate failures and enable auto-accept from the UI
- 🔐 **Secure Credentials** - Passwords stored in VS Code's secure storage
- 🚀 **Auto-Connect** - Optionally connect on VS Code startup
- 🔄 **Auto-Reconnect On Drop** - Restore an established connection after unattended disconnects
- 📊 **Status Bar** - See active connections at a glance
- 🌳 **Tree View** - Manage connections from the activity bar
- 📂 **File Browser** - Browse remote files directly in VS Code
- 🔍 **Visual Compare** - Open a native VS Code diff between local tracked files and the mounted host version
- 🤖 **Agent Review From Compare** - Ask the active MCP agent to review host differences against the opened local file
- ⚙️ **Hybrid Config** - Store connections globally or per-workspace

## 🤖 Copilot Integration

SFTP+ provides **Language Model Tools** that allow GitHub Copilot to interact directly with your remote files. This uses VS Code's native Language Model API - no external MCP server configuration required!

> **Note**: This feature is specific to GitHub Copilot in VS Code. It is not a standalone MCP server.

### How to Enable

1. Connect to your SFTP/FTPS server
2. In the file browser, click the **AI icon** (robot) next to a file or folder
3. Choose the access mode:
   - **🟢 Local Mode** - Copilot edits a local copy, you review changes with diff preview before uploading
   - **🔴 Host Mode** - Copilot writes directly to the remote server (use with caution)

### Available AI Tools

Once MCP is enabled, Copilot can use these tools:

| Tool | Description |
|------|-------------|
| `sftp-plus_list_connections` | List connections, MCP state, mounted drive, and explicit recovery action |
| `sftp-plus_list_files` | List files with metadata (size, modified date) |
| `sftp-plus_read_file` | Read file contents |
| `sftp-plus_write_file` | Write/create files (requires write permission) |
| `sftp-plus_prepare_edit` | Download file for local editing with diff preview |
| `sftp-plus_search_files` | Search for files by pattern |
| `sftp-plus_get_tree` | Get directory tree structure |
| `sftp-plus_get_sync_status` | Get sync status of all tracked files |
| `sftp-plus_restore_original` | Rollback a file to its original server version |
| `sftp-plus_reconnect` | Reconnect a dropped connection autonomously when stored credentials are available |

`sftp-plus_list_connections` now returns `recoveryAction`, `recoveryHint`, and `autonomousReconnectAvailable` so the agent can distinguish between immediate reconnect, manual reconnect, and no-op states after a drop or VS Code reload.

### Sync Status Indicators

Tracked files show their sync status with colors:
- 🔴 **Red** - Remote is newer (needs download)
- 🔵 **Blue** - Local is newer (needs upload)
- 🟢 **Green** - Synced

Local edits are detected even when the file size stays exactly the same. A small change like replacing `6` with `4` now correctly switches the tracked file to `local-newer`.

### Compare And Review

For tracked files that are out of sync:

- **Compare** opens a native VS Code side-by-side diff between the local tracked file and the currently mounted host version.
- **Review with Agent** appears when MCP is active for the host. It opens the local tracked file and asks the active agent to review host differences by proposing edits on the local file only, so you can accept or reject them through the normal Copilot review flow.

To avoid accidental overwrite actions:

- **Download** is only shown when the host is newer or the file is not downloaded locally.
- **Upload** is only shown when the local tracked file is newer.
- Compare/review actions are shown only for single-file tracked selections that are out of sync.

### Upload Changes

After editing a local copy, right-click the file and select **"Upload"** in the SFTP+ file browser, or use **"Upload to Host"** from the Explorer/editor commands, to sync your changes back to the server.

### Original File Backup

SFTP+ automatically backs up the original server version of every file before it's first modified — by an AI agent or a manual download. Backups are stored in `.sftp-plus/originals/` and are **never overwritten**, so you can always rollback to the pre-modification state.

```
.sftp-plus/
├── tracking.json              # Sync metadata
├── {connection}/              # Working copies (editable)
│   └── path/to/file.php
└── originals/                 # Immutable server snapshots
    └── {connection}/
        └── path/to/file.php
```

## Prerequisites

SFTP+ requires two external tools (Windows only). **The extension can install them automatically via winget** - just click on rclone or WinFsp in the SFTP+ panel.

### Manual installation (optional)

If you prefer to install manually:

**rclone:**
```powershell
winget install Rclone.Rclone
```

**WinFsp:**
```powershell
winget install WinFsp.WinFsp
```

> **Note**: A system reboot may be required after installing WinFsp.

## Quick Start

1. Install the extension
2. Open the SFTP+ panel in the Activity Bar
3. Click the prerequisites (rclone/WinFsp) to install if needed
4. Click **+** to add a new connection
5. Fill in server details and save
6. Click the connection to mount it as a Windows drive!

## Configuration

### Connection Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | string | *required* | Display name for the connection |
| `host` | string | *required* | Server hostname or IP |
| `port` | number | 21/22 | Server port (21 for FTP/FTPS, 22 for SFTP) |
| `protocol` | string | "ftps" | Protocol: "ftp", "ftps", or "sftp" |
| `username` | string | *required* | Username for authentication |
| `remotePath` | string | "/" | Remote path to mount |
| `driveLetter` | string | auto | Windows drive letter (e.g., "Z") |
| `explicitTls` | boolean | true | Use explicit TLS for FTPS |
| `ignoreCertErrors` | boolean | false | Auto-accept invalid FTPS certificates by skipping TLS validation |
| `autoConnect` | boolean | false | Connect on VS Code startup |
| `autoReconnectOnDrop` | boolean | false | Auto-reconnect when an established connection drops unexpectedly |
| `cacheMode` | string | "full" | VFS cache mode |
| `idleTimeout` | string | "0" | Keep-alive timeout (0 = disabled) |

> **Note**: `idleTimeout` is set to `0` by default since v0.1.5, meaning connections stay open as long as VS Code is running. The extension monitors connection health and will notify you if a connection is lost.

### Storage Options

Connections can be stored in two locations:

- **Global** (`settings.json`) - Available in all workspaces
- **Workspace** (`.vscode/sftp_plus.json`) - Specific to current workspace

Passwords are stored securely in VS Code's SecretStorage, or optionally in the workspace JSON file.

### Workspace Configuration File

You can create or edit `.vscode/sftp_plus.json` manually to configure connections for your workspace:

```json
{
  "connections": [
    {
      "name": "My Server",
      "host": "ftp.example.com",
      "port": 21,
      "protocol": "ftps",
      "username": "myuser",
      "password": "mypassword",
      "remotePath": "/",
      "driveLetter": "Z",
      "autoConnect": false,
      "autoReconnectOnDrop": false,
      "explicitTls": true,
      "ignoreCertErrors": false
    }
  ]
}
```

#### Password Storage Options

| Method | Location | Security | Use Case |
|--------|----------|----------|----------|
| **SecretStorage** | VS Code secure storage | ✅ Encrypted | Recommended for most users |
| **Workspace JSON** | `.vscode/sftp_plus.json` | ⚠️ Plain text | Shared team configs, CI/CD |

To store the password in the workspace file, simply add the `password` field to your connection object. If omitted, SFTP+ will prompt for the password and store it securely in VS Code's SecretStorage.

> **⚠️ Security Warning**: If you add passwords to `sftp_plus.json`, make sure to add `.vscode/sftp_plus.json` to your `.gitignore` to avoid committing credentials to version control.

### Extension Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sftp-plus.rclonePath` | string | "" | Custom path to rclone executable |
| `sftp-plus.showStatusBar` | boolean | true | Show status bar indicator |
| `sftp-plus.logLevel` | string | "info" | Log verbosity (debug/info/warn/error) |

## Commands

| Command | Description |
|---------|-------------|
| `SFTP+: Connect` | Connect to a server |
| `SFTP+: Disconnect` | Disconnect from a server |
| `SFTP+: Disconnect All` | Disconnect all active connections |
| `SFTP+: Add Connection` | Add a new connection |
| `SFTP+: Refresh Connections` | Reload connection list |
| `SFTP+: Open in File Explorer` | Open mounted drive in Windows Explorer |

## How It Works

1. SFTP+ uses **rclone** to connect to your FTPS/SFTP server
2. **WinFsp** creates a virtual Windows drive
3. The remote filesystem is mounted to a drive letter (e.g., Z:)
4. VS Code can read/write files as if they were local
5. rclone syncs changes back to the server automatically

> **Note**: SFTP+ uses the `--inplace` option to write directly to files without temporary `.partial` files. This ensures maximum compatibility with FTP/FTPS servers.

## Limitations

- **Windows only** - WinFsp is Windows-specific
- **External dependencies** - Requires rclone and WinFsp installation
- **Network-dependent** - Performance depends on server latency

## Troubleshooting

### "rclone not found"

Make sure rclone is installed and in your PATH:
```powershell
rclone version
```

### "WinFsp not installed"

Install WinFsp and reboot if necessary:
```powershell
winget install WinFsp.WinFsp
```

### Connection fails

1. Check server address and port
2. Verify username and password
3. For FTPS certificate failures, open the host **Console** tab and enable `ignoreCertErrors` if you want to auto-accept the certificate
4. Check the host **Console** tab and the Output panel (View → Output → SFTP+) for logs

> **Fix in 0.2.7**: the Host Details panel now keeps a stable `Settings > Console > Files` order, returns focus to `Console` during disconnect, and switches to `Files` as soon as the mounted drive is ready. Together with the 0.2.6 mount-recovery work, this removes the tab flashing and inconsistent post-connect focus observed during reconnect and new-session testing.

### Drive not appearing

The mount may take a few seconds. Check for available drive letters.

## Contributing

Issues and pull requests welcome on [GitHub](https://github.com/cornuz/vscode-sftp-plus).

## License

MIT © 2026 Raphael Cornuz
