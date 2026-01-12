import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connection.manager';

/**
 * Status bar provider showing active connection count and cloud file indicator
 */
export class StatusBarProvider implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private cloudFileIndicator: vscode.StatusBarItem;
  private editorChangeListener: vscode.Disposable;

  constructor(private connectionManager: ConnectionManager) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );

    this.statusBarItem.command = 'sftp-plus.connect';
    this.update();

    // Cloud file indicator (shown on the right side)
    this.cloudFileIndicator = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      1000
    );
    this.cloudFileIndicator.text = '$(cloud) Cloud Edit';
    this.cloudFileIndicator.tooltip = 'This file is on a remote server (SFTP+)';
    this.cloudFileIndicator.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

    // Listen for active editor changes
    this.editorChangeListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
      this._updateCloudFileIndicator(editor);
    });

    // Check current editor
    this._updateCloudFileIndicator(vscode.window.activeTextEditor);

    // Check if status bar should be shown
    const config = vscode.workspace.getConfiguration('sftp-plus');
    if (config.get<boolean>('showStatusBar', true)) {
      this.statusBarItem.show();
    }
  }

  /**
   * Update cloud file indicator based on active editor
   */
  private _updateCloudFileIndicator(editor: vscode.TextEditor | undefined): void {
    if (!editor) {
      this.cloudFileIndicator.hide();
      return;
    }

    const filePath = editor.document.uri.fsPath.toUpperCase(); // Normalize to uppercase for Windows

    // Check if the file is on a mounted drive from our connections
    const activeConnections = this.connectionManager.getActiveConnections();

    const isCloudFile = activeConnections.some(conn => {
      if (conn.mountedDrive) {
        const drivePath = `${conn.mountedDrive.toUpperCase()}:\\`;
        return filePath.startsWith(drivePath);
      }
      return false;
    });

    if (isCloudFile) {
      // Find the connection name for the tooltip
      const connection = activeConnections.find(conn => {
        if (conn.mountedDrive) {
          return filePath.startsWith(`${conn.mountedDrive.toUpperCase()}:\\`);
        }
        return false;
      });

      if (connection) {
        this.cloudFileIndicator.text = `$(cloud) ${connection.config.name}`;
        this.cloudFileIndicator.tooltip = `Cloud Edit: ${connection.config.name} (${connection.config.host})`;
      }
      this.cloudFileIndicator.show();
    } else {
      this.cloudFileIndicator.hide();
    }
  }

  /**
   * Update status bar display
   */
  update(): void {
    const activeCount = this.connectionManager.getActiveConnections().length;
    const totalCount = this.connectionManager.getConnections().length;

    if (activeCount > 0) {
      this.statusBarItem.text = `$(plug) SFTP+: ${activeCount} active`;
      this.statusBarItem.tooltip = `${activeCount} of ${totalCount} connections active\nClick to manage connections`;
      this.statusBarItem.backgroundColor = undefined;
    } else if (totalCount > 0) {
      this.statusBarItem.text = `$(plug) SFTP+`;
      this.statusBarItem.tooltip = `${totalCount} connections configured\nClick to connect`;
      this.statusBarItem.backgroundColor = undefined;
    } else {
      this.statusBarItem.text = `$(plug) SFTP+`;
      this.statusBarItem.tooltip = 'No connections configured\nClick to add one';
      this.statusBarItem.backgroundColor = undefined;
    }
  }

  /**
   * Show or hide based on settings
   */
  updateVisibility(): void {
    const config = vscode.workspace.getConfiguration('sftp-plus');
    if (config.get<boolean>('showStatusBar', true)) {
      this.statusBarItem.show();
    } else {
      this.statusBarItem.hide();
    }
  }

  dispose(): void {
    this.statusBarItem.dispose();
    this.cloudFileIndicator.dispose();
    this.editorChangeListener.dispose();
  }
}
