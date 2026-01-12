import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Connection, ConnectionConfig, ConnectionStatus, ConnectionScope, PasswordSource, DEFAULT_CONNECTION_CONFIG, InstallStatus, SyncStatus } from '../models';
import { ConnectionManager } from '../services/connection.manager';
import { TrackingService, TrackedFileWithContext } from '../services/tracking.service';
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

/**
 * WebviewView provider that shows host details with tabs:
 * - Settings: Connection configuration form
 * - Files: File browser for connected hosts
 */
export class HostDetailsProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sftp-plus.hostDetails';

  private _view?: vscode.WebviewView;
  private _currentConnection?: Connection;
  private _currentTab: 'settings' | 'files' = 'settings';
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

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _connectionManager: ConnectionManager
  ) {
    this._trackingService = new TrackingService();
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

    // Auto-switch tab based on connection status
    if (connectionChanged) {
      if (connection.status === ConnectionStatus.Connected && connection.mountedDrive) {
        // Connected: show Files tab
        this._currentTab = 'files';
        this._currentPath = `${connection.mountedDrive}:\\`;
      } else {
        // Disconnected: show Settings tab
        this._currentTab = 'settings';
        this._currentPath = undefined;
      }
      // Clear cached password when switching connections
      this._cachedPassword = undefined;
    }

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
    // Stop auto-refresh timer
    if (this._autoRefreshTimer) {
      clearInterval(this._autoRefreshTimer);
      this._autoRefreshTimer = undefined;
    }
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

      this._currentConnection = freshConnection;

      // Auto-switch tab when connection status changes
      if (wasConnected && !isNowConnected) {
        // Just disconnected: switch to Settings, clear path
        this._currentTab = 'settings';
        this._currentPath = undefined;
      } else if (!wasConnected && isNowConnected && freshConnection.mountedDrive) {
        // Just connected: switch to Files
        this._currentTab = 'files';
        this._currentPath = `${freshConnection.mountedDrive}:\\`;
      }

      // Reload password (may have been deleted or changed)
      this._loadPasswordAndUpdate(freshConnection.config.name);
    } else {
      // Connection was removed
      this.clear();
    }
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
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.onDidReceiveMessage(async (message) => {
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
          const uri = vscode.Uri.file(message.path);
          await vscode.commands.executeCommand('vscode.open', uri);
          break;

        case 'selectFile':
          this._selectedFile = message.path;
          // Don't update view - selection is handled in webview for responsiveness
          break;

        case 'downloadFile':
          await this._downloadFile(message.path);
          break;

        case 'trackFile':
          await this._trackFile(message.path);
          break;

        case 'untrackFile':
          await this._untrackFile(message.path);
          break;

        case 'refresh':
          await this._updateView();
          // Notify webview that refresh is complete
          this._view?.webview.postMessage({ command: 'refreshComplete' });
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
          this._view?.webview.postMessage({ command: 'focusSearch', cursorPos: message.cursorPos });
          break;

        case 'installPrerequisite':
          // Install prerequisite via command
          if (message.name === 'rclone') {
            await vscode.commands.executeCommand('sftp-plus.installRclone');
          } else if (message.name === 'WinFsp') {
            await vscode.commands.executeCommand('sftp-plus.installWinFsp');
          }
          break;

        case 'openExternal':
          vscode.env.openExternal(vscode.Uri.parse(message.url));
          break;
      }
    });

    this._updateView();
  }

  /**
   * Start or stop auto-refresh timer based on current connection and tab
   */
  private _updateAutoRefreshTimer(): void {
    // Clear any existing timer
    if (this._autoRefreshTimer) {
      clearInterval(this._autoRefreshTimer);
      this._autoRefreshTimer = undefined;
    }

    // Only auto-refresh when on Files tab with a connected connection and syncRate > 0
    if (
      this._currentConnection &&
      this._currentTab === 'files' &&
      this._currentConnection.status === ConnectionStatus.Connected &&
      this._currentConnection.config.syncRate > 0
    ) {
      const intervalMs = this._currentConnection.config.syncRate * 1000;
      this._autoRefreshTimer = setInterval(async () => {
        // Clear tracking cache to force re-check
        this._trackingService.clearCache();
        await this._updateView();
      }, intervalMs);
    }
  }

  private async _updateView(): Promise<void> {
    if (!this._view) return;

    // Update auto-refresh timer
    this._updateAutoRefreshTimer();

    // Load tracked files with sync status for current connection
    if (this._currentConnection && this._currentTab === 'files' && this._currentConnection.mountedDrive) {
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
    } else {
      this._trackedFiles.clear();
    }

    this._view.webview.html = this._getHtml();
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
        message: result.message
      });
    } catch (error) {
      this._view?.webview.postMessage({
        command: 'testResult',
        success: false,
        message: String(error)
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

  private _getHtml(): string {
    const nonce = this._getNonce();

    // Get codicon font URI from resources folder (bundled with extension)
    const codiconsUri = this._view?.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', 'codicon.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${this._view?.webview.cspSource}; style-src ${this._view?.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
      color: var(--vscode-charts-orange, #cca700);
    }
    .file-item.tracked.local-newer .name,
    .file-item.tracked.local-newer .icon .codicon,
    .file-item.tracked.local-newer .tracking-indicator {
      color: var(--vscode-charts-orange, #cca700);
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
    const filesActive = this._currentTab === 'files' ? 'active' : '';
    const isConnected = this._currentConnection?.status === ConnectionStatus.Connected;

    // Get scope label for settings tab
    let scopeLabel = '';
    if (this._currentConnection) {
      scopeLabel = this._currentConnection.scope === 'workspace' ? ' (workspace)' : ' (global)';
    } else if (this._isNewConnection) {
      // New connection will be workspace if available
      scopeLabel = this._connectionManager.hasWorkspace() ? ' (workspace)' : ' (global)';
    }

    if (isConnected) {
      // Connected: Files tab first (primary), Settings second
      return `
        <div class="tabs">
          <button class="tab ${filesActive}" data-tab="files"><span class="codicon codicon-folder"></span> Files</button>
          <button class="tab ${settingsActive}" data-tab="settings"><span class="codicon codicon-gear"></span> Settings${scopeLabel}</button>
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
    } else {
      return this._getFileBrowserHtml();
    }
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
        passwordLabel = 'Password <span class="label-badge secret">(secret)</span>';
        passwordDeleteBtn = `<button type="button" class="btn-icon btn-delete-password" id="deletePasswordBtn" title="Delete saved password"><span class="codicon codicon-trash"></span></button>`;
      } else if (passwordSource === 'workspace') {
        passwordLabel = 'Password <span class="label-badge workspace">(workspace)</span>';
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
          <input type="checkbox" id="explicitTls" name="explicitTls" ${config.explicitTls !== false ? 'checked' : ''}>
          <label for="explicitTls">Use explicit TLS (FTPS)</label>
        </div>

        <div class="checkbox-group">
          <input type="checkbox" id="ignoreCertErrors" name="ignoreCertErrors" ${config.ignoreCertErrors ? 'checked' : ''}>
          <label for="ignoreCertErrors">Ignore SSL certificate errors</label>
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
    if (!this._currentConnection || this._currentConnection.status !== ConnectionStatus.Connected) {
      return `
        <div class="empty-state">
          <div class="icon"><span class="codicon codicon-debug-disconnect" style="font-size: 48px;"></span></div>
          <p>Not connected</p>
          <p style="margin-top: 8px; font-size: 12px;">Connect to browse files</p>
        </div>
      `;
    }

    const files = this._getFilesInPath();

    const sizeActiveClass = this._showFileSize ? 'active' : '';
    const dateActiveClass = this._showFileDate ? 'active' : '';

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
          <div class="context-menu-separator"></div>
          <div class="context-menu-item" data-action="track" id="trackMenuItem">
            <span class="codicon codicon-eye"></span>
            <span>Track this file</span>
          </div>
          <div class="context-menu-item" data-action="untrack" id="untrackMenuItem" style="display: none;">
            <span class="codicon codicon-eye-closed"></span>
            <span>Untrack this file</span>
          </div>
        </div>
      </div>
    `;
  }

  private _getFilesInPath(): string {
    if (!this._currentPath) return '';
    return this._renderDirectory(this._currentPath, 0);
  }

  /**
   * Recursively render directory contents with expand/collapse support
   */
  private _renderDirectory(dirPath: string, depth: number, parentWasExpandedBeforeFilter: boolean = false): string {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const filterLower = this._searchFilter.toLowerCase();

      // Filter entries based on search
      const filtered = entries
        .filter(e => !e.name.startsWith('.'))
        .filter(e => {
          if (!this._searchFilter) return true;

          // Check if this entry was expanded before filter started
          const fullPath = path.join(dirPath, e.name);
          const wasExpandedBeforeFilter = this._foldersExpandedBeforeFilter.has(fullPath);

          // Folders that were expanded before filter: always show (don't filter them)
          // because their content might contain matches
          if (e.isDirectory() && wasExpandedBeforeFilter) return true;

          // At root level OR inside a folder that was expanded before filter:
          // apply the filter
          if (depth === 0 || parentWasExpandedBeforeFilter) {
            return e.name.toLowerCase().includes(filterLower);
          }

          // Inside a folder opened AFTER filter: don't filter
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

      return sorted.map(entry => {
        const fullPath = path.join(dirPath, entry.name);
        const isDir = entry.isDirectory();
        const isExpanded = this._expandedFolders.has(fullPath);
        // Was this folder expanded before filter started?
        const wasExpandedBeforeFilter = this._foldersExpandedBeforeFilter.has(fullPath);
        const indent = depth * 16; // 16px per level

        if (isDir) {
          const chevronClass = isExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right';

          let html = `
            <li class="file-item" data-action="toggle" data-path="${this._escapeHtml(fullPath)}" style="padding-left: ${indent}px;">
              <span class="chevron codicon ${chevronClass}"></span>
              <span class="name">${this._escapeHtml(entry.name)}</span>
            </li>
          `;

          // If expanded, render children
          // Pass whether this folder was expanded before filter started
          if (isExpanded) {
            html += this._renderDirectory(fullPath, depth + 1, wasExpandedBeforeFilter);
          }

          return html;
        } else {
          const iconClass = this._getFileIcon(entry.name);
          const stats = fs.statSync(fullPath);
          const sizeHtml = this._showFileSize ? `<span class="meta size">${this._formatSize(stats.size)}</span>` : '';
          const dateHtml = this._showFileDate ? `<span class="meta date">${this._formatDate(stats.mtime)}</span>` : '';
          const selectedClass = this._selectedFile === fullPath ? ' selected' : '';

          // Check tracking status
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
          // Always reserve space for tracking icon to keep alignment
          const trackingIcon = isTracked
            ? `<span class="tracking-indicator codicon ${trackingIconClass}"></span>`
            : `<span class="tracking-indicator-placeholder"></span>`;

          return `
            <li class="file-item${selectedClass}${trackedClass}" data-action="select" data-path="${this._escapeHtml(fullPath)}" style="padding-left: ${indent}px;">
              <span class="chevron-spacer"></span>
              <span class="icon"><span class="codicon ${iconClass}"></span></span>
              <span class="name">${this._escapeHtml(entry.name)}</span>
              ${dateHtml}${sizeHtml}${trackingIcon}
            </li>
          `;
        }
      }).join('');
    } catch (error) {
      return `<li class="file-item" style="color: var(--vscode-errorForeground)"><span class="codicon codicon-error"></span> Error reading directory</li>`;
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

      // Ensure directory exists
      await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

      // Copy file from mounted drive to local
      await fs.promises.copyFile(remotePath, localPath);

      vscode.window.showInformationMessage(`Downloaded: ${fileName}`);

      // Open the downloaded file
      const localUri = vscode.Uri.file(localPath);
      await vscode.commands.executeCommand('vscode.open', localUri);

      // Refresh view to update sync status if file is tracked
      this._updateView();
    } catch (error) {
      Logger.error('Failed to download file:', error);
      vscode.window.showErrorMessage(`Failed to download file: ${error}`);
    }
  }

  /**
   * Track a file for sync monitoring
   */
  private async _trackFile(remotePath: string): Promise<void> {
    if (!this._currentConnection) {
      vscode.window.showErrorMessage('No connection selected');
      return;
    }

    const connectionName = this._currentConnection.config.name;
    const success = await this._trackingService.trackFile(remotePath, connectionName);

    if (success) {
      // Refresh view to show tracking indicator
      this._updateView();
    }
  }

  /**
   * Untrack a file
   */
  private async _untrackFile(remotePath: string): Promise<void> {
    if (!this._currentConnection) {
      vscode.window.showErrorMessage('No connection selected');
      return;
    }

    const connectionName = this._currentConnection.config.name;
    const success = await this._trackingService.untrackFile(remotePath, connectionName);

    if (success) {
      // Refresh view to remove tracking indicator
      this._updateView();
    }
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

      document.querySelectorAll('.file-item').forEach(item => {
        item.addEventListener('click', () => {
          const action = item.dataset.action;
          const filePath = item.dataset.path;
          if (action === 'toggle') {
            vscode.postMessage({ command: 'toggleFolder', path: filePath });
          } else if (action === 'navigate') {
            vscode.postMessage({ command: 'navigateTo', path: filePath });
          } else if (action === 'select') {
            // Select file (update visual state)
            document.querySelectorAll('.file-item.selected').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');
            vscode.postMessage({ command: 'selectFile', path: filePath });
          }
        });

        // Right-click context menu for files
        item.addEventListener('contextmenu', (e) => {
          const action = item.dataset.action;
          if (action !== 'select') return; // Only for files, not folders

          e.preventDefault();
          const filePath = item.dataset.path;
          const isTracked = item.classList.contains('tracked');

          // Select the file first
          document.querySelectorAll('.file-item.selected').forEach(el => el.classList.remove('selected'));
          item.classList.add('selected');
          vscode.postMessage({ command: 'selectFile', path: filePath });

          // Show/hide track/untrack menu items
          const trackItem = document.getElementById('trackMenuItem');
          const untrackItem = document.getElementById('untrackMenuItem');
          if (trackItem) trackItem.style.display = isTracked ? 'none' : 'flex';
          if (untrackItem) untrackItem.style.display = isTracked ? 'flex' : 'none';

          // Show context menu
          const menu = document.getElementById('contextMenu');
          if (menu) {
            menu.style.left = e.clientX + 'px';
            menu.style.top = e.clientY + 'px';
            menu.classList.add('visible');
            menu.dataset.filePath = filePath;
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
            contextMenu.classList.remove('visible');

            if (action === 'cloudEdit') {
              vscode.postMessage({ command: 'openFile', path: filePath });
            } else if (action === 'download') {
              vscode.postMessage({ command: 'downloadFile', path: filePath });
            } else if (action === 'track') {
              vscode.postMessage({ command: 'trackFile', path: filePath });
            } else if (action === 'untrack') {
              vscode.postMessage({ command: 'untrackFile', path: filePath });
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
        const statusEl = document.getElementById('statusMessage');

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
            if (statusEl) {
              statusEl.className = 'status';
              statusEl.textContent = 'Testing connection...';
            }
            break;
          case 'testResult':
            if (statusEl) {
              statusEl.className = 'status ' + (message.success ? 'success' : 'error');
              statusEl.textContent = message.message;
            }
            break;
          case 'saveSuccess':
            if (statusEl) {
              statusEl.className = 'status success';
              statusEl.textContent = 'Connection saved!';
            }
            break;
          case 'saveError':
            if (statusEl) {
              statusEl.className = 'status error';
              statusEl.textContent = 'Error: ' + message.error;
            }
            break;
        }
      });
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
