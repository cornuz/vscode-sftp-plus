import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';

/**
 * Utilities for maintaining workspace-local Git ignore entries.
 */
export class WorkspaceGitIgnoreUtils {
  private static readonly MANAGED_HEADER = '# SFTP+ workspace-local files';

  /**
   * Ensure the provided patterns are ignored locally for the current Git workspace.
   */
  static async ensurePatterns(workspaceRoot: string, patterns: string[]): Promise<void> {
    try {
      const gitDir = await this.resolveGitDirectory(workspaceRoot);
      if (!gitDir) {
        return;
      }

      const normalizedPatterns = [...new Set(patterns.map(pattern => pattern.trim()).filter(Boolean))];
      if (normalizedPatterns.length === 0) {
        return;
      }

      const infoDir = path.join(gitDir, 'info');
      const excludePath = path.join(infoDir, 'exclude');
      await fs.promises.mkdir(infoDir, { recursive: true });

      let existingContent = '';
      try {
        existingContent = await fs.promises.readFile(excludePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }

      const existingPatterns = new Set(
        existingContent
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line.length > 0 && !line.startsWith('#'))
      );

      const missingPatterns = normalizedPatterns.filter(pattern => !existingPatterns.has(pattern));
      if (missingPatterns.length === 0) {
        return;
      }

      const needsSeparator = existingContent.length > 0 && !existingContent.endsWith('\n') && !existingContent.endsWith('\r\n');
      const blockLines = [
        !existingContent.includes(this.MANAGED_HEADER) ? this.MANAGED_HEADER : undefined,
        ...missingPatterns,
      ].filter((line): line is string => typeof line === 'string');

      const updatedContent = `${existingContent}${needsSeparator ? '\n' : ''}${blockLines.join('\n')}\n`;
      await fs.promises.writeFile(excludePath, updatedContent, 'utf8');
      Logger.info(`Updated Git local excludes at ${excludePath}`);
    } catch (error) {
      Logger.warn(`Failed to update workspace-local Git excludes: ${error}`);
    }
  }

  /**
   * Resolve the effective .git directory for a workspace root.
   */
  private static async resolveGitDirectory(workspaceRoot: string): Promise<string | undefined> {
    const dotGitPath = path.join(workspaceRoot, '.git');
    if (!fs.existsSync(dotGitPath)) {
      return undefined;
    }

    const stat = await fs.promises.stat(dotGitPath);
    if (stat.isDirectory()) {
      return dotGitPath;
    }

    if (!stat.isFile()) {
      return undefined;
    }

    const pointer = await fs.promises.readFile(dotGitPath, 'utf8');
    const match = pointer.match(/^gitdir:\s*(.+)$/im);
    if (!match) {
      return undefined;
    }

    const gitDir = match[1].trim();
    return path.isAbsolute(gitDir) ? gitDir : path.resolve(workspaceRoot, gitDir);
  }
}