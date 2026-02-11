import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionConfig, Connection, ConnectionStatus, ConnectionScope, PasswordSource } from '../models';
import { RcloneService } from './rclone.service';
import { CredentialManager } from './credential.manager';
import { DriveUtils } from '../utils/drive.utils';
import { Logger } from '../utils/logger';

/**
 * Workspace JSON configuration file structure
 */
interface WorkspaceConfigFile {
  connections: ConnectionConfig[];
}

/**
 * Manages all SFTP+ connections with hybrid storage:
 * - Global: stored in VS Code user settings
 * - Workspace: stored in .vscode/sftp_plus.json
 * - Passwords: SecretStorage (preferred) or workspace JSON (legacy)
 */
export class ConnectionManager implements vscode.Disposable {
  private connections: Map<string, Connection> = new Map();
  private _onDidChangeConnections = new vscode.EventEmitter<void>();
  readonly onDidChangeConnections = this._onDidChangeConnections.event;

  /** Health check interval handle */
  private healthCheckInterval?: ReturnType<typeof setInterval>;
  /** Health check interval in milliseconds (default: 30 seconds) */
  private static readonly HEALTH_CHECK_INTERVAL_MS = 30000;
  /** Number of consecutive health check failures before marking disconnected */
  private static readonly HEALTH_CHECK_MAX_FAILURES = 3;

  private static readonly WORKSPACE_CONFIG_FILE = '.vscode/sftp_plus.json';

  constructor(
    private rcloneService: RcloneService,
    private credentialManager: CredentialManager
  ) {
    this.loadConnectionConfigs();
  }

  /**
   * Get the workspace config file path
   */
  private getWorkspaceConfigPath(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return undefined;
    }
    return path.join(workspaceFolders[0].uri.fsPath, ConnectionManager.WORKSPACE_CONFIG_FILE);
  }

  /**
   * Check if we're in a workspace context
   */
  hasWorkspace(): boolean {
    return vscode.workspace.workspaceFolders !== undefined && vscode.workspace.workspaceFolders.length > 0;
  }

  /**
   * Load workspace configuration from JSON file
   */
  private loadWorkspaceConfigs(): { configs: ConnectionConfig[], passwordsInFile: Map<string, string> } {
    const configs: ConnectionConfig[] = [];
    const passwordsInFile = new Map<string, string>();

    const configPath = this.getWorkspaceConfigPath();
    if (!configPath || !fs.existsSync(configPath)) {
      return { configs, passwordsInFile };
    }

    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const data: WorkspaceConfigFile = JSON.parse(content);

      if (Array.isArray(data.connections)) {
        for (const cfg of data.connections) {
          // Extract password from file if present
          if (cfg.password) {
            passwordsInFile.set(cfg.name, cfg.password);
          }
          configs.push(cfg);
        }
      }

      Logger.info(`Loaded ${configs.length} workspace connections from ${configPath}`);
    } catch (error) {
      Logger.error('Failed to load workspace config', error);
    }

    return { configs, passwordsInFile };
  }

  /**
   * Load global configuration from VS Code settings
   */
  private loadGlobalConfigs(): ConnectionConfig[] {
    const config = vscode.workspace.getConfiguration('sftp-plus');
    const connectionConfigs = config.get<ConnectionConfig[]>('connections') || [];
    Logger.info(`Loaded ${connectionConfigs.length} global connections`);
    return connectionConfigs;
  }

  /**
   * Load all connection configurations (workspace + global)
   */
  private loadConnectionConfigs(): void {
    // Clear existing connections but preserve connected state
    const connectedStates = new Map<string, { mountedDrive?: string; processId?: number }>();
    for (const [name, conn] of this.connections) {
      if (conn.status === ConnectionStatus.Connected) {
        connectedStates.set(name, { mountedDrive: conn.mountedDrive, processId: conn.processId });
      }
    }
    this.connections.clear();

    // Load workspace configs first (higher priority)
    const { configs: workspaceConfigs, passwordsInFile } = this.loadWorkspaceConfigs();
    for (const cfg of workspaceConfigs) {
      const hasPasswordInFile = passwordsInFile.has(cfg.name);

      const connection: Connection = {
        config: cfg,
        status: ConnectionStatus.Disconnected,
        scope: 'workspace',
        passwordSource: hasPasswordInFile ? 'workspace' : 'none',
      };

      // Restore connected state if it was connected
      const connectedState = connectedStates.get(cfg.name);
      if (connectedState) {
        connection.status = ConnectionStatus.Connected;
        connection.mountedDrive = connectedState.mountedDrive;
        connection.processId = connectedState.processId;
      }

      this.connections.set(cfg.name, connection);
    }

    // Load global configs (skip if already exists from workspace)
    const globalConfigs = this.loadGlobalConfigs();
    for (const cfg of globalConfigs) {
      if (!this.connections.has(cfg.name)) {
        const connection: Connection = {
          config: cfg,
          status: ConnectionStatus.Disconnected,
          scope: 'global',
          passwordSource: 'none', // Will be updated when password is checked
        };

        // Restore connected state if it was connected
        const connectedState = connectedStates.get(cfg.name);
        if (connectedState) {
          connection.status = ConnectionStatus.Connected;
          connection.mountedDrive = connectedState.mountedDrive;
          connection.processId = connectedState.processId;
        }

        this.connections.set(cfg.name, connection);
      }
    }

    Logger.info(`Total connections loaded: ${this.connections.size}`);
  }

  /**
   * Initialize password sources by checking SecretStorage for each connection
   * Must be called after construction since SecretStorage access is async
   */
  async initializePasswordSources(): Promise<void> {
    for (const [name, connection] of this.connections) {
      await this.updatePasswordSource(name);
    }
    Logger.info('Password sources initialized');
    this._onDidChangeConnections.fire();
  }

  /**
   * Start the health check interval to monitor active connections
   * Checks every 30 seconds if mounted drives are still alive
   */
  startHealthCheck(): void {
    if (this.healthCheckInterval) {
      return; // Already running
    }

    this.healthCheckInterval = setInterval(async () => {
      await this.checkConnectionsHealth();
    }, ConnectionManager.HEALTH_CHECK_INTERVAL_MS);

    Logger.info('Connection health check started (30s interval)');
  }

  /**
   * Stop the health check interval
   */
  stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
      Logger.info('Connection health check stopped');
    }
  }

  /**
   * Check health of all active connections
   * Marks connections as disconnected only after multiple consecutive failures
   */
  private async checkConnectionsHealth(): Promise<void> {
    const activeConnections = this.getActiveConnections();

    if (activeConnections.length === 0) {
      return;
    }

    let hasChanges = false;

    for (const connection of activeConnections) {
      if (!connection.rcPort) {
        continue;
      }

      const isAlive = await this.rcloneService.isConnectionAlive(connection.rcPort);

      if (!isAlive) {
        // Increment failure counter
        connection.healthCheckFailCount = (connection.healthCheckFailCount || 0) + 1;
        Logger.warn(
          `Connection "${connection.config.name}" health check failed ` +
          `(${connection.healthCheckFailCount}/${ConnectionManager.HEALTH_CHECK_MAX_FAILURES})`
        );

        if (connection.healthCheckFailCount >= ConnectionManager.HEALTH_CHECK_MAX_FAILURES) {
          // Exceeded threshold — mark as disconnected
          Logger.warn(`Connection "${connection.config.name}" is no longer responding after ${connection.healthCheckFailCount} failures`);

          connection.status = ConnectionStatus.Disconnected;
          connection.mountedDrive = undefined;
          connection.processId = undefined;
          connection.rcPort = undefined;
          connection.error = 'Connection lost';
          connection.healthCheckFailCount = 0;
          hasChanges = true;

          // Notify user
          vscode.window.showWarningMessage(
            `SFTP+: Connection to "${connection.config.name}" was lost`,
            'Reconnect'
          ).then(selection => {
            if (selection === 'Reconnect') {
              vscode.commands.executeCommand('sftp-plus.connect', connection.config.name);
            }
          });
        }
      } else {
        // Connection is alive — reset failure counter
        if (connection.healthCheckFailCount && connection.healthCheckFailCount > 0) {
          Logger.info(`Connection "${connection.config.name}" recovered after ${connection.healthCheckFailCount} failure(s)`);
          connection.healthCheckFailCount = 0;
        }
      }
    }

    if (hasChanges) {
      this._onDidChangeConnections.fire();
    }
  }

  /**
   * Save workspace configuration to JSON file
   */
  private async saveWorkspaceConfigs(configs: ConnectionConfig[]): Promise<void> {
    const configPath = this.getWorkspaceConfigPath();
    if (!configPath) {
      throw new Error('No workspace folder available');
    }

    // Ensure .vscode directory exists
    const vscodePath = path.dirname(configPath);
    if (!fs.existsSync(vscodePath)) {
      fs.mkdirSync(vscodePath, { recursive: true });
    }

    const data: WorkspaceConfigFile = { connections: configs };
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf8');
    Logger.info(`Saved ${configs.length} connections to ${configPath}`);
  }

  /**
   * Get all workspace connections from file
   */
  private getWorkspaceConfigsFromFile(): ConnectionConfig[] {
    const { configs } = this.loadWorkspaceConfigs();
    return configs;
  }

  /**
   * Get all connections
   */
  getConnections(): Connection[] {
    return Array.from(this.connections.values());
  }

  /**
   * Get connection by name
   */
  getConnection(name: string): Connection | undefined {
    return this.connections.get(name);
  }

  /**
   * Get active (connected) connections
   */
  getActiveConnections(): Connection[] {
    return this.getConnections().filter(c => c.status === ConnectionStatus.Connected);
  }

  /**
   * Get the rclone service instance
   */
  getRcloneService(): RcloneService {
    return this.rcloneService;
  }

  /**
   * Get password for a connection (checks workspace JSON first, then SecretStorage)
   */
  async getPassword(name: string): Promise<string | undefined> {
    const connection = this.connections.get(name);

    // Check workspace JSON file first
    if (connection?.scope === 'workspace') {
      const { passwordsInFile } = this.loadWorkspaceConfigs();
      const workspacePassword = passwordsInFile.get(name);
      if (workspacePassword) {
        return workspacePassword;
      }
    }

    // Fall back to SecretStorage
    return this.credentialManager.getPassword(name);
  }

  /**
   * Update password source for a connection after checking storage
   */
  async updatePasswordSource(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;

    // Check workspace JSON first (only for workspace-scoped connections)
    if (connection.scope === 'workspace') {
      const { passwordsInFile } = this.loadWorkspaceConfigs();
      if (passwordsInFile.has(name)) {
        connection.passwordSource = 'workspace';
        Logger.debug(`Password source for ${name}: workspace (from JSON file)`);
        return;
      }
    }

    // Check SecretStorage (for both global and workspace connections without JSON password)
    const secretPassword = await this.credentialManager.getPassword(name);
    if (secretPassword) {
      connection.passwordSource = 'secret';
      Logger.debug(`Password source for ${name}: secret (from SecretStorage)`);
    } else {
      connection.passwordSource = 'none';
      Logger.debug(`Password source for ${name}: none (no password stored)`);
    }
  }

  /**
   * Connect to a server
   */
  async connect(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) {
      throw new Error(`Connection "${name}" not found`);
    }

    if (connection.status === ConnectionStatus.Connected) {
      Logger.info(`Already connected to ${name}`);
      return;
    }

    try {
      connection.status = ConnectionStatus.Connecting;
      connection.error = undefined;
      this._onDidChangeConnections.fire();

      // Get password (workspace JSON or SecretStorage)
      let password = await this.getPassword(name);
      if (!password) {
        password = await this.promptForPassword(name);
        if (!password) {
          throw new Error('Password is required');
        }
        // Store in SecretStorage
        await this.credentialManager.storePassword(name, password);
        connection.passwordSource = 'secret';
      }

      // Obscure password for rclone
      const obscuredPassword = await this.rcloneService.obscurePassword(password);

      // Find available drive letter
      const driveLetter = connection.config.driveLetter || await DriveUtils.findAvailableDrive();
      if (!driveLetter) {
        throw new Error('No available drive letters');
      }

      // Start mount (returns process and RC port)
      const { process, rcPort } = this.rcloneService.mount(connection.config, obscuredPassword, driveLetter);

      // Wait for mount to be ready
      const mounted = await this.waitForMount(driveLetter, 15000);
      if (!mounted) {
        throw new Error('Mount timed out');
      }

      connection.status = ConnectionStatus.Connected;
      connection.mountedDrive = driveLetter;
      connection.processId = process.pid;
      connection.rcPort = rcPort;
      connection.obscuredPassword = obscuredPassword;  // Store for direct sync

      Logger.info(`Connected to ${name} on ${driveLetter}: (RC port: ${rcPort})`);
      vscode.window.showInformationMessage(`SFTP+: Connected to ${name} (${driveLetter}:)`);

    } catch (error) {
      connection.status = ConnectionStatus.Error;
      connection.error = error instanceof Error ? error.message : String(error);
      Logger.error(`Failed to connect to ${name}`, error);
      vscode.window.showErrorMessage(`SFTP+: Failed to connect to ${name}: ${connection.error}`);
    }

    this._onDidChangeConnections.fire();
  }

  /**
   * Disconnect from a server
   */
  async disconnect(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) {
      throw new Error(`Connection "${name}" not found`);
    }

    if (connection.status !== ConnectionStatus.Connected) {
      Logger.info(`${name} is not connected`);
      return;
    }

    const mountedDrive = connection.mountedDrive;

    try {
      connection.status = ConnectionStatus.Disconnecting;
      this._onDidChangeConnections.fire();

      // Close all editors that have files on this mounted drive
      if (mountedDrive) {
        await this.closeEditorsOnDrive(mountedDrive);
      }

      if (connection.processId) {
        await this.rcloneService.unmount(connection.processId);
      }

      connection.status = ConnectionStatus.Disconnected;
      connection.mountedDrive = undefined;
      connection.processId = undefined;

      Logger.info(`Disconnected from ${name}`);
      vscode.window.showInformationMessage(`SFTP+: Disconnected from ${name}`);

    } catch (error) {
      connection.status = ConnectionStatus.Error;
      connection.error = error instanceof Error ? error.message : String(error);
      Logger.error(`Failed to disconnect from ${name}`, error);
    }

    this._onDidChangeConnections.fire();
  }

  /**
   * Disconnect all connections
   */
  async disconnectAll(): Promise<void> {
    const activeConnections = this.getActiveConnections();

    for (const connection of activeConnections) {
      await this.disconnect(connection.config.name);
    }

    Logger.info(`Disconnected all (${activeConnections.length}) connections`);
  }

  /**
   * Close all editors that have files on a specific mounted drive
   */
  private async closeEditorsOnDrive(driveLetter: string): Promise<void> {
    const drivePath = `${driveLetter.toUpperCase()}:\\`;

    // Get all tab groups and their tabs
    for (const tabGroup of vscode.window.tabGroups.all) {
      for (const tab of tabGroup.tabs) {
        // Check if tab has a URI (it's a file tab)
        const tabInput = tab.input as { uri?: vscode.Uri } | undefined;
        if (tabInput?.uri?.fsPath) {
          const filePath = tabInput.uri.fsPath.toUpperCase();
          if (filePath.startsWith(drivePath)) {
            // Close this tab
            try {
              await vscode.window.tabGroups.close(tab);
              Logger.debug(`Closed editor: ${tabInput.uri.fsPath}`);
            } catch (error) {
              Logger.debug(`Failed to close editor: ${tabInput.uri.fsPath}`);
            }
          }
        }
      }
    }
  }

  /**
   * Auto-connect connections marked for auto-connect
   */
  async autoConnect(): Promise<void> {
    const autoConnectConfigs = this.getConnections()
      .filter(c => c.config.autoConnect && c.status === ConnectionStatus.Disconnected);

    for (const connection of autoConnectConfigs) {
      try {
        await this.connect(connection.config.name);
      } catch (error) {
        Logger.error(`Auto-connect failed for ${connection.config.name}`, error);
      }
    }
  }

  /**
   * Add new connection configuration
   * @param config Connection configuration
   * @param scope Where to store: 'workspace' (sftp_plus.json) or 'global' (settings.json)
   */
  async addConnection(config: ConnectionConfig, scope?: ConnectionScope): Promise<void> {
    if (this.connections.has(config.name)) {
      throw new Error(`Connection "${config.name}" already exists`);
    }

    // Determine scope: workspace if available, otherwise global
    const targetScope = scope || (this.hasWorkspace() ? 'workspace' : 'global');

    // Remove password before saving to storage
    const configWithoutPassword = { ...config };
    delete configWithoutPassword.password;

    if (targetScope === 'workspace') {
      // Save to workspace JSON file
      const workspaceConfigs = this.getWorkspaceConfigsFromFile();
      workspaceConfigs.push(configWithoutPassword);
      await this.saveWorkspaceConfigs(workspaceConfigs);
    } else {
      // Save to global VS Code settings
      const vsConfig = vscode.workspace.getConfiguration('sftp-plus');
      const connections = vsConfig.get<ConnectionConfig[]>('connections') || [];
      connections.push(configWithoutPassword);
      await vsConfig.update('connections', connections, vscode.ConfigurationTarget.Global);
    }

    // Add to local map
    this.connections.set(config.name, {
      config: configWithoutPassword,
      status: ConnectionStatus.Disconnected,
      scope: targetScope,
      passwordSource: 'none',
    });

    this._onDidChangeConnections.fire();
    Logger.info(`Added connection: ${config.name} (${targetScope})`);
  }

  /**
   * Store password for a connection in SecretStorage
   */
  async storePassword(connectionName: string, password: string): Promise<void> {
    await this.credentialManager.storePassword(connectionName, password);

    // Update password source
    const connection = this.connections.get(connectionName);
    if (connection) {
      connection.passwordSource = 'secret';
    }

    Logger.debug(`Password stored for ${connectionName} in SecretStorage`);
  }

  /**
   * Delete password from SecretStorage
   */
  async deleteSecretPassword(connectionName: string): Promise<void> {
    await this.credentialManager.deletePassword(connectionName);

    // Update password source
    const connection = this.connections.get(connectionName);
    if (connection) {
      // Check if password exists in workspace file
      const { passwordsInFile } = this.loadWorkspaceConfigs();
      connection.passwordSource = passwordsInFile.has(connectionName) ? 'workspace' : 'none';
    }

    Logger.info(`Secret password deleted for ${connectionName}`);

    // Notify listeners so UI can update
    this._onDidChangeConnections.fire();
  }

  /**
   * Remove connection configuration
   */
  async removeConnection(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) {
      throw new Error(`Connection "${name}" not found`);
    }

    // Disconnect first if connected
    if (connection.status === ConnectionStatus.Connected) {
      await this.disconnect(name);
    }

    // Remove password from SecretStorage
    await this.credentialManager.deletePassword(name);

    if (connection.scope === 'workspace') {
      // Remove from workspace JSON file
      const workspaceConfigs = this.getWorkspaceConfigsFromFile();
      const filtered = workspaceConfigs.filter(c => c.name !== name);
      await this.saveWorkspaceConfigs(filtered);
    } else {
      // Remove from global VS Code settings
      const vsConfig = vscode.workspace.getConfiguration('sftp-plus');
      const connections = vsConfig.get<ConnectionConfig[]>('connections') || [];
      const filtered = connections.filter(c => c.name !== name);
      await vsConfig.update('connections', filtered, vscode.ConfigurationTarget.Global);
    }

    // Remove from local map
    this.connections.delete(name);

    this._onDidChangeConnections.fire();
    Logger.info(`Removed connection: ${name}`);
  }

  /**
   * Update connection configuration
   */
  async updateConnection(oldName: string, config: ConnectionConfig, newScope?: ConnectionScope): Promise<void> {
    const connection = this.connections.get(oldName);
    if (!connection) {
      throw new Error(`Connection "${oldName}" not found`);
    }

    // Disconnect first if connected
    if (connection.status === ConnectionStatus.Connected) {
      await this.disconnect(oldName);
    }

    const targetScope = newScope || connection.scope;

    // Remove from old location if scope changed
    if (newScope && newScope !== connection.scope) {
      if (connection.scope === 'workspace') {
        const workspaceConfigs = this.getWorkspaceConfigsFromFile();
        const filtered = workspaceConfigs.filter(c => c.name !== oldName);
        await this.saveWorkspaceConfigs(filtered);
      } else {
        const vsConfig = vscode.workspace.getConfiguration('sftp-plus');
        const connections = vsConfig.get<ConnectionConfig[]>('connections') || [];
        const filtered = connections.filter(c => c.name !== oldName);
        await vsConfig.update('connections', filtered, vscode.ConfigurationTarget.Global);
      }
    }

    // Save to target location (without password)
    const configWithoutPassword = { ...config };
    delete configWithoutPassword.password;

    if (targetScope === 'workspace') {
      const workspaceConfigs = this.getWorkspaceConfigsFromFile();
      const index = workspaceConfigs.findIndex(c => c.name === oldName);
      if (index >= 0) {
        workspaceConfigs[index] = configWithoutPassword;
      } else {
        workspaceConfigs.push(configWithoutPassword);
      }
      await this.saveWorkspaceConfigs(workspaceConfigs);
    } else {
      const vsConfig = vscode.workspace.getConfiguration('sftp-plus');
      const connections = vsConfig.get<ConnectionConfig[]>('connections') || [];
      const index = connections.findIndex(c => c.name === oldName);
      if (index >= 0) {
        connections[index] = configWithoutPassword;
      } else {
        connections.push(configWithoutPassword);
      }
      await vsConfig.update('connections', connections, vscode.ConfigurationTarget.Global);
    }

    // Update local map
    if (oldName !== config.name) {
      this.connections.delete(oldName);
      // Move password to new name if name changed
      const password = await this.credentialManager.getPassword(oldName);
      if (password) {
        await this.credentialManager.storePassword(config.name, password);
        await this.credentialManager.deletePassword(oldName);
      }
    }

    this.connections.set(config.name, {
      config: configWithoutPassword,
      status: ConnectionStatus.Disconnected,
      scope: targetScope,
      passwordSource: connection.passwordSource,
    });

    this._onDidChangeConnections.fire();
    Logger.info(`Updated connection: ${oldName} -> ${config.name} (${targetScope})`);
  }

  /**
   * Prompt user for password
   */
  private async promptForPassword(connectionName: string): Promise<string | undefined> {
    return vscode.window.showInputBox({
      prompt: `Enter password for ${connectionName}`,
      password: true,
      ignoreFocusOut: true,
    });
  }

  /**
   * Test a connection configuration without saving
   */
  async testConnection(config: ConnectionConfig, password?: string): Promise<{ success: boolean; message: string }> {
    try {
      // Get password if not provided
      if (!password) {
        password = await this.getPassword(config.name);
        if (!password) {
          password = await this.promptForPassword(config.name);
        }
      }

      if (!password) {
        return { success: false, message: 'Password is required' };
      }

      // Use rclone lsd to test the connection
      const result = await this.rcloneService.testConnection(config, password);
      return result;
    } catch (error) {
      Logger.error('Test connection failed', error);
      return { success: false, message: String(error) };
    }
  }

  /**
   * Wait for mount to become available
   */
  private async waitForMount(driveLetter: string, timeout: number): Promise<boolean> {
    const start = Date.now();
    const mountPoint = `${driveLetter}:\\`;

    while (Date.now() - start < timeout) {
      if (await DriveUtils.driveExists(mountPoint)) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return false;
  }

  /**
   * Refresh connection configurations from settings
   */
  refresh(): void {
    this.loadConnectionConfigs();
    this._onDidChangeConnections.fire();
  }

  dispose(): void {
    // Stop health check
    this.stopHealthCheck();
    // Disconnect all on dispose
    this.disconnectAll();
    this._onDidChangeConnections.dispose();
  }
}
