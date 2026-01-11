import * as vscode from 'vscode';
import { ConnectionTreeProvider } from './providers/connection.tree.provider';
import { HostDetailsProvider } from './providers/host.details.provider';
import { StatusBarProvider } from './providers/statusbar.provider';
import { ConnectionManager } from './services/connection.manager';
import { RcloneService } from './services/rclone.service';
import { PrerequisiteChecker } from './services/prerequisite.checker';
import { CredentialManager } from './services/credential.manager';
import { registerCommands } from './commands';
import { Logger } from './utils/logger';

// Store reference for deactivate
let globalConnectionManager: ConnectionManager | undefined;
let globalRcloneService: RcloneService | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  Logger.info('SFTP+ extension activating...');

  // Initialize services
  const rcloneService = new RcloneService();
  globalRcloneService = rcloneService;

  // Cleanup orphaned SFTP+ drives from previous sessions
  const cleanedDrives = await rcloneService.cleanupAllSftpPlusDrives();
  if (cleanedDrives > 0) {
    Logger.info(`Cleaned up ${cleanedDrives} orphaned drive(s) from previous session`);
  }

  const credentialManager = new CredentialManager(context.secrets);
  const prerequisiteChecker = new PrerequisiteChecker(rcloneService);
  const connectionManager = new ConnectionManager(rcloneService, credentialManager);
  globalConnectionManager = connectionManager;

  // Initialize password sources (async check of SecretStorage)
  await connectionManager.initializePasswordSources();

  // Initialize UI providers
  const treeProvider = new ConnectionTreeProvider(connectionManager);
  treeProvider.setPrerequisiteChecker(prerequisiteChecker);

  const hostDetailsProvider = new HostDetailsProvider(context.extensionUri, connectionManager);
  hostDetailsProvider.setPrerequisiteChecker(prerequisiteChecker);

  const statusBarProvider = new StatusBarProvider(connectionManager);

  // Check prerequisites on startup (will update tree view)
  await prerequisiteChecker.checkAll();

  // Register TreeView for hosts list
  const treeView = vscode.window.createTreeView('sftp-plus.connections', {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
  });

  // Register WebviewView for host details (settings + file browser tabs)
  const hostDetailsDisposable = vscode.window.registerWebviewViewProvider(
    HostDetailsProvider.viewType,
    hostDetailsProvider
  );

  // Register commands
  registerCommands(context, connectionManager, treeProvider, prerequisiteChecker, hostDetailsProvider);

  // Subscribe to connection changes
  connectionManager.onDidChangeConnections(() => {
    treeProvider.refresh();
    statusBarProvider.update();

    // Update host details if current connection status changed
    hostDetailsProvider.refreshCurrentConnection();
  });

  // When a host is selected in the tree, show its details
  treeView.onDidChangeSelection(event => {
    if (event.selection.length > 0) {
      const selectedItem = event.selection[0];
      // Handle connection items
      if ('connection' in selectedItem) {
        hostDetailsProvider.setConnection(selectedItem.connection);
      }
      // Note: PrerequisiteStatusItem is handled by its command
    }
  });

  // Auto-connect configured connections (only if prerequisites are met)
  if (prerequisiteChecker.isReady) {
    await connectionManager.autoConnect();
  }

  // Register disposables
  context.subscriptions.push(
    treeView,
    hostDetailsDisposable,
    statusBarProvider,
    connectionManager,
    prerequisiteChecker,
  );

  Logger.info('SFTP+ extension activated');
}

export async function deactivate(): Promise<void> {
  Logger.info('SFTP+ extension deactivating...');

  // Disconnect all active connections
  if (globalConnectionManager) {
    try {
      await globalConnectionManager.disconnectAll();
      Logger.info('All connections disconnected on deactivate');
    } catch (error) {
      Logger.error('Error disconnecting on deactivate', error);
    }
  }

  // Fallback: cleanup any remaining SFTP+ drives
  if (globalRcloneService) {
    try {
      await globalRcloneService.cleanupAllSftpPlusDrives();
    } catch (error) {
      Logger.debug('Cleanup on deactivate failed (may already be clean)');
    }
  }
}
