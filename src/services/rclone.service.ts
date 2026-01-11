import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { ConnectionConfig, InstallStatus } from '../models';
import { Logger } from '../utils/logger';

const execAsync = promisify(exec);

/**
 * Service for interacting with rclone CLI
 */
export class RcloneService {
  private rclonePath: string;

  constructor() {
    this.rclonePath = this.getConfiguredPath();
  }

  /**
   * Set a custom path for rclone (used when auto-installed)
   */
  setCustomPath(path: string): void {
    this.rclonePath = path;
    Logger.info(`rclone path set to: ${path}`);
  }

  /**
   * Get the current rclone path
   */
  getPath(): string {
    return this.rclonePath;
  }

  /**
   * Get rclone path from settings or use default
   */
  private getConfiguredPath(): string {
    const config = vscode.workspace.getConfiguration('sftp-plus');
    const customPath = config.get<string>('rclonePath');
    return customPath && customPath.length > 0 ? customPath : 'rclone';
  }

  /**
   * Check if rclone is installed and get version
   */
  async checkInstalled(): Promise<InstallStatus> {
    try {
      const { stdout } = await execAsync(`"${this.rclonePath}" version`);
      const versionLine = stdout.split('\n')[0];
      const version = versionLine.replace('rclone ', '').trim();
      Logger.debug(`rclone found: ${version}`);
      return { installed: true, version, path: this.rclonePath };
    } catch (error) {
      Logger.warn('rclone not found in PATH');
      return { installed: false };
    }
  }

  /**
   * Obscure password for rclone (required for connection string)
   */
  async obscurePassword(plainPassword: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`"${this.rclonePath}" obscure "${plainPassword}"`);
      return stdout.trim();
    } catch (error) {
      Logger.error('Failed to obscure password', error);
      throw new Error('Failed to prepare password for connection');
    }
  }

  /**
   * Build rclone connection string for FTP/FTPS
   */
  buildConnectionString(config: ConnectionConfig, obscuredPassword: string): string {
    const parts: string[] = [];

    if (config.protocol === 'sftp') {
      parts.push(':sftp');
      parts.push(`host=${config.host}`);
      parts.push(`port=${config.port || 22}`);
      parts.push(`user=${config.username}`);
      parts.push(`pass=${obscuredPassword}`);
    } else {
      // FTP or FTPS
      parts.push(':ftp');
      parts.push(`host=${config.host}`);
      parts.push(`port=${config.port || 21}`);
      parts.push(`user=${config.username}`);
      parts.push(`pass=${obscuredPassword}`);

      if (config.protocol === 'ftps') {
        if (config.explicitTls) {
          parts.push('explicit_tls=true');
        } else {
          parts.push('tls=true');
        }
      }

      if (config.ignoreCertErrors) {
        parts.push('no_check_certificate=true');
      }
    }

    return parts.join(',') + ':' + (config.remotePath || '/');
  }

  /**
   * Mount remote filesystem to Windows drive
   * @returns ChildProcess for the mount operation
   */
  mount(config: ConnectionConfig, obscuredPassword: string, driveLetter: string): ChildProcess {
    const remoteSpec = this.buildConnectionString(config, obscuredPassword);
    const mountPoint = `${driveLetter}:`;

    const args = [
      'mount',
      remoteSpec,
      mountPoint,
      '--vfs-cache-mode', config.cacheMode || 'full',
      '--vfs-cache-max-age', '1h',
      '--vfs-write-back', '1s',
      '--dir-cache-time', '30s',
      '--poll-interval', '10s',
      '--ftp-concurrency', '4',
      '--ftp-idle-timeout', config.idleTimeout || '5m',
      '--buffer-size', '32M',
      '--vfs-read-ahead', '64M',
      '--vfs-fast-fingerprint',
      '--volname', `SFTP+-${config.name}`,
    ];

    Logger.info(`Mounting ${config.host} to ${mountPoint}`);
    Logger.debug(`rclone args: ${args.join(' ')}`);

    const process = spawn(this.rclonePath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });

    process.unref();

    return process;
  }

  /**
   * Unmount by killing the rclone process
   */
  async unmount(processId: number): Promise<void> {
    try {
      // On Windows, we need to use taskkill
      await execAsync(`taskkill /PID ${processId} /F`);
      Logger.info(`Killed rclone process ${processId}`);
    } catch (error) {
      // Process may already be dead
      Logger.debug(`Process ${processId} may already be stopped`);
    }
  }

  /**
   * Kill all rclone processes (for disconnectAll)
   */
  async killAllRclone(): Promise<void> {
    try {
      await execAsync('taskkill /IM rclone.exe /F');
      Logger.info('Killed all rclone processes');
    } catch (error) {
      // No rclone processes running
      Logger.debug('No rclone processes to kill');
    }
  }

  /**
   * Cleanup all SFTP+ mounted drives
   * This finds all drives with volume labels starting with "SFTP+-" and unmounts them
   */
  async cleanupAllSftpPlusDrives(): Promise<number> {
    let cleanedCount = 0;

    try {
      // Get list of volumes with SFTP+ prefix using WMIC
      const { stdout } = await execAsync(
        'wmic logicaldisk where "VolumeName like \'SFTP+-%\'" get DeviceID,VolumeName /format:csv',
        { timeout: 10000 }
      );

      const lines = stdout.split('\n').filter(line => line.trim() && line.includes('SFTP+-'));

      for (const line of lines) {
        const parts = line.split(',');
        if (parts.length >= 3) {
          const driveLetter = parts[1].replace(':', '').trim();
          const volumeName = parts[2].trim();

          if (driveLetter && volumeName.startsWith('SFTP+-')) {
            Logger.info(`Cleaning up orphaned drive ${driveLetter}: (${volumeName})`);

            try {
              // Use rclone mount to unmount the drive
              await execAsync(`"${this.rclonePath}" mount --unmount ${driveLetter}:`, { timeout: 5000 });
              cleanedCount++;
            } catch (unmountError) {
              // If rclone unmount fails, try to find and kill the rclone process for this drive
              Logger.debug(`rclone unmount failed for ${driveLetter}:, trying taskkill`);
              try {
                // Get rclone processes and their command lines
                const { stdout: taskList } = await execAsync(
                  `wmic process where "name='rclone.exe'" get ProcessId,CommandLine /format:csv`,
                  { timeout: 5000 }
                );

                const processLines = taskList.split('\n').filter(l => l.includes(driveLetter + ':'));
                for (const procLine of processLines) {
                  const procParts = procLine.split(',');
                  if (procParts.length >= 3) {
                    const pid = procParts[procParts.length - 1].trim();
                    if (pid && !isNaN(parseInt(pid))) {
                      await execAsync(`taskkill /PID ${pid} /F`);
                      cleanedCount++;
                      Logger.info(`Killed rclone process ${pid} for drive ${driveLetter}:`);
                    }
                  }
                }
              } catch (killError) {
                Logger.warn(`Could not cleanup drive ${driveLetter}: ${killError}`);
              }
            }
          }
        }
      }

      if (cleanedCount > 0) {
        Logger.info(`Cleaned up ${cleanedCount} orphaned SFTP+ drive(s)`);
      }
    } catch (error) {
      // WMIC command failed - no drives to clean or WMIC not available
      Logger.debug('No orphaned SFTP+ drives found or WMIC unavailable');
    }

    return cleanedCount;
  }

  /**
   * Test a connection without mounting
   */
  async testConnection(config: ConnectionConfig, password: string): Promise<{ success: boolean; message: string }> {
    try {
      const obscuredPassword = await this.obscurePassword(password);
      const remoteSpec = this.buildConnectionString(config, obscuredPassword);

      // Use rclone lsd to list directories (quick test)
      const { stdout, stderr } = await execAsync(
        `"${this.rclonePath}" lsd "${remoteSpec}" --max-depth 1`,
        { timeout: 15000 }
      );

      Logger.info(`Test connection to ${config.host} successful`);
      return { success: true, message: 'Connection successful' };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error(`Test connection to ${config.host} failed`, error);

      // Parse common error messages
      if (errorMessage.includes('530')) {
        return { success: false, message: 'Authentication failed - check username/password' };
      }
      if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
        return { success: false, message: 'Connection timed out - check host/port' };
      }
      if (errorMessage.includes('certificate')) {
        return { success: false, message: 'Certificate error - try enabling "Ignore Certificate Errors"' };
      }

      return { success: false, message: errorMessage };
    }
  }
}
