import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TrackedFile, SyncStatus } from '../models';
import { Logger } from '../utils/logger';

/**
 * Tracking data stored in .sftp-plus/tracking.json
 * Grouped by connection name for drive-letter independence
 */
interface TrackingData {
  version: number;
  connections: {
    [connectionName: string]: {
      trackedFiles: TrackedFile[];
    };
  };
}

/**
 * Extended tracked file with connection context for internal use
 */
export interface TrackedFileWithContext extends TrackedFile {
  connectionName: string;
  fullRemotePath: string; // Computed with current drive letter
}

/**
 * Service for managing tracked files between remote and local
 */
export class TrackingService {
  private static readonly TRACKING_FOLDER = '.sftp-plus';
  private static readonly ORIGINALS_FOLDER = 'originals';
  private static readonly TRACKING_FILE = 'tracking.json';
  private static readonly DATA_VERSION = 2;

  private _trackingData: TrackingData | null = null;

  constructor() {}

  /**
   * Get the workspace root path
   */
  private _getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
  }

  /**
   * Get the tracking folder path
   */
  private _getTrackingFolderPath(): string | undefined {
    const root = this._getWorkspaceRoot();
    return root ? path.join(root, TrackingService.TRACKING_FOLDER) : undefined;
  }

  /**
   * Get the tracking file path
   */
  private _getTrackingFilePath(): string | undefined {
    const folder = this._getTrackingFolderPath();
    return folder ? path.join(folder, TrackingService.TRACKING_FILE) : undefined;
  }

  /**
   * Ensure tracking folder exists
   */
  private async _ensureTrackingFolder(): Promise<string | undefined> {
    const folderPath = this._getTrackingFolderPath();
    if (!folderPath) return undefined;

    try {
      await fs.promises.mkdir(folderPath, { recursive: true });
      return folderPath;
    } catch (error) {
      Logger.error('Failed to create tracking folder:', error);
      return undefined;
    }
  }

  /**
   * Load tracking data from file
   */
  async loadTrackingData(): Promise<TrackingData> {
    if (this._trackingData) return this._trackingData;

    const filePath = this._getTrackingFilePath();
    if (!filePath) {
      return { version: TrackingService.DATA_VERSION, connections: {} };
    }

    try {
      if (fs.existsSync(filePath)) {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const data = JSON.parse(content);

        // Migrate from v1 format (flat array) to v2 (grouped by connection)
        if (data.trackedFiles && !data.connections) {
          this._trackingData = this._migrateFromV1(data);
          // Save migrated data
          await this.saveTrackingData(this._trackingData);
        } else {
          this._trackingData = data;
        }
        return this._trackingData!;
      }
    } catch (error) {
      Logger.error('Failed to load tracking data:', error);
    }

    return { version: TrackingService.DATA_VERSION, connections: {} };
  }

  /**
   * Migrate from v1 format (flat array) to v2 (grouped by connection)
   */
  private _migrateFromV1(oldData: { trackedFiles: Array<{ remotePath: string; localPath: string; connectionName: string }> }): TrackingData {
    const newData: TrackingData = { version: TrackingService.DATA_VERSION, connections: {} };

    for (const file of oldData.trackedFiles) {
      const connName = file.connectionName;
      if (!newData.connections[connName]) {
        newData.connections[connName] = { trackedFiles: [] };
      }

      // Convert absolute path to relative (remove drive letter like "Z:\")
      let relativePath = file.remotePath;
      if (/^[A-Z]:\\/i.test(relativePath)) {
        relativePath = relativePath.substring(3).replace(/\\/g, '/');
      }

      // Also clean up local path to use forward slashes
      const localPath = file.localPath.replace(/\\/g, '/');

      newData.connections[connName].trackedFiles.push({
        remotePath: relativePath,
        localPath,
      });
    }

    return newData;
  }

  /**
   * Save tracking data to file
   */
  async saveTrackingData(data: TrackingData): Promise<boolean> {
    await this._ensureTrackingFolder();
    const filePath = this._getTrackingFilePath();
    if (!filePath) return false;

    try {
      await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
      this._trackingData = data;
      return true;
    } catch (error) {
      Logger.error('Failed to save tracking data:', error);
      return false;
    }
  }

  /**
   * Extract relative path from full remote path (remove drive letter)
   */
  private _getRelativePath(fullPath: string): string {
    // Remove drive letter (e.g., "Z:\folder\file.txt" -> "folder/file.txt")
    if (/^[A-Z]:\\/i.test(fullPath)) {
      return fullPath.substring(3).replace(/\\/g, '/');
    }
    return fullPath.replace(/\\/g, '/');
  }

  /**
   * Build full remote path from relative path and drive letter
   */
  private _getFullRemotePath(relativePath: string, driveLetter: string): string {
    return `${driveLetter}:\\${relativePath.replace(/\//g, '\\')}`;
  }

  /**
   * Track a file
   */
  async trackFile(fullRemotePath: string, connectionName: string): Promise<boolean> {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('No workspace folder open. Cannot track files.');
      return false;
    }

    const data = await this.loadTrackingData();
    const relativePath = this._getRelativePath(fullRemotePath);

    // Initialize connection if needed
    if (!data.connections[connectionName]) {
      data.connections[connectionName] = { trackedFiles: [] };
    }

    // Check if already tracked
    const existing = data.connections[connectionName].trackedFiles.find(f => f.remotePath === relativePath);
    if (existing) {
      vscode.window.showInformationMessage(`File is already tracked: ${path.basename(fullRemotePath)}`);
      return false;
    }

    // Calculate local path: .sftp-plus/[connection]/[relative-path]
    const localPath = `.sftp-plus/${connectionName}/${relativePath}`;

    const trackedFile: TrackedFile = {
      remotePath: relativePath,
      localPath,
    };

    data.connections[connectionName].trackedFiles.push(trackedFile);
    const success = await this.saveTrackingData(data);

    if (success) {
      vscode.window.showInformationMessage(`Now tracking: ${path.basename(fullRemotePath)}`);
    }

    return success;
  }

  /**
   * Untrack a file
   */
  async untrackFile(fullRemotePath: string, connectionName: string): Promise<boolean> {
    const data = await this.loadTrackingData();
    const relativePath = this._getRelativePath(fullRemotePath);

    if (!data.connections[connectionName]) {
      return false;
    }

    const files = data.connections[connectionName].trackedFiles;
    const index = files.findIndex(f => f.remotePath === relativePath);

    if (index === -1) {
      return false;
    }

    const fileName = path.basename(fullRemotePath);
    files.splice(index, 1);

    // Clean up empty connection
    if (files.length === 0) {
      delete data.connections[connectionName];
    }

    const success = await this.saveTrackingData(data);

    if (success) {
      vscode.window.showInformationMessage(`Stopped tracking: ${fileName}`);
    }

    return success;
  }

  /**
   * Check if a file is tracked
   */
  async isTracked(fullRemotePath: string, connectionName: string): Promise<boolean> {
    const data = await this.loadTrackingData();
    const relativePath = this._getRelativePath(fullRemotePath);

    if (!data.connections[connectionName]) {
      return false;
    }

    return data.connections[connectionName].trackedFiles.some(f => f.remotePath === relativePath);
  }

  /**
   * Get all tracked files for a connection with full paths
   */
  async getTrackedFilesForConnection(connectionName: string, driveLetter: string): Promise<TrackedFileWithContext[]> {
    const data = await this.loadTrackingData();

    if (!data.connections[connectionName]) {
      return [];
    }

    return data.connections[connectionName].trackedFiles.map(f => ({
      ...f,
      connectionName,
      fullRemotePath: this._getFullRemotePath(f.remotePath, driveLetter),
    }));
  }

  /**
   * Get sync status for a tracked file (calculated dynamically)
   */
  async getSyncStatus(trackedFile: TrackedFileWithContext): Promise<SyncStatus> {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) return SyncStatus.Error;

    const localFullPath = path.join(workspaceRoot, trackedFile.localPath);

    try {
      // Check if local file exists
      if (!fs.existsSync(localFullPath)) {
        return SyncStatus.NotDownloaded;
      }

      // Check if remote file exists (on mounted drive)
      if (!fs.existsSync(trackedFile.fullRemotePath)) {
        return SyncStatus.Error;
      }

      // Compare by file size first, then by date if sizes differ
      const localStats = await fs.promises.stat(localFullPath);
      const remoteStats = await fs.promises.stat(trackedFile.fullRemotePath);

      const localSize = localStats.size;
      const remoteSize = remoteStats.size;

      if (localSize === remoteSize) {
        // Same size = consider as synced (content is identical)
        return SyncStatus.Synced;
      }

      // Different sizes = compare modification times to determine which is newer
      const localMtime = localStats.mtime.getTime();
      const remoteMtime = remoteStats.mtime.getTime();

      if (remoteMtime > localMtime) {
        return SyncStatus.RemoteNewer;
      } else {
        return SyncStatus.LocalNewer;
      }
    } catch (error) {
      Logger.error('Failed to get sync status:', error);
      return SyncStatus.Error;
    }
  }

  /**
   * Download a tracked file from remote to local
   */
  async downloadTrackedFile(trackedFile: TrackedFileWithContext): Promise<boolean> {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) return false;

    const localFullPath = path.join(workspaceRoot, trackedFile.localPath);

    try {
      // Ensure directory exists
      await fs.promises.mkdir(path.dirname(localFullPath), { recursive: true });

      // Copy from remote (mounted drive) to local
      await fs.promises.copyFile(trackedFile.fullRemotePath, localFullPath);

      vscode.window.showInformationMessage(`Downloaded: ${path.basename(trackedFile.localPath)}`);
      return true;
    } catch (error) {
      Logger.error('Failed to download tracked file:', error);
      vscode.window.showErrorMessage(`Failed to download: ${error}`);
      return false;
    }
  }

  /**
   * Upload a tracked file from local to remote
   */
  async uploadTrackedFile(trackedFile: TrackedFileWithContext): Promise<boolean> {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) return false;

    const localFullPath = path.join(workspaceRoot, trackedFile.localPath);

    try {
      // Copy from local to remote (mounted drive)
      await fs.promises.copyFile(localFullPath, trackedFile.fullRemotePath);

      vscode.window.showInformationMessage(`Uploaded: ${path.basename(trackedFile.localPath)}`);
      return true;
    } catch (error) {
      Logger.error('Failed to upload tracked file:', error);
      vscode.window.showErrorMessage(`Failed to upload: ${error}`);
      return false;
    }
  }

  /**
   * Get the originals folder path for a connection
   */
  private _getOriginalsFolderPath(connectionName: string): string | undefined {
    const root = this._getWorkspaceRoot();
    return root
      ? path.join(root, TrackingService.TRACKING_FOLDER, TrackingService.ORIGINALS_FOLDER, connectionName)
      : undefined;
  }

  /**
   * Get the original backup path for a specific file
   */
  getOriginalPath(connectionName: string, relativePath: string): string | undefined {
    const root = this._getWorkspaceRoot();
    if (!root) return undefined;
    return path.join(
      root,
      TrackingService.TRACKING_FOLDER,
      TrackingService.ORIGINALS_FOLDER,
      connectionName,
      relativePath.replace(/\//g, path.sep)
    );
  }

  /**
   * Backup the original server version of a file before any modification.
   * Only creates the backup if it does NOT already exist (immutable snapshot).
   * Copies from the mounted drive (remote server) to .sftp-plus/originals/{connection}/{path}.
   *
   * @returns The path to the original backup, or null if backup failed
   */
  async backupOriginal(
    connectionName: string,
    remotePath: string,
    driveLetter: string
  ): Promise<string | null> {
    const originalsFolder = this._getOriginalsFolderPath(connectionName);
    if (!originalsFolder) {
      Logger.error('Cannot backup original: no workspace root');
      return null;
    }

    // Clean remote path (remove leading slashes, normalize separators)
    const cleanPath = remotePath.replace(/^\/+/, '').replace(/\\/g, '/');
    const originalFilePath = path.join(originalsFolder, cleanPath.replace(/\//g, path.sep));

    // Immutable: if backup already exists, return existing path
    if (fs.existsSync(originalFilePath)) {
      Logger.info(`Original backup already exists: ${originalFilePath}`);
      return originalFilePath;
    }

    // Build full remote path on mounted drive
    const fullRemotePath = `${driveLetter}:\\${cleanPath.replace(/\//g, '\\')}`;

    try {
      // Check if remote file exists
      if (!fs.existsSync(fullRemotePath)) {
        Logger.warn(`Cannot backup original: remote file not found: ${fullRemotePath}`);
        return null;
      }

      // Ensure directory exists
      await fs.promises.mkdir(path.dirname(originalFilePath), { recursive: true });

      // Copy from server (mounted drive) to originals folder
      await fs.promises.copyFile(fullRemotePath, originalFilePath);

      Logger.info(`Original backup created: ${originalFilePath} (from ${fullRemotePath})`);
      return originalFilePath;
    } catch (error) {
      Logger.error(`Failed to backup original for ${cleanPath}:`, error);
      return null;
    }
  }

  /**
   * Check if an original backup exists for a file
   */
  hasOriginal(connectionName: string, remotePath: string): boolean {
    const originalPath = this.getOriginalPath(connectionName, remotePath.replace(/^\/+/, ''));
    return originalPath ? fs.existsSync(originalPath) : false;
  }

  /**
   * Restore the original backup to the local working copy.
   * Does NOT delete the original (it stays as reference).
   *
   * @returns true if restored successfully
   */
  async restoreOriginal(connectionName: string, remotePath: string): Promise<boolean> {
    const root = this._getWorkspaceRoot();
    if (!root) return false;

    const cleanPath = remotePath.replace(/^\/+/, '').replace(/\\/g, '/');
    const originalPath = this.getOriginalPath(connectionName, cleanPath);
    if (!originalPath || !fs.existsSync(originalPath)) {
      Logger.warn(`No original backup to restore for ${connectionName}/${cleanPath}`);
      return false;
    }

    // Target = local working copy (.sftp-plus/{connection}/{path})
    const localCopyPath = path.join(root, `.sftp-plus/${connectionName}/${cleanPath}`);

    try {
      await fs.promises.mkdir(path.dirname(localCopyPath), { recursive: true });
      await fs.promises.copyFile(originalPath, localCopyPath);
      Logger.info(`Restored original to working copy: ${localCopyPath}`);
      return true;
    } catch (error) {
      Logger.error(`Failed to restore original for ${cleanPath}:`, error);
      return false;
    }
  }

  /**
   * Get detailed sync status for all tracked files of a connection.
   * Returns structured data suitable for MCP tool output.
   */
  async getDetailedSyncStatus(
    connectionName: string,
    driveLetter: string
  ): Promise<Array<{
    remotePath: string;
    localPath: string;
    status: SyncStatus;
    hasOriginal: boolean;
    originalPath?: string;
    localSize?: number;
    remoteSize?: number;
    originalSize?: number;
    localModified?: string;
    remoteModified?: string;
  }>> {
    const root = this._getWorkspaceRoot();
    if (!root) return [];

    const trackedFiles = await this.getTrackedFilesForConnection(connectionName, driveLetter);
    const results: Array<{
      remotePath: string;
      localPath: string;
      status: SyncStatus;
      hasOriginal: boolean;
      originalPath?: string;
      localSize?: number;
      remoteSize?: number;
      originalSize?: number;
      localModified?: string;
      remoteModified?: string;
    }> = [];

    for (const tracked of trackedFiles) {
      const status = await this.getSyncStatus(tracked);
      const cleanPath = tracked.remotePath.replace(/^\/+/, '');
      const originalBackupExists = this.hasOriginal(connectionName, cleanPath);
      const originalPath = originalBackupExists
        ? this.getOriginalPath(connectionName, cleanPath)
        : undefined;

      const entry: typeof results[0] = {
        remotePath: tracked.remotePath,
        localPath: tracked.localPath,
        status,
        hasOriginal: originalBackupExists,
        originalPath: originalPath ? path.relative(root, originalPath).replace(/\\/g, '/') : undefined,
      };

      // Get file stats
      const localFullPath = path.join(root, tracked.localPath);
      try {
        if (fs.existsSync(localFullPath)) {
          const localStats = await fs.promises.stat(localFullPath);
          entry.localSize = localStats.size;
          entry.localModified = localStats.mtime.toISOString();
        }
      } catch { /* skip */ }

      try {
        if (fs.existsSync(tracked.fullRemotePath)) {
          const remoteStats = await fs.promises.stat(tracked.fullRemotePath);
          entry.remoteSize = remoteStats.size;
          entry.remoteModified = remoteStats.mtime.toISOString();
        }
      } catch { /* skip */ }

      if (originalPath) {
        try {
          if (fs.existsSync(originalPath)) {
            const origStats = await fs.promises.stat(originalPath);
            entry.originalSize = origStats.size;
          }
        } catch { /* skip */ }
      }

      results.push(entry);
    }

    return results;
  }

  /**
   * Clear cached data (force reload on next access)
   */
  clearCache(): void {
    this._trackingData = null;
  }

  /**
   * Auto-scan local .sftp-plus folders and sync tracking data
   * This scans all files in .sftp-plus/[connection]/ folders and updates tracking.json
   */
  async autoScanLocalFiles(): Promise<void> {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) return;

    const sftpPlusFolder = path.join(workspaceRoot, TrackingService.TRACKING_FOLDER);

    // Check if .sftp-plus folder exists
    if (!fs.existsSync(sftpPlusFolder)) {
      Logger.info('No .sftp-plus folder found, skipping auto-scan');
      return;
    }

    Logger.info('Auto-scanning local .sftp-plus files...');

    const data = await this.loadTrackingData();
    let changed = false;

    try {
      // Get all connection folders (subdirectories of .sftp-plus, excluding tracking.json)
      const entries = await fs.promises.readdir(sftpPlusFolder, { withFileTypes: true });
      const connectionFolders = entries.filter(e => e.isDirectory());

      for (const connFolder of connectionFolders) {
        const connectionName = connFolder.name;
        const connectionPath = path.join(sftpPlusFolder, connectionName);

        // Initialize connection if needed
        if (!data.connections[connectionName]) {
          data.connections[connectionName] = { trackedFiles: [] };
        }

        // Get all files recursively in this connection folder
        const localFiles = await this._scanDirectoryRecursive(connectionPath, '');

        // Create a set of currently tracked paths for this connection
        const trackedPaths = new Set(data.connections[connectionName].trackedFiles.map(f => f.remotePath));

        // Add new files that aren't tracked yet
        for (const relativePath of localFiles) {
          if (!trackedPaths.has(relativePath)) {
            const localPath = `.sftp-plus/${connectionName}/${relativePath}`;
            data.connections[connectionName].trackedFiles.push({
              remotePath: relativePath,
              localPath,
            });
            changed = true;
            Logger.info(`Auto-tracked: ${connectionName}/${relativePath}`);
          }
        }

        // Remove tracked files that no longer exist locally
        const localFileSet = new Set(localFiles);
        const filesToRemove = data.connections[connectionName].trackedFiles.filter(
          f => !localFileSet.has(f.remotePath)
        );

        if (filesToRemove.length > 0) {
          data.connections[connectionName].trackedFiles = data.connections[connectionName].trackedFiles.filter(
            f => localFileSet.has(f.remotePath)
          );
          changed = true;
          for (const f of filesToRemove) {
            Logger.info(`Auto-untracked (file deleted): ${connectionName}/${f.remotePath}`);
          }
        }

        // Clean up empty connections
        if (data.connections[connectionName].trackedFiles.length === 0) {
          delete data.connections[connectionName];
          changed = true;
        }
      }

      // Save if changed
      if (changed) {
        await this.saveTrackingData(data);
        Logger.info('Tracking data updated from auto-scan');
      } else {
        Logger.info('No changes detected during auto-scan');
      }
    } catch (error) {
      Logger.error('Error during auto-scan:', error);
    }
  }

  /**
   * Recursively scan a directory and return all file paths (relative to the base)
   */
  private async _scanDirectoryRecursive(dirPath: string, relativePath: string): Promise<string[]> {
    const results: string[] = [];

    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          // Recurse into subdirectory
          const subFiles = await this._scanDirectoryRecursive(fullPath, entryRelativePath);
          results.push(...subFiles);
        } else if (entry.isFile()) {
          results.push(entryRelativePath);
        }
      }
    } catch (error) {
      Logger.error(`Error scanning directory ${dirPath}:`, error);
    }

    return results;
  }
}
