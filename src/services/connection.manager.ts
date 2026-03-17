import * as vscode from 'vscode';
import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  ConnectionConfig,
  Connection,
  ConnectionStatus,
  ConnectionScope,
  PasswordSource,
  ConnectionDiagnostic,
  ConnectionSessionEntry,
  ConnectionTestResult,
} from '../models';
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

interface WorkspaceConfigCache {
  configPath?: string;
  configs: ConnectionConfig[];
  passwordsInFile: Map<string, string>;
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
  private sessionLogs: Map<string, ConnectionSessionEntry[]> = new Map();
  private lastDiagnostics: Map<string, ConnectionDiagnostic> = new Map();
  private _onDidChangeSessionLogs = new vscode.EventEmitter<string>();
  readonly onDidChangeSessionLogs = this._onDidChangeSessionLogs.event;

  /** Health check interval handle */
  private healthCheckInterval?: ReturnType<typeof setInterval>;
  /** Health check interval in milliseconds (default: 30 seconds) */
  private static readonly HEALTH_CHECK_INTERVAL_MS = 30000;
  /** Number of consecutive health check failures before marking disconnected */
  private static readonly HEALTH_CHECK_MAX_FAILURES = 3;
  /** Number of consecutive mount-access failures before marking disconnected */
  private static readonly MOUNT_ACCESS_MAX_FAILURES = 2;
  /** Maximum time spent probing a mounted drive before treating it as inaccessible */
  private static readonly MOUNT_ACCESS_CHECK_TIMEOUT_MS = 3000;

  private static readonly WORKSPACE_CONFIG_FILE = '.vscode/sftp_plus.json';
  private workspaceConfigCache?: WorkspaceConfigCache;

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
  private loadWorkspaceConfigs(forceReload = false): { configs: ConnectionConfig[], passwordsInFile: Map<string, string> } {
    const configPath = this.getWorkspaceConfigPath();
    if (!forceReload && this.workspaceConfigCache && this.workspaceConfigCache.configPath === configPath) {
      return {
        configs: [...this.workspaceConfigCache.configs],
        passwordsInFile: new Map(this.workspaceConfigCache.passwordsInFile),
      };
    }

    const configs: ConnectionConfig[] = [];
    const passwordsInFile = new Map<string, string>();
    if (!configPath || !fs.existsSync(configPath)) {
      this.workspaceConfigCache = { configPath, configs: [], passwordsInFile: new Map() };
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

    this.workspaceConfigCache = {
      configPath,
      configs: [...configs],
      passwordsInFile: new Map(passwordsInFile),
    };

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
  private loadConnectionConfigs(forceReloadWorkspace = false): void {
    // Clear existing connections but preserve connected state
    const connectedStates = new Map<string, { mountedDrive?: string; processId?: number }>();
    for (const [name, conn] of this.connections) {
      if (conn.status === ConnectionStatus.Connected) {
        connectedStates.set(name, { mountedDrive: conn.mountedDrive, processId: conn.processId });
      }
    }
    this.connections.clear();

    // Load workspace configs first (higher priority)
    const { configs: workspaceConfigs, passwordsInFile } = this.loadWorkspaceConfigs(forceReloadWorkspace);
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
          const shouldAutoReconnect = connection.config.autoReconnectOnDrop === true;
          const cachedPasswordAvailable = !!connection.obscuredPassword;

          connection.status = ConnectionStatus.Disconnected;
          connection.mountedDrive = undefined;
          connection.processId = undefined;
          connection.rcPort = undefined;
          connection.error = 'Connection lost';
          connection.healthCheckFailCount = 0;
          this.appendSessionLog(connection.config.name, 'connect', 'error', 'Connection lost during health check');
          hasChanges = true;

          if (shouldAutoReconnect) {
            this.appendSessionLog(
              connection.config.name,
              'connect',
              'info',
              cachedPasswordAvailable
                ? 'Auto-reconnect is enabled. Attempting to reconnect.'
                : 'Auto-reconnect is enabled but cached credentials are unavailable. Falling back to normal connect flow.'
            );

            this.reconnect(connection.config.name, {
              silent: true,
              reason: 'unexpected disconnect',
            }).catch((error) => {
              Logger.error(`Auto-reconnect failed for "${connection.config.name}"`, error);
              vscode.window.showWarningMessage(
                `SFTP+: Auto-reconnect failed for "${connection.config.name}"`,
                'Reconnect'
              ).then(selection => {
                if (selection === 'Reconnect') {
                  vscode.commands.executeCommand('sftp-plus.connect', connection.config.name);
                }
              });
            });
          } else {
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
        }
      } else {
        if (connection.mountedDrive) {
          const mountPath = `${connection.mountedDrive}:\\`;
          const isMountAccessible = await this.isMountedDriveAccessible(mountPath);

          if (!isMountAccessible) {
            this.reportMountAccessFailure(connection.config.name, {
              path: mountPath,
              message: 'Mounted drive is not accessible during health check',
              code: 'EIO',
            });
            continue;
          }

          this.resetMountAccessFailures(connection.config.name);
        }

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
    this.workspaceConfigCache = {
      configPath,
      configs: [...configs],
      passwordsInFile: new Map(
        configs
          .filter((cfg): cfg is ConnectionConfig & { password: string } => typeof cfg.password === 'string' && cfg.password.length > 0)
          .map(cfg => [cfg.name, cfg.password])
      ),
    };
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
   * Get the current in-memory session log for a connection
   */
  getSessionLog(name: string): ConnectionSessionEntry[] {
    return [...(this.sessionLogs.get(name) || [])];
  }

  /**
   * Get the last classified diagnostic for a connection
   */
  getLastDiagnostic(name: string): ConnectionDiagnostic | undefined {
    return this.lastDiagnostics.get(name);
  }

  /**
   * Clear session log entries for a connection
   */
  clearSessionLog(name: string): void {
    this.sessionLogs.set(name, []);
    this._onDidChangeSessionLogs.fire(name);
  }

  /**
   * Append a session log line for a connection
   */
  appendSessionLog(name: string, source: 'connect' | 'test', level: 'info' | 'warn' | 'error', message: string): void {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }

    const entries = this.sessionLogs.get(name) || [];
    entries.push({
      timestamp: new Date().toISOString(),
      source,
      level,
      message: trimmed,
    });

    if (entries.length > 200) {
      entries.splice(0, entries.length - 200);
    }

    this.sessionLogs.set(name, entries);
    this._onDidChangeSessionLogs.fire(name);
  }

  /**
   * Add a lightweight visual separator between console runs for a host
   */
  private appendSessionSeparator(name: string, source: 'connect' | 'test'): void {
    const entries = this.sessionLogs.get(name) || [];
    if (entries.length > 0) {
      this.appendSessionLog(name, source, 'info', '---');
    }
  }

  /**
   * Track the latest structured diagnostic for a connection
   */
  private setLastDiagnostic(name: string, diagnostic: ConnectionDiagnostic): void {
    this.lastDiagnostics.set(name, diagnostic);
  }

  /**
   * Stream rclone child-process output into the session console
   */
  private attachMountLogging(name: string, process: ChildProcess): void {
    const forward = (chunk: string, level: 'info' | 'warn' | 'error') => {
      for (const line of chunk.split(/\r?\n/)) {
        this.appendSessionLog(name, 'connect', level, line);
      }
    };

    process.stdout?.on('data', (data: Buffer | string) => {
      forward(data.toString(), 'info');
    });

    process.stderr?.on('data', (data: Buffer | string) => {
      const text = data.toString();
      forward(text, 'error');
    });

    process.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      const summary = code === 0
        ? 'Mount process exited cleanly'
        : `Mount process exited${code !== null ? ` with code ${code}` : ''}${signal ? ` (signal: ${signal})` : ''}`;
      this.appendSessionLog(name, 'connect', code === 0 ? 'info' : 'warn', summary);
    });
  }

  /**
   * Get active (connected) connections
   */
  getActiveConnections(): Connection[] {
    return this.getConnections().filter(c => c.status === ConnectionStatus.Connected);
  }

  reportMountAccessFailure(name: string, details: { path: string; message: string; code?: string }): void {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== ConnectionStatus.Connected) {
      return;
    }

    connection.mountAccessFailCount = (connection.mountAccessFailCount || 0) + 1;

    Logger.warn(
      `Connection "${name}" mount access failed ` +
      `(${connection.mountAccessFailCount}/${ConnectionManager.MOUNT_ACCESS_MAX_FAILURES}) at ${details.path}: ${details.message}`
    );

    if (connection.mountAccessFailCount < ConnectionManager.MOUNT_ACCESS_MAX_FAILURES) {
      return;
    }

    const shouldAutoReconnect = connection.config.autoReconnectOnDrop === true;
    const cachedPasswordAvailable = !!connection.obscuredPassword;
    const failureMessage = 'Mounted drive became unreadable';

    connection.status = ConnectionStatus.Disconnected;
    connection.mountedDrive = undefined;
    connection.rcPort = undefined;
    connection.error = failureMessage;
    connection.healthCheckFailCount = 0;
    connection.mountAccessFailCount = 0;

    this.appendSessionLog(name, 'connect', 'error', `${failureMessage}: ${details.message}`);
    this._cleanupMountProcess(connection, name, 'mount became unreadable');
    this._onDidChangeConnections.fire();

    if (shouldAutoReconnect) {
      this.appendSessionLog(
        name,
        'connect',
        'info',
        cachedPasswordAvailable
          ? 'Auto-reconnect is enabled. Attempting to recover the unreadable mount.'
          : 'Mounted drive became unreadable and cached credentials are unavailable. Manual reconnect may be required.'
      );

      this.reconnect(name, {
        silent: true,
        reason: 'mount access failure',
      }).catch((error) => {
        Logger.error(`Auto-reconnect failed for "${name}" after mount access failure`, error);
        vscode.window.showWarningMessage(
          `SFTP+: Mount for "${name}" became unreadable and auto-reconnect failed`,
          'Connect'
        ).then(selection => {
          if (selection === 'Connect') {
            void vscode.commands.executeCommand('sftp-plus.connect', name);
          }
        });
      });
      return;
    }

    vscode.window.showWarningMessage(
      `SFTP+: Mount for "${name}" became unreadable`,
      'Connect'
    ).then(selection => {
      if (selection === 'Connect') {
        void vscode.commands.executeCommand('sftp-plus.connect', name);
      }
    });
  }

  resetMountAccessFailures(name: string): void {
    const connection = this.connections.get(name);
    if (!connection) {
      return;
    }

    if ((connection.mountAccessFailCount || 0) > 0) {
      connection.mountAccessFailCount = 0;
    }
  }

  private async isMountedDriveAccessible(mountPath: string): Promise<boolean> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<boolean>((resolve) => {
      timeoutHandle = setTimeout(() => {
        Logger.warn(`Timed out while probing mounted drive accessibility for ${mountPath}`);
        resolve(false);
      }, ConnectionManager.MOUNT_ACCESS_CHECK_TIMEOUT_MS);
    });

    try {
      const isAccessible = await Promise.race([
        fs.promises.access(mountPath, fs.constants.R_OK).then(() => true).catch(() => false),
        timeoutPromise,
      ]);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      return isAccessible;
    } catch {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      return false;
    }
  }

  private _cleanupMountProcess(connection: Connection, name: string, reason: string): void {
    const processId = connection.processId;
    if (!processId) {
      return;
    }

    void (async () => {
      try {
        await this.rcloneService.unmount(processId);
        Logger.info(`Cleaned up rclone process ${processId} for "${name}" after ${reason}`);
      } catch (error) {
        Logger.warn(`Failed to clean up rclone process ${processId} for "${name}" after ${reason}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        const current = this.connections.get(name);
        if (current && current.processId === processId) {
          current.processId = undefined;
        }
      }
    })();
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

    let mountProcess: ChildProcess | undefined;

    if (connection.status === ConnectionStatus.Connected) {
      Logger.info(`Already connected to ${name}`);
      return;
    }

    try {
      if (connection.processId) {
        try {
          await this.rcloneService.unmount(connection.processId);
          Logger.info(`Cleaned up stale rclone process ${connection.processId} for "${name}" before connect`);
        } catch (error) {
          Logger.warn(`Failed to clean up stale rclone process ${connection.processId} for "${name}" before connect: ${error instanceof Error ? error.message : String(error)}`);
        }

        connection.processId = undefined;
        connection.mountedDrive = undefined;
        connection.rcPort = undefined;
      }

      connection.status = ConnectionStatus.Connecting;
      connection.error = undefined;
      connection.healthCheckFailCount = 0;
      connection.mountAccessFailCount = 0;
      this.appendSessionSeparator(name, 'connect');
      this.appendSessionLog(name, 'connect', 'info', `Starting connection to ${connection.config.host}`);
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

      if (connection.config.protocol === 'ftps' && !connection.config.ignoreCertErrors) {
        this.appendSessionLog(name, 'connect', 'info', 'Running FTPS certificate preflight');
        const preflight = await this.rcloneService.testConnection(connection.config, password, (line, level) => {
          this.appendSessionLog(name, 'test', level, line);
        });
        this.setLastDiagnostic(name, preflight.diagnostic);

        if (!preflight.success) {
          throw new Error(preflight.message);
        }
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
      mountProcess = process;
      this.attachMountLogging(name, process);

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
      connection.healthCheckFailCount = 0;
      connection.mountAccessFailCount = 0;
      this.setLastDiagnostic(name, { kind: 'unknown', message: 'Connection successful' });
      this.appendSessionLog(name, 'connect', 'info', `Mounted on ${driveLetter}: (RC port ${rcPort})`);

      Logger.info(`Connected to ${name} on ${driveLetter}: (RC port: ${rcPort})`);
      vscode.window.showInformationMessage(`SFTP+: Connected to ${name} (${driveLetter}:)`);

    } catch (error) {
      if (mountProcess?.pid) {
        try {
          await this.rcloneService.unmount(mountProcess.pid);
          Logger.info(`Cleaned up failed mount process ${mountProcess.pid} for "${name}" after connect error`);
        } catch (cleanupError) {
          Logger.warn(`Failed to clean up failed mount process ${mountProcess.pid} for "${name}": ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }
      }

      const diagnostic = this.rcloneService.classifyConnectionError(error, connection.config.ignoreCertErrors);
      this.setLastDiagnostic(name, diagnostic);
      connection.status = ConnectionStatus.Error;
      connection.error = diagnostic.message;
      connection.mountedDrive = undefined;
      connection.processId = undefined;
      connection.rcPort = undefined;
      this.appendSessionLog(name, 'connect', 'error', diagnostic.message);
      Logger.error(`Failed to connect to ${name}`, error);
      const action = diagnostic.canAcceptCertificate
        ? await vscode.window.showErrorMessage(
          `SFTP+: Failed to connect to ${name}: ${connection.error}`,
          'Accept certificate'
        )
        : undefined;

      if (action === 'Accept certificate') {
        const updatedConfig: ConnectionConfig = {
          ...connection.config,
          ignoreCertErrors: true,
        };
        await this.updateConnection(name, updatedConfig, connection.scope);
        const refreshed = this.connections.get(updatedConfig.name);
        if (refreshed) {
          refreshed.error = 'Certificate auto-accept enabled. Retry the connection.';
        }
        vscode.window.showInformationMessage(`SFTP+: Certificate auto-accept enabled for ${name}. Retry the connection.`);
      } else if (!diagnostic.canAcceptCertificate) {
        vscode.window.showErrorMessage(`SFTP+: Failed to connect to ${name}: ${connection.error}`);
      }
    }

    this._onDidChangeConnections.fire();
  }

  /**
   * Reconnect to a server — mirrors the UI "Reconnect" button behaviour:
   * kills any stale rclone process first, then mounts fresh.
   *
   * Uses the obscured password cached in memory from the previous session so no
   * UI prompt is shown (fully autonomous when called from an AI agent).
   * Falls back to the normal connect() flow only if no cached password exists
   * (e.g. after a VS Code restart), which may prompt the user.
   */
  async reconnect(name: string, options?: { silent?: boolean; reason?: string; requireCachedCredentials?: boolean; force?: boolean }): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) {
      throw new Error(`Connection "${name}" not found`);
    }

    let mountProcess: ChildProcess | undefined;

    if (connection.status === ConnectionStatus.Connected && !options?.force) {
      Logger.info(`Already connected to ${name}`);
      return;
    }

    if (options?.reason) {
      this.appendSessionSeparator(name, 'connect');
      this.appendSessionLog(name, 'connect', 'info', `Reconnecting after ${options.reason}`);
    }

    let reconnectObscuredPassword = connection.obscuredPassword;

    if (!reconnectObscuredPassword && options?.requireCachedCredentials) {
      this.appendSessionLog(name, 'connect', 'info', 'Attempting autonomous reconnect using stored credentials');
      const storedPassword = await this.getPassword(name);
      if (storedPassword) {
        reconnectObscuredPassword = await this.rcloneService.obscurePassword(storedPassword);
        connection.obscuredPassword = reconnectObscuredPassword;
        this.appendSessionLog(name, 'connect', 'info', 'Stored credentials recovered for autonomous reconnect');
      }
    }

    // If the obscured password is still cached from the previous session, reuse it directly.
    // This bypasses SecretStorage lookup and the UI prompt entirely.
    if (reconnectObscuredPassword) {
      Logger.info(`Reconnecting to "${name}" using non-interactive credentials`);
      try {
        // ── Step 1: kill any stale rclone process (same as UI Reconnect button) ──
        if (connection.processId) {
          try {
            await this.rcloneService.unmount(connection.processId);
            Logger.info(`Killed stale rclone process ${connection.processId} for "${name}"`);
          } catch {
            Logger.warn(`Could not kill stale rclone process ${connection.processId} for "${name}" — continuing anyway`);
          }
        }

        // Wait briefly for OS to release the drive letter (mirrors the 500 ms delay in the UI button)
        await new Promise(resolve => setTimeout(resolve, 500));

        // ── Step 2: reset state ──
        connection.status = ConnectionStatus.Connecting;
        connection.error = undefined;
        connection.mountedDrive = undefined;
        connection.processId = undefined;
        connection.rcPort = undefined;
        connection.healthCheckFailCount = 0;
        connection.mountAccessFailCount = 0;
        this.appendSessionLog(name, 'connect', 'info', `Starting reconnect to ${connection.config.host}`);
        this._onDidChangeConnections.fire();

        // ── Step 3: mount fresh ──
        const driveLetter = connection.config.driveLetter || await DriveUtils.findAvailableDrive();
        if (!driveLetter) {
          throw new Error('No available drive letters');
        }

        const { process, rcPort } = this.rcloneService.mount(connection.config, reconnectObscuredPassword, driveLetter);
        mountProcess = process;
        this.attachMountLogging(name, process);

        const mounted = await this.waitForMount(driveLetter, 15000);
        if (!mounted) {
          throw new Error('Mount timed out — server may be unreachable');
        }

        connection.status = ConnectionStatus.Connected;
        connection.mountedDrive = driveLetter;
        connection.processId = process.pid;
        connection.rcPort = rcPort;
        connection.healthCheckFailCount = 0;
        connection.mountAccessFailCount = 0;
        this.appendSessionLog(name, 'connect', 'info', `Mounted on ${driveLetter}: (RC port ${rcPort})`);

        Logger.info(`Reconnected to "${name}" on ${driveLetter}:`);
        if (!options?.silent) {
          vscode.window.showInformationMessage(`SFTP+: Reconnected to ${name} (${driveLetter}:)`);
        }

      } catch (error) {
        if (mountProcess?.pid) {
          try {
            await this.rcloneService.unmount(mountProcess.pid);
            Logger.info(`Cleaned up failed mount process ${mountProcess.pid} for "${name}" after reconnect error`);
          } catch (cleanupError) {
            Logger.warn(`Failed to clean up failed mount process ${mountProcess.pid} for "${name}": ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
          }
        }

        connection.status = ConnectionStatus.Error;
        connection.error = error instanceof Error ? error.message : String(error);
        connection.mountedDrive = undefined;
        connection.processId = undefined;
        connection.rcPort = undefined;
        this.appendSessionLog(name, 'connect', 'error', connection.error);
        Logger.error(`Failed to reconnect to "${name}"`, error);
        this._onDidChangeConnections.fire();
        if (!options?.silent) {
          vscode.window.showErrorMessage(`SFTP+: Failed to reconnect to ${name}: ${connection.error}`);
        }
        throw error;
      }

      this._onDidChangeConnections.fire();
      return;
    }

    if (options?.requireCachedCredentials) {
      const message =
        'Autonomous reconnect unavailable: no stored credentials are available for non-interactive reconnect. ' +
        'The user must reconnect manually once from the SFTP+ panel and store credentials if they want autonomous recovery after reload.';
      this.appendSessionLog(name, 'connect', 'error', message);
      Logger.warn(`No stored credentials for "${name}" and reconnect requires non-interactive credentials`);
      throw new Error(message);
    }

    // No cached obscured password — fall back to normal connect (may prompt the user for password)
    Logger.info(`No cached password for "${name}", falling back to normal connect flow`);
    await this.connect(name);
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
      this.appendSessionSeparator(name, 'connect');
      this.appendSessionLog(name, 'connect', 'info', `Disconnecting from ${connection.config.host}`);
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
      connection.rcPort = undefined;
      connection.mountAccessFailCount = 0;
      this.appendSessionLog(name, 'connect', 'info', `Disconnected from ${connection.config.host}`);

      Logger.info(`Disconnected from ${name}`);
      vscode.window.showInformationMessage(`SFTP+: Disconnected from ${name}`);

    } catch (error) {
      connection.status = ConnectionStatus.Error;
      connection.error = error instanceof Error ? error.message : String(error);
      this.appendSessionLog(name, 'connect', 'error', connection.error);
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
  async testConnection(config: ConnectionConfig, password?: string): Promise<ConnectionTestResult> {
    try {
      this.appendSessionSeparator(config.name, 'test');
      this.appendSessionLog(config.name, 'test', 'info', `Testing connection to ${config.host}`);

      // Get password if not provided
      if (!password) {
        password = await this.getPassword(config.name);
        if (!password) {
          password = await this.promptForPassword(config.name);
        }
      }

      if (!password) {
        const diagnostic: ConnectionDiagnostic = {
          kind: 'authentication',
          message: 'Password is required',
        };
        this.setLastDiagnostic(config.name, diagnostic);
        return { success: false, message: diagnostic.message, diagnostic };
      }

      // Use rclone lsd to test the connection
      const result = await this.rcloneService.testConnection(config, password, (line, level) => {
        this.appendSessionLog(config.name, 'test', level, line);
      });
      this.setLastDiagnostic(config.name, result.diagnostic);
      return result;
    } catch (error) {
      Logger.error('Test connection failed', error);
      const diagnostic = this.rcloneService.classifyConnectionError(error, config.ignoreCertErrors);
      this.setLastDiagnostic(config.name, diagnostic);
      this.appendSessionLog(config.name, 'test', 'error', diagnostic.message);
      return { success: false, message: diagnostic.message, diagnostic };
    }
  }

  /**
   * Wait for mount to become available
   */
  private async waitForMount(driveLetter: string, timeout: number): Promise<boolean> {
    const start = Date.now();
    const mountPoint = `${driveLetter}:\\`;

    while (Date.now() - start < timeout) {
      if (await this.isMountedDriveAccessible(mountPoint)) {
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
    this.loadConnectionConfigs(true);
    this._onDidChangeConnections.fire();
  }

  dispose(): void {
    // Stop health check
    this.stopHealthCheck();
    // Disconnect all on dispose
    this.disconnectAll();
    this._onDidChangeSessionLogs.dispose();
    this._onDidChangeConnections.dispose();
  }
}
