import * as vscode from 'vscode';
import { Logger } from '../utils/logger';

/**
 * Manages secure credential storage using VS Code SecretStorage
 */
export class CredentialManager {
  private static readonly KEY_PREFIX = 'sftp-plus.password.';

  constructor(private secretStorage: vscode.SecretStorage) {}

  /**
   * Store password securely
   */
  async storePassword(connectionName: string, password: string): Promise<void> {
    const key = this.getKey(connectionName);
    await this.secretStorage.store(key, password);
    Logger.debug(`Stored password for ${connectionName}`);
  }

  /**
   * Retrieve password from secure storage
   */
  async getPassword(connectionName: string): Promise<string | undefined> {
    const key = this.getKey(connectionName);
    return this.secretStorage.get(key);
  }

  /**
   * Delete password from secure storage
   */
  async deletePassword(connectionName: string): Promise<void> {
    const key = this.getKey(connectionName);
    await this.secretStorage.delete(key);
    Logger.debug(`Deleted password for ${connectionName}`);
  }

  /**
   * Check if password exists
   */
  async hasPassword(connectionName: string): Promise<boolean> {
    const password = await this.getPassword(connectionName);
    return password !== undefined;
  }

  /**
   * Generate storage key from connection name
   */
  private getKey(connectionName: string): string {
    return CredentialManager.KEY_PREFIX + connectionName;
  }
}
