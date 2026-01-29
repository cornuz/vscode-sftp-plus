import * as vscode from 'vscode';
import { Connection, ConnectionStatus, PrerequisiteStatus } from '../models';
import { ConnectionManager } from '../services/connection.manager';
import { PrerequisiteChecker } from '../services/prerequisite.checker';

/**
 * Union type for all tree items
 */
export type TreeItem = ConnectionTreeItem | PrerequisiteStatusItem;

/**
 * TreeView provider for displaying connections in the activity bar
 */
export class ConnectionTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _prerequisiteChecker?: PrerequisiteChecker;

  constructor(private connectionManager: ConnectionManager) {}

  /**
   * Set the prerequisite checker to display status
   */
  setPrerequisiteChecker(checker: PrerequisiteChecker): void {
    this._prerequisiteChecker = checker;
    checker.onDidChangeStatus(() => this.refresh());
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): Thenable<TreeItem[]> {
    if (element) {
      // No children for any items
      return Promise.resolve([]);
    }

    // Root level: show all connections
    const connections = this.connectionManager.getConnections();
    const items: TreeItem[] = connections.map(conn => new ConnectionTreeItem(conn));

    // Add prerequisite status items at the bottom if we have a checker
    if (this._prerequisiteChecker?.status) {
      const status = this._prerequisiteChecker.status;
      items.push(new PrerequisiteStatusItem('rclone', status.rclone.installed, status.rclone.version));
      items.push(new PrerequisiteStatusItem('WinFsp', status.winfsp.installed, status.winfsp.version));
    }

    return Promise.resolve(items);
  }
}

/**
 * Tree item representing a connection
 */
export class ConnectionTreeItem extends vscode.TreeItem {
  constructor(public readonly connection: Connection) {
    super(connection.config.name, vscode.TreeItemCollapsibleState.None);

    this.tooltip = this.buildTooltip();
    this.description = this.buildDescription();
    this.iconPath = this.getIcon();
    this.contextValue = this.getContextValue();

    // Click only selects the item (shows details in panel)
    // Connection/disconnection is done via the inline icons
  }

  private buildTooltip(): string {
    const c = this.connection.config;
    const lines = [
      `${c.name}`,
      `${c.protocol.toUpperCase()}://${c.host}:${c.port}`,
      `User: ${c.username}`,
      `Status: ${this.connection.status}`,
    ];

    if (this.connection.mountedDrive) {
      lines.push(`Drive: ${this.connection.mountedDrive}:`);
    }

    if (this.connection.error) {
      lines.push(`Error: ${this.connection.error}`);
    }

    return lines.join('\n');
  }

  private buildDescription(): string {
    switch (this.connection.status) {
      case ConnectionStatus.Connected:
        return `${this.connection.mountedDrive}: ✓`;
      case ConnectionStatus.Connecting:
        return 'connecting...';
      case ConnectionStatus.Disconnecting:
        return 'disconnecting...';
      case ConnectionStatus.Error:
        return '✗ error';
      default:
        return this.connection.config.host;
    }
  }

  private getIcon(): vscode.ThemeIcon {
    switch (this.connection.status) {
      case ConnectionStatus.Connected:
        // Use MCP icon (blue) when MCP is active, otherwise plug icon (green)
        if (this.connection.mcpActive) {
          return new vscode.ThemeIcon('mcp', new vscode.ThemeColor('charts.blue'));
        }
        return new vscode.ThemeIcon('plug', new vscode.ThemeColor('charts.green'));
      case ConnectionStatus.Connecting:
      case ConnectionStatus.Disconnecting:
        return new vscode.ThemeIcon('sync~spin');
      case ConnectionStatus.Error:
        return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
      default:
        return new vscode.ThemeIcon('plug', new vscode.ThemeColor('charts.gray'));
    }
  }

  private getContextValue(): string {
    const mcpSuffix = this.connection.mcpActive ? '-mcp' : '';
    switch (this.connection.status) {
      case ConnectionStatus.Connected:
        return `connected${mcpSuffix}`;
      case ConnectionStatus.Disconnected:
        return 'disconnected';
      default:
        return 'busy';
    }
  }
}

/**
 * Tree item showing prerequisite installation status
 */
export class PrerequisiteStatusItem extends vscode.TreeItem {
  public readonly prereqName: 'rclone' | 'WinFsp';

  constructor(
    name: 'rclone' | 'WinFsp',
    public readonly installed: boolean,
    public readonly version?: string
  ) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.prereqName = name;

    if (installed) {
      // rclone version already has 'v' prefix, WinFsp doesn't
      this.description = version || '✓';
      this.tooltip = `${name} is installed${version ? ` (${version})` : ''}\nClick to view details`;
      this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
    } else {
      this.description = '✗ not installed';
      this.tooltip = `${name} is not installed\nClick to view details and install`;
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
    }

    // Always show details when clicked (install button is in the details panel)
    this.command = {
      command: 'sftp-plus.showPrerequisiteDetails',
      title: `Show ${name} details`,
      arguments: [name, { installed, version }],
    };

    this.contextValue = 'prerequisite';
  }
}