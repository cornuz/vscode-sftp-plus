# AGENTS.md

Rules and guidelines for AI agents working on this project.

## Language

- All code comments, documentation, commit messages, and user-facing content **must be in English**.

## Code Style

- Use TypeScript for all source files
- Follow ESLint configuration
- Use meaningful variable and function names
- Add JSDoc comments for public APIs

## Project Structure

- `src/` - TypeScript source files
- `src/commands/` - VS Code command handlers
- `src/models/` - Type definitions and interfaces
- `src/providers/` - TreeView and WebView providers
- `src/services/` - Business logic and external tool integration
- `src/utils/` - Utility functions and helpers
- `resources/` - Icons and static assets
- `dist/` - Compiled JavaScript output

## Commits

- Use conventional commit format: `type(scope): description`
- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

## Publishing

To publish updates to the VS Code Marketplace:

1. Update version in `package.json`
2. Update `CHANGELOG.md` with changes
3. Commit and push to GitHub
4. Package and publish:

```bash
npx @vscode/vsce publish patch   # 0.1.0 → 0.1.1
npx @vscode/vsce publish minor   # 0.1.0 → 0.2.0
npx @vscode/vsce publish major   # 0.1.0 → 1.0.0
```

Or manually:

```bash
npx @vscode/vsce package --no-dependencies
npx @vscode/vsce publish
```

Or upload manually via web:

1. Package the extension: `npx @vscode/vsce package --no-dependencies`
2. Go to https://marketplace.visualstudio.com/manage/publishers/cornuz-design
3. Click on SFTP+ → "Update" → Upload the `.vsix` file

- **Publisher**: `cornuz-design`
- **Marketplace**: https://marketplace.visualstudio.com/items?itemName=cornuz-design.sftp-plus
