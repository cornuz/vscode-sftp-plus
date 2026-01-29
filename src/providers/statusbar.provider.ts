import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connection.manager';
import { Logger } from '../utils/logger';

/**
 * Status bar provider showing active connection count and cloud file indicator
 */
export class StatusBarProvider implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private cloudFileIndicator: vscode.StatusBarItem;
  private editorChangeListener: vscode.Disposable;
  private saveListener: vscode.Disposable;

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

    // Listen for file saves to show notification for cloud files
    this.saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
      this._onCloudFileSaved(document);
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
   * Show notification when a cloud file is saved and trigger sync.
   * Since VFS queue doesn't work with open files, we use direct rclone copy.
   */
  private async _onCloudFileSaved(document: vscode.TextDocument): Promise<void> {
    const filePath = document.uri.fsPath;
    const filePathUpper = filePath.toUpperCase();
    const activeConnections = this.connectionManager.getActiveConnections();

    const connection = activeConnections.find(conn => {
      if (conn.mountedDrive) {
        return filePathUpper.startsWith(`${conn.mountedDrive.toUpperCase()}:\\`);
      }
      return false;
    });

    if (connection && connection.mountedDrive && connection.rcPort) {
      const fileName = filePath.split(/[\\/]/).pop() || 'file';
      const rcloneService = this.connectionManager.getRcloneService();

      // Update the status bar to show syncing
      this.cloudFileIndicator.text = `$(sync~spin) Syncing...`;
      this.cloudFileIndicator.tooltip = `Syncing ${fileName} to ${connection.config.name}...`;

      try {
        // First try VFS queue approach
        const syncResult = await rcloneService.flushVfsCache(connection.rcPort, filePath);

        // If VFS queue didn't work (file open in editor), use direct CLI copy
        if (!syncResult.uploaded) {
          Logger.info(`[DirectSync] VFS queue empty, trying direct rclone copy...`);

          const directSuccess = await rcloneService.directSyncFile(
            filePath,
            connection.mountedDrive,
            connection.config,
            connection.obscuredPassword
          );

          if (directSuccess) {
            this._updateCloudFileIndicator(vscode.window.activeTextEditor);
            vscode.window.setStatusBarMessage(`$(cloud-upload) ${fileName} synced`, 3000);
            Logger.info(`[DirectSync] Success: ${fileName}`);
            return;
          }
        }

        // Wait a bit for upload to complete
        await new Promise(resolve => setTimeout(resolve, 500));
        this._updateCloudFileIndicator(vscode.window.activeTextEditor);

        if (syncResult.uploaded) {
          vscode.window.setStatusBarMessage(`$(cloud-upload) ${fileName} uploaded`, 3000);
        } else if (syncResult.queued) {
          vscode.window.setStatusBarMessage(`$(clock) ${fileName} queued for upload`, 3000);
        } else {
          vscode.window.setStatusBarMessage(`$(cloud) ${fileName} saved`, 3000);
        }
      } catch (error) {
        Logger.error(`Sync error: ${fileName}`, error);
        this._updateCloudFileIndicator(vscode.window.activeTextEditor);
        vscode.window.setStatusBarMessage(`$(warning) ${fileName} sync may be delayed`, 3000);
      }
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
    this.saveListener.dispose();
  }
}
