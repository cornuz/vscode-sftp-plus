import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Connection, ConnectionStatus } from '../models';
import { ConnectionManager } from '../services/connection.manager';
import { Logger } from '../utils/logger';

/**
 * Event emitted when AI write permissions change
 */
export interface AiPermissionChangeEvent {
  connectionName: string;
  path: string;
  writable: boolean;
}

/**
 * Manages MCP/Copilot access for SFTP+ connections.
 * Registers Language Model Tools that provide file access to Copilot.
 * Tools are registered on-demand when the first MCP is activated (lazy registration).
 */
export class McpManager implements vscode.Disposable {
  private _disposables: vscode.Disposable[] = [];
  private _toolsRegistered = false;
  private _onDidChangeAiPermissions = new vscode.EventEmitter<AiPermissionChangeEvent>();
  readonly onDidChangeAiPermissions = this._onDidChangeAiPermissions.event;

  private _onDidChangeMcpStatus = new vscode.EventEmitter<string>();
  readonly onDidChangeMcpStatus = this._onDidChangeMcpStatus.event;

  constructor(private readonly connectionManager: ConnectionManager) {
    // Tools are registered lazily on first MCP activation
  }

  /**
   * Register handlers for the Language Model Tools declared in package.json.
   * Called lazily on first MCP activation to avoid registering tools in projects
   * that don't need them.
   */
  private _registerToolHandlers(): void {
    if (this._toolsRegistered) {
      return;
    }

    // Tool: list_connections
    this._disposables.push(
      vscode.lm.registerTool('sftp-plus_list_connections', {
        invoke: async (_options, _token) => {
          return this._listConnections();
        },
      })
    );

    // Tool: list_files
    this._disposables.push(
      vscode.lm.registerTool('sftp-plus_list_files', {
        invoke: async (options, _token) => {
          const input = options.input as { connectionName: string; path?: string };
          return this._listFiles(input.connectionName, input.path);
        },
      })
    );

    // Tool: read_file
    this._disposables.push(
      vscode.lm.registerTool('sftp-plus_read_file', {
        invoke: async (options, _token) => {
          const input = options.input as { connectionName: string; path: string };
          return this._readFile(input.connectionName, input.path);
        },
      })
    );

    // Tool: write_file
    this._disposables.push(
      vscode.lm.registerTool('sftp-plus_write_file', {
        invoke: async (options, _token) => {
          const input = options.input as { connectionName: string; path: string; content: string };
          return this._writeFile(input.connectionName, input.path, input.content);
        },
      })
    );

    // Tool: list_writable_paths
    this._disposables.push(
      vscode.lm.registerTool('sftp-plus_list_writable_paths', {
        invoke: async (options, _token) => {
          const input = options.input as { connectionName: string };
          return this._listWritablePaths(input.connectionName);
        },
      })
    );

    // Tool: request_write_access
    this._disposables.push(
      vscode.lm.registerTool('sftp-plus_request_write_access', {
        invoke: async (options, _token) => {
          const input = options.input as { connectionName: string; path: string };
          return this._requestWriteAccessTool(input.connectionName, input.path);
        },
      })
    );

    this._toolsRegistered = true;
    Logger.info('SFTP+ Language Model Tools registered');
  }

  /**
   * Start MCP/Copilot access for a connection
   */
  async startMcp(connectionName: string): Promise<void> {
    const connection = this.connectionManager.getConnection(connectionName);
    if (!connection) {
      throw new Error(`Connection "${connectionName}" not found`);
    }

    if (connection.status !== ConnectionStatus.Connected) {
      throw new Error(`Connection "${connectionName}" must be connected first`);
    }

    if (connection.mcpActive) {
      Logger.info(`MCP already active for ${connectionName}`);
      return;
    }

    // Register tools on first MCP activation (lazy registration)
    this._registerToolHandlers();

    // Initialize AI writable paths set
    connection.aiWritablePaths = new Set<string>();
    connection.mcpActive = true;

    Logger.info(`MCP/Copilot access enabled for ${connectionName}`);
    vscode.window.showInformationMessage(`SFTP+: Copilot access enabled for ${connectionName}`);

    this._onDidChangeMcpStatus.fire(connectionName);
  }

  /**
   * Stop MCP/Copilot access for a connection
   */
  async stopMcp(connectionName: string): Promise<void> {
    const connection = this.connectionManager.getConnection(connectionName);
    if (!connection) {
      return;
    }

    // Clear MCP state
    connection.mcpActive = false;
    connection.aiWritablePaths = undefined;

    Logger.info(`MCP/Copilot access disabled for ${connectionName}`);
    vscode.window.showInformationMessage(`SFTP+: Copilot access disabled for ${connectionName}`);

    this._onDidChangeMcpStatus.fire(connectionName);
  }

  /**
   * Check if MCP is active for a connection
   */
  isMcpActive(connectionName: string): boolean {
    const connection = this.connectionManager.getConnection(connectionName);
    return connection?.mcpActive === true;
  }

  /**
   * Toggle AI write access for a path
   */
  toggleAiWriteAccess(connectionName: string, filePath: string): boolean {
    const connection = this.connectionManager.getConnection(connectionName);
    if (!connection?.mcpActive || !connection.aiWritablePaths) {
      return false;
    }

    const isWritable = connection.aiWritablePaths.has(filePath);
    if (isWritable) {
      connection.aiWritablePaths.delete(filePath);
    } else {
      connection.aiWritablePaths.add(filePath);
    }

    this._onDidChangeAiPermissions.fire({
      connectionName,
      path: filePath,
      writable: !isWritable,
    });

    return !isWritable;
  }

  /**
   * Set AI write access for a path (used by request_write_access tool)
   */
  setAiWriteAccess(connectionName: string, filePath: string, writable: boolean): void {
    const connection = this.connectionManager.getConnection(connectionName);
    if (!connection?.mcpActive || !connection.aiWritablePaths) {
      return;
    }

    if (writable) {
      connection.aiWritablePaths.add(filePath);
    } else {
      connection.aiWritablePaths.delete(filePath);
    }

    this._onDidChangeAiPermissions.fire({
      connectionName,
      path: filePath,
      writable,
    });
  }

  /**
   * Check if a path has AI write access
   */
  isAiWritable(connectionName: string, filePath: string): boolean {
    const connection = this.connectionManager.getConnection(connectionName);
    if (!connection?.mcpActive || !connection.aiWritablePaths) {
      return false;
    }

    // Check exact path
    if (connection.aiWritablePaths.has(filePath)) {
      return true;
    }

    // Check if any parent folder has write access
    let currentPath = filePath;
    while (currentPath) {
      const parent = path.dirname(currentPath);
      if (parent === currentPath) break; // Root reached
      if (connection.aiWritablePaths.has(parent)) {
        return true;
      }
      currentPath = parent;
    }

    return false;
  }

  /**
   * Get all paths with AI write access for a connection
   */
  getAiWritablePaths(connectionName: string): string[] {
    const connection = this.connectionManager.getConnection(connectionName);
    if (!connection?.aiWritablePaths) {
      return [];
    }
    return Array.from(connection.aiWritablePaths);
  }

  /**
   * Allow AI write access on a folder and all its contents
   */
  async allowAiWriteOnFolder(connectionName: string, folderPath: string): Promise<void> {
    const connection = this.connectionManager.getConnection(connectionName);
    if (!connection?.mcpActive || !connection.aiWritablePaths) {
      return;
    }

    // Add the folder itself
    connection.aiWritablePaths.add(folderPath);

    this._onDidChangeAiPermissions.fire({
      connectionName,
      path: folderPath,
      writable: true,
    });
  }

  /**
   * Revoke AI write access on a folder and all its contents
   */
  async revokeAiWriteOnFolder(connectionName: string, folderPath: string): Promise<void> {
    const connection = this.connectionManager.getConnection(connectionName);
    if (!connection?.mcpActive || !connection.aiWritablePaths) {
      return;
    }

    // Remove the folder and all paths under it
    const toRemove: string[] = [];
    for (const p of connection.aiWritablePaths) {
      if (p === folderPath || p.startsWith(folderPath + path.sep)) {
        toRemove.push(p);
      }
    }

    for (const p of toRemove) {
      connection.aiWritablePaths.delete(p);
    }

    this._onDidChangeAiPermissions.fire({
      connectionName,
      path: folderPath,
      writable: false,
    });
  }

  /**
   * Request AI write access via notification (called by AI agent)
   */
  async requestWriteAccess(connectionName: string, filePath: string): Promise<boolean> {
    const connection = this.connectionManager.getConnection(connectionName);
    if (!connection?.mcpActive) {
      return false;
    }

    const fileName = path.basename(filePath);
    const result = await vscode.window.showInformationMessage(
      `Copilot requests write access to "${fileName}" on ${connectionName}`,
      { modal: false },
      'Allow',
      'Deny'
    );

    if (result === 'Allow') {
      this.setAiWriteAccess(connectionName, filePath, true);
      return true;
    }

    return false;
  }

  /**
   * Get active MCP connections
   */
  getActiveMcpConnections(): string[] {
    return this.connectionManager.getConnections()
      .filter(c => c.mcpActive)
      .map(c => c.config.name);
  }

  // ============================================
  // Tool Implementations
  // ============================================

  /**
   * List all connections and their MCP status
   */
  private _listConnections(): vscode.LanguageModelToolResult {
    const connections = this.connectionManager.getConnections();

    const result = connections.map(c => ({
      name: c.config.name,
      host: c.config.host,
      protocol: c.config.protocol,
      status: c.status,
      mcpEnabled: c.mcpActive === true,
      mountedDrive: c.mountedDrive || null,
    }));

    const mcpEnabledCount = result.filter(c => c.mcpEnabled).length;

    let summary = `Found ${connections.length} connection(s)`;
    if (mcpEnabledCount > 0) {
      summary += `, ${mcpEnabledCount} with Copilot access enabled`;
    } else {
      summary += `. Note: No connections have Copilot access enabled. Ask the user to enable it via the SFTP+ panel.`;
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(`${summary}\n\n${JSON.stringify(result, null, 2)}`),
    ]);
  }

  /**
   * List files in a directory
   */
  private async _listFiles(connectionName: string, remotePath?: string): Promise<vscode.LanguageModelToolResult> {
    const connection = this.connectionManager.getConnection(connectionName);

    if (!connection) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error: Connection "${connectionName}" not found. Use sftp-plus_list_connections to see available connections.`),
      ]);
    }

    if (!connection.mcpActive) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error: Copilot access is not enabled for "${connectionName}". Ask the user to enable it via the SFTP+ panel (click the Copilot icon on the connection).`),
      ]);
    }

    if (!connection.mountedDrive) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error: Connection "${connectionName}" is not mounted. It needs to be connected first.`),
      ]);
    }

    // Construct the path - handle both with and without leading slash
    const basePath = `${connection.mountedDrive}:`;
    const cleanRemotePath = remotePath ? remotePath.replace(/^\/+/, '') : '';
    const targetPath = cleanRemotePath ? path.join(basePath, cleanRemotePath) : basePath + path.sep;

    Logger.info(`MCP list_files: basePath=${basePath}, remotePath=${remotePath}, targetPath=${targetPath}`);

    try {
      // Check if drive exists
      if (!fs.existsSync(basePath + path.sep)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Error: Drive ${connection.mountedDrive}: is not accessible. ` +
            `The SFTP connection may have been disconnected. Please reconnect via SFTP+ panel.`
          ),
        ]);
      }

      const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
      const items = entries
        .filter(e => !e.name.startsWith('.'))
        .map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'folder' : 'file',
          path: (cleanRemotePath ? cleanRemotePath + '/' : '') + e.name,
        }));

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Files in "${remotePath || '/'}" on ${connectionName} (${connection.config.host}):\n\n` +
          JSON.stringify(items, null, 2)
        ),
      ]);
    } catch (error) {
      Logger.error(`MCP list_files error: ${error}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Error listing files at "${remotePath || '/'}" on ${connectionName}: ${error}\n` +
          `Target path was: ${targetPath}`
        ),
      ]);
    }
  }

  /**
   * Read file content
   */
  private async _readFile(connectionName: string, remotePath: string): Promise<vscode.LanguageModelToolResult> {
    const connection = this.connectionManager.getConnection(connectionName);

    if (!connection) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error: Connection "${connectionName}" not found.`),
      ]);
    }

    if (!connection.mcpActive) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error: Copilot access is not enabled for "${connectionName}". Ask the user to enable it.`),
      ]);
    }

    if (!connection.mountedDrive) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error: Connection "${connectionName}" is not mounted.`),
      ]);
    }

    // Construct the path - handle both with and without leading slash
    const basePath = `${connection.mountedDrive}:`;
    const cleanRemotePath = remotePath.replace(/^\/+/, '');
    const fullPath = path.join(basePath, cleanRemotePath);

    Logger.info(`MCP read_file: basePath=${basePath}, remotePath=${remotePath}, fullPath=${fullPath}`);

    try {
      // Check if drive exists
      if (!fs.existsSync(basePath + path.sep)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Error: Drive ${connection.mountedDrive}: is not accessible. ` +
            `The SFTP connection may have been disconnected. Please reconnect via SFTP+ panel.`
          ),
        ]);
      }

      // Check if file exists
      if (!fs.existsSync(fullPath)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Error: File "${remotePath}" not found on ${connectionName}. ` +
            `Use sftp-ls to list available files.`
          ),
        ]);
      }

      const stats = await fs.promises.stat(fullPath);
      if (stats.isDirectory()) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Error: "${remotePath}" is a directory, not a file. ` +
            `Use sftp-ls to list its contents.`
          ),
        ]);
      }

      const content = await fs.promises.readFile(fullPath, 'utf-8');
      const fileName = path.basename(remotePath);

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Content of "${fileName}" from ${connectionName} (${connection.config.host}):\n\n${content}`
        ),
      ]);
    } catch (error) {
      Logger.error(`MCP read_file error: ${error}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Error reading file "${remotePath}" on ${connectionName}: ${error}\n` +
          `Full path was: ${fullPath}`
        ),
      ]);
    }
  }

  /**
   * Write file content
   */
  private async _writeFile(connectionName: string, remotePath: string, content: string): Promise<vscode.LanguageModelToolResult> {
    const connection = this.connectionManager.getConnection(connectionName);

    if (!connection) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error: Connection "${connectionName}" not found.`),
      ]);
    }

    if (!connection.mcpActive) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error: Copilot access is not enabled for "${connectionName}".`),
      ]);
    }

    if (!connection.mountedDrive) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error: Connection "${connectionName}" is not mounted.`),
      ]);
    }

    // Construct the path - handle both with and without leading slash
    const basePath = `${connection.mountedDrive}:`;
    const cleanRemotePath = remotePath.replace(/^\/+/, '');
    const fullPath = path.join(basePath, cleanRemotePath);

    Logger.info(`MCP write_file: basePath=${basePath}, remotePath=${remotePath}, fullPath=${fullPath}`);

    // Check write permission
    if (!this.isAiWritable(connectionName, fullPath)) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Error: Write access not granted for "${remotePath}" on "${connectionName}". ` +
          `Use sftp-plus_request_write_access to ask the user for permission, ` +
          `or ask them to enable write access in the SFTP+ file browser (click the Copilot icon next to the file).`
        ),
      ]);
    }

    try {
      // Check if drive exists
      if (!fs.existsSync(basePath + path.sep)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Error: Drive ${connection.mountedDrive}: is not accessible. ` +
            `The SFTP connection may have been disconnected. Please reconnect via SFTP+ panel.`
          ),
        ]);
      }

      // Ensure directory exists
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.promises.writeFile(fullPath, content, 'utf-8');

      const fileName = path.basename(remotePath);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Successfully wrote to "${fileName}" on ${connectionName} (${connection.config.host})`
        ),
      ]);
    } catch (error) {
      Logger.error(`MCP write_file error: ${error}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Error writing file "${remotePath}" on ${connectionName}: ${error}\n` +
          `Full path was: ${fullPath}`
        ),
      ]);
    }
  }

  /**
   * List paths with write access
   */
  private _listWritablePaths(connectionName: string): vscode.LanguageModelToolResult {
    const connection = this.connectionManager.getConnection(connectionName);

    if (!connection) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error: Connection "${connectionName}" not found.`),
      ]);
    }

    if (!connection.mcpActive) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error: Copilot access is not enabled for "${connectionName}".`),
      ]);
    }

    const paths = this.getAiWritablePaths(connectionName);
    const basePath = connection.mountedDrive ? `${connection.mountedDrive}:\\` : '';

    // Convert to relative paths
    const relativePaths = paths.map(p => {
      if (p.startsWith(basePath)) {
        return p.substring(basePath.length).replace(/\\/g, '/') || '/';
      }
      return p.replace(/\\/g, '/');
    });

    if (relativePaths.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `No paths have write access enabled on "${connectionName}". ` +
          `Use sftp-plus_request_write_access to ask the user for permission on specific files.`
        ),
      ]);
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `Files/folders with write access on "${connectionName}":\n${relativePaths.map(p => `- ${p}`).join('\n')}`
      ),
    ]);
  }

  /**
   * Request write access tool implementation
   */
  private async _requestWriteAccessTool(connectionName: string, remotePath: string): Promise<vscode.LanguageModelToolResult> {
    const connection = this.connectionManager.getConnection(connectionName);

    if (!connection) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error: Connection "${connectionName}" not found.`),
      ]);
    }

    if (!connection.mcpActive) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error: Copilot access is not enabled for "${connectionName}".`),
      ]);
    }

    if (!connection.mountedDrive) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error: Connection "${connectionName}" is not mounted.`),
      ]);
    }

    const basePath = `${connection.mountedDrive}:\\`;
    const fullPath = path.join(basePath, remotePath);

    // Check if already writable
    if (this.isAiWritable(connectionName, fullPath)) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Write access already granted for ${remotePath}`),
      ]);
    }

    // Request access via notification
    const granted = await this.requestWriteAccess(connectionName, fullPath);

    if (granted) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Write access granted for ${remotePath}. You can now use sftp-plus_write_file to modify this file.`),
      ]);
    } else {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Write access denied for ${remotePath}. The user did not grant permission.`),
      ]);
    }
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._onDidChangeAiPermissions.dispose();
    this._onDidChangeMcpStatus.dispose();
  }
}
