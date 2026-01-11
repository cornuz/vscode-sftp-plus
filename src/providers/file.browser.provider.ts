import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Connection, ConnectionStatus } from '../models';
import { ConnectionManager } from '../services/connection.manager';
import { Logger } from '../utils/logger';

/**
 * TreeView provider for browsing files on connected drives
 */
export class FileBrowserProvider implements vscode.TreeDataProvider<FileItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<FileItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentConnection?: Connection;
  private rootPath?: string;

  constructor(private connectionManager: ConnectionManager) {}

  /**
   * Set the connection to browse
   */
  setConnection(connection: Connection | undefined): void {
    this.currentConnection = connection;
    if (connection?.status === ConnectionStatus.Connected && connection.mountedDrive) {
      this.rootPath = `${connection.mountedDrive}:\\`;
    } else {
      this.rootPath = undefined;
    }
    this.refresh();
  }

  /**
   * Clear the browser
   */
  clear(): void {
    this.currentConnection = undefined;
    this.rootPath = undefined;
    this.refresh();
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: FileItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: FileItem): Promise<FileItem[]> {
    if (!this.rootPath || !this.currentConnection) {
      return [];
    }

    const dirPath = element && element.resourceUri ? element.resourceUri.fsPath : this.rootPath;

    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

      const items: FileItem[] = entries
        .filter(entry => !entry.name.startsWith('.')) // Hide hidden files
        .sort((a, b) => {
          // Folders first, then files
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        })
        .map(entry => new FileItem(
          entry.name,
          path.join(dirPath, entry.name),
          entry.isDirectory()
        ));

      return items;
    } catch (error) {
      Logger.error(`Failed to read directory: ${dirPath}`, error);
      return [];
    }
  }
}

/**
 * Tree item representing a file or folder
 */
export class FileItem extends vscode.TreeItem {
  constructor(
    public readonly name: string,
    public readonly fullPath: string,
    public readonly isDirectory: boolean
  ) {
    super(
      name,
      isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    this.resourceUri = vscode.Uri.file(fullPath);
    this.tooltip = fullPath;

    if (isDirectory) {
      this.iconPath = new vscode.ThemeIcon('folder');
      this.contextValue = 'folder';
    } else {
      this.iconPath = vscode.ThemeIcon.File;
      this.contextValue = 'file';
      // Open file on click
      this.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [this.resourceUri],
      };
    }
  }
}
