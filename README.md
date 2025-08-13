# 🐘 Odoo Debugger for VSCode

A powerful VS Code extension designed to help you **manage and debug Odoo projects** efficiently. This tool gives you an interactive and intuitive way to organize Odoo workspaces, projects, custom modules, databases, and debug configurations—all within VSCode.

---

## ✨ Features

### 🚀 Project Management
- **Create and Manage Projects** with custom addons and associated databases.
- Auto-detect and list **repositories** under your custom addons folder.
- One-click **select, delete, and switch projects**.

![Odoo Debugger Demo](./resources/assets/projects.gif)

### 🗃️ Database Management
- Create, restore, and delete **Odoo PostgreSQL databases** tied to a project.
- Automatically attach database dumps and associate with repositories.
- Switch between project databases directly from the sidebar.

![Odoo Debugger Demo](./resources/assets/dbs.gif)

### 🧩 Module Selector
- Easily select and highlight custom Odoo modules.
- Quick integration with debugger setup.

![Odoo Debugger Demo](./resources/assets/modules.gif)

### 📂 Repository Explorer
- List repositories per project.
- Select the primary repo to debug from.

![Odoo Debugger Demo](./resources/assets/repos.gif)

### ⚙️ Workspace Settings
- Configure:
  - Odoo binary path
  - Python interpreter path
  - Addons path
  - Dumps folder
- Quickly edit settings from the UI.

![Odoo Debugger Demo](./resources/assets/settings.gif)

### 🐞 Integrated Debugging
- One-click **Start Odoo Shell** inside the VS Code terminal.
- One-click **Start Odoo Server** using current project settings.
- Auto-refresh debugger when selecting a project, repo, database, or module.

![Odoo Debugger Demo](./resources/assets/shellandserver.gif)

### 🏗️ Code Quality & Architecture
- **Centralized Data Management**: Streamlined data operations with dedicated utility functions
- **Error Handling**: Consistent error handling patterns across all modules
- **Type Safety**: Enhanced TypeScript implementation with proper null checking
- **DRY Principles**: Eliminated code duplication and redundant patterns
- **Maintainable Codebase**: Clean, well-structured code that's easy to extend and modify

---

## 🖼️ Extension Views

This extension adds the following views to the **Activity Bar**:

- 🔹 `Project Selector`  
- 🔹 `Repository Selector`  
- 🔹 `Database Selector`  
- 🔹 `Module Selector`  
- 🔹 `Workspace Settings`

Each view comes with context menu actions and buttons for creation, selection, and management.

---

## 🛠️ Requirements

- Node.js
- Python (typically ≥ 3.8)
- PostgreSQL with access rights
- Odoo compatible projects
- `odoo-bin` available in your workspace
- `pg_dump` and `createdb` available in PATH for database management

---

## 🧪 Commands

The extension registers the following VSCode commands:

| Command | Description |
|--------|-------------|
| `projectSelector.create` | Create a new project with optional database |
| `projectSelector.selectProject` | Switch active project |
| `projectSelector.delete` | Delete a project |
| `repoSelector.selectRepo` | Select repository for debugging |
| `dbSelector.create` | Create a new database |
| `dbSelector.selectDb` | Switch database |
| `dbSelector.delete` | Delete a database |
| `dbSelector.restore` | Restore database from dump |
| `moduleSelector.select` | Select a custom module |
| `workspaceSettings.editSetting` | Edit workspace settings |
| `workspaceSettings.startShell` | Launch Odoo shell in terminal |
| `workspaceSettings.startServer` | Start Odoo server in terminal |

---

## 📁 Configuration

All settings and metadata are stored in the `.vscode/odoo-debugger-data.json` file in your workspace.

---

## 🔧 Development & Architecture

### Recent Improvements
- **Code Consolidation**: Merged `common.ts` and `dataHelpers.ts` into unified `utils.ts`
- **Comment Preservation**: JSON files now preserve comments during saves using `jsonc-parser`
- **Path Normalization**: Consistent handling of absolute/relative paths across the extension
- **Enhanced Error Handling**: Consistent error handling patterns with proper TypeScript types
- **Improved Maintainability**: Single source of truth for all utility functions and data operations
- **Type Safety**: Fixed all TypeScript compilation errors and enhanced null checking

### Technical Stack
- **Frontend**: VS Code Extension API
- **Language**: TypeScript with strict type checking
- **Build System**: Webpack for bundling
- **JSON Handling**: `jsonc-parser` for comment preservation in JSON files
- **Testing**: VS Code Extension Test Runner
- **CI/CD**: GitHub Actions for automated building and releases
- **Architecture**: Modular design with centralized utilities

### Project Structure
```
src/
├── extension.ts           # Main extension entry point
├── utils.ts              # Centralized utilities and data operations
├── models/               # TypeScript interfaces and classes
│   ├── project.ts
│   ├── db.ts
│   ├── repo.ts
│   ├── module.ts
│   └── settings.ts
├── project.ts            # Project management tree provider
├── dbs.ts               # Database management tree provider
├── repos.ts             # Repository management tree provider
├── module.ts            # Module selection tree provider
├── settings.ts          # Settings tree provider
├── debugger.ts          # Debug configuration management
├── odooInstaller.ts     # Odoo setup utilities
│   └── settings.ts
├── debugger.ts          # VS Code debugging configuration
├── dbs.ts              # Database operations tree provider
├── repos.ts            # Repository operations tree provider
├── project.ts          # Project operations tree provider
├── settings.ts         # Settings tree provider
├── module.ts           # Module operations tree provider
├── settingsStore.ts    # Settings storage management
└── odooInstaller.ts    # Odoo installation utilities
```

For detailed information about the recent refactoring, see [REFACTORING_SUMMARY.md](./REFACTORING_SUMMARY.md).

### Contributing Guidelines
The codebase follows clean architecture principles:
- **Data Layer**: `src/utils.ts` handles all utility functions and data operations
- **Models**: `src/models/` contains TypeScript interfaces and classes
- **Views**: Tree providers in individual files (e.g., `src/project.ts`, `src/dbs.ts`)
- **Commands**: Centralized in `src/extension.ts`

When adding new features:
1. Use `SettingsStore.getSelectedProject()` for project operations
2. Use `SettingsStore.load()` and `SettingsStore.saveWithComments()` for data persistence
3. Use `saveToFileWithComments()` for JSON file operations that should preserve comments
4. Follow the established error handling patterns
4. Maintain TypeScript strict type checking

---

## � Automated Releases

The project uses GitHub Actions for automated building and releasing:

- **CI/CD Pipeline**: Automatically builds and tests on every push
- **Version Detection**: Monitors `package.json` for version changes  
- **Automated Releases**: Creates GitHub releases with VSIX packages

### Creating a Release
1. Use the "Version Bump" GitHub Action workflow
2. Select version type (patch/minor/major)
3. The system automatically:
   - Updates `package.json` and `CHANGELOG.md`
   - Creates a GitHub release
   - Builds and attaches the VSIX file

See [`.github/README.md`](./.github/README.md) for detailed CI/CD documentation.

---

## 🚀 Future Features

Planned enhancements:
- Database dump management from shell
- Module scaffolding tools
- Enhanced database functionality
- Auto-restart server when configuration changes

---

## ⚠️ Known Issues
- Duplicate project names cause issues
