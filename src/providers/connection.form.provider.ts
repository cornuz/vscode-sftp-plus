import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connection.manager';
import { ConnectionConfig, DEFAULT_CONNECTION_CONFIG, Connection } from '../models';
import { Logger } from '../utils/logger';

/**
 * Provides a webview form for adding/editing connections
 */
export class ConnectionFormProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sftp-plus.connectionForm';

  private _view?: vscode.WebviewView;
  private _editingConnection?: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connectionManager: ConnectionManager
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'save':
          await this._saveConnection(message.config);
          break;
        case 'cancel':
          this._editingConnection = undefined;
          this.showEmpty();
          break;
        case 'testConnection':
          await this._testConnection(message.config);
          break;
      }
    });
  }

  /**
   * Show the form for a new connection
   */
  public showNewForm(): void {
    this._editingConnection = undefined;
    if (this._view) {
      this._view.webview.postMessage({
        command: 'showForm',
        config: DEFAULT_CONNECTION_CONFIG,
        isNew: true,
      });
      this._view.show(true);
    }
  }

  /**
   * Show the form for editing an existing connection
   */
  public showEditForm(connection: Connection): void {
    this._editingConnection = connection.config.name;
    if (this._view) {
      this._view.webview.postMessage({
        command: 'showForm',
        config: connection.config,
        isNew: false,
      });
      this._view.show(true);
    }
  }

  /**
   * Show empty state
   */
  public showEmpty(): void {
    if (this._view) {
      this._view.webview.postMessage({ command: 'showEmpty' });
    }
  }

  private async _saveConnection(config: ConnectionConfig & { password?: string }): Promise<void> {
    try {
      // Extract password before saving config (password not stored in settings)
      const password = config.password;
      delete config.password;

      if (this._editingConnection) {
        // Update existing
        await this.connectionManager.updateConnection(this._editingConnection, config);
        vscode.window.showInformationMessage(`Connection "${config.name}" updated`);
      } else {
        // Add new
        await this.connectionManager.addConnection(config);
        vscode.window.showInformationMessage(`Connection "${config.name}" added`);
      }

      // Store password if provided
      if (password) {
        await this.connectionManager.storePassword(config.name, password);
      }
      this._editingConnection = undefined;
      this.showEmpty();
    } catch (error) {
      Logger.error('Failed to save connection', error);
      vscode.window.showErrorMessage(`Failed to save: ${error}`);
    }
  }

  private async _testConnection(config: ConnectionConfig & { password?: string }): Promise<void> {
    if (this._view) {
      this._view.webview.postMessage({ command: 'testStart' });
    }

    try {
      // Pass the password from the form directly
      const result = await this.connectionManager.testConnection(config, config.password);
      if (this._view) {
        this._view.webview.postMessage({
          command: 'testResult',
          success: result.success,
          message: result.message,
        });
      }
    } catch (error) {
      if (this._view) {
        this._view.webview.postMessage({
          command: 'testResult',
          success: false,
          message: String(error),
        });
      }
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Connection Form</title>
  <style>
    :root {
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border);
      --button-bg: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --button-hover: var(--vscode-button-hoverBackground);
      --button-secondary-bg: var(--vscode-button-secondaryBackground);
      --button-secondary-fg: var(--vscode-button-secondaryForeground);
      --error-fg: var(--vscode-errorForeground);
      --success-fg: var(--vscode-testing-iconPassed);
    }

    * { box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 12px;
      margin: 0;
    }

    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: var(--vscode-descriptionForeground);
    }

    .empty-state p {
      margin: 8px 0;
    }

    .form-container {
      display: none;
    }

    .form-container.visible {
      display: block;
    }

    .form-title {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .form-group {
      margin-bottom: 12px;
    }

    .form-group label {
      display: block;
      margin-bottom: 4px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .form-group input,
    .form-group select {
      width: 100%;
      padding: 6px 8px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border, transparent);
      border-radius: 2px;
      font-size: 13px;
    }

    .form-group input:focus,
    .form-group select:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }

    .form-row {
      display: flex;
      gap: 8px;
    }

    .form-row .form-group {
      flex: 1;
    }

    .form-row .form-group.small {
      flex: 0 0 80px;
    }

    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }

    .checkbox-group input[type="checkbox"] {
      width: auto;
    }

    .checkbox-group label {
      margin: 0;
      font-size: 13px;
      color: var(--vscode-foreground);
    }

    .form-section {
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .form-section-title {
      font-size: 11px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 12px;
    }

    .button-row {
      display: flex;
      gap: 8px;
      margin-top: 20px;
    }

    button {
      padding: 6px 14px;
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: 13px;
    }

    .btn-primary {
      background: var(--button-bg);
      color: var(--button-fg);
    }

    .btn-primary:hover {
      background: var(--button-hover);
    }

    .btn-secondary {
      background: var(--button-secondary-bg);
      color: var(--button-secondary-fg);
    }

    .btn-test {
      margin-left: auto;
    }

    .test-result {
      margin-top: 8px;
      padding: 8px;
      border-radius: 2px;
      font-size: 12px;
    }

    .test-result.success {
      background: rgba(0, 255, 0, 0.1);
      color: var(--success-fg);
    }

    .test-result.error {
      background: rgba(255, 0, 0, 0.1);
      color: var(--error-fg);
    }

    .test-result.loading {
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div id="empty-state" class="empty-state">
    <p>No connection selected</p>
    <p><small>Click + to add a new connection</small></p>
  </div>

  <div id="form-container" class="form-container">
    <div class="form-title" id="form-title">New Connection</div>

    <div class="form-group">
      <label for="name">Connection Name</label>
      <input type="text" id="name" placeholder="My Server" required>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label for="host">Host</label>
        <input type="text" id="host" placeholder="ftp.example.com" required>
      </div>
      <div class="form-group small">
        <label for="port">Port</label>
        <input type="number" id="port" value="21">
      </div>
    </div>

    <div class="form-group">
      <label for="protocol">Protocol</label>
      <select id="protocol">
        <option value="ftps">FTPS (FTP over TLS)</option>
        <option value="ftp">FTP (Plain)</option>
        <option value="sftp">SFTP (SSH)</option>
      </select>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" placeholder="user@example.com">
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" placeholder="••••••••">
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label for="remotePath">Remote Path</label>
        <input type="text" id="remotePath" value="/" placeholder="/">
      </div>
      <div class="form-group small">
        <label for="driveLetter">Drive</label>
        <input type="text" id="driveLetter" placeholder="Z" maxlength="1">
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-title">Options</div>

      <div class="checkbox-group">
        <input type="checkbox" id="explicitTls" checked>
        <label for="explicitTls">Explicit TLS (for FTPS)</label>
      </div>

      <div class="checkbox-group">
        <input type="checkbox" id="ignoreCertErrors">
        <label for="ignoreCertErrors">Ignore certificate errors</label>
      </div>

      <div class="checkbox-group">
        <input type="checkbox" id="autoConnect">
        <label for="autoConnect">Auto-connect on startup</label>
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-title">Performance</div>

      <div class="form-row">
        <div class="form-group">
          <label for="cacheMode">Cache Mode</label>
          <select id="cacheMode">
            <option value="full">Full (recommended)</option>
            <option value="writes">Writes only</option>
            <option value="minimal">Minimal</option>
            <option value="off">Off</option>
          </select>
        </div>
        <div class="form-group">
          <label for="idleTimeout">Idle Timeout</label>
          <input type="text" id="idleTimeout" value="5m" placeholder="5m">
        </div>
      </div>
    </div>

    <div id="test-result" class="test-result" style="display: none;"></div>

    <div class="button-row">
      <button type="button" class="btn-primary" id="btn-save">Save</button>
      <button type="button" class="btn-secondary" id="btn-cancel">Cancel</button>
      <button type="button" class="btn-secondary btn-test" id="btn-test">Test</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const emptyState = document.getElementById('empty-state');
    const formContainer = document.getElementById('form-container');
    const formTitle = document.getElementById('form-title');
    const testResult = document.getElementById('test-result');

    // Form fields
    const fields = {
      name: document.getElementById('name'),
      host: document.getElementById('host'),
      port: document.getElementById('port'),
      protocol: document.getElementById('protocol'),
      username: document.getElementById('username'),
      password: document.getElementById('password'),
      remotePath: document.getElementById('remotePath'),
      driveLetter: document.getElementById('driveLetter'),
      explicitTls: document.getElementById('explicitTls'),
      ignoreCertErrors: document.getElementById('ignoreCertErrors'),
      autoConnect: document.getElementById('autoConnect'),
      cacheMode: document.getElementById('cacheMode'),
      idleTimeout: document.getElementById('idleTimeout'),
    };

    // Update port when protocol changes
    fields.protocol.addEventListener('change', () => {
      const protocol = fields.protocol.value;
      if (protocol === 'sftp') {
        fields.port.value = '22';
      } else {
        fields.port.value = '21';
      }
    });

    // Button handlers
    document.getElementById('btn-save').addEventListener('click', () => {
      const config = getFormData();
      if (validateForm(config)) {
        vscode.postMessage({ command: 'save', config });
      }
    });

    document.getElementById('btn-cancel').addEventListener('click', () => {
      vscode.postMessage({ command: 'cancel' });
    });

    document.getElementById('btn-test').addEventListener('click', () => {
      const config = getFormData();
      if (validateForm(config)) {
        vscode.postMessage({ command: 'testConnection', config });
      }
    });

    function getFormData() {
      return {
        name: fields.name.value.trim(),
        host: fields.host.value.trim(),
        port: parseInt(fields.port.value) || 21,
        protocol: fields.protocol.value,
        username: fields.username.value.trim(),
        password: fields.password.value,
        remotePath: fields.remotePath.value.trim() || '/',
        driveLetter: fields.driveLetter.value.trim().toUpperCase() || undefined,
        explicitTls: fields.explicitTls.checked,
        ignoreCertErrors: fields.ignoreCertErrors.checked,
        autoConnect: fields.autoConnect.checked,
        cacheMode: fields.cacheMode.value,
        idleTimeout: fields.idleTimeout.value.trim() || '5m',
      };
    }

    function validateForm(config) {
      if (!config.name) {
        showError('Connection name is required');
        fields.name.focus();
        return false;
      }
      if (!config.host) {
        showError('Host is required');
        fields.host.focus();
        return false;
      }
      if (!config.username) {
        showError('Username is required');
        fields.username.focus();
        return false;
      }
      return true;
    }

    function showError(message) {
      testResult.textContent = message;
      testResult.className = 'test-result error';
      testResult.style.display = 'block';
    }

    function fillForm(config) {
      fields.name.value = config.name || '';
      fields.host.value = config.host || '';
      fields.port.value = config.port || 21;
      fields.protocol.value = config.protocol || 'ftps';
      fields.username.value = config.username || '';
      fields.password.value = '';  // Never prefill password
      fields.remotePath.value = config.remotePath || '/';
      fields.driveLetter.value = config.driveLetter || '';
      fields.explicitTls.checked = config.explicitTls !== false;
      fields.ignoreCertErrors.checked = config.ignoreCertErrors === true;
      fields.autoConnect.checked = config.autoConnect === true;
      fields.cacheMode.value = config.cacheMode || 'full';
      fields.idleTimeout.value = config.idleTimeout || '5m';
    }

    // Handle messages from extension
    window.addEventListener('message', event => {
      const message = event.data;

      switch (message.command) {
        case 'showForm':
          emptyState.style.display = 'none';
          formContainer.classList.add('visible');
          formTitle.textContent = message.isNew ? 'New Connection' : 'Edit Connection';
          fillForm(message.config);
          testResult.style.display = 'none';
          fields.name.focus();
          break;

        case 'showEmpty':
          emptyState.style.display = 'block';
          formContainer.classList.remove('visible');
          break;

        case 'testStart':
          testResult.textContent = 'Testing connection...';
          testResult.className = 'test-result loading';
          testResult.style.display = 'block';
          break;

        case 'testResult':
          testResult.textContent = message.message;
          testResult.className = 'test-result ' + (message.success ? 'success' : 'error');
          testResult.style.display = 'block';
          break;
      }
    });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
