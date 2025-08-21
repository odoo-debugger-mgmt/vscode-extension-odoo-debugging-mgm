import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { VersionModel } from './models/version';
import { SettingsStore } from './settingsStore';
import { SettingsModel } from './models/settings';
import { getWorkspacePath, getDefaultVersionSettings, stripSettings } from './utils';

export class VersionsService {
    private static instance: VersionsService;
    private readonly versions: Map<string, VersionModel> = new Map();
    private activeVersionId: string | undefined;
    private initialized: boolean = false;

    private constructor() {
        // Initialization will be done via initialize() method
    }

    public static getInstance(): VersionsService {
        if (!VersionsService.instance) {
            VersionsService.instance = new VersionsService();
        }
        return VersionsService.instance;
    }

    /**
     * Initialize the service by loading versions
     */
    public async initialize(): Promise<void> {
        if (!this.initialized) {
            await this.loadVersions();
            await this.validateAndRepairVersions();
            this.initialized = true;
        }
    }

    /**
     * Load versions from odoo-debugger-data.json
     */
    private async loadVersions(): Promise<void> {
        try {
            const data = await SettingsStore.load();
            const versionsData = data.versions || {};
            const activeVersionId = data.activeVersion;

            this.versions.clear();

            // Load existing versions
            Object.entries(versionsData).forEach(([id, versionData]) => {
                const version = VersionModel.fromJSON(versionData);
                if (version) {
                    this.versions.set(id, version);
                }
            });

            // Check if legacy settings exist - if so, skip auto-saving to preserve them for migration
            const hasLegacySettings = this.hasLegacySettings();

            // Create default version if none exist
            if (this.versions.size === 0) {
                const defaultVersion = new VersionModel(
                    'Default Version',
                    '17.0' // Odoo version
                );
                defaultVersion.isActive = true;
                this.versions.set(defaultVersion.id, defaultVersion);
                this.activeVersionId = defaultVersion.id;

                // Only save if no legacy settings exist (to avoid destroying them before migration)
                if (!hasLegacySettings) {
                    await this.saveVersions();
                }
            } else {
                this.activeVersionId = activeVersionId;

                // Ensure active version exists and update isActive flags
                if (!this.activeVersionId || !this.versions.has(this.activeVersionId)) {
                    this.activeVersionId = this.versions.keys().next().value;
                }

                // Update isActive flags for all versions
                this.versions.forEach((version, id) => {
                    version.isActive = (id === this.activeVersionId);
                });

                // Only save if no legacy settings exist (to avoid destroying them before migration)
                if (!hasLegacySettings) {
                    await this.saveVersions();
                }
            }
        } catch (error) {
            console.error('Failed to load versions:', error);
            // Create default version on error
            const defaultVersion = new VersionModel('Default Version', '17.0');
            defaultVersion.isActive = true;
            this.versions.set(defaultVersion.id, defaultVersion);
            this.activeVersionId = defaultVersion.id;
        }
    }

    /**
     * Save all versions to odoo-debugger-data.json
     */
    private async saveVersions(): Promise<void> {
        try {
            const data = await SettingsStore.load();
            const versionsData: any = {};

            this.versions.forEach((version, id) => {
                versionsData[id] = version.toJSON();
            });

            data.versions = versionsData;
            data.activeVersion = this.activeVersionId;
            await SettingsStore.saveWithoutComments(stripSettings(data));
            console.log(`Saved ${this.versions.size} versions successfully`);
        } catch (error) {
            console.error('Failed to save versions:', error);
            throw error; // Re-throw to propagate error up the chain
        }
    }

    /**
     * Save versions during migration without stripping settings (they'll be cleared separately)
     */
    private async saveVersionsDuringMigration(): Promise<void> {
        try {
            const data = await SettingsStore.load();
            const versionsData: any = {};

            this.versions.forEach((version, id) => {
                versionsData[id] = version.toJSON();
            });

            data.versions = versionsData;
            data.activeVersion = this.activeVersionId;

            // During migration, don't strip settings - they'll be cleared by clearLegacySettings
            await SettingsStore.saveWithoutComments(data);
            console.log(`Saved ${this.versions.size} versions during migration`);
        } catch (error) {
            console.error('Failed to save versions during migration:', error);
            throw error;
        }
    }

        /**
     * Get all versions
     */
    public getVersions(): VersionModel[] {
        return Array.from(this.versions.values());
    }

    /**
     * Get a specific version by ID
     */
    public getVersion(id: string): VersionModel | undefined {
        return this.versions.get(id);
    }

    /**
     * Get the currently active version
     */
    public getActiveVersion(): VersionModel | undefined {
        if (!this.activeVersionId) {
            return undefined;
        }
        return this.versions.get(this.activeVersionId);
    }

    /**
     * Get settings from the currently active version
     * Falls back to default settings if no active version
     */
    public async getActiveVersionSettings(): Promise<any> {
        await this.initialize(); // Ensure initialization

        const activeVersion = this.getActiveVersion();
        if (activeVersion?.settings) {
            console.log(`Using settings from active version: ${activeVersion.name}`);
            return activeVersion.settings;
        }

        // Fallback: if no active version or no settings, create a temporary default
        console.warn('No active version or settings found, creating temporary default settings');

        // Create a version with default settings if none exists
        if (this.versions.size === 0) {
            const defaultVersion = new VersionModel('Default Version', '17.0');
            defaultVersion.isActive = true;
            this.versions.set(defaultVersion.id, defaultVersion);
            this.activeVersionId = defaultVersion.id;
            await this.saveVersions();
            return defaultVersion.settings;
        }

        // Return default settings structure as fallback
        return new SettingsModel();
    }

    /**
     * Set active version
     */
    public async setActiveVersion(id: string): Promise<boolean> {
        await this.initialize(); // Ensure initialization

        if (!this.versions.has(id)) {
            console.error(`Version with id ${id} not found`);
            return false;
        }

        const oldActiveVersionId = this.activeVersionId;

        // Update isActive properties on all versions
        this.versions.forEach((version, versionId) => {
            version.isActive = (versionId === id);
        });

        this.activeVersionId = id;

        try {
            await this.saveVersions(); // Save all versions to update isActive flags

            // Fire event for UI updates
            vscode.commands.executeCommand('odoo.versionsChanged');
            console.log(`Successfully set active version from ${oldActiveVersionId} to ${id}`);
            return true;
        } catch (error) {
            console.error('Error saving active version:', error);
            // Revert on error
            this.activeVersionId = oldActiveVersionId;
            this.versions.forEach((version, versionId) => {
                version.isActive = (versionId === oldActiveVersionId);
            });
            return false;
        }
    }

    /**
     * Create a new version
     */
    public async createVersion(name: string, odooVersion: string): Promise<VersionModel> {
        await this.initialize(); // Ensure initialization

        // Get default settings from VS Code configuration
        const defaultSettings = getDefaultVersionSettings();

        // Update debugger name to include the Odoo version
        defaultSettings.debuggerName = `odoo:${odooVersion}`;

        const version = new VersionModel(name, odooVersion, defaultSettings);
        this.versions.set(version.id, version);

        await this.saveVersions();
        vscode.commands.executeCommand('odoo.versionsChanged');

        return version;
    }

    /**
     * Update an existing version
     */
    public async updateVersion(id: string, updates: Partial<VersionModel>): Promise<boolean> {
        await this.initialize(); // Ensure initialization

        const version = this.versions.get(id);
        if (!version) {
            return false;
        }

        // Handle settings updates specially to merge instead of replace
        if (updates.settings) {
            // Merge new settings with existing settings
            Object.assign(version.settings, updates.settings);
            // Remove settings from updates to avoid double assignment
            const { settings, ...otherUpdates } = updates;
            // Update other properties
            Object.assign(version, otherUpdates);
        } else {
            // Update version properties normally
            Object.assign(version, updates);
        }

        // Update the updatedAt timestamp
        version.updatedAt = new Date();

        await this.saveVersions();
        vscode.commands.executeCommand('odoo.versionsChanged');

        return true;
    }

    /**
     * Delete a version
     */
    public async deleteVersion(id: string): Promise<boolean> {
        await this.initialize(); // Ensure initialization

        if (!this.versions.has(id)) {
            return false;
        }

        // Don't allow deleting the last version
        if (this.versions.size <= 1) {
            vscode.window.showWarningMessage('Cannot delete the last version. At least one version must exist.');
            return false;
        }

        // Clean up any database references to this version before deleting
        await this.cleanupDatabaseVersionReferences(id);

        this.versions.delete(id);

        // If this was the active version, switch to another one
        if (this.activeVersionId === id) {
            this.activeVersionId = this.versions.keys().next().value;

            // Update isActive flags for all versions
            this.versions.forEach((version, versionId) => {
                version.isActive = (versionId === this.activeVersionId);
            });
        }

        await this.saveVersions();
        vscode.commands.executeCommand('odoo.versionsChanged');

        return true;
    }

    /**
     * Clean up database references when a version is deleted
     */
    private async cleanupDatabaseVersionReferences(deletedVersionId: string): Promise<void> {
        try {
            const data = await SettingsStore.load();
            let needsSave = false;

            if (data.projects && Array.isArray(data.projects)) {
                for (const project of data.projects) {
                    if (project.dbs && Array.isArray(project.dbs)) {
                        for (const db of project.dbs) {
                            if (db.versionId === deletedVersionId) {
                                console.log(`Clearing version reference from database "${db.name}" (was using deleted version)`);
                                db.versionId = undefined;
                                // Don't touch odooVersion - let it remain as is for backward compatibility
                                needsSave = true;
                            }
                        }
                    }
                }
            }

            if (needsSave) {
                console.log('Saving cleaned database references after version deletion');
                await SettingsStore.saveWithoutComments(stripSettings(data));
            }
        } catch (error) {
            console.warn('Failed to clean up database version references:', error);
            // Don't throw - this shouldn't prevent version deletion
        }
    }

    /**
     * Clone a version
     */
    public async cloneVersion(sourceId: string, newName: string): Promise<VersionModel | undefined> {
        await this.initialize(); // Ensure initialization

        const sourceVersion = this.versions.get(sourceId);
        if (!sourceVersion) {
            console.error(`Source version with id ${sourceId} not found`);
            return undefined;
        }

        try {
            const clonedVersion = sourceVersion.clone(newName);
            this.versions.set(clonedVersion.id, clonedVersion);

            await this.saveVersions();
            vscode.commands.executeCommand('odoo.versionsChanged');

            console.log(`Successfully cloned version ${sourceVersion.name} to ${newName}`);
            return clonedVersion;
        } catch (error) {
            console.error('Error cloning version:', error);
            return undefined;
        }
    }

    /**
     * Get settings for active version
     */
    public async getActiveSettings(): Promise<any> {
        await this.initialize(); // Ensure initialization
        const activeVersion = this.getActiveVersion();
        return activeVersion ? activeVersion.settings : {};
    }

    /**
     * Update settings for active version
     */
    public async updateActiveSettings(settings: Partial<any>): Promise<void> {
        await this.initialize(); // Ensure initialization
        const activeVersion = this.getActiveVersion();
        if (!activeVersion) {
            console.warn('No active version found, cannot update settings');
            return;
        }

        Object.assign(activeVersion.settings, settings);
        activeVersion.updatedAt = new Date();
        await this.saveVersions();
        vscode.commands.executeCommand('odoo.versionsChanged');
    }

    /**
     * Refresh from odoo-debugger-data.json (useful when data changes externally)
     */
    public async refresh(): Promise<void> {
        await this.loadVersions();
        await this.validateAndRepairVersions();

        // Also attempt migration in case legacy settings were added externally
        await this.migrateFromLegacySettings().catch(error => {
            console.warn('Settings migration during refresh failed (this is non-critical):', error);
        });

        vscode.commands.executeCommand('odoo.versionsChanged');
    }

    /**
     * Validate and repair versions data structure
     */
    private async validateAndRepairVersions(): Promise<void> {
        let needsRepair = false;

        // Ensure we have at least one version
        if (this.versions.size === 0) {
            console.log('No versions found, creating default version');
            const defaultVersion = new VersionModel('Default Version', '17.0');
            defaultVersion.isActive = true;
            this.versions.set(defaultVersion.id, defaultVersion);
            this.activeVersionId = defaultVersion.id;
            needsRepair = true;
        }

        // Ensure we have an active version
        if (!this.activeVersionId || !this.versions.has(this.activeVersionId)) {
            console.log('Invalid active version, selecting first available version');
            this.activeVersionId = this.versions.keys().next().value;
            needsRepair = true;
        }

        // Ensure only one version is marked as active
        let activeCount = 0;
        this.versions.forEach((version, id) => {
            if (version.isActive) {
                activeCount++;
                if (id !== this.activeVersionId) {
                    version.isActive = false;
                    needsRepair = true;
                }
            } else if (id === this.activeVersionId) {
                version.isActive = true;
                needsRepair = true;
            }
        });

        if (activeCount === 0) {
            const activeVersion = this.versions.get(this.activeVersionId!);
            if (activeVersion) {
                activeVersion.isActive = true;
                needsRepair = true;
            }
        }

        // Save if repairs were needed
        if (needsRepair) {
            console.log('Version data repaired, saving...');
            await this.saveVersions();
        }
    }

        /**
     * Migrate existing settings from SettingsStore to a new version for backwards compatibility
     */
    public async migrateFromLegacySettings(): Promise<void> {
        try {
            console.log('Starting migration check...');

            // Check if legacy settings actually exist in the file
            if (!this.hasLegacySettings()) {
                console.log('No legacy settings found, migration not needed');
                return;
            }

            console.log('Legacy settings found, proceeding with migration...');

            // Try to get existing settings
            const existingSettings = await SettingsStore.getSettings();
            if (!existingSettings) {
                console.log('Legacy settings exist but are empty, clearing them');
                await this.clearLegacySettings();
                return;
            }

            console.log('Retrieved legacy settings:', existingSettings);

            // Check if we already have a migrated version (avoid duplicate migration)
            if (this.getVersion('migrated-version')) {
                console.log('Migration already completed, clearing legacy settings');
                await this.clearLegacySettings();
                return;
            }

            console.log('Migrating legacy settings to version management...');

            // Convert SettingsModel to VersionSettings format
            const versionSettings = {
                debuggerName: existingSettings.debuggerName || 'odoo:17.0',
                debuggerVersion: existingSettings.debuggerVersion || '1.0.0',
                portNumber: existingSettings.portNumber || 8017,
                shellPortNumber: existingSettings.shellPortNumber || 5017,
                limitTimeReal: existingSettings.limitTimeReal || 0,
                limitTimeCpu: existingSettings.limitTimeCpu || 0,
                maxCronThreads: existingSettings.maxCronThreads || 0,
                extraParams: existingSettings.extraParams || '--log-handler,odoo.addons.base.models.ir_attachment:WARNING',
                devMode: existingSettings.devMode || '--dev=all',
                dumpsFolder: existingSettings.dumpsFolder || '/dumps',
                odooPath: existingSettings.odooPath || './odoo',
                enterprisePath: existingSettings.enterprisePath || './enterprise',
                designThemesPath: existingSettings.designThemesPath || './design-themes',
                customAddonsPath: existingSettings.customAddonsPath || './custom-addons',
                pythonPath: existingSettings.pythonPath || './venv/bin/python',
                subModulesPaths: existingSettings.subModulesPaths || '',
                installApps: existingSettings.installApps || '',
                upgradeApps: existingSettings.upgradeApps || ''
            };

            // Create a new version with migrated settings
            const migratedVersion = new VersionModel(
                'Migrated Settings',
                '17.0', // Default Odoo version
                versionSettings
            );
            migratedVersion.id = 'migrated-version';

            // Clear existing default version if it exists and replace with migrated version
            if (this.versions.size === 1) {
                const existingVersion = Array.from(this.versions.values())[0];
                if (existingVersion.name === 'Default Version') {
                    this.versions.clear();
                }
            }

            // Add the migrated version and set as active
            migratedVersion.isActive = true;
            this.versions.set(migratedVersion.id, migratedVersion);
            this.activeVersionId = migratedVersion.id;

            console.log('Saving migrated version to versions system...');
            await this.saveVersionsDuringMigration();

            console.log('Clearing legacy settings after successful version save...');
            // Clear the legacy settings to prevent repeated migration
            await this.clearLegacySettings();

            // Now that legacy settings are cleared, save versions normally to ensure proper state
            console.log('Final save of versions with settings properly cleared...');
            await this.saveVersions();

            console.log('Successfully migrated legacy settings to version management');
        } catch (error) {
            console.warn('Failed to migrate legacy settings:', error);
            // Don't throw - migration failure shouldn't break the extension
        }
    }

    /**
     * Clear legacy settings from odoo-debugger-data.json after successful migration
     */
    private async clearLegacySettings(): Promise<void> {
        try {
            const workspacePath = getWorkspacePath();
            if (!workspacePath) {
                return;
            }

            const filePath = path.join(workspacePath, '.vscode', 'odoo-debugger-data.json');
            if (!fs.existsSync(filePath)) {
                return;
            }

            // Read current data
            const content = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(content);

            // Remove the settings property but keep projects
            if (data.settings) {
                delete data.settings;

                // Write back the cleaned data
                const cleanedContent = JSON.stringify(data, null, 4);
                fs.writeFileSync(filePath, cleanedContent, 'utf-8');

                console.log('Legacy settings cleared after successful migration');
            }
        } catch (error) {
            console.warn('Failed to clear legacy settings:', error);
            // Don't throw - clearing failure shouldn't break anything
        }
    }

    /**
     * Check if legacy settings exist in the odoo-debugger-data.json file
     */
    private hasLegacySettings(): boolean {
        try {
            const workspacePath = getWorkspacePath();
            if (!workspacePath) {
                return false;
            }

            const filePath = path.join(workspacePath, '.vscode', 'odoo-debugger-data.json');
            if (!fs.existsSync(filePath)) {
                return false;
            }

            // Read current data
            const content = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(content);

            // Check if settings property exists and has meaningful content
            return data.settings && Object.keys(data.settings).length > 0;
        } catch (error) {
            console.warn('Failed to check for legacy settings:', error);
            return false;
        }
    }

    /**
     * Set a specific setting to its default value for a version
     */
    public async setSettingToDefault(versionId: string, settingKey: string): Promise<boolean> {
        const version = this.versions.get(versionId);
        if (!version) {
            vscode.window.showErrorMessage('Version not found.');
            return false;
        }

        try {
            // Get the default value for this setting
            const defaultSettings = getDefaultVersionSettings();
            const defaultValue = defaultSettings[settingKey];

            if (defaultValue === undefined) {
                vscode.window.showErrorMessage('Default value not found for this setting.');
                return false;
            }

            // Update the setting
            const updatedSettings = { ...version.settings, [settingKey]: defaultValue };
            version.updateSettings(updatedSettings);

            await this.saveVersions();
            vscode.commands.executeCommand('odoo.versionsChanged');

            vscode.window.showInformationMessage(`Setting "${settingKey}" reset to default value.`);
            return true;
        } catch (error) {
            console.error('Failed to set setting to default:', error);
            vscode.window.showErrorMessage('Failed to set setting to default value.');
            return false;
        }
    }

    /**
     * Set a specific setting's current value as the new default
     */
    public async setSettingAsDefault(versionId: string, settingKey: string): Promise<boolean> {
        const version = this.versions.get(versionId);
        if (!version) {
            vscode.window.showErrorMessage('Version not found.');
            return false;
        }

        try {
            const currentValue = (version.settings as any)[settingKey];
            if (currentValue === undefined) {
                vscode.window.showErrorMessage('Setting value not found.');
                return false;
            }

            // Update the VS Code configuration
            const config = vscode.workspace.getConfiguration('odooDebugger.defaultVersion');
            await config.update(settingKey, currentValue, vscode.ConfigurationTarget.Workspace);

            vscode.window.showInformationMessage(`Setting "${settingKey}" value saved as new default.`);
            return true;
        } catch (error) {
            console.error('Failed to set setting as default:', error);
            vscode.window.showErrorMessage('Failed to set setting as default.');
            return false;
        }
    }

    /**
     * Set all settings to their default values for a version
     */
    public async setAllSettingsToDefault(versionId: string): Promise<boolean> {
        const version = this.versions.get(versionId);
        if (!version) {
            vscode.window.showErrorMessage('Version not found.');
            return false;
        }

        try {
            // Get all default settings from VS Code configuration
            const defaultSettings = getDefaultVersionSettings();

            // Only preserve version-specific settings that should be calculated
            // Port numbers should come from VS Code settings, not calculated
            defaultSettings.debuggerName = `odoo:${version.odooVersion}`;

            version.updateSettings(defaultSettings);

            await this.saveVersions();
            vscode.commands.executeCommand('odoo.versionsChanged');

            vscode.window.showInformationMessage(`All settings reset to default values for version "${version.name}".`);
            return true;
        } catch (error) {
            console.error('Failed to set all settings to default:', error);
            vscode.window.showErrorMessage('Failed to reset all settings to default values.');
            return false;
        }
    }

    /**
     * Set all current settings as new defaults
     */
    public async setAllSettingsAsDefault(versionId: string): Promise<boolean> {
        const version = this.versions.get(versionId);
        if (!version) {
            vscode.window.showErrorMessage('Version not found.');
            return false;
        }

        try {
            const config = vscode.workspace.getConfiguration('odooDebugger.defaultVersion');
            const settings = version.settings;

            // Update all settings in configuration
            for (const [key, value] of Object.entries(settings)) {
                await config.update(key, value, vscode.ConfigurationTarget.Workspace);
            }

            vscode.window.showInformationMessage(`All settings from version "${version.name}" saved as new defaults.`);
            return true;
        } catch (error) {
            console.error('Failed to set all settings as default:', error);
            vscode.window.showErrorMessage('Failed to save all settings as defaults.');
            return false;
        }
    }
}
