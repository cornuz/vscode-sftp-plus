import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { RcloneService } from './rclone.service';
import { PrerequisiteStatus, InstallStatus } from '../models';
import { Logger } from '../utils/logger';

const execAsync = promisify(exec);

/**
 * Checks for required external dependencies (rclone, WinFsp)
 */
export class PrerequisiteChecker implements vscode.Disposable {
  private static readonly WINFSP_PATHS = [
    'C:\\Program Files (x86)\\WinFsp\\bin\\winfsp-x64.dll',
    'C:\\Program Files\\WinFsp\\bin\\winfsp-x64.dll',
  ];

  private _cachedStatus?: PrerequisiteStatus;
  private _onDidChangeStatus = new vscode.EventEmitter<PrerequisiteStatus>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  constructor(private rcloneService: RcloneService) {}

  dispose(): void {
    this._onDidChangeStatus.dispose();
  }

  /**
   * Get cached status (may be undefined if not yet checked)
   */
  get status(): PrerequisiteStatus | undefined {
    return this._cachedStatus;
  }

  /**
   * Check if all prerequisites are installed
   */
  get isReady(): boolean {
    return this._cachedStatus?.rclone.installed === true &&
           this._cachedStatus?.winfsp.installed === true;
  }

  /**
   * Check all prerequisites and cache the result
   */
  async checkAll(): Promise<PrerequisiteStatus> {
    const [rclone, winfsp] = await Promise.all([
      this.checkRclone(),
      this.checkWinFsp(),
    ]);

    this._cachedStatus = { rclone, winfsp };
    this._onDidChangeStatus.fire(this._cachedStatus);

    return this._cachedStatus;
  }

  /**
   * Check if rclone is installed
   */
  async checkRclone(): Promise<InstallStatus> {
    return this.rcloneService.checkInstalled();
  }

  /**
   * Check if WinFsp is installed and get version
   */
  async checkWinFsp(): Promise<InstallStatus> {
    for (const p of PrerequisiteChecker.WINFSP_PATHS) {
      if (fs.existsSync(p)) {
        Logger.debug(`WinFsp found at ${p}`);

        // Get version from DLL file properties
        const version = await this.getWinFspVersion(p);
        return { installed: true, path: p, version };
      }
    }
    Logger.warn('WinFsp not found');
    return { installed: false };
  }

  /**
   * Get WinFsp version from DLL file properties
   */
  private async getWinFspVersion(dllPath: string): Promise<string | undefined> {
    try {
      // Use PowerShell to get FileVersion from DLL (ProductVersion just returns year like "2025")
      const command = `powershell -NoProfile -Command "(Get-Item '${dllPath}').VersionInfo.FileVersion.Split('.')[0..2] -join '.'"`;
      const { stdout } = await execAsync(command, { timeout: 5000 });
      const version = stdout.trim();
      if (version && /^\d/.test(version)) {
        return version;
      }
    } catch {
      Logger.debug('Could not get WinFsp version from file properties');
    }
    return undefined;
  }

  /**
   * Check if winget is available
   */
  private async checkWinget(): Promise<boolean> {
    if (os.platform() !== 'win32') {
      return false;
    }
    try {
      await execAsync('winget --version');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Install rclone via winget
   */
  async installRclone(_context: vscode.ExtensionContext): Promise<boolean> {
    const hasWinget = await this.checkWinget();

    if (!hasWinget) {
      vscode.window.showErrorMessage(
        'SFTP+: winget is required to install rclone automatically.',
        'Open Downloads'
      ).then(action => {
        if (action === 'Open Downloads') {
          vscode.env.openExternal(vscode.Uri.parse('https://rclone.org/downloads/'));
        }
      });
      return false;
    }

    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'SFTP+: Installing rclone via winget...',
      cancellable: false
    }, async (progress) => {
      try {
        progress.report({ message: 'Installing...', increment: 20 });

        // Run winget install
        await execAsync(
          'winget install Rclone.Rclone --accept-source-agreements --accept-package-agreements',
          { timeout: 120000 } // 2 minute timeout
        );

        progress.report({ message: 'Verifying...', increment: 60 });

        // Wait a moment for PATH to update
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Recheck and update status
        await this.checkAll();

        if (this._cachedStatus?.rclone.installed) {
          vscode.window.showInformationMessage(
            `SFTP+: rclone ${this._cachedStatus.rclone.version} installed successfully!`
          );
          return true;
        } else {
          // rclone installed but not in PATH yet - may need terminal restart
          vscode.window.showWarningMessage(
            'SFTP+: rclone installed. Restart VS Code to refresh PATH.',
            'Restart'
          ).then(action => {
            if (action === 'Restart') {
              vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
          });
          return true;
        }

      } catch (error) {
        Logger.error('Failed to install rclone via winget', error);
        vscode.window.showErrorMessage(
          `SFTP+: Failed to install rclone: ${error}`,
          'Open Downloads'
        ).then(action => {
          if (action === 'Open Downloads') {
            vscode.env.openExternal(vscode.Uri.parse('https://rclone.org/downloads/'));
          }
        });
        return false;
      }
    });
  }

  /**
   * Install WinFsp via winget (requires admin)
   */
  async installWinFsp(): Promise<boolean> {
    const hasWinget = await this.checkWinget();

    if (!hasWinget) {
      // Fallback to download page
      await this.downloadWinFsp();
      return false;
    }

    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'SFTP+: Installing WinFsp via winget...',
      cancellable: false
    }, async (progress) => {
      try {
        progress.report({ message: 'Installing (admin required)...', increment: 20 });

        // Run winget install - this will trigger UAC prompt
        await execAsync(
          'winget install WinFsp.WinFsp --accept-source-agreements --accept-package-agreements',
          { timeout: 180000 } // 3 minute timeout
        );

        progress.report({ message: 'Verifying...', increment: 60 });

        // Wait for driver installation
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Recheck and update status
        await this.checkAll();

        if (this._cachedStatus?.winfsp.installed) {
          vscode.window.showInformationMessage('SFTP+: WinFsp installed successfully!');
          return true;
        } else {
          // Driver may need reboot
          vscode.window.showWarningMessage(
            'SFTP+: WinFsp installed. A system reboot may be required.',
            'Reboot Later', 'Recheck'
          ).then(action => {
            if (action === 'Recheck') {
              this.checkAll();
            }
          });
          return true;
        }

      } catch (error) {
        Logger.error('Failed to install WinFsp via winget', error);
        // Fallback to download page
        vscode.window.showErrorMessage(
          `SFTP+: Failed to install WinFsp automatically. Opening download page.`
        );
        await this.downloadWinFsp();
        return false;
      }
    });
  }

  /**
   * Open WinFsp download page (fallback)
   */
  async downloadWinFsp(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse('https://winfsp.dev/rel/'));

    const action = await vscode.window.showInformationMessage(
      'WinFsp download page opened. After installation, click Recheck.',
      'Recheck'
    );

    if (action === 'Recheck') {
      await this.checkAll();
      if (this._cachedStatus?.winfsp.installed) {
        vscode.window.showInformationMessage('SFTP+: WinFsp is now installed!');
      } else {
        vscode.window.showWarningMessage('SFTP+: WinFsp still not detected. A reboot may be required.');
      }
    }
  }

  /**
   * Show installation wizard for missing prerequisites
   */
  async showInstallWizard(): Promise<void> {
    const status = await this.checkAll();
    const missing: string[] = [];

    if (!status.rclone.installed) {
      missing.push('rclone');
    }
    if (!status.winfsp.installed) {
      missing.push('WinFsp');
    }

    if (missing.length === 0) {
      vscode.window.showInformationMessage(
        `SFTP+ Prerequisites OK!\n` +
        `• rclone: ${status.rclone.version}\n` +
        `• WinFsp: installed`
      );
      return;
    }

    const actions: string[] = [];
    if (!status.rclone.installed) {
      actions.push('Install rclone');
    }
    if (!status.winfsp.installed) {
      actions.push('Install WinFsp');
    }
    actions.push('View Documentation');

    const action = await vscode.window.showErrorMessage(
      `SFTP+ requires: ${missing.join(', ')}`,
      ...actions
    );

    switch (action) {
      case 'Install rclone':
        vscode.env.openExternal(vscode.Uri.parse('https://rclone.org/downloads/'));
        vscode.window.showInformationMessage(
          'After installing rclone, run: winget install Rclone.Rclone\n' +
          'Or download from the opened page and add to PATH.'
        );
        break;

      case 'Install WinFsp':
        vscode.env.openExternal(vscode.Uri.parse('https://winfsp.dev/rel/'));
        vscode.window.showInformationMessage(
          'After installing WinFsp, a system reboot may be required.\n' +
          'Or run: winget install WinFsp.WinFsp'
        );
        break;

      case 'View Documentation':
        vscode.env.openExternal(vscode.Uri.parse('https://github.com/NETSQUAD-SA/vscode-sftp-plus#prerequisites'));
        break;
    }
  }
}
