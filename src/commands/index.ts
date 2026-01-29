import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connection.manager';
import { ConnectionTreeProvider, ConnectionTreeItem } from '../providers/connection.tree.provider';
import { HostDetailsProvider } from '../providers/host.details.provider';
import { PrerequisiteChecker } from '../services/prerequisite.checker';
import { ConnectionConfig, DEFAULT_CONNECTION_CONFIG } from '../models';
import { McpManager } from '../mcp';
import { exec } from 'child_process';

/**
 * Extract connection name from argument (can be string or TreeItem)
 */
function extractConnectionName(arg: string | ConnectionTreeItem | undefined): string | undefined {
  if (!arg) return undefined;
  if (typeof arg === 'string') return arg;
  if (arg instanceof ConnectionTreeItem) return arg.connection.config.name;
  return undefined;
}

/**
 * Register all extension commands
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  connectionManager: ConnectionManager,
  treeProvider: ConnectionTreeProvider,
  prerequisiteChecker: PrerequisiteChecker,
  hostDetailsProvider?: HostDetailsProvider,
  mcpManager?: McpManager
): void {

  // Connect command
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.connect', async (arg?: string | ConnectionTreeItem) => {
      let name = extractConnectionName(arg);

      if (!name) {
        // Show picker if no name provided
        const connections = connectionManager.getConnections()
          .filter(c => c.status === 'disconnected');

        if (connections.length === 0) {
          vscode.window.showInformationMessage('No disconnected connections available');
          return;
        }

        const picked = await vscode.window.showQuickPick(
          connections.map(c => ({
            label: c.config.name,
            description: `${c.config.protocol}://${c.config.host}`,
          })),
          { placeHolder: 'Select connection to mount' }
        );

        if (picked) {
          name = picked.label;
        }
      }

      if (name) {
        await connectionManager.connect(name);
      }
    })
  );

  // Disconnect command
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.disconnect', async (arg?: string | ConnectionTreeItem) => {
      let name = extractConnectionName(arg);

      if (!name) {
        const connections = connectionManager.getActiveConnections();

        if (connections.length === 0) {
          vscode.window.showInformationMessage('No active connections');
          return;
        }

        const picked = await vscode.window.showQuickPick(
          connections.map(c => ({
            label: c.config.name,
            description: `${c.mountedDrive}:`,
          })),
          { placeHolder: 'Select connection to unmount' }
        );

        if (picked) {
          name = picked.label;
        }
      }

      if (name) {
        await connectionManager.disconnect(name);
      }
    })
  );

  // Disconnect all command
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.disconnectAll', async () => {
      await connectionManager.disconnectAll();
    })
  );

  // Open remote file command (opens in non-preview mode for full editing)
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.openRemoteFile', async (uri: vscode.Uri) => {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to open file: ${error}`);
      }
    })
  );

  // Add connection command
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.addConnection', async () => {
      if (hostDetailsProvider) {
        // Use webview form
        hostDetailsProvider.showNewConnectionForm();
      } else {
        // Fallback to step-by-step wizard
        const config = await promptForConnectionConfig();
        if (config) {
          await connectionManager.addConnection(config);
          vscode.window.showInformationMessage(`Connection "${config.name}" added`);
        }
      }
    })
  );

  // Edit connection command
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.editConnection', async (arg?: string | ConnectionTreeItem) => {
      let name = extractConnectionName(arg);

      if (!name) {
        const connections = connectionManager.getConnections();
        const picked = await vscode.window.showQuickPick(
          connections.map(c => ({ label: c.config.name })),
          { placeHolder: 'Select connection to edit' }
        );
        if (picked) {
          name = picked.label;
        }
      }

      if (name && hostDetailsProvider) {
        const connection = connectionManager.getConnection(name);
        if (connection) {
          hostDetailsProvider.showConnectionSettings(connection);
        }
      } else if (name) {
        // Fallback to settings
        vscode.window.showInformationMessage(
          'Edit connection: Open Settings and modify sftp-plus.connections'
        );
        vscode.commands.executeCommand('workbench.action.openSettings', 'sftp-plus.connections');
      }
    })
  );

  // Remove connection command
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.removeConnection', async (arg?: string | ConnectionTreeItem) => {
      let name = extractConnectionName(arg);

      if (!name) {
        const connections = connectionManager.getConnections();
        const picked = await vscode.window.showQuickPick(
          connections.map(c => ({ label: c.config.name })),
          { placeHolder: 'Select connection to remove' }
        );
        if (picked) {
          name = picked.label;
        }
      }

      if (name) {
        const confirm = await vscode.window.showWarningMessage(
          `Remove connection "${name}"?`,
          { modal: true },
          'Remove'
        );

        if (confirm === 'Remove') {
          try {
            await connectionManager.removeConnection(name);
            vscode.window.showInformationMessage(`Connection "${name}" removed`);
          } catch (error) {
            vscode.window.showErrorMessage(`Failed to remove: ${error}`);
          }
        }
      }
    })
  );

  // Check prerequisites command
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.checkPrerequisites', async () => {
      await prerequisiteChecker.showInstallWizard();
    })
  );

  // Install rclone command
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.installRclone', async () => {
      await prerequisiteChecker.installRclone(context);
    })
  );

  // Install WinFsp command
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.installWinFsp', async () => {
      await prerequisiteChecker.installWinFsp();
    })
  );

  // Download WinFsp command (fallback)
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.downloadWinFsp', async () => {
      await prerequisiteChecker.downloadWinFsp();
    })
  );

  // Show prerequisite details command
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.showPrerequisiteDetails', (name: 'rclone' | 'WinFsp', status: { installed: boolean; version?: string }) => {
      if (hostDetailsProvider) {
        hostDetailsProvider.setPrerequisite(name, status);
      }
    })
  );

  // Refresh command
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.refresh', () => {
      connectionManager.refresh();
      treeProvider.refresh();
    })
  );

  // Browse connection command (show files in panel)
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.browseConnection', async (arg?: string | ConnectionTreeItem) => {
      const name = extractConnectionName(arg);
      if (name && hostDetailsProvider) {
        const connection = connectionManager.getConnection(name);
        if (connection && connection.status === 'connected' && connection.mountedDrive) {
          hostDetailsProvider.showFileBrowser(connection);
        } else if (connection && connection.status !== 'connected') {
          vscode.window.showInformationMessage(`Connect to "${name}" first to browse files`);
        }
      }
    })
  );

  // Open in Explorer command
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.openInExplorer', async (arg?: string | ConnectionTreeItem) => {
      let name = extractConnectionName(arg);
      let driveLetter: string | undefined;

      if (name) {
        const connection = connectionManager.getConnection(name);
        driveLetter = connection?.mountedDrive;
      } else {
        const connections = connectionManager.getActiveConnections();
        if (connections.length === 1) {
          driveLetter = connections[0].mountedDrive;
        } else if (connections.length > 1) {
          const picked = await vscode.window.showQuickPick(
            connections.map(c => ({
              label: c.config.name,
              description: `${c.mountedDrive}:`,
            })),
            { placeHolder: 'Select connection to open' }
          );
          if (picked) {
            const conn = connectionManager.getConnection(picked.label);
            driveLetter = conn?.mountedDrive;
          }
        }
      }

      if (driveLetter) {
        const path = `${driveLetter}:\\`;
        exec(`explorer "${path}"`);
      }
    })
  );

  // Start MCP command
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.startMcp', async (arg?: string | ConnectionTreeItem) => {
      if (!mcpManager) {
        vscode.window.showErrorMessage('MCP manager not available');
        return;
      }

      let name = extractConnectionName(arg);

      if (!name) {
        // Show picker for connected hosts without MCP
        const connections = connectionManager.getActiveConnections()
          .filter(c => !c.mcpActive);

        if (connections.length === 0) {
          vscode.window.showInformationMessage('No connected hosts available for Copilot access');
          return;
        }

        const picked = await vscode.window.showQuickPick(
          connections.map(c => ({
            label: c.config.name,
            description: `${c.mountedDrive}:`,
          })),
          { placeHolder: 'Select host to enable Copilot access' }
        );

        if (picked) {
          name = picked.label;
        }
      }

      if (name) {
        try {
          await mcpManager.startMcp(name);
          treeProvider.refresh();
          hostDetailsProvider?.refreshCurrentConnection();
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to enable Copilot access: ${error}`);
        }
      }
    })
  );

  // Stop MCP command
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.stopMcp', async (arg?: string | ConnectionTreeItem) => {
      if (!mcpManager) {
        vscode.window.showErrorMessage('MCP manager not available');
        return;
      }

      let name = extractConnectionName(arg);

      if (!name) {
        // Show picker for MCP-enabled hosts
        const connections = connectionManager.getActiveConnections()
          .filter(c => c.mcpActive);

        if (connections.length === 0) {
          vscode.window.showInformationMessage('No hosts with Copilot access enabled');
          return;
        }

        const picked = await vscode.window.showQuickPick(
          connections.map(c => ({
            label: c.config.name,
            description: `${c.mountedDrive}:`,
          })),
          { placeHolder: 'Select host to disable Copilot access' }
        );

        if (picked) {
          name = picked.label;
        }
      }

      if (name) {
        try {
          await mcpManager.stopMcp(name);
          treeProvider.refresh();
          hostDetailsProvider?.refreshCurrentConnection();
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to disable Copilot access: ${error}`);
        }
      }
    })
  );

  // Toggle AI write access command
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.toggleAiWrite', async (connectionName: string, filePath: string) => {
      if (!mcpManager) {
        return;
      }

      mcpManager.toggleAiWriteAccess(connectionName, filePath);
      hostDetailsProvider?.refreshCurrentConnection();
    })
  );

  // Allow AI write on folder command
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.allowAiWriteFolder', async (connectionName: string, folderPath: string) => {
      if (!mcpManager) {
        return;
      }

      await mcpManager.allowAiWriteOnFolder(connectionName, folderPath);
      hostDetailsProvider?.refreshCurrentConnection();
    })
  );

  // Revoke AI write on folder command
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.revokeAiWriteFolder', async (connectionName: string, folderPath: string) => {
      if (!mcpManager) {
        return;
      }

      await mcpManager.revokeAiWriteOnFolder(connectionName, folderPath);
      hostDetailsProvider?.refreshCurrentConnection();
    })
  );

  // Upload to host command - uploads local .sftp-plus file back to server
  context.subscriptions.push(
    vscode.commands.registerCommand('sftp-plus.uploadToHost', async (uri?: vscode.Uri) => {
      // Get the file URI from argument or active editor
      let fileUri = uri;
      if (!fileUri && vscode.window.activeTextEditor) {
        fileUri = vscode.window.activeTextEditor.document.uri;
      }

      if (!fileUri) {
        vscode.window.showErrorMessage('No file selected for upload');
        return;
      }

      const localPath = fileUri.fsPath;

      // Check if file is in .sftp-plus folder
      const sftpPlusMatch = localPath.match(/[/\\]\.sftp-plus[/\\]([^/\\]+)[/\\](.+)$/);
      if (!sftpPlusMatch) {
        vscode.window.showErrorMessage('This file is not in a .sftp-plus folder');
        return;
      }

      const connectionName = sftpPlusMatch[1];
      const relativePath = sftpPlusMatch[2].replace(/\\/g, '/');

      // Find the connection
      const connection = connectionManager.getConnection(connectionName);
      if (!connection) {
        vscode.window.showErrorMessage(`Connection "${connectionName}" not found`);
        return;
      }

      if (!connection.mountedDrive) {
        vscode.window.showErrorMessage(`Connection "${connectionName}" is not mounted. Please connect first.`);
        return;
      }

      // Construct remote path
      const remotePath = `${connection.mountedDrive}:\\${relativePath.replace(/\//g, '\\')}`;

      try {
        // Check if local file exists
        const fs = await import('fs');
        if (!fs.existsSync(localPath)) {
          vscode.window.showErrorMessage(`Local file not found: ${localPath}`);
          return;
        }

        // Save the file first if it has unsaved changes
        const document = vscode.workspace.textDocuments.find(d => d.uri.fsPath === localPath);
        if (document?.isDirty) {
          await document.save();
        }

        // Copy to remote
        await fs.promises.copyFile(localPath, remotePath);

        const fileName = localPath.split(/[/\\]/).pop();
        vscode.window.showInformationMessage(`Uploaded "${fileName}" to ${connectionName}`);

        // Refresh tracked files to update sync status display
        await hostDetailsProvider?.refreshTrackedFiles();

      } catch (error) {
        vscode.window.showErrorMessage(`Failed to upload: ${error}`);
      }
    })
  );
}

/**
 * Prompt user for new connection configuration
 */
async function promptForConnectionConfig(): Promise<ConnectionConfig | undefined> {
  // Name
  const name = await vscode.window.showInputBox({
    prompt: 'Connection name',
    placeHolder: 'My Server',
    validateInput: (value) => value ? null : 'Name is required',
  });
  if (!name) { return undefined; }

  // Host
  const host = await vscode.window.showInputBox({
    prompt: 'Server hostname or IP',
    placeHolder: 'ftp.example.com',
    validateInput: (value) => value ? null : 'Host is required',
  });
  if (!host) { return undefined; }

  // Protocol
  const protocol = await vscode.window.showQuickPick(
    [
      { label: 'FTPS', description: 'FTP over TLS (recommended)', value: 'ftps' },
      { label: 'FTP', description: 'Plain FTP (insecure)', value: 'ftp' },
      { label: 'SFTP', description: 'SSH File Transfer Protocol', value: 'sftp' },
    ],
    { placeHolder: 'Select protocol' }
  );
  if (!protocol) { return undefined; }

  // Port
  const defaultPort = protocol.value === 'sftp' ? '22' : '21';
  const portStr = await vscode.window.showInputBox({
    prompt: 'Port',
    value: defaultPort,
    validateInput: (value) => {
      const num = parseInt(value);
      return (num > 0 && num < 65536) ? null : 'Invalid port number';
    },
  });
  if (!portStr) { return undefined; }

  // Username
  const username = await vscode.window.showInputBox({
    prompt: 'Username',
    placeHolder: 'user@example.com',
    validateInput: (value) => value ? null : 'Username is required',
  });
  if (!username) { return undefined; }

  // Build config with defaults
  const config: ConnectionConfig = {
    ...DEFAULT_CONNECTION_CONFIG as ConnectionConfig,
    name,
    host,
    port: parseInt(portStr),
    protocol: protocol.value as 'ftp' | 'ftps' | 'sftp',
    username,
  };

  // Advanced options?
  const showAdvanced = await vscode.window.showQuickPick(
    [
      { label: 'Use defaults', description: 'Save with default settings' },
      { label: 'Configure advanced options', description: 'Set drive letter, TLS options, etc.' },
    ],
    { placeHolder: 'Additional configuration?' }
  );

  if (showAdvanced?.label === 'Configure advanced options') {
    // Drive letter
    const driveLetter = await vscode.window.showInputBox({
      prompt: 'Drive letter (leave empty for auto-assign)',
      placeHolder: 'Z',
      validateInput: (value) => {
        if (!value) { return null; }
        if (!/^[A-Z]$/i.test(value)) { return 'Single letter A-Z'; }
        return null;
      },
    });
    if (driveLetter) {
      config.driveLetter = driveLetter.toUpperCase();
    }

    // Ignore cert errors (for FTPS)
    if (protocol.value === 'ftps') {
      const ignoreCert = await vscode.window.showQuickPick(
        [
          { label: 'No', description: 'Verify SSL certificates (recommended)', value: false },
          { label: 'Yes', description: 'Ignore certificate errors (for self-signed)', value: true },
        ],
        { placeHolder: 'Ignore SSL certificate errors?' }
      );
      if (ignoreCert) {
        config.ignoreCertErrors = ignoreCert.value;
      }
    }

    // Auto-connect
    const autoConnect = await vscode.window.showQuickPick(
      [
        { label: 'No', value: false },
        { label: 'Yes', description: 'Connect when VS Code starts', value: true },
      ],
      { placeHolder: 'Auto-connect on startup?' }
    );
    if (autoConnect) {
      config.autoConnect = autoConnect.value;
    }
  }

  return config;
}
