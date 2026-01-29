/**
 * Storage scope for connection configuration
 */
export type ConnectionScope = 'global' | 'workspace';

/**
 * Password storage source
 */
export type PasswordSource = 'secret' | 'workspace' | 'none';

/**
 * Connection configuration interface
 */
export interface ConnectionConfig {
  /** Display name for this connection */
  name: string;

  /** Server hostname or IP */
  host: string;

  /** Server port (default: 21 for FTP/FTPS, 22 for SFTP) */
  port: number;

  /** Connection protocol */
  protocol: 'ftp' | 'ftps' | 'sftp';

  /** Username for authentication */
  username: string;

  /** Remote path to mount (default: /) */
  remotePath: string;

  /** Windows drive letter (e.g., Z). Auto-assigned if empty */
  driveLetter?: string;

  /** Use explicit TLS for FTPS (default: true) */
  explicitTls: boolean;

  /** Ignore SSL certificate errors - for self-signed certs (default: false) */
  ignoreCertErrors: boolean;

  /** Auto-connect when VS Code starts (default: false) */
  autoConnect: boolean;

  /** VFS cache mode for performance (default: full) */
  cacheMode: 'off' | 'minimal' | 'writes' | 'full';

  /** Keep-alive idle timeout (default: 5m) */
  idleTimeout: string;

  /** Sync rate in seconds for file browser auto-refresh (default: 60) */
  syncRate: number;

  /** Password stored in workspace JSON file (for compatibility, not recommended) */
  password?: string;
}

/**
 * Extended connection info with storage metadata
 */
export interface ConnectionInfo {
  config: ConnectionConfig;
  /** Where the configuration is stored */
  scope: ConnectionScope;
  /** Where the password comes from */
  passwordSource: PasswordSource;
}

/**
 * Active connection state
 */
export interface Connection {
  /** Connection configuration */
  config: ConnectionConfig;

  /** Current connection status */
  status: ConnectionStatus;

  /** Where the configuration is stored */
  scope: ConnectionScope;

  /** Where the password comes from */
  passwordSource: PasswordSource;

  /** Assigned drive letter when mounted */
  mountedDrive?: string;

  /** rclone process ID when mounted */
  processId?: number;

  /** rclone RC API port for this mount */
  rcPort?: number;

  /** Error message if connection failed */
  error?: string;

  /** MCP server is active for this connection (runtime only) */
  mcpActive?: boolean;

  /** Map of remote paths to their AI write mode: 'local' (green) or 'host' (red) */
  aiWritablePaths?: Map<string, 'local' | 'host'>;

  /** Obscured password for direct sync (runtime only, not persisted) */
  obscuredPassword?: string;
}

/**
 * Connection status enum
 */
export enum ConnectionStatus {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Disconnecting = 'disconnecting',
  Error = 'error',
}

/**
 * Prerequisite installation status
 */
export interface InstallStatus {
  installed: boolean;
  version?: string;
  path?: string;
}

/**
 * All prerequisites status
 */
export interface PrerequisiteStatus {
  rclone: InstallStatus;
  winfsp: InstallStatus;
}

/**
 * Default connection configuration values
 */
export const DEFAULT_CONNECTION_CONFIG: Partial<ConnectionConfig> = {
  port: 21,
  protocol: 'ftps',
  remotePath: '/',
  explicitTls: true,
  ignoreCertErrors: false,
  autoConnect: false,
  cacheMode: 'full',
  idleTimeout: '5m',
  syncRate: 60,
};

/**
 * Tracked file entry (paths are relative, without drive letter)
 */
export interface TrackedFile {
  /** Remote path relative to mount root (e.g., /path/to/file.txt) */
  remotePath: string;
  /** Local path relative to workspace (e.g., .sftp-plus/connection-name/path/to/file.txt) */
  localPath: string;
}

/**
 * Sync status for a tracked file (calculated dynamically)
 */
export enum SyncStatus {
  /** File tracked but not downloaded locally */
  NotDownloaded = 'not-downloaded',
  /** Remote file is newer than local */
  RemoteNewer = 'remote-newer',
  /** Local file is newer than remote */
  LocalNewer = 'local-newer',
  /** Files are in sync */
  Synced = 'synced',
  /** Error checking status */
  Error = 'error',
}
