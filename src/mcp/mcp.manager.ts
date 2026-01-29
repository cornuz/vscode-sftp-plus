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
  mode: 'local' | 'host' | null; // null = revoked
}

/**
 * AI write mode type
 */
export type AiWriteMode = 'local' | 'host';

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
          const input = options.input as { connectionName: string; path?: string; recursive?: boolean; maxDepth?: number };
          return this._listFiles(input.connectionName, input.path, input.recursive, input.maxDepth);
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

    // Tool: search_files
    this._disposables.push(
      vscode.lm.registerTool('sftp-plus_search_files', {
        invoke: async (options, _token) => {
          const input = options.input as {
            connectionName: string;
            pattern: string;
            path?: string;
            useRegex?: boolean;
            type?: 'file' | 'folder' | 'all';
            maxResults?: number;
          };
          return this._searchFiles(input.connectionName, input.pattern, input.path, input.useRegex, input.type, input.maxResults);
        },
      })
    );

    // Tool: get_tree
    this._disposables.push(
      vscode.lm.registerTool('sftp-plus_get_tree', {
        invoke: async (options, _token) => {
          const input = options.input as {
            connectionName: string;
            path?: string;
            maxDepth?: number;
            includeFiles?: boolean;
          };
          return this._getTree(input.connectionName, input.path, input.maxDepth, input.includeFiles);
        },
      })
    );

    // Tool: prepare_edit - Download file locally for Copilot to edit with diff preview
    this._disposables.push(
      vscode.lm.registerTool('sftp-plus_prepare_edit', {
        invoke: async (options, _token) => {
          const input = options.input as { connectionName: string; path: string };
          return this._prepareEdit(input.connectionName, input.path);
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

    // Initialize AI writable paths map
    connection.aiWritablePaths = new Map<string, 'local' | 'host'>();
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
   * Toggle AI write access for a path with mode selection
   * Returns the new mode ('local', 'host') or null if revoked
   */
  async toggleAiWriteAccess(connectionName: string, filePath: string): Promise<AiWriteMode | null> {
    const connection = this.connectionManager.getConnection(connectionName);
    if (!connection?.mcpActive || !connection.aiWritablePaths) {
      return null;
    }

    const currentMode = connection.aiWritablePaths.get(filePath);

    if (currentMode) {
      // Currently has access - revoke it
      connection.aiWritablePaths.delete(filePath);
      this._onDidChangeAiPermissions.fire({
        connectionName,
        path: filePath,
        mode: null,
      });
      return null;
    } else {
      // No access - show menu to choose mode
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(file-symlink-file) Local', description: 'Download file locally for editing with diff preview', value: 'local' as const },
          { label: '$(cloud-upload) Host', description: 'Allow direct writing to server (no diff preview)', value: 'host' as const },
        ],
        { placeHolder: 'Choose AI write access mode' }
      );

      if (choice) {
        connection.aiWritablePaths.set(filePath, choice.value);
        this._onDidChangeAiPermissions.fire({
          connectionName,
          path: filePath,
          mode: choice.value,
        });
        return choice.value;
      }
      return null;
    }
  }

  /**
   * Set AI write access for a path with specific mode
   */
  setAiWriteAccess(connectionName: string, filePath: string, mode: AiWriteMode | null): void {
    const connection = this.connectionManager.getConnection(connectionName);
    if (!connection?.mcpActive || !connection.aiWritablePaths) {
      return;
    }

    if (mode) {
      connection.aiWritablePaths.set(filePath, mode);
    } else {
      connection.aiWritablePaths.delete(filePath);
    }

    this._onDidChangeAiPermissions.fire({
      connectionName,
      path: filePath,
      mode,
    });
  }

  /**
   * Get the AI write mode for a path ('local', 'host', or null)
   */
  getAiWriteMode(connectionName: string, filePath: string): AiWriteMode | null {
    const connection = this.connectionManager.getConnection(connectionName);
    if (!connection?.mcpActive || !connection.aiWritablePaths) {
      return null;
    }

    // Check exact path
    const mode = connection.aiWritablePaths.get(filePath);
    if (mode) {
      return mode;
    }

    // Check if any parent folder has write access
    let currentPath = filePath;
    while (currentPath) {
      const parent = path.dirname(currentPath);
      if (parent === currentPath) break; // Root reached
      const parentMode = connection.aiWritablePaths.get(parent);
      if (parentMode) {
        return parentMode;
      }
      currentPath = parent;
    }

    return null;
  }

  /**
   * Check if a path has AI write access (any mode)
   */
  isAiWritable(connectionName: string, filePath: string): boolean {
    return this.getAiWriteMode(connectionName, filePath) !== null;
  }

  /**
   * Check if a path has host (direct) write access
   */
  isAiHostWritable(connectionName: string, filePath: string): boolean {
    return this.getAiWriteMode(connectionName, filePath) === 'host';
  }

  /**
   * Get all paths with AI write access for a connection
   */
  getAiWritablePaths(connectionName: string): Array<{ path: string; mode: AiWriteMode }> {
    const connection = this.connectionManager.getConnection(connectionName);
    if (!connection?.aiWritablePaths) {
      return [];
    }
    return Array.from(connection.aiWritablePaths.entries()).map(([path, mode]) => ({ path, mode }));
  }

  /**
   * Allow AI write access on a folder and all its contents
   */
  async allowAiWriteOnFolder(connectionName: string, folderPath: string): Promise<void> {
    const connection = this.connectionManager.getConnection(connectionName);
    if (!connection?.mcpActive || !connection.aiWritablePaths) {
      return;
    }

    // Show menu to choose mode
    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(file-symlink-file) Local', description: 'Download files locally for editing with diff preview', value: 'local' as const },
        { label: '$(cloud-upload) Host', description: 'Allow direct writing to server (no diff preview)', value: 'host' as const },
      ],
      { placeHolder: 'Choose AI write access mode for folder' }
    );

    if (choice) {
      connection.aiWritablePaths.set(folderPath, choice.value);
      this._onDidChangeAiPermissions.fire({
        connectionName,
        path: folderPath,
        mode: choice.value,
      });
    }
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
    for (const [p] of connection.aiWritablePaths) {
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
      mode: null,
    });
  }

  /**
   * Request AI write access via notification (called by AI agent)
   * Returns: { mode: 'local' | 'host', localPath?: string } or null if denied
   */
  async requestWriteAccess(connectionName: string, filePath: string): Promise<{ mode: AiWriteMode; localPath?: string } | null> {
    const connection = this.connectionManager.getConnection(connectionName);
    if (!connection?.mcpActive) {
      return null;
    }

    const fileName = path.basename(filePath);
    const result = await vscode.window.showInformationMessage(
      `Copilot requests write access to "${fileName}" on ${connectionName}`,
      { modal: false },
      'Local (with diff)',
      'Host (direct)',
      'Cancel'
    );

    if (result === 'Local (with diff)') {
      // Download file locally and return local path
      const localPath = await this._downloadForEdit(connectionName, filePath, connection);
      if (localPath) {
        this.setAiWriteAccess(connectionName, filePath, 'local');
        return { mode: 'local', localPath };
      }
      return null;
    } else if (result === 'Host (direct)') {
      this.setAiWriteAccess(connectionName, filePath, 'host');
      return { mode: 'host' };
    }

    return null;
  }

  /**
   * Download a file for local editing (helper for requestWriteAccess)
   */
  private async _downloadForEdit(connectionName: string, remotePath: string, connection: Connection): Promise<string | null> {
    if (!connection.mountedDrive) {
      return null;
    }

    const basePath = `${connection.mountedDrive}:`;

    // remotePath may already be a full path like "Z:\folder\file.txt" or a relative path like "/folder/file.txt"
    let cleanRemotePath: string;
    let fullRemotePath: string;

    if (remotePath.match(/^[A-Za-z]:\\/)) {
      // Already a full Windows path (e.g., "Z:\folder\file.txt")
      fullRemotePath = remotePath;
      cleanRemotePath = remotePath.substring(3).replace(/\\/g, '/'); // Remove "Z:\" and normalize
    } else {
      // Relative path (e.g., "/folder/file.txt" or "folder/file.txt")
      cleanRemotePath = remotePath.replace(/^\/+/, '').replace(/\\/g, '/');
      fullRemotePath = path.join(basePath, cleanRemotePath);
    }

    try {
      // Get workspace root
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder is open. Cannot download file locally.');
        return null;
      }

      const workspaceRoot = workspaceFolders[0].uri.fsPath;

      // Calculate local path: .sftp-plus/[connection]/[relative-path]
      const localRelativePath = `.sftp-plus/${connectionName}/${cleanRemotePath}`;
      const localFullPath = path.join(workspaceRoot, localRelativePath);

      // Ensure directory exists
      await fs.promises.mkdir(path.dirname(localFullPath), { recursive: true });

      // Copy file from remote to local
      await fs.promises.copyFile(fullRemotePath, localFullPath);

      // Open the file in VS Code editor
      const document = await vscode.workspace.openTextDocument(localFullPath);
      await vscode.window.showTextDocument(document);

      Logger.info(`Downloaded file for local edit: ${localFullPath}`);
      return localFullPath;
    } catch (error) {
      Logger.error(`Failed to download file for edit: ${error}`);
      vscode.window.showErrorMessage(`Failed to download file: ${error}`);
      return null;
    }
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
   * List files in a directory (with optional recursive support)
   */
  private async _listFiles(connectionName: string, remotePath?: string, recursive?: boolean, maxDepth?: number): Promise<vscode.LanguageModelToolResult> {
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

    Logger.info(`MCP list_files: basePath=${basePath}, remotePath=${remotePath}, targetPath=${targetPath}, recursive=${recursive}`);

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

      const items: Array<{ name: string; type: string; path: string }> = [];
      const depth = maxDepth ?? 10;

      if (recursive) {
        await this._listFilesRecursive(targetPath, cleanRemotePath, items, depth, 0);
      } else {
        const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
        for (const e of entries) {
          if (!e.name.startsWith('.')) {
            items.push({
              name: e.name,
              type: e.isDirectory() ? 'folder' : 'file',
              path: (cleanRemotePath ? cleanRemotePath + '/' : '') + e.name,
            });
          }
        }
      }

      const modeText = recursive ? ` (recursive, depth=${depth})` : '';
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Files in "${remotePath || '/'}" on ${connectionName} (${connection.config.host})${modeText}:\n` +
          `Found ${items.length} items.\n\n` +
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
   * Helper: Recursively list files
   */
  private async _listFilesRecursive(
    fsPath: string,
    relativePath: string,
    results: Array<{ name: string; type: string; path: string }>,
    maxDepth: number,
    currentDepth: number
  ): Promise<void> {
    if (currentDepth > maxDepth) return;

    try {
      const entries = await fs.promises.readdir(fsPath, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;

        const itemPath = (relativePath ? relativePath + '/' : '') + e.name;
        const isDir = e.isDirectory();

        results.push({
          name: e.name,
          type: isDir ? 'folder' : 'file',
          path: itemPath,
        });

        if (isDir) {
          await this._listFilesRecursive(
            path.join(fsPath, e.name),
            itemPath,
            results,
            maxDepth,
            currentDepth + 1
          );
        }
      }
    } catch (error) {
      // Skip directories we can't read
      Logger.warn(`MCP list_files_recursive: Cannot read ${fsPath}: ${error}`);
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

    // Check write permission - must be in HOST mode
    const writeMode = this.getAiWriteMode(connectionName, fullPath);
    if (!writeMode) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Error: Write access not granted for "${remotePath}" on "${connectionName}". ` +
          `Use sftp-plus_request_write_access to ask the user for permission.`
        ),
      ]);
    }

    if (writeMode === 'local') {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Error: This file has LOCAL write mode, not HOST mode. ` +
          `Use standard Copilot edit tools (replace_string_in_file) on the local copy instead. ` +
          `The user chose to edit locally with diff preview, so direct server writes are not allowed.`
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
   * Prepare a file for editing by downloading it locally
   * This allows Copilot to use standard edit tools with diff preview
   */
  private async _prepareEdit(connectionName: string, remotePath: string): Promise<vscode.LanguageModelToolResult> {
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

    // Construct the remote path
    const basePath = `${connection.mountedDrive}:`;
    const cleanRemotePath = remotePath.replace(/^\/+/, '');
    const fullRemotePath = path.join(basePath, cleanRemotePath);

    Logger.info(`MCP prepare_edit: remotePath=${remotePath}, fullRemotePath=${fullRemotePath}`);

    try {
      // Check if remote file exists
      if (!fs.existsSync(fullRemotePath)) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Error: File "${remotePath}" does not exist on "${connectionName}".`),
        ]);
      }

      // Check if it's a file
      const stat = fs.statSync(fullRemotePath);
      if (stat.isDirectory()) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Error: "${remotePath}" is a directory, not a file.`),
        ]);
      }

      // Get workspace root
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Error: No workspace folder is open. Please open a folder in VS Code to use prepare_edit.`
          ),
        ]);
      }

      const workspaceRoot = workspaceFolders[0].uri.fsPath;

      // Calculate local path: .sftp-plus/[connection]/[relative-path]
      const localRelativePath = `.sftp-plus/${connectionName}/${cleanRemotePath.replace(/\\/g, '/')}`;
      const localFullPath = path.join(workspaceRoot, localRelativePath);

      // Ensure directory exists
      await fs.promises.mkdir(path.dirname(localFullPath), { recursive: true });

      // Copy file from remote to local
      await fs.promises.copyFile(fullRemotePath, localFullPath);

      Logger.info(`MCP prepare_edit: Downloaded to ${localFullPath}`);

      // Open the file in VS Code editor
      const document = await vscode.workspace.openTextDocument(localFullPath);
      await vscode.window.showTextDocument(document);

      const fileName = path.basename(remotePath);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `File "${fileName}" from ${connectionName} has been downloaded and opened locally.\n\n` +
          `**Local file path:** ${localFullPath}\n\n` +
          `You can now edit this file using standard Copilot edit tools. ` +
          `The user will see a diff preview and can accept or reject your changes. ` +
          `After editing, the user can sync the file back to the server via the SFTP+ tracking feature.`
        ),
      ]);
    } catch (error) {
      Logger.error(`MCP prepare_edit error: ${error}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Error preparing file "${remotePath}" for edit: ${error}`
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

    const pathsWithModes = this.getAiWritablePaths(connectionName);
    const basePath = connection.mountedDrive ? `${connection.mountedDrive}:\\` : '';

    // Convert to relative paths with mode info
    const formattedPaths = pathsWithModes.map(({ path: p, mode }) => {
      const relativePath = p.startsWith(basePath)
        ? p.substring(basePath.length).replace(/\\/g, '/') || '/'
        : p.replace(/\\/g, '/');
      const modeLabel = mode === 'local' ? '🟢 LOCAL' : '🔴 HOST';
      return `- ${relativePath} [${modeLabel}]`;
    });

    if (formattedPaths.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `No paths have write access enabled on "${connectionName}". ` +
          `Use sftp-plus_request_write_access to ask the user for permission on specific files.`
        ),
      ]);
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `Files/folders with write access on "${connectionName}":\n` +
        `(🟢 LOCAL = edit local copy with diff preview, 🔴 HOST = direct server write)\n\n` +
        `${formattedPaths.join('\n')}`
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
    const existingMode = this.getAiWriteMode(connectionName, fullPath);
    if (existingMode) {
      if (existingMode === 'local') {
        // Already has local mode - download and return local path
        const localPath = await this._downloadForEdit(connectionName, remotePath, connection);
        if (localPath) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
              `Write access already granted in LOCAL mode for ${remotePath}.\n\n` +
              `**Local file path:** ${localPath}\n\n` +
              `Use standard Copilot edit tools (replace_string_in_file, etc.) on the local file to make changes with diff preview. ` +
              `Do NOT use sftp-plus_write_file for this file.`
            ),
          ]);
        }
      } else {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Write access already granted in HOST mode for ${remotePath}. ` +
            `You can use sftp-plus_write_file to modify this file directly on the server.`
          ),
        ]);
      }
    }

    // Request access via notification (shows Local/Host/Cancel)
    const result = await this.requestWriteAccess(connectionName, fullPath);

    if (result) {
      if (result.mode === 'local' && result.localPath) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Write access granted in LOCAL mode for ${remotePath}.\n\n` +
            `**Local file path:** ${result.localPath}\n\n` +
            `The file has been downloaded and opened locally. Use standard Copilot edit tools (replace_string_in_file, etc.) ` +
            `to make changes with diff preview. The user will accept/reject changes and sync back to server.\n\n` +
            `IMPORTANT: Do NOT use sftp-plus_write_file for this file.`
          ),
        ]);
      } else {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Write access granted in HOST mode for ${remotePath}. ` +
            `You can now use sftp-plus_write_file to modify this file directly on the server.`
          ),
        ]);
      }
    } else {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Write access denied for ${remotePath}. The user did not grant permission.`),
      ]);
    }
  }

  /**
   * Search for files matching a pattern
   */
  private async _searchFiles(
    connectionName: string,
    pattern: string,
    remotePath?: string,
    useRegex?: boolean,
    type?: 'file' | 'folder' | 'all',
    maxResults?: number
  ): Promise<vscode.LanguageModelToolResult> {
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

    const basePath = `${connection.mountedDrive}:`;
    const cleanRemotePath = remotePath ? remotePath.replace(/^\/+/, '') : '';
    const startPath = cleanRemotePath ? path.join(basePath, cleanRemotePath) : basePath + path.sep;
    const limit = maxResults ?? 100;
    const filterType = type ?? 'all';

    Logger.info(`MCP search_files: pattern=${pattern}, path=${remotePath}, useRegex=${useRegex}, type=${filterType}`);

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

      // Create matcher function
      const matcher = this._createMatcher(pattern, useRegex ?? false);
      const results: Array<{ name: string; type: string; path: string }> = [];

      await this._searchRecursive(startPath, cleanRemotePath, matcher, filterType, results, limit);

      const resultText = results.length > 0
        ? JSON.stringify(results, null, 2)
        : 'No files matching the pattern were found.';

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Search results for "${pattern}" in "${remotePath || '/'}" on ${connectionName}:\n` +
          `Found ${results.length} matching items${results.length >= limit ? ` (limited to ${limit})` : ''}.\n\n` +
          resultText
        ),
      ]);
    } catch (error) {
      Logger.error(`MCP search_files error: ${error}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error searching files: ${error}`),
      ]);
    }
  }

  /**
   * Create a matcher function from a pattern (glob or regex)
   */
  private _createMatcher(pattern: string, useRegex: boolean): (name: string) => boolean {
    if (useRegex) {
      try {
        const regex = new RegExp(pattern, 'i');
        return (name: string) => regex.test(name);
      } catch {
        // Invalid regex, fall back to literal match
        return (name: string) => name.toLowerCase().includes(pattern.toLowerCase());
      }
    }

    // Convert glob to regex
    // Handle common glob patterns: *, **, ?, [abc]
    let regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars except * and ?
      .replace(/\*\*/g, '{{GLOBSTAR}}')      // Temporarily replace **
      .replace(/\*/g, '[^/]*')               // * matches anything except /
      .replace(/\?/g, '.')                   // ? matches single char
      .replace(/{{GLOBSTAR}}/g, '.*');       // ** matches anything including /

    try {
      const regex = new RegExp(`^${regexPattern}$`, 'i');
      return (name: string) => regex.test(name);
    } catch {
      return (name: string) => name.toLowerCase().includes(pattern.toLowerCase());
    }
  }

  /**
   * Helper: Recursively search for files
   */
  private async _searchRecursive(
    fsPath: string,
    relativePath: string,
    matcher: (name: string) => boolean,
    filterType: 'file' | 'folder' | 'all',
    results: Array<{ name: string; type: string; path: string }>,
    limit: number
  ): Promise<void> {
    if (results.length >= limit) return;

    try {
      const entries = await fs.promises.readdir(fsPath, { withFileTypes: true });

      for (const e of entries) {
        if (results.length >= limit) break;
        if (e.name.startsWith('.')) continue;

        const itemPath = (relativePath ? relativePath + '/' : '') + e.name;
        const isDir = e.isDirectory();
        const itemType = isDir ? 'folder' : 'file';

        // Check if name matches pattern
        if (matcher(e.name)) {
          // Apply type filter
          if (filterType === 'all' || filterType === itemType) {
            results.push({
              name: e.name,
              type: itemType,
              path: itemPath,
            });
          }
        }

        // Recurse into directories
        if (isDir) {
          await this._searchRecursive(
            path.join(fsPath, e.name),
            itemPath,
            matcher,
            filterType,
            results,
            limit
          );
        }
      }
    } catch (error) {
      // Skip directories we can't read
      Logger.warn(`MCP search_recursive: Cannot read ${fsPath}: ${error}`);
    }
  }

  /**
   * Get directory tree structure
   */
  private async _getTree(
    connectionName: string,
    remotePath?: string,
    maxDepth?: number,
    includeFiles?: boolean
  ): Promise<vscode.LanguageModelToolResult> {
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

    const basePath = `${connection.mountedDrive}:`;
    const cleanRemotePath = remotePath ? remotePath.replace(/^\/+/, '') : '';
    const startPath = cleanRemotePath ? path.join(basePath, cleanRemotePath) : basePath + path.sep;
    const depth = maxDepth ?? 5;
    const withFiles = includeFiles !== false; // Default true

    Logger.info(`MCP get_tree: path=${remotePath}, maxDepth=${depth}, includeFiles=${withFiles}`);

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

      const tree = await this._buildTree(startPath, depth, 0, withFiles);
      const treeText = this._formatTree(tree, remotePath || '/', 0);

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Directory tree of "${remotePath || '/'}" on ${connectionName} (depth=${depth}):\n\n` +
          treeText
        ),
      ]);
    } catch (error) {
      Logger.error(`MCP get_tree error: ${error}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Error getting tree: ${error}`),
      ]);
    }
  }

  /**
   * Helper: Build tree structure
   */
  private async _buildTree(
    fsPath: string,
    maxDepth: number,
    currentDepth: number,
    includeFiles: boolean
  ): Promise<Array<{ name: string; type: 'file' | 'folder'; children?: Array<any> }>> {
    const result: Array<{ name: string; type: 'file' | 'folder'; children?: Array<any> }> = [];

    try {
      const entries = await fs.promises.readdir(fsPath, { withFileTypes: true });

      // Sort: folders first, then files, alphabetically
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      for (const e of entries) {
        if (e.name.startsWith('.')) continue;

        const isDir = e.isDirectory();

        if (isDir) {
          const node: { name: string; type: 'file' | 'folder'; children?: Array<any> } = {
            name: e.name,
            type: 'folder',
          };

          if (currentDepth < maxDepth) {
            node.children = await this._buildTree(
              path.join(fsPath, e.name),
              maxDepth,
              currentDepth + 1,
              includeFiles
            );
          }

          result.push(node);
        } else if (includeFiles) {
          result.push({
            name: e.name,
            type: 'file',
          });
        }
      }
    } catch (error) {
      // Skip directories we can't read
    }

    return result;
  }

  /**
   * Helper: Format tree as text
   */
  private _formatTree(
    nodes: Array<{ name: string; type: 'file' | 'folder'; children?: Array<any> }>,
    rootPath: string,
    indent: number
  ): string {
    let result = indent === 0 ? `${rootPath}\n` : '';
    const prefix = '  '.repeat(indent);

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const isLast = i === nodes.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const icon = node.type === 'folder' ? '📁 ' : '📄 ';

      result += `${prefix}${connector}${icon}${node.name}\n`;

      if (node.children && node.children.length > 0) {
        const childPrefix = isLast ? '    ' : '│   ';
        result += this._formatTreeChildren(node.children, indent + 1, prefix + childPrefix);
      }
    }

    return result;
  }

  /**
   * Helper: Format tree children
   */
  private _formatTreeChildren(
    nodes: Array<{ name: string; type: 'file' | 'folder'; children?: Array<any> }>,
    indent: number,
    prefixBase: string
  ): string {
    let result = '';

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const isLast = i === nodes.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const icon = node.type === 'folder' ? '📁 ' : '📄 ';

      result += `${prefixBase}${connector}${icon}${node.name}\n`;

      if (node.children && node.children.length > 0) {
        const childPrefix = isLast ? '    ' : '│   ';
        result += this._formatTreeChildren(node.children, indent + 1, prefixBase + childPrefix);
      }
    }

    return result;
  }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._onDidChangeAiPermissions.dispose();
    this._onDidChangeMcpStatus.dispose();
  }
}
