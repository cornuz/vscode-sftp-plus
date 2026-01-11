import * as fs from 'fs';
import { promisify } from 'util';
import { exec } from 'child_process';
import { Logger } from './logger';

const execAsync = promisify(exec);

/**
 * Utilities for Windows drive management
 */
export class DriveUtils {
  private static readonly DRIVE_LETTERS = 'ZYXWVUTSRQPONMLKJIHGFEDC'.split('');

  /**
   * Find an available drive letter (starting from Z, going backwards)
   */
  static async findAvailableDrive(): Promise<string | undefined> {
    for (const letter of DriveUtils.DRIVE_LETTERS) {
      const path = `${letter}:\\`;
      const exists = await DriveUtils.driveExists(path);
      if (!exists) {
        Logger.debug(`Found available drive letter: ${letter}`);
        return letter;
      }
    }
    Logger.error('No available drive letters');
    return undefined;
  }

  /**
   * Check if a drive path exists
   */
  static async driveExists(path: string): Promise<boolean> {
    try {
      await fs.promises.access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get list of currently mounted drives
   */
  static async getMountedDrives(): Promise<string[]> {
    try {
      const { stdout } = await execAsync('wmic logicaldisk get name');
      const lines = stdout.split('\n')
        .map(line => line.trim())
        .filter(line => /^[A-Z]:$/.test(line));
      return lines.map(line => line.charAt(0));
    } catch (error) {
      Logger.error('Failed to get mounted drives', error);
      return [];
    }
  }
}
