import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connection.manager';

/**
 * Status bar provider showing active connection count
 */
export class StatusBarProvider implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;

  constructor(private connectionManager: ConnectionManager) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );

    this.statusBarItem.command = 'sftp-plus.connect';
    this.update();

    // Check if status bar should be shown
    const config = vscode.workspace.getConfiguration('sftp-plus');
    if (config.get<boolean>('showStatusBar', true)) {
      this.statusBarItem.show();
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
  }
}
