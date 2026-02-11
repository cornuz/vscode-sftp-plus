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
   * @returns Object with ChildProcess and RC port for the mount operation
   */
  mount(config: ConnectionConfig, obscuredPassword: string, driveLetter: string): { process: ChildProcess; rcPort: number } {
    const remoteSpec = this.buildConnectionString(config, obscuredPassword);
    const mountPoint = `${driveLetter}:`;

    // Use a unique RC port for each mount (base port + drive letter offset)
    const rcPort = 5572 + (driveLetter.charCodeAt(0) - 'A'.charCodeAt(0));

    // Create a stable cache directory based on connection name
    // This ensures the same cache is reused across reconnections
    const safeName = config.name.replace(/[^a-zA-Z0-9-_]/g, '_');
    const localAppData = globalThis.process?.env?.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local';
    const cacheDir = `${localAppData}\\rclone\\sftp-plus-cache\\${safeName}`;

    const args = [
      'mount',
      remoteSpec,
      mountPoint,
      '--vfs-cache-mode', config.cacheMode || 'full',
      '--vfs-cache-max-age', '1h',
      '--vfs-write-back', '0s',  // Immediate write-back when file is closed
      '--vfs-write-wait', '5s',  // Wait longer for in-sequence writes (large files)
      '--dir-cache-time', '30s',
      '--poll-interval', '10s',
      '--buffer-size', '64M',    // Larger buffer for big files
      '--vfs-read-ahead', '64M',
      '--transfers', '4',        // Allow parallel uploads from cache
      '--volname', `SFTP+-${config.name}`,
      // Use a stable cache directory for this connection
      '--cache-dir', cacheDir,
      // Enable Remote Control API to force flush
      '--rc',
      '--rc-addr', `localhost:${rcPort}`,
      '--rc-no-auth',
    ];

    // Common options for all protocols
    args.push('--inplace');               // Write directly to file, avoid .partial temp files
    args.push('--low-level-retries', '10');  // More retries for network issues

    // Add protocol-specific options
    // Note: idle-timeout=0 disables automatic disconnection (keeps connection alive)
    if (config.protocol === 'sftp') {
      args.push('--sftp-idle-timeout', config.idleTimeout || '0');
    } else {
      // FTP/FTPS specific options
      args.push('--ftp-concurrency', '1');  // Single connection to avoid conflicts
      args.push('--ftp-idle-timeout', config.idleTimeout || '0');
      args.push('--ftp-disable-epsv');      // Disable extended passive mode for compatibility
      args.push('--ftp-disable-tls13');     // Workaround for buggy FTP servers with TLS
      args.push('--ftp-close-timeout', '30s'); // Wait longer before closing data connection
      args.push('--ftp-shut-timeout', '30s');  // Wait longer for data connection close status
      if (config.protocol === 'ftps' || config.ignoreCertErrors) {
        args.push('--ftp-no-check-certificate');
      }
    }

    Logger.info(`Mounting ${config.host} to ${mountPoint} (RC port: ${rcPort})`);
    Logger.debug(`rclone args: ${args.join(' ')}`);

    const process = spawn(this.rclonePath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });

    process.unref();

    return { process, rcPort };
  }

  /**
   * Force upload of pending writes.
   * Key insight: With VS Code keeping files open, the VFS queue may never see the file.
   * We need to use vfs/forget to force rclone to re-read and sync the file.
   */
  async flushVfsCache(rcPort: number, filePath?: string): Promise<{ queued: boolean; uploaded: boolean }> {
    const fileName = filePath?.split(/[\\/]/).pop() || 'unknown';
    const result = { queued: false, uploaded: false };

    try {
      Logger.info(`=== SYNC START: ${fileName} ===`);

      // 1. Get full VFS stats
      const stats = await this._getVfsStats(rcPort);
      Logger.info(`[VFS Stats] Queued: ${stats?.uploadsQueued || 0}, Uploading: ${stats?.uploadsInProgress || 0}`);

      // 2. Check upload queue
      const queueBefore = await this._getUploadQueue(rcPort);
      Logger.info(`[Queue] ${queueBefore.length} items`);

      // 3. If file is in queue, trigger immediate upload
      for (const item of queueBefore) {
        const fileNameLower = fileName.toLowerCase();
        if (!filePath || item.name.toLowerCase().includes(fileNameLower)) {
          result.queued = true;
          if (!item.uploading) {
            const success = await this._setQueueItemExpiry(rcPort, item.id, item.name);
            if (success) {
              result.uploaded = true;
              Logger.info(`[Upload] Triggered immediate upload: ${item.name}`);
            }
          } else {
            result.uploaded = true;
            Logger.info(`[Upload] Already uploading: ${item.name}`);
          }
        }
      }

      // 4. If file not in queue, the file handle is likely still open
      //    Try vfs/forget to force rclone to re-sync from cache
      if (!result.queued && filePath) {
        Logger.info(`[Forget] File not in queue, trying vfs/forget to force re-sync`);
        const forgetSuccess = await this._forgetAndResync(rcPort, filePath);
        if (forgetSuccess) {
          result.uploaded = true;
          Logger.info(`[Forget] Successfully triggered re-sync`);
        }
      }

      // 5. Final check
      await new Promise(resolve => setTimeout(resolve, 500));
      const queueFinal = await this._getUploadQueue(rcPort);
      Logger.info(`[FINAL] Queue: ${queueFinal.length} items`);

      Logger.info(`=== SYNC END: ${fileName} (queued: ${result.queued}, uploaded: ${result.uploaded}) ===`);

      return result;
    } catch (error) {
      Logger.error(`[SYNC ERROR] ${fileName}: ${error}`);
      return result;
    }
  }

  /**
   * Use vfs/forget to force rclone to forget the file from VFS cache
   * This should trigger a re-read/re-write from the disk cache
   */
  private async _forgetAndResync(rcPort: number, filePath: string): Promise<boolean> {
    try {
      // Extract path relative to mount point (remove drive letter)
      const relativePath = filePath.substring(3).replace(/\\/g, '/');
      const dirPath = relativePath.split('/').slice(0, -1).join('/');
      const fileName = relativePath.split('/').pop() || '';

      Logger.debug(`[Forget] Relative path: ${relativePath}, dir: ${dirPath}, file: ${fileName}`);

      // Method 1: Try vfs/forget on the specific file
      const forgetResponse = await fetch(`http://localhost:${rcPort}/vfs/forget`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: relativePath,
        }),
      });

      if (forgetResponse.ok) {
        const forgetResult = await forgetResponse.json() as { forgotten?: string[] };
        Logger.info(`[Forget] Forgotten: ${JSON.stringify(forgetResult.forgotten || [])}`);
      } else {
        const errText = await forgetResponse.text();
        Logger.debug(`[Forget] vfs/forget failed: ${errText}`);
      }

      // Method 2: Refresh the directory to trigger re-read
      await this._refreshVfsDir(rcPort, filePath);

      // Method 3: Check if there's data in the disk cache we can read
      //           and use operations/stat to see current file state
      const driveLetter = filePath.charAt(0).toUpperCase();
      const statResponse = await fetch(`http://localhost:${rcPort}/operations/stat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fs: `${driveLetter}:`,
          remote: relativePath,
        }),
      });

      if (statResponse.ok) {
        const stat = await statResponse.json() as { item?: { Name: string; Size: number; ModTime: string } };
        if (stat.item) {
          Logger.info(`[Stat] Remote file: ${stat.item.Name}, ${stat.item.Size}b, mod=${stat.item.ModTime}`);
        }
      }

      // Small delay then check queue again
      await new Promise(resolve => setTimeout(resolve, 300));

      const queueAfterForget = await this._getUploadQueue(rcPort);
      if (queueAfterForget.length > 0) {
        Logger.info(`[Forget] After forget, queue has ${queueAfterForget.length} items`);
        // Trigger immediate upload for new queue items
        for (const item of queueAfterForget) {
          if (item.name.includes(fileName) && !item.uploading) {
            await this._setQueueItemExpiry(rcPort, item.id, item.name);
          }
        }
        return true;
      }

      return false;
    } catch (error) {
      Logger.debug(`[Forget] Error: ${error}`);
      return false;
    }
  }

  /**
   * Get VFS statistics
   */
  private async _getVfsStats(rcPort: number): Promise<{
    uploadsQueued: number;
    uploadsInProgress: number;
    metadataDirty?: number;
  } | null> {
    try {
      const response = await fetch(`http://localhost:${rcPort}/vfs/stats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (response.ok) {
        const data = await response.json() as {
          diskCache?: { uploadsQueued: number; uploadsInProgress: number };
          metaData?: { dirty: number };
        };
        return {
          uploadsQueued: data.diskCache?.uploadsQueued || 0,
          uploadsInProgress: data.diskCache?.uploadsInProgress || 0,
          metadataDirty: data.metaData?.dirty,
        };
      }
    } catch (error) {
      Logger.debug(`VFS stats error: ${error}`);
    }
    return null;
  }

  /**
   * Get current upload queue
   */
  private async _getUploadQueue(rcPort: number): Promise<Array<{
    id: number;
    name: string;
    size: number;
    expiry: number;
    uploading: boolean;
  }>> {
    try {
      const response = await fetch(`http://localhost:${rcPort}/vfs/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (response.ok) {
        const data = await response.json() as { queue?: Array<any> };
        return data.queue || [];
      }
    } catch (error) {
      Logger.debug(`Queue fetch error: ${error}`);
    }
    return [];
  }

  /**
   * Try to trigger VFS to move dirty files to queue
   */
  private async _triggerVfsWrite(rcPort: number, filePath?: string): Promise<void> {
    try {
      // Method 1: Try vfs/refresh to update cache state
      await this._refreshVfsDir(rcPort, filePath);

      // Method 2: Read the file via RC API to trigger cache update
      // This sometimes helps VFS realize the file has changed
      if (filePath) {
        const driveLetter = filePath.charAt(0).toUpperCase();
        const remotePath = filePath.substring(3).replace(/\\/g, '/');

        // Just check if file exists - this can trigger cache awareness
        const response = await fetch(`http://localhost:${rcPort}/operations/stat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fs: `${driveLetter}:`,
            remote: remotePath,
          }),
        });

        if (response.ok) {
          const stat = await response.json() as { item?: { Name: string; Size: number; ModTime: string } };
          if (stat.item) {
            Logger.debug(`[Stat] ${stat.item.Name}: ${stat.item.Size}b, mod=${stat.item.ModTime}`);
          }
        }
      }
    } catch (error) {
      Logger.debug(`Trigger write error: ${error}`);
    }
  }

  /**
   * Set immediate expiry for a queue item
   */
  private async _setQueueItemExpiry(rcPort: number, itemId: number, itemName: string): Promise<boolean> {
    try {
      const response = await fetch(`http://localhost:${rcPort}/vfs/queue-set-expiry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: itemId,
          expiry: -1000000000,  // Negative = upload immediately
        }),
      });

      if (response.ok) {
        Logger.info(`[Expiry] Immediate upload triggered for: ${itemName}`);
        return true;
      } else {
        const errText = await response.text();
        Logger.warn(`[Expiry] Failed for ${itemName}: ${errText}`);
      }
    } catch (error) {
      Logger.debug(`Set expiry error: ${error}`);
    }
    return false;
  }

  /**
   * Refresh VFS directory cache to ensure changes are visible
   */
  private async _refreshVfsDir(rcPort: number, filePath?: string): Promise<void> {
    try {
      const refreshUrl = `http://localhost:${rcPort}/vfs/refresh`;
      const dirPath = filePath ? filePath.split(/[\\/]/).slice(0, -1).join('/').replace(/^[A-Z]:/i, '') : '';

      const response = await fetch(refreshUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dirPath ? { dir: dirPath } : {}),
      });

      if (response.ok) {
        Logger.debug(`VFS directory cache refreshed${dirPath ? ` for: ${dirPath}` : ''}`);
      }
    } catch (error) {
      Logger.debug(`VFS refresh failed (non-critical): ${error}`);
    }
  }

  /**
   * Force sync a file from the mounted drive to the remote server.
   * This bypasses VFS write-back by using operations/copyfile via RC API.
   * The file is copied from the local cache to the remote directly.
   */
  async forceSyncFile(
    rcPort: number,
    localFilePath: string,
    mountedDrive: string,
    config: ConnectionConfig
  ): Promise<boolean> {
    try {
      // Extract the relative path from the mounted drive
      // e.g., "Z:\folder\file.txt" -> "folder/file.txt"
      const drivePart = `${mountedDrive}:\\`;
      if (!localFilePath.toUpperCase().startsWith(drivePart.toUpperCase())) {
        Logger.warn(`File ${localFilePath} is not on mounted drive ${mountedDrive}`);
        return false;
      }

      const relativePath = localFilePath
        .substring(drivePart.length)
        .replace(/\\/g, '/');

      // Build the remote path
      const remotePath = config.remotePath
        ? `${config.remotePath.replace(/\/$/, '')}/${relativePath}`
        : `/${relativePath}`;

      // Get the directory and filename parts
      const pathParts = relativePath.split('/');
      const fileName = pathParts.pop() || '';
      const remoteDir = pathParts.length > 0 ? pathParts.join('/') : '';

      Logger.info(`Force syncing: ${localFilePath} -> remote:${remotePath}`);

      // Use core/command to run rclone copyto
      // This copies the local file (from the VFS cache) directly to the remote
      const copyUrl = `http://localhost:${rcPort}/core/command`;

      // Get the parent directory of the file for the local fs
      const localDir = localFilePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');

      const copyResponse = await fetch(copyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'copyto',
          arg: [
            localFilePath.replace(/\\/g, '/'),
            `:${config.protocol === 'sftp' ? 'sftp' : 'ftp'},host=${config.host},user=${config.username}:${remotePath}`,
          ],
          opt: {
            'no-check-certificate': config.ignoreCertErrors || config.protocol === 'ftps',
          },
        }),
      });

      if (copyResponse.ok) {
        const result = await copyResponse.json() as { error?: boolean; result?: string };
        if (result.error) {
          Logger.warn(`Copy command returned error: ${result.result}`);
          return false;
        }
        Logger.info(`File synced successfully: ${fileName}`);
        return true;
      } else {
        const errText = await copyResponse.text();
        Logger.warn(`Force sync failed: ${copyResponse.status} - ${errText}`);

        // Fallback: try using operations/copyfile which might work better
        return await this._fallbackCopyFile(rcPort, localFilePath, remotePath, config);
      }
    } catch (error) {
      Logger.error(`Force sync error: ${error}`);
      return false;
    }
  }

  /**
   * Fallback copy using operations/copyfile
   */
  private async _fallbackCopyFile(
    rcPort: number,
    localFilePath: string,
    remotePath: string,
    config: ConnectionConfig
  ): Promise<boolean> {
    try {
      const fileName = localFilePath.split(/[\\/]/).pop() || '';
      const remoteDir = remotePath.split('/').slice(0, -1).join('/') || '/';

      // Build remote spec without password (RC API should have access)
      const remoteSpec = `:${config.protocol === 'sftp' ? 'sftp' : 'ftp'},host=${config.host},user=${config.username}:`;

      const copyUrl = `http://localhost:${rcPort}/operations/copyfile`;
      const copyResponse = await fetch(copyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          srcFs: '/',
          srcRemote: localFilePath.replace(/\\/g, '/'),
          dstFs: remoteSpec,
          dstRemote: remotePath,
        }),
      });

      if (copyResponse.ok) {
        Logger.info(`Fallback copy succeeded: ${fileName}`);
        return true;
      } else {
        const errText = await copyResponse.text();
        Logger.debug(`Fallback copy also failed: ${errText}`);
        return false;
      }
    } catch (error) {
      Logger.debug(`Fallback copy error: ${error}`);
      return false;
    }
  }

  /**
   * Direct sync using rclone CLI - bypasses VFS completely
   * This reads the file from the mounted drive and copies it to remote
   * using rclone copyto command with credentials
   */
  async directSyncFile(
    localFilePath: string,
    mountedDrive: string,
    config: ConnectionConfig,
    obscuredPassword?: string
  ): Promise<boolean> {
    if (!obscuredPassword) {
      Logger.warn(`[DirectSync] No obscured password available for ${config.name}`);
      return false;
    }

    try {
      // Extract relative path from mounted drive
      const drivePart = `${mountedDrive}:\\`;
      if (!localFilePath.toUpperCase().startsWith(drivePart.toUpperCase())) {
        Logger.warn(`[DirectSync] File not on mounted drive: ${localFilePath}`);
        return false;
      }

      const relativePath = localFilePath.substring(drivePart.length).replace(/\\/g, '/');
      const fileName = relativePath.split('/').pop() || '';

      // Build remote path
      const remotePath = config.remotePath
        ? `${config.remotePath.replace(/\/$/, '')}/${relativePath}`
        : `/${relativePath}`;

      // Build rclone remote string with credentials
      let remoteSpec: string;
      if (config.protocol === 'sftp') {
        remoteSpec = `:sftp,host=${config.host},port=${config.port || 22},user=${config.username},pass=${obscuredPassword}:${remotePath}`;
      } else {
        // FTP/FTPS
        const tlsOption = config.protocol === 'ftps'
          ? (config.explicitTls ? ',explicit_tls=true' : ',tls=true')
          : '';
        const certOption = config.ignoreCertErrors ? ',no_check_certificate=true' : '';
        remoteSpec = `:ftp,host=${config.host},port=${config.port || 21},user=${config.username},pass=${obscuredPassword}${tlsOption}${certOption}:${remotePath}`;
      }

      Logger.info(`[DirectSync] Copying ${fileName} to remote...`);

      // Use rclone copyto command directly
      // We read from the mounted drive (which reads from VFS cache) and copy to remote
      const command = `"${this.rclonePath}" copyto "${localFilePath}" "${remoteSpec}" --no-check-certificate -v`;

      const { stdout, stderr } = await execAsync(command, { timeout: 60000 });

      if (stderr && stderr.includes('ERROR')) {
        Logger.warn(`[DirectSync] rclone stderr: ${stderr}`);
        return false;
      }

      Logger.info(`[DirectSync] Successfully copied ${fileName}`);
      return true;
    } catch (error) {
      Logger.error(`[DirectSync] Failed: ${error}`);
      return false;
    }
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
   * Check if a mounted connection is still alive via RC API
   * Returns true if the RC API responds correctly
   */
  async isConnectionAlive(rcPort: number): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`http://localhost:${rcPort}/core/stats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        return true;
      }
      return false;
    } catch (error) {
      // Connection refused or timeout = mount is dead
      Logger.debug(`Connection health check failed on port ${rcPort}: ${error}`);
      return false;
    }
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
