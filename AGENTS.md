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
