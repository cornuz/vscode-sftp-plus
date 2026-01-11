# Changelog

All notable changes to the SFTP+ extension will be documented in this file.

## [0.1.0] - 2026-01-09

### Added

- Initial release
- Connect/disconnect to FTPS and SFTP servers
- Mount remote filesystems as Windows drives via rclone + WinFsp
- Secure credential storage using VS Code SecretStorage
- TreeView for managing connections in the activity bar
- Status bar indicator showing active connections
- Add Connection wizard with protocol selection
- Auto-connect option for startup
- Prerequisite checker for rclone and WinFsp
- Configurable drive letters
- Support for self-signed certificates (ignoreCertErrors)
- Explicit TLS support for FTPS
- VFS caching for performance
- Keep-alive with configurable idle timeout
