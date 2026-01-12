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

      // Compare modification times
      const localStats = await fs.promises.stat(localFullPath);
      const remoteStats = await fs.promises.stat(trackedFile.fullRemotePath);

      const localMtime = localStats.mtime.getTime();
      const remoteMtime = remoteStats.mtime.getTime();

      // Allow 1 second tolerance for filesystem differences
      const tolerance = 1000;

      if (Math.abs(localMtime - remoteMtime) <= tolerance) {
        return SyncStatus.Synced;
      } else if (remoteMtime > localMtime) {
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
   * Clear cached data (force reload on next access)
   */
  clearCache(): void {
    this._trackingData = null;
  }
}
