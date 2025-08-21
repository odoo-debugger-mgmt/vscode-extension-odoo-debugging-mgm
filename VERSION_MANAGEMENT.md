# Version Management System

The Odoo VS Code extension now includes a comprehensive version management system that allows you to create and switch between different Odoo configurations as "versions".

## 🎯 Overview

The version system acts like profiles for different Odoo environments. Each version can have its own settings for:
- Port numbers
- Python/Odoo paths  
- Development parameters
- Database configurations
- And all other Odoo-specific settings

## 🚀 Getting Started

### Creating Your First Version

1. **Via Sidebar**: 
   - Open the Odoo Tools sidebar
   - Navigate to the "Versions" section
   - Click the "+" icon to create a new version

2. **Via Command Palette**:
   - Press `Ctrl+Shift+P` (`Cmd+Shift+P` on Mac)
   - Type "Odoo: Manage Versions"
   - Select "Create New Version"

### Switching Between Versions

1. **Via Sidebar**: Click on any version in the Versions tree to make it active
2. **Via Command**: Use "Odoo: Set Active Version" from Command Palette

## ⚙️ VS Code Settings Integration

### How It Works

The version system provides a clean VS Code settings experience:

1. **Version Management**: All versions are stored in `odoo.availableVersions` (managed internally)
2. **Active Version**: The current version is shown in `odoo.activeVersionName` 
3. **Current Settings**: All settings for the active version appear as flat `odoo.*` settings

### Editing Settings

When you open VS Code Settings (`Ctrl+,`) and search for "Odoo", you'll see two sections:

#### 1. Odoo - Version Management
- **Active Version**: Shows which version is currently selected
- **Version storage**: Internal data (managed by the extension)

#### 2. Odoo - Current Version Settings  
- **All Odoo settings**: Port numbers, paths, parameters, etc.
- **Live editing**: Changes immediately apply to the active version
- **Type validation**: Proper input validation for numbers, paths, etc.

### Settings Categories

**Server Configuration:**
- `odoo.portNumber`: Main Odoo server port
- `odoo.shellPortNumber`: Odoo shell port
- `odoo.debuggerName`: Debug configuration name

**Performance Settings:**
- `odoo.limitTimeReal`: Real time limit in seconds  
- `odoo.limitTimeCpu`: CPU time limit in seconds
- `odoo.maxCronThreads`: Maximum cron threads

**Development Options:**
- `odoo.devMode`: Development mode parameters
- `odoo.extraParams`: Additional Odoo parameters
- `odoo.installApps`: Apps to install on startup
- `odoo.upgradeApps`: Apps to upgrade on startup

**Path Configuration:**
- `odoo.odooPath`: Path to Odoo source code
- `odoo.enterprisePath`: Path to Odoo Enterprise
- `odoo.customAddonsPath`: Path to custom addons
- `odoo.pythonPath`: Python executable path
- `odoo.dumpsFolder`: Database dumps location

## 🔄 Automatic Synchronization

The extension automatically keeps settings synchronized:

1. **When switching versions**: Active version settings populate VS Code settings
2. **When editing in VS Code**: Changes are saved back to the active version
3. **Real-time updates**: UI reflects changes immediately

## 💡 Usage Patterns

### Development Workflow

```
Production (v17.0)     Development (v17.0-dev)     Testing (v16.0)
├─ Port: 8017          ├─ Port: 8018              ├─ Port: 8016
├─ No dev mode         ├─ --dev=all               ├─ --dev=xml
├─ Enterprise path     ├─ Custom addons path     ├─ Basic setup
└─ Live database       └─ Test database          └─ Test database
```

### Multi-Client Setup

```
Client A (v17.0)       Client B (v16.0)           Internal (master)
├─ Port: 8100          ├─ Port: 8200              ├─ Port: 8000
├─ Client addons       ├─ Legacy version          ├─ Latest features
├─ Production data     ├─ Client-specific setup  ├─ Development mode
└─ Specific modules    └─ Old dependencies       └─ Experimental
```

## 🛠️ Advanced Features

### Command Palette Integration

All version management is available through commands:
- `Odoo: Manage Versions` - Quick access to all version actions
- `Odoo: Create Version` - Create new version
- `Odoo: Set Active Version` - Switch versions
- `Odoo: Clone Version` - Duplicate existing version
- `Odoo: Delete Version` - Remove version
- `Odoo: Sync Settings` - Manual sync from VS Code settings

### Version Cloning

Clone existing versions to create similar configurations:
1. Right-click on any version in the sidebar
2. Select "Clone Version"
3. Enter a new name
4. Modify settings as needed

### Context Menus

Right-click on versions for quick actions:
- **Set Active** (⭐): Make this version active
- **Clone**: Create a copy
- **Delete**: Remove version (with safety checks)

## 🔒 Data Safety

### Protections
- Cannot delete the last remaining version
- Cannot delete the currently active version  
- Confirmation dialogs for destructive operations
- All data stored in VS Code workspace settings

### Backup & Restore
Since all data is in VS Code settings, you can:
- Export workspace settings to backup versions
- Share version configurations between team members
- Version control your settings with your project

## 🎛️ Migration from Legacy Settings

If you're upgrading from an older version:
1. Your existing settings will be migrated to a "Default Version"
2. All functionality remains the same
3. You can create additional versions as needed
4. Legacy settings are preserved

## 📝 Tips & Best Practices

### Naming Conventions
- Use descriptive names: "Production v17.0", "Development", "Client XYZ"
- Include version numbers: "v17.0", "v16.0", "master"
- Add environment info: "staging", "prod", "dev"

### Port Management
- Version-based ports are auto-calculated (17.0 → 8017, 16.0 → 8016)
- Customize ports to avoid conflicts
- Use consistent port ranges for different purposes

### Team Collaboration
- Document version purposes in names
- Share workspace settings for consistent team setup
- Use version control for settings files
- Create standard versions for common scenarios

## 🐛 Troubleshooting

### Settings Not Syncing
1. Use "Odoo: Sync Settings" command
2. Check active version in sidebar
3. Refresh VS Code settings

### Version Not Switching  
1. Check Versions sidebar for active indicator (⭐)
2. Try manual refresh with "Odoo: Refresh Versions"
3. Verify version exists in settings

### Lost Configurations
1. Check `odoo.availableVersions` in settings
2. Export/import workspace settings as backup
3. Recreate versions if needed

For more help, check the extension's GitHub issues or create a new issue with your specific problem.
