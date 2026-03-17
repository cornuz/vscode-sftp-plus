import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Connection, ConnectionConfig, ConnectionStatus, DEFAULT_CONNECTION_CONFIG, InstallStatus, SyncStatus } from '../models';
import { ConnectionManager } from '../services/connection.manager';
import { TrackingService, TrackedFileWithContext } from '../services/tracking.service';
import { McpManager } from '../mcp';
import { Logger } from '../utils/logger';

/**
 * Information about a prerequisite for display
 */
interface PrerequisiteInfo {
  name: 'rclone' | 'WinFsp';
  status: InstallStatus;
}

/**
 * Extended config type that includes password from form submission
 */
interface ConnectionConfigWithPassword extends ConnectionConfig {
  password?: string;
}

interface FileBrowserErrorState {
  path: string;
  message: string;
  hint: string;
  code?: string;
}

/**
 * WebviewView provider that shows host details with tabs:
 * - Settings: Connection configuration form
 * - Files: File browser for connected hosts
 */
export class HostDetailsProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sftp-plus.hostDetails';

  private _view?: vscode.WebviewView;
  private _currentConnection?: Connection;
  private _currentTab: 'settings' | 'console' | 'files' = 'settings';
  private _currentPath?: string;
  private _isNewConnection = false;
  private _expandedFolders: Set<string> = new Set(); // Track expanded folders
  private _foldersExpandedBeforeFilter: Set<string> = new Set(); // Folders that were open when filter started
  private _showFileSize = true; // Toggle for file size display
  private _showFileDate = false; // Toggle for file date display
  private _searchFilter = ''; // Search filter for file names
  private _selectedFile?: string; // Currently selected file path
  private _trackedFiles: Map<string, { file: TrackedFileWithContext; status: SyncStatus }> = new Map(); // Cached tracked files with status
  private _cachedPassword?: string; // Cached password for current connection display
  private _currentPrerequisite?: PrerequisiteInfo; // Currently selected prerequisite
  private _prerequisiteStatusListener?: vscode.Disposable;
  private readonly _trackingService: TrackingService;
  private _autoRefreshTimer?: ReturnType<typeof setInterval>; // Timer for auto-refresh
  private _mcpManager?: McpManager; // MCP manager for AI write access
  private _fileBrowserMarkup = '<li class="file-item empty"><span class="codicon codicon-loading codicon-modifier-spin"></span> Loading files...</li>';
  private _fileBrowserLoading = false;
  private _fileBrowserError?: FileBrowserErrorState;
  private _autoRefreshSuspended = false;
  private _fileBrowserRefreshPromise?: Promise<void>;
  private _pendingFileBrowserRefresh = false;
  private _viewGeneration = 0;
  private _fileBrowserReady = false;
  private _pendingAutoSwitchToFiles = false;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _connectionManager: ConnectionManager
  ) {
    this._trackingService = new TrackingService();

    vscode.workspace.onDidSaveTextDocument((document) => {
      if (this._shouldRefreshForTrackedLocalPath(document.uri.fsPath)) {
        void this.refreshTrackedFiles();
      }
    });

    vscode.workspace.onDidCreateFiles((event) => {
      if (event.files.some(file => this._shouldRefreshForTrackedLocalPath(file.fsPath))) {
        void this.refreshTrackedFiles();
      }
    });

    vscode.workspace.onDidDeleteFiles((event) => {
      if (event.files.some(file => this._shouldRefreshForTrackedLocalPath(file.fsPath))) {
        void this.refreshTrackedFiles();
      }
    });
  }

  /**
   * Set the MCP manager for AI write toggle functionality
   */
  setMcpManager(mcpManager: McpManager): void {
    this._mcpManager = mcpManager;
    // Subscribe to AI permission changes to refresh the view
    mcpManager.onDidChangeAiPermissions(() => {
      this._updateView();
    });
  }

  /**
   * Subscribe to prerequisite status changes to refresh the details panel
   */
  setPrerequisiteChecker(checker: { onDidChangeStatus: vscode.Event<{ rclone: InstallStatus; winfsp: InstallStatus }> }): void {
    this._prerequisiteStatusListener = checker.onDidChangeStatus((status) => {
      // If we're currently showing a prerequisite, update it with new status
      if (this._currentPrerequisite) {
        const newStatus = this._currentPrerequisite.name === 'rclone' ? status.rclone : status.winfsp;
        this._currentPrerequisite = { name: this._currentPrerequisite.name, status: newStatus };
        this._updateView();
      }
    });
  }

  /**
   * Set the current connection and auto-switch tab based on status
   */
  setConnection(connection: Connection): void {
    const connectionChanged = this._currentConnection?.config.name !== connection.config.name;
    this._currentConnection = connection;
    this._isNewConnection = false;
    this._currentPrerequisite = undefined; // Clear prerequisite when showing connection
    const hasMountedDrive = !!connection.mountedDrive;
    const isDisconnecting = connection.status === ConnectionStatus.Disconnecting;
    const isConnecting = connection.status === ConnectionStatus.Connecting;

    if (hasMountedDrive) {
      this._clearFileBrowserFailureState();
      this._fileBrowserReady = false;
      this._pendingAutoSwitchToFiles = true;
      this._fileBrowserMarkup = '<li class="file-item empty"><span class="codicon codicon-loading codicon-modifier-spin"></span> Loading files...</li>';
    }

    // Auto-switch tab based on connection status
    if (connectionChanged) {
      if (hasMountedDrive) {
        // Mounted: show Files immediately, content handles loading state
        this._currentTab = 'files';
        this._currentPath = `${connection.mountedDrive}:\\`;
        this._pendingAutoSwitchToFiles = true;
        this._fileBrowserReady = false;
      } else if (isConnecting || isDisconnecting) {
        this._currentTab = 'console';
        this._currentPath = undefined;
        this._pendingAutoSwitchToFiles = false;
        this._fileBrowserReady = false;
      } else {
        // Disconnected host selection: show Settings tab
        this._currentTab = 'settings';
        this._currentPath = undefined;
        this._pendingAutoSwitchToFiles = false;
        this._fileBrowserReady = false;
      }
      // Clear cached password when switching connections
      this._cachedPassword = undefined;
    } else if (isConnecting || isDisconnecting) {
      this._currentTab = 'console';
      this._currentPath = undefined;
      this._pendingAutoSwitchToFiles = false;
      this._fileBrowserReady = false;
    }

    void this._updateView();

    // Load password async and update view
    this._loadPasswordAndUpdate(connection.config.name);
  }

  /**
   * Set the current prerequisite to display its details
   */
  setPrerequisite(name: 'rclone' | 'WinFsp', status: InstallStatus): void {
    this._currentConnection = undefined;
    this._currentPrerequisite = { name, status };
    this._isNewConnection = false;
    this._updateView();
    this._revealView();
  }

  /**
   * Load password from storage and update view
   */
  private async _loadPasswordAndUpdate(connectionName: string): Promise<void> {
    this._cachedPassword = await this._connectionManager.getPassword(connectionName);
    this._updateView();
  }

  /**
   * Show settings for a specific connection
   */
  showConnectionSettings(connection: Connection): void {
    this._currentConnection = connection;
    this._currentTab = 'settings';
    this._isNewConnection = false;
    this._cachedPassword = undefined;
    this._loadPasswordAndUpdate(connection.config.name);
    this._revealView();
  }

  /**
   * Show new connection form
   */
  showNewConnectionForm(): void {
    this._currentConnection = undefined;
    this._currentTab = 'settings';
    this._isNewConnection = true;
    this._cachedPassword = undefined;
    this._updateView();
    this._revealView();
  }

  /**
   * Show file browser for a connection
   */
  showFileBrowser(connection: Connection): void {
    this._currentConnection = connection;
    this._currentTab = 'files';
    if (connection.mountedDrive) {
      this._currentPath = `${connection.mountedDrive}:\\`;
    }
    this._clearFileBrowserFailureState();
    this._fileBrowserReady = false;
    this._pendingAutoSwitchToFiles = true;
    this._fileBrowserMarkup = '<li class="file-item empty"><span class="codicon codicon-loading codicon-modifier-spin"></span> Loading files...</li>';
    this._updateView();
    this._revealView();
  }

  /**
   * Clear the view
   */
  clear(): void {
    this._currentConnection = undefined;
    this._currentPath = undefined;
    this._cachedPassword = undefined;
    this._resetTransientViewState();
    this._clearFileBrowserFailureState();
    this._fileBrowserMarkup = '<li class="file-item empty"><span class="codicon codicon-info"></span> No active connection</li>';
    this._updateView();
  }

  /**
   * Refresh current connection from manager (handles connect/disconnect)
   */
  refreshCurrentConnection(): void {
    if (!this._currentConnection) return;

    // Get fresh connection data from manager
    const freshConnection = this._connectionManager.getConnection(this._currentConnection.config.name);

    if (freshConnection) {
      const wasConnected = this._currentConnection.status === ConnectionStatus.Connected;
      const isNowConnected = freshConnection.status === ConnectionStatus.Connected;
      const isConnecting = freshConnection.status === ConnectionStatus.Connecting;
      const isDisconnecting = freshConnection.status === ConnectionStatus.Disconnecting;
      const hasMountedDrive = !!freshConnection.mountedDrive;

      this._currentConnection = freshConnection;

      // Auto-switch tab when connection status changes
      if (hasMountedDrive) {
        // Mounted: show Files immediately, content handles loading state
        this._clearFileBrowserFailureState();
        this._pendingAutoSwitchToFiles = true;
        this._fileBrowserReady = false;
        this._currentTab = 'files';
        this._currentPath = `${freshConnection.mountedDrive}:\\`;
      } else if (wasConnected && !isNowConnected) {
        // Just disconnected: switch to Console, clear path
        this._currentTab = 'console';
        this._currentPath = undefined;
        this._resetTransientViewState();
      } else if (isConnecting || isDisconnecting) {
        this._currentTab = 'console';
        this._currentPath = undefined;
        this._selectedFile = undefined;
        this._pendingAutoSwitchToFiles = false;
        this._fileBrowserReady = false;
      } else if (isNowConnected && freshConnection.mountedDrive && this._currentTab === 'settings') {
        // Already connected but still on settings tab: show Files immediately
        this._clearFileBrowserFailureState();
        this._pendingAutoSwitchToFiles = true;
        this._fileBrowserReady = false;
        this._currentTab = 'files';
        if (!this._currentPath) {
          this._currentPath = `${freshConnection.mountedDrive}:\\`;
        }
      }

      void this._updateView();

      // Reload password (may have been deleted or changed)
      this._loadPasswordAndUpdate(freshConnection.config.name);
    } else {
      // Connection was removed
      this.clear();
    }
  }

  /**
   * Refresh tracked files - rescans local files and updates sync status
   * Call this after download/upload operations to ensure display is updated
   */
  async refreshTrackedFiles(): Promise<void> {
    // Rescan local .sftp-plus files to update tracking.json
    await this._trackingService.autoScanLocalFiles();
    // Clear cache and reload tracked files with fresh sync status
    this._trackingService.clearCache();
    await this._updateView();
  }

  private _shouldRefreshForTrackedLocalPath(filePath: string): boolean {
    if (
      !this._currentConnection ||
      this._currentTab !== 'files' ||
      this._currentConnection.status !== ConnectionStatus.Connected
    ) {
      return false;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return false;
    }

    const trackedRoot = path.join(workspaceRoot, '.sftp-plus', this._currentConnection.config.name);
    const normalizedFilePath = path.normalize(filePath).toLowerCase();
    const normalizedTrackedRoot = path.normalize(trackedRoot).toLowerCase();

    return normalizedFilePath === normalizedTrackedRoot || normalizedFilePath.startsWith(`${normalizedTrackedRoot}${path.sep}`);
  }

  private _revealView(): void {
    if (this._view) {
      this._view.show?.(true);
    }
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._viewGeneration += 1;
    const viewGeneration = this._viewGeneration;
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'resources')],
    };

    webviewView.onDidDispose(() => {
      if (!this._isActiveView(webviewView, viewGeneration)) {
        return;
      }

      Logger.debug('Host details webview disposed');
      this._viewGeneration += 1;
      this._view = undefined;
      this._resetTransientViewState();
    });

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (!this._isActiveView(webviewView, viewGeneration)) {
        return;
      }

      switch (message.command) {
        case 'switchTab':
          this._currentTab = message.tab;
          // Initialize path when switching to files tab
          if (message.tab === 'files' && !this._currentPath && this._currentConnection?.mountedDrive) {
            this._currentPath = `${this._currentConnection.mountedDrive}:\\`;
          }
          this._updateView();
          break;

        case 'saveConnection':
          await this._saveConnection(message.config);
          break;

        case 'testConnection':
          await this._testConnection(message.config);
          break;

        case 'deleteConnection':
          await this._confirmAndDeleteConnection(message.name);
          break;

        case 'deletePassword':
          await this._deletePassword(message.name);
          break;

        case 'toggleFolder':
          // Toggle folder expand/collapse
          if (this._expandedFolders.has(message.path)) {
            this._expandedFolders.delete(message.path);
          } else {
            this._expandedFolders.add(message.path);
          }
          this._updateView();
          break;

        case 'navigateTo':
          this._currentPath = message.path;
          this._expandedFolders.clear(); // Reset expanded state when navigating
          this._searchFilter = ''; // Clear search when navigating
          this._updateView();
          break;

        case 'navigateUp':
          if (this._currentPath) {
            const parent = path.dirname(this._currentPath);
            if (parent !== this._currentPath) {
              this._currentPath = parent;
              this._searchFilter = ''; // Clear search when navigating
              this._updateView();
            }
          }
          break;

        case 'openFile':
          if (message.paths && Array.isArray(message.paths)) {
            // Multi-file open
            for (const filePath of message.paths) {
              const fileUri = vscode.Uri.file(filePath);
              const doc = await vscode.workspace.openTextDocument(fileUri);
              await vscode.window.showTextDocument(doc, { preview: false });
            }
          } else {
            const fileUri = vscode.Uri.file(message.path);
            const doc = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(doc, { preview: false });
          }
          break;

        case 'selectFile':
          this._selectedFile = message.path;
          // Don't update view - selection is handled in webview for responsiveness
          break;

        case 'downloadFile':
          if (message.paths && Array.isArray(message.paths)) {
            for (const filePath of message.paths) {
              await this._downloadFile(filePath);
            }
          } else {
            await this._downloadFile(message.path);
          }
          break;

        case 'uploadFile':
          if (message.paths && Array.isArray(message.paths)) {
            for (const filePath of message.paths) {
              await this._uploadFile(filePath);
            }
          } else {
            await this._uploadFile(message.path);
          }
          break;

        case 'compareFile':
          await this._compareFile(message.path);
          break;

        case 'reviewWithAgent':
          await this._reviewWithAgent(message.path);
          break;

        case 'renameFile':
          await this._renameFile(message.path);
          break;

        case 'duplicateFile':
          await this._duplicateFile(message.path);
          break;

        case 'deleteFile':
          if (message.paths && Array.isArray(message.paths)) {
            await this._deleteFiles(message.paths);
          } else {
            await this._deleteFile(message.path);
          }
          break;

        case 'refresh':
          await this._updateView(true);
          // Notify webview that refresh is complete
          await this._postMessageToView({ command: 'refreshComplete' }, webviewView, viewGeneration);
          break;

        case 'toggleSize':
          this._showFileSize = !this._showFileSize;
          this._updateView();
          break;

        case 'toggleDate':
          this._showFileDate = !this._showFileDate;
          this._updateView();
          break;

        case 'search':
          // When starting a new filter, capture which folders were already open
          if (!this._searchFilter && message.query) {
            this._foldersExpandedBeforeFilter = new Set(this._expandedFolders);
          }
          // When clearing filter, reset the tracking
          if (!message.query) {
            this._foldersExpandedBeforeFilter.clear();
          }
          this._searchFilter = message.query || '';
          this._updateView();
          // Restore focus to search input after update
          await this._postMessageToView({ command: 'focusSearch', cursorPos: message.cursorPos }, webviewView, viewGeneration);
          break;

        case 'installPrerequisite':
          // Install prerequisite via command
          if (message.name === 'rclone') {
            await vscode.commands.executeCommand('sftp-plus.installRclone');
          } else if (message.name === 'WinFsp') {
            await vscode.commands.executeCommand('sftp-plus.installWinFsp');
          }
          break;

        case 'toggleAiWrite':
          // Toggle AI write access for a file/folder (async - shows menu)
          if (this._mcpManager && this._currentConnection) {
            await this._mcpManager.toggleAiWriteAccess(this._currentConnection.config.name, message.path);
          }
          break;

        case 'allowAiWriteFolder':
          // Allow AI write on folder
          if (this._mcpManager && this._currentConnection) {
            await this._mcpManager.allowAiWriteOnFolder(this._currentConnection.config.name, message.path);
          }
          break;

        case 'revokeAiWriteFolder':
          // Revoke AI write on folder
          if (this._mcpManager && this._currentConnection) {
            await this._mcpManager.revokeAiWriteOnFolder(this._currentConnection.config.name, message.path);
          }
          break;

        case 'reconnect':
          // Reconnect the current connection
          if (this._currentConnection) {
            try {
              this._clearFileBrowserFailureState();
              await this._connectionManager.reconnect(this._currentConnection.config.name, {
                reason: 'manual reconnect',
                force: true,
              });
            } catch (error) {
              Logger.error(`Reconnect failed: ${error}`);
              vscode.window.showErrorMessage(`Failed to reconnect: ${error}`);
            }
          }
          break;

        case 'openExternal':
          vscode.env.openExternal(vscode.Uri.parse(message.url));
          break;
      }
    });

    this._updateView();
  }

  private _clearAutoRefreshTimer(): void {
    if (this._autoRefreshTimer) {
      clearInterval(this._autoRefreshTimer);
      this._autoRefreshTimer = undefined;
    }
  }

  private _resetTransientViewState(): void {
    this._clearAutoRefreshTimer();
    this._fileBrowserLoading = false;
    this._fileBrowserRefreshPromise = undefined;
    this._pendingFileBrowserRefresh = false;
    this._selectedFile = undefined;
    this._pendingAutoSwitchToFiles = false;
    this._fileBrowserReady = false;
  }

  private _isActiveView(view: vscode.WebviewView, generation: number): boolean {
    return this._view === view && this._viewGeneration === generation;
  }

  private async _postMessageToView(message: unknown, view: vscode.WebviewView, generation: number): Promise<void> {
    if (!this._isActiveView(view, generation)) {
      return;
    }

    try {
      await view.webview.postMessage(message);
    } catch (error) {
      Logger.debug(`Skipping postMessage for disposed host details webview: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Start or stop auto-refresh timer based on current connection and tab
   */
  private _updateAutoRefreshTimer(): void {
    // Clear any existing timer
    this._clearAutoRefreshTimer();

    // Only auto-refresh when on Files tab with a connected connection and syncRate > 0
    if (
      this._view &&
      this._currentConnection &&
      this._currentTab === 'files' &&
      this._fileBrowserReady &&
      !!this._currentConnection.mountedDrive &&
      this._currentConnection.config.syncRate > 0 &&
      !this._autoRefreshSuspended
    ) {
      const intervalMs = this._currentConnection.config.syncRate * 1000;
      this._autoRefreshTimer = setInterval(async () => {
        // Clear tracking cache to force re-check
        this._trackingService.clearCache();
        await this._updateView();
      }, intervalMs);
    }
  }

  private async _updateView(forceFileBrowserReload = false): Promise<void> {
    const targetView = this._view;
    const viewGeneration = this._viewGeneration;
    if (!targetView) {
      this._clearAutoRefreshTimer();
      return;
    }

    // Update auto-refresh timer
    this._updateAutoRefreshTimer();

    const shouldPrepareFileBrowser = !!(
      this._currentConnection &&
      this._currentConnection.mountedDrive &&
      (this._currentTab === 'files' || !this._fileBrowserReady || this._pendingAutoSwitchToFiles)
    );

    // Load tracked files with sync status for current connection
    if (shouldPrepareFileBrowser && this._currentConnection?.mountedDrive) {
      const trackedFiles = await this._trackingService.getTrackedFilesForConnection(
        this._currentConnection.config.name,
        this._currentConnection.mountedDrive
      );
      this._trackedFiles.clear();
      for (const file of trackedFiles) {
        const status = await this._trackingService.getSyncStatus(file);
        // Use fullRemotePath as key to match with displayed files
        this._trackedFiles.set(file.fullRemotePath, { file, status });
      }

      if (!this._isActiveView(targetView, viewGeneration)) {
        return;
      }

      await this._refreshFileBrowserMarkup(forceFileBrowserReload);
    } else {
      this._trackedFiles.clear();
      this._fileBrowserError = undefined;
      this._fileBrowserLoading = false;
    }

    if (!this._isActiveView(targetView, viewGeneration)) {
      Logger.debug('Skipping stale host details render');
      return;
    }

    targetView.webview.html = this._getHtml(targetView.webview);
  }

  private async _saveConnection(formData: ConnectionConfigWithPassword): Promise<void> {
    try {
      const password = formData.password;

      // Create config without password for storage
      const config: ConnectionConfig = {
        name: formData.name,
        host: formData.host,
        port: formData.port,
        protocol: formData.protocol,
        username: formData.username,
        remotePath: formData.remotePath,
        driveLetter: formData.driveLetter,
        autoConnect: formData.autoConnect,
        autoReconnectOnDrop: formData.autoReconnectOnDrop,
        explicitTls: formData.explicitTls,
        ignoreCertErrors: formData.ignoreCertErrors,
        cacheMode: formData.cacheMode,
        idleTimeout: formData.idleTimeout,
        syncRate: formData.syncRate || 60,
      };

      if (this._isNewConnection) {
        await this._connectionManager.addConnection(config);
      } else {
        const oldName = this._currentConnection?.config.name || config.name;
        await this._connectionManager.updateConnection(oldName, config);
      }

      // Store password securely if provided
      if (password) {
        await this._connectionManager.storePassword(config.name, password);
      }

      this._view?.webview.postMessage({ command: 'saveSuccess' });
      vscode.window.showInformationMessage(`Connection "${config.name}" saved`);

      // Refresh to show updated connection
      this._currentConnection = this._connectionManager.getConnection(config.name);
      this._isNewConnection = false;
      this._updateView();
    } catch (error) {
      this._view?.webview.postMessage({
        command: 'saveError',
        error: String(error)
      });
    }
  }

  private async _testConnection(formData: ConnectionConfigWithPassword): Promise<void> {
    try {
      if (this._currentConnection) {
        this._currentTab = 'console';
        await this._updateView();
      }
      this._view?.webview.postMessage({ command: 'testStarted' });

      // Create a config object for testing (use defaults for required fields)
      const config: ConnectionConfig = {
        ...DEFAULT_CONNECTION_CONFIG as ConnectionConfig,
        name: formData.name || 'test',
        host: formData.host,
        port: formData.port,
        protocol: formData.protocol,
        username: formData.username,
        remotePath: formData.remotePath || '/',
        explicitTls: formData.explicitTls,
        ignoreCertErrors: formData.ignoreCertErrors,
      };

      const result = await this._connectionManager.testConnection(config, formData.password);

      this._view?.webview.postMessage({
        command: 'testResult',
        success: result.success,
        message: result.message,
        diagnosticKind: result.diagnostic.kind,
        canAcceptCertificate: result.diagnostic.canAcceptCertificate === true,
      });
    } catch (error) {
      this._view?.webview.postMessage({
        command: 'testResult',
        success: false,
        message: String(error),
        diagnosticKind: 'unknown',
        canAcceptCertificate: false,
      });
    }
  }

  private async _confirmAndDeleteConnection(name: string): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      `Delete connection "${name}"?`,
      { modal: true },
      'Delete'
    );
    if (answer === 'Delete') {
      await this._deleteConnection(name);
    }
  }

  private async _deleteConnection(name: string): Promise<void> {
    try {
      await this._connectionManager.removeConnection(name);
      vscode.window.showInformationMessage(`Connection "${name}" removed`);
      this._currentConnection = undefined;
      this._isNewConnection = false;
      this._updateView();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to remove: ${error}`);
    }
  }

  private async _deletePassword(name: string): Promise<void> {
    try {
      await this._connectionManager.deleteSecretPassword(name);
      vscode.window.showInformationMessage(`Password for "${name}" deleted from SecretStorage`);
      // Refresh current connection to update passwordSource
      this._currentConnection = this._connectionManager.getConnection(name);
      this._updateView();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to delete password: ${error}`);
    }
  }

  private _getHtml(webview: vscode.Webview): string {
    const nonce = this._getNonce();
    const cspSource = webview.cspSource;

    // Get codicon font URI from resources folder (bundled with extension)
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', 'codicon.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Host Details</title>
  ${codiconsUri ? `<link href="${codiconsUri}" rel="stylesheet" />` : ''}
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 0;
    }

    /* Codicon helper */
    .codicon {
      font-family: 'codicon';
      font-size: 16px;
      vertical-align: middle;
      margin-right: 4px;
    }

    /* Tabs */
    .tabs {
      display: flex;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-tab-inactiveBackground);
    }
    .tab {
      padding: 8px 16px;
      cursor: pointer;
      border: none;
      background: transparent;
      color: var(--vscode-tab-inactiveForeground);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      transition: all 0.2s;
    }
    .tab:hover {
      background: var(--vscode-tab-hoverBackground);
    }
    .tab.active {
      color: var(--vscode-tab-activeForeground);
      background: var(--vscode-tab-activeBackground);
      border-bottom: 2px solid var(--vscode-focusBorder);
    }
    .tab:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Content */
    .content {
      padding: 12px;
      height: calc(100vh - 40px);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .content.scrollable {
      overflow-y: auto;
    }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: var(--vscode-descriptionForeground);
    }
    .empty-state .icon {
      font-size: 48px;
      margin-bottom: 16px;
      opacity: 0.5;
    }

    /* Prerequisite details */
    .prereq-details {
      padding: 16px;
    }
    .prereq-details h3 {
      margin: 0 0 12px 0;
      font-size: 14px;
      font-weight: 600;
    }
    .prereq-status {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
      font-size: 13px;
    }
    .prereq-desc {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.5;
      margin-bottom: 20px;
    }
    .prereq-actions {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .prereq-actions .link {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      font-size: 12px;
      cursor: pointer;
    }
    .prereq-actions .link:hover {
      text-decoration: underline;
    }

    /* Form */
    .form-group {
      margin-bottom: 12px;
    }
    label {
      display: block;
      margin-bottom: 4px;
      color: var(--vscode-foreground);
      font-weight: 500;
      font-size: 11px;
      text-transform: uppercase;
    }
    input, select {
      width: 100%;
      padding: 6px 8px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 2px;
      font-size: 13px;
    }
    input:focus, select:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    .row {
      display: flex;
      gap: 8px;
    }
    .row > * { flex: 1; }

    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .checkbox-group input {
      width: auto;
    }
    .checkbox-group label {
      margin: 0;
      text-transform: none;
      font-weight: normal;
      font-size: 13px;
    }

    /* Buttons */
    .button-row {
      display: flex;
      gap: 8px;
      margin-top: 16px;
    }
    button {
      padding: 6px 14px;
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: 13px;
      transition: opacity 0.2s;
    }
    button:hover { opacity: 0.9; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-icon {
      padding: 4px 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .btn-icon .codicon {
      margin: 0;
    }
    .btn-icon.spinning .codicon {
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .btn-danger {
      background: var(--vscode-errorForeground);
      color: white;
    }

    /* Status */
    .status {
      padding: 8px;
      margin-top: 12px;
      border-radius: 2px;
      font-size: 12px;
    }
    .status.success {
      background: var(--vscode-inputValidation-infoBackground);
      border: 1px solid var(--vscode-inputValidation-infoBorder);
    }
    .status.error {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
    }
    .status-actions {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }

    /* Console */
    .console-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      gap: 8px;
    }
    .console-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .console-title {
      font-size: 12px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      letter-spacing: 0.4px;
    }
    .console-body {
      flex: 1;
      overflow: auto;
      background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .console-line {
      display: grid;
      grid-template-columns: 72px 48px 1fr;
      gap: 8px;
      padding: 2px 0;
    }
    .console-line.message .console-message {
      color: var(--vscode-foreground);
    }
    .console-line.notice .console-message {
      color: var(--vscode-textLink-foreground, #3794ff);
    }
    .console-line.error .console-message {
      color: var(--vscode-errorForeground);
    }
    .console-line.confirmation .console-message {
      color: var(--vscode-testing-iconPassed, #89d185);
    }
    .console-meta {
      color: var(--vscode-descriptionForeground);
    }
    .console-empty {
      color: var(--vscode-descriptionForeground);
      padding: 8px 0;
    }

    /* File Browser */
    .file-browser-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }
    .browser-toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .browser-toolbar button {
      padding: 4px 6px;
    }
    .file-list-container {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
    }
    .search-container {
      flex: 1;
      display: flex;
      align-items: center;
      position: relative;
      margin: 0 4px;
    }
    .search-icon {
      position: absolute;
      left: 6px;
      color: var(--vscode-input-placeholderForeground);
      font-size: 12px;
      pointer-events: none;
    }
    .search-input {
      flex: 1;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      color: var(--vscode-input-foreground);
      padding: 4px 24px 4px 24px;
      border-radius: 3px;
      font-size: 12px;
      outline: none;
    }
    .search-input:focus {
      border-color: var(--vscode-focusBorder);
    }
    .search-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    .search-clear {
      position: absolute;
      right: 2px;
      background: transparent;
      border: none;
      color: var(--vscode-input-placeholderForeground);
      cursor: pointer;
      padding: 2px 4px;
      display: flex;
      align-items: center;
    }
    .search-clear:hover {
      color: var(--vscode-foreground);
    }
    .btn-toggle {
      background: transparent;
      border: 1px solid transparent;
      color: var(--vscode-descriptionForeground);
      opacity: 0.6;
      padding: 4px 6px;
      border-radius: 3px;
    }
    .btn-toggle:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground);
    }
    .btn-toggle.active {
      opacity: 1;
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-activeBackground);
      border-color: var(--vscode-focusBorder);
    }
    .browser-loading-note {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px 0;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .file-list {
      list-style: none;
    }
    .file-item {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 4px;
      cursor: pointer;
      border-radius: 3px;
      font-size: 13px;
    }
    .file-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .file-item.empty {
      opacity: 0.5;
      cursor: default;
    }
    .file-item .chevron {
      width: 16px;
      text-align: center;
      font-size: 14px;
      color: var(--vscode-foreground);
      flex-shrink: 0;
    }
    .file-item .chevron.loading {
      animation: spin 1s linear infinite;
      opacity: 0.8;
    }
    .file-item .chevron-spacer {
      width: 16px;
      flex-shrink: 0;
    }
    .file-item .icon {
      width: 16px;
      text-align: center;
      flex-shrink: 0;
    }
    .file-item .icon .codicon-folder,
    .file-item .icon .codicon-folder-opened {
      color: var(--vscode-charts-yellow, #e2c08d);
    }
    .file-item .name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file-item .meta {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
      margin-left: 8px;
      white-space: nowrap;
    }
    .file-item .meta.date {
      min-width: 80px;
      text-align: right;
    }
    .file-item .meta.size {
      min-width: 60px;
      text-align: right;
    }
    .file-item.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .file-item.selected .meta {
      color: var(--vscode-list-activeSelectionForeground);
      opacity: 0.8;
    }
    /* Spinning animation for refresh */
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .spinning .codicon-refresh {
      animation: spin 1s linear infinite;
    }

    /* Tracking indicator - sync states */
    .file-item.tracked.not-downloaded .name,
    .file-item.tracked.not-downloaded .icon .codicon,
    .file-item.tracked.not-downloaded .tracking-indicator {
      color: var(--vscode-charts-red, #f14c4c);
    }
    .file-item.tracked.remote-newer .name,
    .file-item.tracked.remote-newer .icon .codicon,
    .file-item.tracked.remote-newer .tracking-indicator {
      color: #ff0000;
    }
    .file-item.tracked.local-newer .name,
    .file-item.tracked.local-newer .icon .codicon,
    .file-item.tracked.local-newer .tracking-indicator {
      color: #569cd6;
    }
    .file-item.tracked.synced .name,
    .file-item.tracked.synced .icon .codicon,
    .file-item.tracked.synced .tracking-indicator {
      color: var(--vscode-charts-green, #89d185);
    }
    .file-item.tracked .tracking-indicator {
      font-size: 12px;
      flex-shrink: 0;
      width: 16px;
      text-align: center;
    }
    .file-item .tracking-indicator-placeholder {
      width: 16px;
      flex-shrink: 0;
    }
    .file-item.selected.tracked .name,
    .file-item.selected.tracked .icon .codicon,
    .file-item.selected.tracked .tracking-indicator {
      color: var(--vscode-list-activeSelectionForeground);
    }

    /* AI Toggle Icons */
    .ai-toggle {
      flex-shrink: 0;
      width: 20px;
      text-align: center;
      cursor: pointer;
      padding: 0 2px;
      border-radius: 3px;
      margin-left: 4px;
    }
    .ai-toggle:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }
    .ai-toggle.ai-readonly {
      color: var(--vscode-descriptionForeground);
      opacity: 0.5;
    }
    .ai-toggle.ai-readonly:hover {
      opacity: 1;
    }
    .ai-toggle.ai-local {
      color: #22c55e; /* Green for local mode */
    }
    .ai-toggle.ai-host {
      color: #ff0000; /* Red for host mode */
    }
    .file-item.selected .ai-toggle.ai-readonly {
      color: var(--vscode-list-activeSelectionForeground);
      opacity: 0.5;
    }
    .file-item.selected .ai-toggle.ai-local {
      color: #22c55e;
    }
    .file-item.selected .ai-toggle.ai-host {
      color: #ff0000;
    }

    /* Context Menu */
    .context-menu {
      position: fixed;
      background: var(--vscode-menu-background);
      border: 1px solid var(--vscode-menu-border);
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      padding: 4px 0;
      min-width: 160px;
      z-index: 1000;
      display: none;
    }
    .context-menu.visible {
      display: block;
    }
    .context-menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 13px;
      color: var(--vscode-menu-foreground);
    }
    .context-menu-item:hover {
      background: var(--vscode-menu-selectionBackground);
      color: var(--vscode-menu-selectionForeground);
    }
    .context-menu-item .codicon {
      font-size: 14px;
      width: 16px;
    }
    .context-menu-separator {
      height: 1px;
      background: var(--vscode-menu-separatorBackground);
      margin: 4px 0;
    }

    .section-title {
      font-size: 11px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      margin: 16px 0 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    /* Password label with badge */
    .password-label {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .label-badge {
      font-size: 9px;
      padding: 1px 4px;
      border-radius: 3px;
      text-transform: lowercase;
      font-weight: normal;
    }
    .label-badge.secret {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .label-badge.workspace {
      background: var(--vscode-statusBarItem-warningBackground, #856404);
      color: var(--vscode-statusBarItem-warningForeground, #fff);
    }
    .btn-delete-password {
      background: transparent;
      border: none;
      color: var(--vscode-errorForeground);
      cursor: pointer;
      padding: 0 2px;
      margin-left: auto;
      opacity: 0.7;
    }
    .btn-delete-password:hover {
      opacity: 1;
    }
    .btn-delete-password .codicon {
      font-size: 12px;
      margin: 0;
    }
  </style>
</head>
<body>
  ${this._getTabsHtml()}
  <div class="content${this._currentTab === 'settings' ? ' scrollable' : ''}">
    ${this._getContentHtml()}
  </div>
  <script nonce="${nonce}">\n    ${this._getScript()}
  </script>
</body>
</html>`;
  }

  private _getTabsHtml(): string {
    const settingsActive = this._currentTab === 'settings' ? 'active' : '';
    const consoleActive = this._currentTab === 'console' ? 'active' : '';
    const filesActive = this._currentTab === 'files' ? 'active' : '';
    const isConnected = !!this._currentConnection?.mountedDrive || this._currentConnection?.status === ConnectionStatus.Connected;
    const hasConnection = !!this._currentConnection;

    // Get scope label for settings tab
    let scopeLabel = '';
    if (this._currentConnection) {
      scopeLabel = this._currentConnection.scope === 'workspace' ? ' (WS)' : ' (GL)';
    } else if (this._isNewConnection) {
      // New connection will be workspace if available
      scopeLabel = this._connectionManager.hasWorkspace() ? ' (WS)' : ' (GL)';
    }

    if (isConnected) {
      // Connected: keep a stable left-to-right tab order
      return `
        <div class="tabs">
          <button class="tab ${settingsActive}" data-tab="settings"><span class="codicon codicon-gear"></span> Settings${scopeLabel}</button>
          <button class="tab ${consoleActive}" data-tab="console"><span class="codicon codicon-output"></span> Console</button>
          <button class="tab ${filesActive}" data-tab="files"><span class="codicon ${this._fileBrowserLoading && !this._fileBrowserReady ? 'codicon-loading codicon-modifier-spin' : 'codicon-list-tree'}"></span> Files</button>
        </div>
      `;
    } else if (hasConnection) {
      return `
        <div class="tabs">
          <button class="tab ${settingsActive}" data-tab="settings"><span class="codicon codicon-gear"></span> Settings${scopeLabel}</button>
          <button class="tab ${consoleActive}" data-tab="console"><span class="codicon codicon-output"></span> Console</button>
        </div>
      `;
    } else {
      // Disconnected: Settings only (Files hidden)
      return `
        <div class="tabs">
          <button class="tab ${settingsActive}" data-tab="settings"><span class="codicon codicon-gear"></span> Settings${scopeLabel}</button>
        </div>
      `;
    }
  }

  private _getContentHtml(): string {
    // Show prerequisite details if selected
    if (this._currentPrerequisite) {
      return this._getPrerequisiteHtml();
    }

    if (!this._currentConnection && !this._isNewConnection) {
      return `
        <div class="empty-state">
          <div class="icon"><span class="codicon codicon-server" style="font-size: 48px;"></span></div>
          <p>Select a host to view details</p>
          <p style="margin-top: 8px; font-size: 12px;">or click + to add a new connection</p>
        </div>
      `;
    }

    if (this._currentTab === 'settings') {
      return this._getSettingsHtml();
    }

    if (this._currentTab === 'console') {
      return this._getConsoleHtml();
    }

    return this._getFileBrowserHtml();
  }

  private _getConsoleHtml(): string {
    if (!this._currentConnection) {
      return `
        <div class="empty-state">
          <div class="icon"><span class="codicon codicon-output" style="font-size: 48px;"></span></div>
          <p>No active session</p>
          <p style="margin-top: 8px; font-size: 12px;">Run a test or connect to capture logs</p>
        </div>
      `;
    }

    const entries = this._connectionManager.getSessionLog(this._currentConnection.config.name);
    const lines = entries.length > 0
      ? entries.map(entry => {
        const time = this._escapeHtml(entry.timestamp.slice(11, 19));
        const source = this._escapeHtml(entry.source);
        const message = this._escapeHtml(entry.message);
        const tone = this._getConsoleTone(entry.level, entry.message);
        return `<div class="console-line ${tone}"><span class="console-meta">${time}</span><span class="console-meta">${source}</span><span class="console-message">${message}</span></div>`;
      }).join('')
      : '<div class="console-empty">No logs yet for this session.</div>';

    return `
      <div class="console-container">
        <div class="console-header">
          <div class="console-title">${this._escapeHtml(this._currentConnection.config.name)} session console</div>
        </div>
        <div class="console-body" id="consoleBody">${lines}</div>
      </div>
    `;
  }

  private _getConsoleTone(level: 'info' | 'warn' | 'error', message: string): 'message' | 'notice' | 'error' | 'confirmation' {
    const normalized = message.toLowerCase();

    if (
      normalized.includes(' error') ||
      normalized.startsWith('error') ||
      normalized.includes('error:') ||
      normalized.includes(' failed') ||
      normalized.includes('exception')
    ) {
      return 'error';
    }

    if (
      normalized.includes(' notice:') ||
      normalized.startsWith('notice:') ||
      normalized.includes('serving remote control')
    ) {
      return 'notice';
    }

    if (
      normalized.includes('mounted on') ||
      normalized.includes('connection successful') ||
      normalized.includes('connected to')
    ) {
      return 'confirmation';
    }

    return 'message';
  }

  private _getPrerequisiteHtml(): string {
    const prereq = this._currentPrerequisite!;
    const isInstalled = prereq.status.installed;
    const version = prereq.status.version;

    const descriptions: Record<string, { title: string; desc: string; url: string }> = {
      'rclone': {
        title: 'rclone',
        desc: 'rclone is a command-line program to sync files and directories to and from cloud storage. SFTP+ uses rclone to mount remote FTP/SFTP servers as local drives on Windows.',
        url: 'https://rclone.org/'
      },
      'WinFsp': {
        title: 'Windows File System Proxy (WinFsp)',
        desc: 'WinFsp is a Windows driver that allows user-mode file systems to be mounted as Windows drives. rclone requires WinFsp to mount remote servers as drive letters.',
        url: 'https://winfsp.dev/'
      }
    };

    const info = descriptions[prereq.name];
    const statusIcon = isInstalled
      ? '<span class="codicon codicon-check" style="color: var(--vscode-charts-green);"></span>'
      : '<span class="codicon codicon-warning" style="color: var(--vscode-charts-orange);"></span>';

    const statusText = isInstalled
      ? `Installed${version ? ` (${version})` : ''}`
      : 'Not installed';

    const actionButton = isInstalled
      ? ''
      : `<button type="button" class="btn btn-primary" id="installPrereqBtn">
           <span class="codicon codicon-cloud-download"></span> Install via winget
         </button>`;

    return `
      <div class="prereq-details">
        <h3>${info.title}</h3>

        <div class="prereq-status">
          ${statusIcon}
          <span>${statusText}</span>
        </div>

        <p class="prereq-desc">${info.desc}</p>

        <div class="prereq-actions">
          ${actionButton}
          <a href="#" class="link" id="prereqLink" data-url="${info.url}">
            <span class="codicon codicon-link-external"></span> Learn more
          </a>
        </div>
      </div>
    `;
  }

  private _getSettingsHtml(): string {
    const config = this._currentConnection?.config || DEFAULT_CONNECTION_CONFIG;
    const isNew = this._isNewConnection;
    const isConnected = this._currentConnection?.status === ConnectionStatus.Connected;

    // Password source label and delete button
    let passwordLabel = 'Password';
    let passwordDeleteBtn = '';
    if (!isNew && this._currentConnection) {
      const passwordSource = this._currentConnection.passwordSource;
      if (passwordSource === 'secret') {
        passwordLabel = 'Password <span class="label-badge secret">(SS)</span>';
        passwordDeleteBtn = `<button type="button" class="btn-icon btn-delete-password" id="deletePasswordBtn" title="Delete saved password"><span class="codicon codicon-trash"></span></button>`;
      } else if (passwordSource === 'workspace') {
        passwordLabel = 'Password <span class="label-badge workspace">(WS)</span>';
      }
    }

    return `
      <form id="settingsForm">
        <div class="form-group">
          <label>Connection Name</label>
          <input type="text" name="name" value="${this._escapeHtml(config.name || '')}"
                 placeholder="My Server" required ${!isNew ? 'readonly' : ''}>
        </div>

        <div class="row">
          <div class="form-group">
            <label>Protocol</label>
            <select name="protocol">
              <option value="ftps" ${config.protocol === 'ftps' ? 'selected' : ''}>FTPS</option>
              <option value="ftp" ${config.protocol === 'ftp' ? 'selected' : ''}>FTP</option>
              <option value="sftp" ${config.protocol === 'sftp' ? 'selected' : ''}>SFTP</option>
            </select>
          </div>
          <div class="form-group">
            <label>Port</label>
            <input type="number" name="port" value="${config.port || 21}" min="1" max="65535">
          </div>
        </div>

        <div class="form-group">
          <label>Host</label>
          <input type="text" name="host" value="${this._escapeHtml(config.host || '')}"
                 placeholder="ftp.example.com" required>
        </div>

        <div class="row">
          <div class="form-group">
            <label>Username</label>
            <input type="text" name="username" value="${this._escapeHtml(config.username || '')}"
                   placeholder="user@example.com" required>
          </div>
          <div class="form-group">
            <label class="password-label">${passwordLabel} ${passwordDeleteBtn}</label>
            <input type="text" name="password" value="${this._escapeHtml(this._cachedPassword || '')}">
          </div>
        </div>

        <div class="row">
          <div class="form-group">
            <label>Remote Path</label>
            <input type="text" name="remotePath" value="${this._escapeHtml(config.remotePath || '/')}">
          </div>
          <div class="form-group">
            <label>Drive Letter</label>
            <input type="text" name="driveLetter" value="${this._escapeHtml(config.driveLetter || '')}"
                   placeholder="Auto" maxlength="1" style="text-transform: uppercase;">
          </div>
        </div>

        <div class="section-title">Options</div>

        <div class="checkbox-group">
          <input type="checkbox" id="autoConnect" name="autoConnect" ${config.autoConnect ? 'checked' : ''}>
          <label for="autoConnect">Auto-connect on startup</label>
        </div>

        <div class="checkbox-group">
          <input type="checkbox" id="autoReconnectOnDrop" name="autoReconnectOnDrop" ${config.autoReconnectOnDrop ? 'checked' : ''}>
          <label for="autoReconnectOnDrop">Auto-reconnect on unattended disconnection</label>
        </div>

        <div class="checkbox-group">
          <input type="checkbox" id="explicitTls" name="explicitTls" ${config.explicitTls !== false ? 'checked' : ''}>
          <label for="explicitTls">Use explicit TLS (FTPS)</label>
        </div>

        <div class="checkbox-group">
          <input type="checkbox" id="ignoreCertErrors" name="ignoreCertErrors" ${config.ignoreCertErrors ? 'checked' : ''}>
          <label for="ignoreCertErrors">Auto-accept invalid certificate (FTPS)</label>
        </div>

        <div class="form-group" style="margin-top: 12px;">
          <label>Sync Rate (seconds)</label>
          <input type="number" name="syncRate" value="${config.syncRate || 60}" min="5" max="3600" placeholder="60">
        </div>

        <div id="statusMessage"></div>

        <div class="button-row">
          <button type="submit" class="btn-primary" ${isConnected ? 'disabled title="Disconnect first to edit"' : ''}>
            ${isNew ? 'Add Connection' : 'Save Changes'}
          </button>
          <button type="button" class="btn-secondary" id="testBtn">Test</button>
          ${!isNew ? `<button type="button" class="btn-danger" id="deleteBtn">Delete</button>` : ''}
        </div>
      </form>
    `;
  }

  private _getFileBrowserHtml(): string {
    if (!this._currentConnection || !this._currentConnection.mountedDrive) {
      return `
        <div class="empty-state">
          <div class="icon"><span class="codicon codicon-debug-disconnect" style="font-size: 48px;"></span></div>
          <p>Not connected</p>
          <p style="margin-top: 8px; font-size: 12px;">Connect to browse files</p>
        </div>
      `;
    }

    let files = this._fileBrowserMarkup;
    if (this._fileBrowserError) {
      files = this._renderFileBrowserError(this._fileBrowserError);
    } else if (this._fileBrowserLoading && !files) {
      files = '<li class="file-item empty"><span class="codicon codicon-loading codicon-modifier-spin"></span> Loading files...</li>';
    } else if (!files) {
      files = '<li class="file-item empty"><span class="codicon codicon-info"></span> Empty folder</li>';
    }

    const sizeActiveClass = this._showFileSize ? 'active' : '';
    const dateActiveClass = this._showFileDate ? 'active' : '';

    const showAgentReview = this._currentConnection?.mcpActive === true;
    const loadingState = this._fileBrowserLoading && !this._fileBrowserReady
      ? '<div class="browser-loading-note"><span class="codicon codicon-loading codicon-modifier-spin"></span> Preparing file tree...</div>'
      : '';

    return `
      <div class="file-browser-container">
        <div class="browser-toolbar">
          <button class="btn-secondary btn-icon" id="refreshBtn" title="Refresh"><span class="codicon codicon-refresh"></span></button>
          <div class="search-container">
            <span class="codicon codicon-search search-icon"></span>
            <input type="text" id="searchInput" class="search-input" placeholder="Filter..." value="${this._escapeHtml(this._searchFilter)}" />
            ${this._searchFilter ? '<button class="search-clear" id="clearSearchBtn" title="Clear"><span class="codicon codicon-close"></span></button>' : ''}
          </div>
          <button class="btn-toggle ${sizeActiveClass}" id="toggleSizeBtn" title="Toggle file size"><span class="codicon codicon-symbol-numeric"></span></button>
          <button class="btn-toggle ${dateActiveClass}" id="toggleDateBtn" title="Toggle modification date"><span class="codicon codicon-calendar"></span></button>
        </div>
        ${loadingState}
        <div class="file-list-container">
          <ul class="file-list">
            ${files}
          </ul>
        </div>
        <!-- Context Menu -->
        <div class="context-menu" id="contextMenu">
          <div class="context-menu-item" data-action="cloudEdit">
            <span class="codicon codicon-edit"></span>
            <span>Cloud Edit</span>
          </div>
          <div class="context-menu-item" data-action="download">
            <span class="codicon codicon-cloud-download"></span>
            <span>Download</span>
          </div>
          <div class="context-menu-item" data-action="compare">
            <span class="codicon codicon-compare-changes"></span>
            <span>Compare</span>
          </div>
          ${showAgentReview ? `
          <div class="context-menu-item" data-action="reviewWithAgent">
            <span class="codicon codicon-copilot"></span>
            <span>Review with Agent</span>
          </div>` : ''}
          <div class="context-menu-item" data-action="upload">
            <span class="codicon codicon-cloud-upload"></span>
            <span>Upload</span>
          </div>
          <div class="context-menu-separator"></div>
          <div class="context-menu-item" data-action="rename">
            <span class="codicon codicon-pencil"></span>
            <span>Rename</span>
          </div>
          <div class="context-menu-item" data-action="duplicate">
            <span class="codicon codicon-copy"></span>
            <span>Duplicate</span>
          </div>
          <div class="context-menu-item" data-action="delete">
            <span class="codicon codicon-trash"></span>
            <span>Delete</span>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Recursively render directory contents with expand/collapse support
   */
  private async _renderDirectory(dirPath: string, depth: number, parentWasExpandedBeforeFilter: boolean = false): Promise<string> {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const filterLower = this._searchFilter.toLowerCase();

    const filtered = entries
      .filter(e => !e.name.startsWith('.'))
      .filter(e => {
        if (!this._searchFilter) return true;

        const fullPath = path.join(dirPath, e.name);
        const wasExpandedBeforeFilter = this._foldersExpandedBeforeFilter.has(fullPath);

        if (e.isDirectory() && wasExpandedBeforeFilter) return true;

        if (depth === 0 || parentWasExpandedBeforeFilter) {
          return e.name.toLowerCase().includes(filterLower);
        }

        return true;
      });

    const sorted = filtered
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    if (sorted.length === 0 && depth === 0) {
      const message = this._searchFilter ? 'No matching files' : 'Empty folder';
      return `<li class="file-item empty"><span class="codicon codicon-info"></span> ${message}</li>`;
    }

    const rendered = await Promise.all(sorted.map(async entry => {
      const fullPath = path.join(dirPath, entry.name);
      const isDir = entry.isDirectory();
      const isExpanded = this._expandedFolders.has(fullPath);
      const wasExpandedBeforeFilter = this._foldersExpandedBeforeFilter.has(fullPath);
      const indent = depth * 16;
      const aiToggleIcon = this._getAiToggleIcon(fullPath);

      if (isDir) {
        const chevronClass = isExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right';

        let html = `
          <li class="file-item" data-action="toggle" data-path="${this._escapeHtml(fullPath)}" style="padding-left: ${indent}px;">
            <span class="chevron codicon ${chevronClass}"></span>
            <span class="name">${this._escapeHtml(entry.name)}</span>
            ${aiToggleIcon}
          </li>
        `;

        if (isExpanded) {
          html += await this._renderDirectory(fullPath, depth + 1, wasExpandedBeforeFilter);
        }

        return html;
      }

      const iconClass = this._getFileIcon(entry.name);
      const metadata = await this._getFileMetadata(fullPath);
      const sizeHtml = this._showFileSize && metadata ? `<span class="meta size">${this._formatSize(metadata.size)}</span>` : '';
      const dateHtml = this._showFileDate && metadata ? `<span class="meta date">${this._formatDate(metadata.mtime)}</span>` : '';
      const selectedClass = this._selectedFile === fullPath ? ' selected' : '';

      const trackedInfo = this._trackedFiles.get(fullPath);
      const isTracked = !!trackedInfo;
      let syncStatusClass = '';
      let trackingIconClass = 'codicon-eye';

      if (trackedInfo) {
        switch (trackedInfo.status) {
          case SyncStatus.NotDownloaded:
            syncStatusClass = ' not-downloaded';
            trackingIconClass = 'codicon-cloud-download';
            break;
          case SyncStatus.RemoteNewer:
            syncStatusClass = ' remote-newer';
            trackingIconClass = 'codicon-arrow-down';
            break;
          case SyncStatus.LocalNewer:
            syncStatusClass = ' local-newer';
            trackingIconClass = 'codicon-arrow-up';
            break;
          case SyncStatus.Synced:
            syncStatusClass = ' synced';
            trackingIconClass = 'codicon-check';
            break;
          default:
            trackingIconClass = 'codicon-warning';
        }
      }

      const trackedClass = isTracked ? ` tracked${syncStatusClass}` : '';
      const trackingIcon = isTracked
        ? `<span class="tracking-indicator codicon ${trackingIconClass}"></span>`
        : `<span class="tracking-indicator-placeholder"></span>`;

      return `
        <li class="file-item${selectedClass}${trackedClass}" data-action="select" data-path="${this._escapeHtml(fullPath)}" style="padding-left: ${indent}px;">
          <span class="chevron-spacer"></span>
          <span class="icon"><span class="codicon ${iconClass}"></span></span>
          <span class="name">${this._escapeHtml(entry.name)}</span>
          ${dateHtml}${sizeHtml}${trackingIcon}${aiToggleIcon}
        </li>
      `;
    }));

    return rendered.join('');
  }

  private async _getFileMetadata(fullPath: string): Promise<{ size: number; mtime: Date } | undefined> {
    if (!this._showFileSize && !this._showFileDate) {
      return undefined;
    }

    const stats = await fs.promises.stat(fullPath);
    return { size: stats.size, mtime: stats.mtime };
  }

  private async _refreshFileBrowserMarkup(force = false): Promise<void> {
    if (!this._currentConnection || this._currentConnection.status !== ConnectionStatus.Connected || !this._currentPath) {
      this._fileBrowserMarkup = '';
      this._fileBrowserError = undefined;
      this._fileBrowserLoading = false;
      return;
    }

    if (this._autoRefreshSuspended && this._fileBrowserError && !force) {
      return;
    }

    if (this._fileBrowserRefreshPromise) {
      this._pendingFileBrowserRefresh = true;
      await this._fileBrowserRefreshPromise;
      return;
    }

    this._fileBrowserRefreshPromise = this._buildFileBrowserMarkup(force);
    await this._fileBrowserRefreshPromise;
  }

  private async _buildFileBrowserMarkup(force: boolean): Promise<void> {
    const refreshKey = `${this._currentConnection?.config.name ?? ''}:${this._currentPath ?? ''}:${this._searchFilter}`;
    if (force) {
      this._clearFileBrowserFailureState();
    }

    this._fileBrowserLoading = true;

    try {
      const markup = this._currentPath ? await this._renderDirectory(this._currentPath, 0) : '';
      const currentKey = `${this._currentConnection?.config.name ?? ''}:${this._currentPath ?? ''}:${this._searchFilter}`;

      if (refreshKey === currentKey) {
        this._fileBrowserMarkup = markup;
        this._fileBrowserError = undefined;
        this._fileBrowserReady = true;
        if (this._pendingAutoSwitchToFiles) {
          this._pendingAutoSwitchToFiles = false;
          this._currentTab = 'files';
        }
        if (this._currentConnection) {
          this._connectionManager.resetMountAccessFailures(this._currentConnection.config.name);
        }
      }
    } catch (error) {
      const currentPath = this._currentPath ?? '';
      Logger.error(`Error reading directory ${currentPath}: ${error}`);
      this._setFileBrowserError(currentPath, error);
      this._fileBrowserMarkup = this._renderFileBrowserError(this._fileBrowserError);
    } finally {
      this._fileBrowserLoading = false;
      this._fileBrowserRefreshPromise = undefined;

      if (this._pendingFileBrowserRefresh) {
        this._pendingFileBrowserRefresh = false;
        await this._refreshFileBrowserMarkup();
      }
    }
  }

  private _setFileBrowserError(dirPath: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code = this._getErrorCode(error);
    const hint = this._getFileBrowserErrorHint(message, code);

    this._fileBrowserError = { path: dirPath, message, hint, code };
    this._fileBrowserReady = false;
    this._pendingAutoSwitchToFiles = false;

    if (this._isMountAccessError(message, code)) {
      this._autoRefreshSuspended = true;
      if (this._currentConnection) {
        this._connectionManager.reportMountAccessFailure(this._currentConnection.config.name, {
          path: dirPath,
          message,
          code,
        });
      }
    }
  }

  private _renderFileBrowserError(error: FileBrowserErrorState | undefined): string {
    const hint = error?.hint ?? '';
    return `
      <li class="file-item" style="color: var(--vscode-errorForeground)">
        <span class="codicon codicon-error"></span> Error reading directory${hint}
      </li>
      <li class="file-item">
        <button class="action-button" data-action="reconnect" style="margin-left: 24px; margin-top: 8px;">
          <span class="codicon codicon-refresh"></span> Reconnect
        </button>
      </li>
    `;
  }

  private _clearFileBrowserFailureState(): void {
    this._fileBrowserError = undefined;
    this._autoRefreshSuspended = false;
  }

  private _getErrorCode(error: unknown): string | undefined {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return String((error as NodeJS.ErrnoException).code);
    }

    return undefined;
  }

  private _isMountAccessError(message: string, code?: string): boolean {
    const normalized = `${code ?? ''} ${message}`.toLowerCase();
    return ['eio', 'ebusy', 'enoent', 'etimedout', 'eacces', 'enotconn'].some(token => normalized.includes(token))
      || normalized.includes('i/o error')
      || normalized.includes('not accessible')
      || normalized.includes('timed out')
      || normalized.includes('permission denied');
  }

  private _getFileBrowserErrorHint(message: string, code?: string): string {
    const normalized = `${code ?? ''} ${message}`.toLowerCase();

    if (normalized.includes('enoent') || normalized.includes('not accessible') || normalized.includes('eio')) {
      return ' - Drive may be disconnected. Try reconnecting.';
    }

    if (normalized.includes('etimedout') || normalized.includes('timeout')) {
      return ' - Connection timed out. Try reconnecting.';
    }

    if (normalized.includes('eacces') || normalized.includes('permission')) {
      return ' - Permission denied.';
    }

    return '';
  }

  /**
   * Check if MCP is active for the current connection
   */
  private _isMcpActive(): boolean {
    if (!this._mcpManager || !this._currentConnection) {
      return false;
    }
    return this._currentConnection.mcpActive === true;
  }

  /**
   * Check if a path has AI write access
   */
  private _isAiWritable(filePath: string): boolean {
    if (!this._mcpManager || !this._currentConnection) {
      return false;
    }
    return this._mcpManager.isAiWritable(this._currentConnection.config.name, filePath);
  }

  /**
   * Get the AI write mode for a path
   */
  private _getAiWriteMode(filePath: string): 'local' | 'host' | null {
    if (!this._mcpManager || !this._currentConnection) {
      return null;
    }
    return this._mcpManager.getAiWriteMode(this._currentConnection.config.name, filePath);
  }

  /**
   * Get the AI toggle icon HTML for a file/folder
   * - No icon: read-only (click to set mode)
   * - Green (copilot): LOCAL mode (click to revoke)
   * - Red (copilot-warning): HOST mode (click to revoke)
   */
  private _getAiToggleIcon(filePath: string): string {
    if (!this._isMcpActive()) {
      return ''; // No icon if MCP is not active
    }

    const mode = this._getAiWriteMode(filePath);

    if (mode === 'local') {
      // Green = Local mode
      return `<span class="ai-toggle ai-local" data-action="toggleAiWrite" data-path="${this._escapeHtml(filePath)}" title="AI Local mode (diff preview) - click to revoke"><span class="codicon codicon-copilot"></span></span>`;
    } else if (mode === 'host') {
      // Red = Host mode
      return `<span class="ai-toggle ai-host" data-action="toggleAiWrite" data-path="${this._escapeHtml(filePath)}" title="AI Host mode (direct write) - click to revoke"><span class="codicon codicon-copilot-warning"></span></span>`;
    } else {
      // Gray = No access (click to set mode)
      return `<span class="ai-toggle ai-readonly" data-action="toggleAiWrite" data-path="${this._escapeHtml(filePath)}" title="AI read-only - click to allow write"><span class="codicon codicon-copilot"></span></span>`;
    }
  }

  /**
   * Format date for display
   */
  private _formatDate(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (days < 7) {
      return date.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    } else {
      return date.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
    }
  }

  /**
   * Download a file to .sftp-plus/[connection]/ folder
   */
  private async _downloadFile(remotePath: string): Promise<void> {
    try {
      if (!this._currentConnection) {
        vscode.window.showErrorMessage('No connection selected');
        return;
      }

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
        return;
      }

      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      const connectionName = this._currentConnection.config.name;
      const fileName = path.basename(remotePath);

      // Calculate local path: .sftp-plus/[connection]/[relative-path]
      // Extract path after drive letter (e.g., Z:\folder\file.txt -> folder\file.txt)
      const relativePath = remotePath.substring(3); // Remove "Z:\"
      const localPath = path.join(workspaceRoot, '.sftp-plus', connectionName, relativePath);

      // Backup original server version before any modification
      const driveLetter = this._currentConnection.mountedDrive;
      if (driveLetter) {
        const cleanRelative = relativePath.replace(/\\/g, '/');
        await this._trackingService.backupOriginal(connectionName, cleanRelative, driveLetter);
      }

      // Ensure directory exists
      await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

      // Copy file from mounted drive to local
      await fs.promises.copyFile(remotePath, localPath);

      vscode.window.showInformationMessage(`Downloaded: ${fileName}`);

      // Open the downloaded file
      const localUri = vscode.Uri.file(localPath);
      await vscode.commands.executeCommand('vscode.open', localUri);

      // Refresh tracked files to update sync status (rescans and updates display)
      await this.refreshTrackedFiles();
    } catch (error) {
      Logger.error('Failed to download file:', error);
      vscode.window.showErrorMessage(`Failed to download file: ${error}`);
    }
  }

  /**
   * Upload a tracked local file back to the mounted host
   */
  private async _uploadFile(remotePath: string): Promise<void> {
    try {
      const trackedInfo = this._trackedFiles.get(remotePath);
      if (!trackedInfo) {
        vscode.window.showErrorMessage('Upload is only available for tracked local-newer files');
        return;
      }

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
        return;
      }

      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      const localFullPath = path.join(workspaceRoot, trackedInfo.file.localPath);
      const localDocument = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === localFullPath);
      if (localDocument?.isDirty) {
        await localDocument.save();
      }

      const success = await this._trackingService.uploadTrackedFile(trackedInfo.file);
      if (success) {
        await this.refreshTrackedFiles();
      }
    } catch (error) {
      Logger.error('Failed to upload file:', error);
      vscode.window.showErrorMessage(`Failed to upload file: ${error}`);
    }
  }

  /**
   * Compare the local tracked file with the mounted host file using VS Code diff
   */
  private async _compareFile(remotePath: string): Promise<void> {
    try {
      const trackedInfo = this._trackedFiles.get(remotePath);
      if (!trackedInfo) {
        vscode.window.showErrorMessage('Compare is only available for tracked files');
        return;
      }

      const status = trackedInfo.status;
      if (status !== SyncStatus.LocalNewer && status !== SyncStatus.RemoteNewer) {
        vscode.window.showInformationMessage('Compare is only available when the local and host versions differ');
        return;
      }

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
        return;
      }

      const localFullPath = path.join(workspaceRoot, trackedInfo.file.localPath);
      if (!fs.existsSync(localFullPath) || !fs.existsSync(trackedInfo.file.fullRemotePath)) {
        vscode.window.showErrorMessage('Compare requires both the local tracked file and the mounted host file');
        return;
      }

      const title = `Compare: ${path.basename(remotePath)} (Local ↔ Host)`;
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(localFullPath),
        vscode.Uri.file(trackedInfo.file.fullRemotePath),
        title,
        { preview: true }
      );
    } catch (error) {
      Logger.error('Failed to compare file:', error);
      vscode.window.showErrorMessage(`Failed to compare file: ${error}`);
    }
  }

  /**
   * Ask the active agent to review host differences by proposing edits on the local tracked file.
   */
  private async _reviewWithAgent(remotePath: string): Promise<void> {
    const trackedInfo = this._trackedFiles.get(remotePath);
    if (!trackedInfo) {
      vscode.window.showErrorMessage('Agent review is only available for tracked files');
      return;
    }

    if (trackedInfo.status !== SyncStatus.LocalNewer && trackedInfo.status !== SyncStatus.RemoteNewer) {
      vscode.window.showInformationMessage('Agent review is only available when the local and host versions differ');
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot || !this._currentConnection) {
      vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
      return;
    }

    const localFullPath = path.join(workspaceRoot, trackedInfo.file.localPath);
    if (!fs.existsSync(localFullPath) || !fs.existsSync(trackedInfo.file.fullRemotePath)) {
      vscode.window.showErrorMessage('Agent review requires both the local tracked file and the mounted host file');
      return;
    }

    const localUri = vscode.Uri.file(localFullPath);
    const localDocument = await vscode.workspace.openTextDocument(localUri);
    await vscode.window.showTextDocument(localDocument, { preview: false });

    const prompt = [
      `Review the differences between the local tracked file and the current host version for connection "${this._currentConnection.config.name}".`,
      `Target the already opened local workspace file at "${localFullPath}".`,
      `Use the host file "${trackedInfo.file.remotePath}" on that SFTP+ connection as the reference version to compare against.`,
      `The current detected sync status is "${trackedInfo.status}".`,
      'Do not modify the host file and do not upload anything.',
      'If there are meaningful differences, use standard Copilot edit tools on the local file only so the user gets accept/reject review changes directly in VS Code.',
      'Only propose changes that reflect the host-only differences, keep identical lines untouched, and briefly explain the most critical differences first in chat.'
    ].join(' ');

    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        mode: 'agent',
        query: prompt,
        isPartialQuery: false,
      });
    } catch (error) {
      Logger.warn(`Falling back to native diff because chat open failed: ${error instanceof Error ? error.message : String(error)}`);
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(localFullPath),
        vscode.Uri.file(trackedInfo.file.fullRemotePath),
        `Compare: ${path.basename(trackedInfo.file.remotePath)} (Local ↔ Host)`,
        { preview: true }
      );
    }
  }

  /**
   * Rename a file or folder
   */
  private async _renameFile(filePath: string): Promise<void> {
    const currentName = path.basename(filePath);
    const isDirectory = fs.statSync(filePath).isDirectory();

    const newName = await vscode.window.showInputBox({
      prompt: `Enter new name for ${isDirectory ? 'folder' : 'file'}`,
      value: currentName,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Name cannot be empty';
        }
        if (value.includes('/') || value.includes('\\')) {
          return 'Name cannot contain path separators';
        }
        return undefined;
      }
    });

    if (!newName || newName === currentName) {
      return;
    }

    try {
      const dirPath = path.dirname(filePath);
      const newPath = path.join(dirPath, newName);

      // Check if target already exists
      if (fs.existsSync(newPath)) {
        vscode.window.showErrorMessage(`A ${isDirectory ? 'folder' : 'file'} with that name already exists`);
        return;
      }

      fs.renameSync(filePath, newPath);
      vscode.window.showInformationMessage(`Renamed to "${newName}"`);
      this._updateView();
    } catch (error) {
      Logger.error('Failed to rename', error);
      vscode.window.showErrorMessage(`Failed to rename: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Duplicate a file or folder
   */
  private async _duplicateFile(filePath: string): Promise<void> {
    const currentName = path.basename(filePath);
    const isDirectory = fs.statSync(filePath).isDirectory();
    const ext = path.extname(currentName);
    const nameWithoutExt = ext ? currentName.slice(0, -ext.length) : currentName;
    const suggestedName = `${nameWithoutExt} (copy)${ext}`;

    const newName = await vscode.window.showInputBox({
      prompt: `Enter name for the duplicate ${isDirectory ? 'folder' : 'file'}`,
      value: suggestedName,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Name cannot be empty';
        }
        if (value.includes('/') || value.includes('\\')) {
          return 'Name cannot contain path separators';
        }
        return undefined;
      }
    });

    if (!newName) {
      return;
    }

    try {
      const dirPath = path.dirname(filePath);
      const newPath = path.join(dirPath, newName);

      // Check if target already exists
      if (fs.existsSync(newPath)) {
        vscode.window.showErrorMessage(`A ${isDirectory ? 'folder' : 'file'} with that name already exists`);
        return;
      }

      if (isDirectory) {
        // Recursively copy directory
        this._copyDirectorySync(filePath, newPath);
      } else {
        fs.copyFileSync(filePath, newPath);
      }

      vscode.window.showInformationMessage(`Created "${newName}"`);
      this._updateView();
    } catch (error) {
      Logger.error('Failed to duplicate', error);
      vscode.window.showErrorMessage(`Failed to duplicate: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Recursively copy a directory
   */
  private _copyDirectorySync(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this._copyDirectorySync(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Delete a file or folder
   */
  private async _deleteFile(filePath: string): Promise<void> {
    const fileName = path.basename(filePath);
    const isDirectory = fs.statSync(filePath).isDirectory();

    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to delete "${fileName}"?${isDirectory ? ' This will delete all contents.' : ''}`,
      { modal: true },
      'Delete'
    );

    if (confirm !== 'Delete') {
      return;
    }

    try {
      if (isDirectory) {
        fs.rmSync(filePath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(filePath);
      }

      vscode.window.showInformationMessage(`Deleted "${fileName}"`);
      this._updateView();
    } catch (error) {
      Logger.error('Failed to delete', error);
      vscode.window.showErrorMessage(`Failed to delete: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Delete multiple files/folders with single confirmation
   */
  private async _deleteFiles(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return;

    // Count files and folders
    let fileCount = 0;
    let folderCount = 0;
    for (const filePath of filePaths) {
      try {
        if (fs.statSync(filePath).isDirectory()) {
          folderCount++;
        } else {
          fileCount++;
        }
      } catch {
        // File may not exist, skip
      }
    }

    const itemDescription = [];
    if (fileCount > 0) itemDescription.push(`${fileCount} file${fileCount > 1 ? 's' : ''}`);
    if (folderCount > 0) itemDescription.push(`${folderCount} folder${folderCount > 1 ? 's' : ''}`);

    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to delete ${itemDescription.join(' and ')}?${folderCount > 0 ? ' Folders will be deleted with all their contents.' : ''}`,
      { modal: true },
      'Delete'
    );

    if (confirm !== 'Delete') {
      return;
    }

    let deletedCount = 0;
    let errorCount = 0;

    for (const filePath of filePaths) {
      try {
        const isDirectory = fs.statSync(filePath).isDirectory();
        if (isDirectory) {
          fs.rmSync(filePath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(filePath);
        }
        deletedCount++;
      } catch (error) {
        Logger.error(`Failed to delete ${filePath}`, error);
        errorCount++;
      }
    }

    if (errorCount === 0) {
      vscode.window.showInformationMessage(`Deleted ${deletedCount} item${deletedCount > 1 ? 's' : ''}`);
    } else {
      vscode.window.showWarningMessage(`Deleted ${deletedCount} item${deletedCount > 1 ? 's' : ''}, ${errorCount} failed`);
    }

    this._updateView();
  }

  /**
   * Get appropriate icon based on file extension
   */
  private _getFileIcon(filename: string): string {
    const ext = path.extname(filename).toLowerCase();

    // Map common extensions to codicons
    const iconMap: Record<string, string> = {
      // Code files
      '.js': 'codicon-symbol-method',
      '.ts': 'codicon-symbol-method',
      '.jsx': 'codicon-symbol-method',
      '.tsx': 'codicon-symbol-method',
      '.py': 'codicon-symbol-method',
      '.java': 'codicon-symbol-method',
      '.c': 'codicon-symbol-method',
      '.cpp': 'codicon-symbol-method',
      '.cs': 'codicon-symbol-method',
      '.go': 'codicon-symbol-method',
      '.rs': 'codicon-symbol-method',
      '.php': 'codicon-symbol-method',
      '.rb': 'codicon-symbol-method',
      '.swift': 'codicon-symbol-method',
      '.kt': 'codicon-symbol-method',

      // Web files
      '.html': 'codicon-code',
      '.htm': 'codicon-code',
      '.css': 'codicon-symbol-color',
      '.scss': 'codicon-symbol-color',
      '.sass': 'codicon-symbol-color',
      '.less': 'codicon-symbol-color',
      '.vue': 'codicon-code',
      '.svelte': 'codicon-code',

      // Data files
      '.json': 'codicon-json',
      '.xml': 'codicon-code',
      '.yaml': 'codicon-code',
      '.yml': 'codicon-code',
      '.toml': 'codicon-code',
      '.csv': 'codicon-table',
      '.sql': 'codicon-database',

      // Config files
      '.env': 'codicon-gear',
      '.gitignore': 'codicon-git-commit',
      '.npmrc': 'codicon-package',
      '.editorconfig': 'codicon-settings',

      // Documents
      '.md': 'codicon-markdown',
      '.txt': 'codicon-file-text',
      '.pdf': 'codicon-file-pdf',
      '.doc': 'codicon-file-text',
      '.docx': 'codicon-file-text',

      // Images
      '.png': 'codicon-file-media',
      '.jpg': 'codicon-file-media',
      '.jpeg': 'codicon-file-media',
      '.gif': 'codicon-file-media',
      '.svg': 'codicon-file-media',
      '.ico': 'codicon-file-media',
      '.webp': 'codicon-file-media',

      // Archives
      '.zip': 'codicon-file-zip',
      '.tar': 'codicon-file-zip',
      '.gz': 'codicon-file-zip',
      '.rar': 'codicon-file-zip',
      '.7z': 'codicon-file-zip',

      // Binary/executables
      '.exe': 'codicon-file-binary',
      '.dll': 'codicon-file-binary',
      '.so': 'codicon-file-binary',
      '.bin': 'codicon-file-binary',

      // Misc
      '.log': 'codicon-output',
      '.lock': 'codicon-lock',
      '.jsp': 'codicon-code',
    };

    return iconMap[ext] || 'codicon-file';
  }

  private _formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }

  private _getScript(): string {
    return `
      const vscode = acquireVsCodeApi();
      const escapeHtml = (value) => String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&#039;');

      function updateStatus(message, type, canAcceptCertificate) {
        const statusEl = document.getElementById('statusMessage');
        if (!statusEl) {
          return;
        }

        statusEl.className = 'status' + (type ? ' ' + type : '');
        const actions = canAcceptCertificate
          ? '<div class="status-actions"><button type="button" class="btn-secondary" id="acceptCertBtn">Accept certificate and retest</button></div>'
          : '';
        statusEl.innerHTML = '<div>' + escapeHtml(message) + '</div>' + actions;

        document.getElementById('acceptCertBtn')?.addEventListener('click', () => {
          const checkbox = document.getElementById('ignoreCertErrors');
          const testBtn = document.getElementById('testBtn');
          if (checkbox) {
            checkbox.checked = true;
          }
          testBtn?.click();
        });
      }

      // Tab switching
      document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
          if (tab.disabled) return;
          vscode.postMessage({ command: 'switchTab', tab: tab.dataset.tab });
        });
      });

      // Settings form
      const form = document.getElementById('settingsForm');
      if (form) {
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const formData = new FormData(form);
          const config = {
            name: formData.get('name'),
            protocol: formData.get('protocol'),
            port: parseInt(formData.get('port')),
            host: formData.get('host'),
            username: formData.get('username'),
            password: formData.get('password') || undefined,
            remotePath: formData.get('remotePath') || '/',
            driveLetter: formData.get('driveLetter')?.toUpperCase() || undefined,
            autoConnect: formData.get('autoConnect') === 'on',
            autoReconnectOnDrop: formData.get('autoReconnectOnDrop') === 'on',
            explicitTls: formData.get('explicitTls') === 'on',
            ignoreCertErrors: formData.get('ignoreCertErrors') === 'on',
            syncRate: parseInt(formData.get('syncRate')) || 60,
          };
          vscode.postMessage({ command: 'saveConnection', config });
        });

        document.getElementById('testBtn')?.addEventListener('click', () => {
          const formData = new FormData(form);
          const config = {
            name: formData.get('name'),
            protocol: formData.get('protocol'),
            port: parseInt(formData.get('port')),
            host: formData.get('host'),
            username: formData.get('username'),
            password: formData.get('password'),
            remotePath: formData.get('remotePath') || '/',
            explicitTls: formData.get('explicitTls') === 'on',
            ignoreCertErrors: formData.get('ignoreCertErrors') === 'on',
            autoReconnectOnDrop: formData.get('autoReconnectOnDrop') === 'on',
          };
          vscode.postMessage({ command: 'testConnection', config });
        });

        document.getElementById('deleteBtn')?.addEventListener('click', () => {
          const name = form.querySelector('[name="name"]').value;
          vscode.postMessage({ command: 'deleteConnection', name });
        });

        document.getElementById('deletePasswordBtn')?.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const name = form.querySelector('[name="name"]').value;
          // confirm() works in webview but let's be safe
          vscode.postMessage({ command: 'deletePassword', name });
        });
      }

      // File browser
      const refreshBtn = document.getElementById('refreshBtn');
      refreshBtn?.addEventListener('click', () => {
        refreshBtn.classList.add('spinning');
        vscode.postMessage({ command: 'refresh' });
      });

      document.getElementById('toggleSizeBtn')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'toggleSize' });
      });

      document.getElementById('toggleDateBtn')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'toggleDate' });
      });

      // Search input with debounce
      const searchInput = document.getElementById('searchInput');
      let searchTimeout;
      searchInput?.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        const cursorPos = e.target.selectionStart;
        searchTimeout = setTimeout(() => {
          vscode.postMessage({ command: 'search', query: e.target.value, cursorPos: cursorPos });
        }, 150);
      });

      document.getElementById('clearSearchBtn')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'search', query: '' });
      });

      // Prerequisite install button
      document.getElementById('installPrereqBtn')?.addEventListener('click', () => {
        const prereqName = document.querySelector('.prereq-details h3')?.textContent;
        if (prereqName?.includes('rclone')) {
          vscode.postMessage({ command: 'installPrerequisite', name: 'rclone' });
        } else if (prereqName?.includes('WinFsp')) {
          vscode.postMessage({ command: 'installPrerequisite', name: 'WinFsp' });
        }
      });

      // Prerequisite learn more link
      document.getElementById('prereqLink')?.addEventListener('click', (e) => {
        e.preventDefault();
        const url = e.currentTarget.dataset.url;
        vscode.postMessage({ command: 'openExternal', url });
      });

      // AI toggle click handler
      document.querySelectorAll('.ai-toggle').forEach(toggle => {
        toggle.addEventListener('click', (e) => {
          e.stopPropagation(); // Prevent file/folder selection
          const filePath = toggle.dataset.path;
          vscode.postMessage({ command: 'toggleAiWrite', path: filePath });
        });
      });

      // Reconnect button handler (shown on connection errors)
      document.querySelectorAll('[data-action="reconnect"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ command: 'reconnect' });
        });
      });

      // Track selected files for multi-selection
      let selectedFiles = [];

      // Helper to get all selected file paths
      function getSelectedFilePaths() {
        return Array.from(document.querySelectorAll('.file-item.selected'))
          .map(el => el.dataset.path)
          .filter(p => p);
      }

      // Helper to check if all selected items are files (not folders)
      function areAllSelectedFiles() {
        return Array.from(document.querySelectorAll('.file-item.selected'))
          .every(el => el.dataset.action === 'select');
      }

      document.querySelectorAll('.file-item').forEach(item => {
        item.addEventListener('click', (e) => {
          // Don't handle if click was on AI toggle
          if (e.target.closest('.ai-toggle')) return;

          const action = item.dataset.action;
          const filePath = item.dataset.path;
          if (action === 'toggle') {
            const chevron = item.querySelector('.chevron');
            if (chevron) {
              chevron.classList.remove('codicon-chevron-right', 'codicon-chevron-down');
              chevron.classList.add('codicon-loading', 'codicon-modifier-spin', 'loading');
            }
            // Clear selection when toggling folder
            if (!e.ctrlKey && !e.metaKey) {
              document.querySelectorAll('.file-item.selected').forEach(el => el.classList.remove('selected'));
            }
            vscode.postMessage({ command: 'toggleFolder', path: filePath });
          } else if (action === 'navigate') {
            vscode.postMessage({ command: 'navigateTo', path: filePath });
          } else if (action === 'select') {
            // Multi-select with Ctrl/Cmd key
            if (e.ctrlKey || e.metaKey) {
              // Toggle selection
              item.classList.toggle('selected');
            } else {
              // Single select - clear others
              document.querySelectorAll('.file-item.selected').forEach(el => el.classList.remove('selected'));
              item.classList.add('selected');
            }
            vscode.postMessage({ command: 'selectFile', path: filePath });
          }
        });

        // Right-click context menu for files and folders
        item.addEventListener('contextmenu', (e) => {
          const action = item.dataset.action;
          const isFile = action === 'select';
          const isFolder = action === 'toggle';

          // Only for files and folders, not navigation items
          if (!isFile && !isFolder) return;

          e.preventDefault();
          const filePath = item.dataset.path;
          const isTracked = item.classList.contains('tracked');

          // If right-clicking on an unselected item, select only that item
          // If right-clicking on a selected item, keep all selections
          if (!item.classList.contains('selected')) {
            document.querySelectorAll('.file-item.selected').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');
            if (isFile) {
              vscode.postMessage({ command: 'selectFile', path: filePath });
            }
          }

          // Get all selected paths
          const selectedPaths = getSelectedFilePaths();
          const multiSelect = selectedPaths.length > 1;
          const allFiles = areAllSelectedFiles();
          const selectedItems = Array.from(document.querySelectorAll('.file-item.selected'));
          const allLocalNewer = selectedItems.length > 0 && selectedItems.every(el => el.classList.contains('local-newer'));
          const allDownloadSafe = selectedItems.length > 0 && selectedItems.every(el => {
            if (!el.classList.contains('tracked')) {
              return true;
            }
            return el.classList.contains('remote-newer') || el.classList.contains('not-downloaded');
          });
          const singleTrackedOutOfSync = selectedItems.length === 1 &&
            (selectedItems[0].classList.contains('local-newer') || selectedItems[0].classList.contains('remote-newer'));

          // Show/hide menu items based on selection
          const cloudEditItem = document.querySelector('[data-action="cloudEdit"]');
          const downloadItem = document.querySelector('[data-action="download"]');
          const compareItem = document.querySelector('[data-action="compare"]');
          const reviewWithAgentItem = document.querySelector('[data-action="reviewWithAgent"]');
          const uploadItem = document.querySelector('[data-action="upload"]');
          const renameItem = document.querySelector('[data-action="rename"]');
          const duplicateItem = document.querySelector('[data-action="duplicate"]');

          // Cloud Edit: only for files (single or multi)
          if (cloudEditItem) cloudEditItem.style.display = allFiles ? 'flex' : 'none';
          if (downloadItem) downloadItem.style.display = (allFiles && allDownloadSafe) ? 'flex' : 'none';
          if (compareItem) compareItem.style.display = (allFiles && singleTrackedOutOfSync) ? 'flex' : 'none';
          if (reviewWithAgentItem) reviewWithAgentItem.style.display = (allFiles && singleTrackedOutOfSync) ? 'flex' : 'none';
          if (uploadItem) uploadItem.style.display = (allFiles && allLocalNewer) ? 'flex' : 'none';

          // Rename, Duplicate: only for single selection
          if (renameItem) renameItem.style.display = (!multiSelect) ? 'flex' : 'none';
          if (duplicateItem) duplicateItem.style.display = (!multiSelect) ? 'flex' : 'none';

          // Update menu item labels for multi-select
          if (cloudEditItem) {
            cloudEditItem.querySelector('span:last-child').textContent = multiSelect ? 'Cloud Edit (' + selectedPaths.length + ')' : 'Cloud Edit';
          }
          if (downloadItem) {
            downloadItem.querySelector('span:last-child').textContent = multiSelect ? 'Download (' + selectedPaths.length + ')' : 'Download';
          }
          if (compareItem) {
            compareItem.querySelector('span:last-child').textContent = 'Compare';
          }
          if (reviewWithAgentItem) {
            reviewWithAgentItem.querySelector('span:last-child').textContent = 'Review with Agent';
          }
          if (uploadItem) {
            uploadItem.querySelector('span:last-child').textContent = multiSelect ? 'Upload (' + selectedPaths.length + ')' : 'Upload';
          }
          const deleteItem = document.querySelector('[data-action="delete"]');
          if (deleteItem) {
            deleteItem.querySelector('span:last-child').textContent = multiSelect ? 'Delete (' + selectedPaths.length + ')' : 'Delete';
          }

          // Show context menu
          const menu = document.getElementById('contextMenu');
          if (menu) {
            // First, make menu visible but off-screen to calculate its height
            menu.style.left = '-9999px';
            menu.style.top = '-9999px';
            menu.classList.add('visible');

            // Get menu height and viewport dimensions
            const menuHeight = menu.offsetHeight;
            const viewportHeight = window.innerHeight;
            const clickY = e.clientY;

            // Determine if menu should open upward or downward
            // If click is in bottom half, open upward
            const openUpward = clickY > viewportHeight / 2;

            // Position menu
            menu.style.left = e.clientX + 'px';
            if (openUpward) {
              // Open upward: position bottom of menu at click position
              menu.style.top = (clickY - menuHeight) + 'px';
            } else {
              // Open downward: position top of menu at click position
              menu.style.top = clickY + 'px';
            }

            menu.dataset.filePath = filePath;
            menu.dataset.selectedPaths = JSON.stringify(selectedPaths);
          }
        });
      });

      // Context menu actions
      const contextMenu = document.getElementById('contextMenu');
      if (contextMenu) {
        contextMenu.querySelectorAll('.context-menu-item').forEach(menuItem => {
          menuItem.addEventListener('click', () => {
            const action = menuItem.dataset.action;
            const filePath = contextMenu.dataset.filePath;
            const selectedPaths = JSON.parse(contextMenu.dataset.selectedPaths || '[]');
            const isMultiSelect = selectedPaths.length > 1;
            contextMenu.classList.remove('visible');

            if (action === 'cloudEdit') {
              if (isMultiSelect) {
                vscode.postMessage({ command: 'openFile', paths: selectedPaths });
              } else {
                vscode.postMessage({ command: 'openFile', path: filePath });
              }
            } else if (action === 'download') {
              if (isMultiSelect) {
                vscode.postMessage({ command: 'downloadFile', paths: selectedPaths });
              } else {
                vscode.postMessage({ command: 'downloadFile', path: filePath });
              }
            } else if (action === 'compare') {
              vscode.postMessage({ command: 'compareFile', path: filePath });
            } else if (action === 'reviewWithAgent') {
              vscode.postMessage({ command: 'reviewWithAgent', path: filePath });
            } else if (action === 'upload') {
              if (isMultiSelect) {
                vscode.postMessage({ command: 'uploadFile', paths: selectedPaths });
              } else {
                vscode.postMessage({ command: 'uploadFile', path: filePath });
              }
            } else if (action === 'rename') {
              vscode.postMessage({ command: 'renameFile', path: filePath });
            } else if (action === 'duplicate') {
              vscode.postMessage({ command: 'duplicateFile', path: filePath });
            } else if (action === 'delete') {
              if (isMultiSelect) {
                vscode.postMessage({ command: 'deleteFile', paths: selectedPaths });
              } else {
                vscode.postMessage({ command: 'deleteFile', path: filePath });
              }
            }
          });
        });
      }

      // Hide context menu on click outside
      document.addEventListener('click', (e) => {
        const menu = document.getElementById('contextMenu');
        if (menu && !menu.contains(e.target)) {
          menu.classList.remove('visible');
        }
      });

      // Handle messages from extension
      window.addEventListener('message', event => {
        const message = event.data;

        switch (message.command) {
          case 'focusSearch':
            const searchEl = document.getElementById('searchInput');
            if (searchEl) {
              searchEl.focus();
              if (message.cursorPos !== undefined) {
                searchEl.setSelectionRange(message.cursorPos, message.cursorPos);
              }
            }
            break;
          case 'refreshComplete':
            const refreshBtn = document.getElementById('refreshBtn');
            if (refreshBtn) {
              refreshBtn.classList.remove('spinning');
            }
            break;
          case 'testStarted':
            updateStatus('Testing connection...', '', false);
            break;
          case 'testResult':
            updateStatus(message.message, message.success ? 'success' : 'error', message.canAcceptCertificate === true);
            break;
          case 'saveSuccess':
            updateStatus('Connection saved!', 'success', false);
            break;
          case 'saveError':
            updateStatus('Error: ' + message.error, 'error', false);
            break;
        }
      });

      const consoleBody = document.getElementById('consoleBody');
      if (consoleBody) {
        consoleBody.scrollTop = consoleBody.scrollHeight;
      }
    `;
  }

  private _escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private _getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
