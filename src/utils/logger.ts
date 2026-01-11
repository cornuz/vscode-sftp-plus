import * as vscode from 'vscode';

/**
 * Log levels
 */
export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
}

/**
 * Simple logger with configurable level
 */
export class Logger {
  private static outputChannel: vscode.OutputChannel | undefined;
  private static level: LogLevel = LogLevel.Info;

  /**
   * Initialize logger (call on extension activation)
   */
  static initialize(): void {
    if (!Logger.outputChannel) {
      Logger.outputChannel = vscode.window.createOutputChannel('SFTP+');
    }

    // Get configured level
    const config = vscode.workspace.getConfiguration('sftp-plus');
    const levelStr = config.get<string>('logLevel', 'info');
    Logger.level = Logger.parseLevel(levelStr);
  }

  private static parseLevel(level: string): LogLevel {
    switch (level.toLowerCase()) {
      case 'debug': return LogLevel.Debug;
      case 'info': return LogLevel.Info;
      case 'warn': return LogLevel.Warn;
      case 'error': return LogLevel.Error;
      default: return LogLevel.Info;
    }
  }

  private static log(level: LogLevel, prefix: string, message: string, error?: unknown): void {
    if (level < Logger.level) {
      return;
    }

    if (!Logger.outputChannel) {
      Logger.initialize();
    }

    const timestamp = new Date().toISOString();
    let logMessage = `[${timestamp}] ${prefix} ${message}`;

    if (error) {
      if (error instanceof Error) {
        logMessage += `\n  ${error.message}`;
        if (error.stack) {
          logMessage += `\n  ${error.stack}`;
        }
      } else {
        logMessage += `\n  ${String(error)}`;
      }
    }

    Logger.outputChannel?.appendLine(logMessage);

    // Also log to console in debug mode
    if (level === LogLevel.Debug) {
      console.log(logMessage);
    }
  }

  static debug(message: string): void {
    Logger.log(LogLevel.Debug, '[DEBUG]', message);
  }

  static info(message: string): void {
    Logger.log(LogLevel.Info, '[INFO]', message);
  }

  static warn(message: string): void {
    Logger.log(LogLevel.Warn, '[WARN]', message);
  }

  static error(message: string, error?: unknown): void {
    Logger.log(LogLevel.Error, '[ERROR]', message, error);
  }

  /**
   * Show output channel
   */
  static show(): void {
    Logger.outputChannel?.show();
  }

  /**
   * Dispose output channel
   */
  static dispose(): void {
    Logger.outputChannel?.dispose();
    Logger.outputChannel = undefined;
  }
}
