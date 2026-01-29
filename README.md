# SFTP+ MCP

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/cornuz-design.sftp-plus?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=cornuz-design.sftp-plus)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub](https://img.shields.io/github/stars/cornuz/vscode-sftp-plus?style=social)](https://github.com/cornuz/vscode-sftp-plus)

**Full read/write access to SFTP/FTPS servers in VS Code with AI/Copilot integration**

SFTP+ solves the read-only limitation of existing SFTP extensions by mounting remote servers as native Windows drives using [rclone](https://rclone.org/) and [WinFsp](https://winfsp.dev/). **NEW in v0.2.0**: MCP Server integration gives GitHub Copilot direct access to your remote files!

## Features

- 🤖 **Copilot Integration** - Give GitHub Copilot read/write access to remote files
- 🔌 **Connect/Disconnect** - Mount FTPS/SFTP servers as Windows drives
- 📁 **Full Read/Write** - Edit files directly, changes sync automatically
- 🔐 **Secure Credentials** - Passwords stored in VS Code's secure storage
- 🚀 **Auto-Connect** - Optionally connect on VS Code startup
- 📊 **Status Bar** - See active connections at a glance
- 🌳 **Tree View** - Manage connections from the activity bar
- 📂 **File Browser** - Browse remote files directly in VS Code
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
| `sftp-plus_list_connections` | List all available SFTP/FTP connections |
| `sftp-plus_list_files` | List files in a directory |
| `sftp-plus_read_file` | Read file contents |
| `sftp-plus_write_file` | Write/create files (requires write permission) |
| `sftp-plus_prepare_edit` | Download file for local editing with diff preview |
| `sftp-plus_search_files` | Search for files by pattern |
| `sftp-plus_get_tree` | Get directory tree structure |

### Sync Status Indicators

Tracked files show their sync status with colors:
- 🔴 **Red** - Remote is newer (needs download)
- 🔵 **Blue** - Local is newer (needs upload)
- 🟢 **Green** - Synced

### Upload Changes

After editing a local copy, right-click the file and select **"Upload to Host"** to sync your changes back to the server.

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
| `ignoreCertErrors` | boolean | false | Ignore SSL certificate errors |
| `autoConnect` | boolean | false | Connect on VS Code startup |
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
3. For self-signed certificates, enable `ignoreCertErrors`
4. Check the Output panel (View → Output → SFTP+) for logs

### Drive not appearing

The mount may take a few seconds. Check for available drive letters.

## Contributing

Issues and pull requests welcome on [GitHub](https://github.com/cornuz/vscode-sftp-plus).

## License

MIT © 2026 Raphael Cornuz
