/**
 * Version model: a named settings profile bound to a target Odoo branch.
 */
import { randomUUID } from "crypto";

export interface VersionSettings {
    // Debug configuration
    debuggerName: string;
    debuggerVersion: string;
    portNumber: number;
    shellPortNumber: number;

    // Performance settings
    limitTimeReal: number;
    limitTimeCpu: number;
    maxCronThreads: number;

    // Command settings
    extraParams: string;
    devMode: string;
    installApps: string;
    upgradeApps: string;

    // Path settings
    dumpsFolder: string;
    odooPath: string;
    enterprisePath: string;
    designThemesPath: string;
    customAddonsPath: string;
    pythonPath: string;
    subModulesPaths: string;
    preCheckoutCommands: string[];
    postCheckoutCommands: string[];
    /** Absolute paths this extension created while provisioning. */
    managedPaths: string[];
}

export class VersionModel {
    id: string;
    name: string; // User-friendly name like "Odoo 17.0", "Saas 17.4"
    odooVersion: string; // Branch name like "17.0", "saas-17.4", "master"
    settings: VersionSettings;
    isActive: boolean = false; // Currently active version
    createdAt: Date;
    updatedAt: Date;

    constructor(
        name: string,
        odooVersion: string,
        settings: Partial<VersionSettings> = {},
        id: string = randomUUID(),
        isActive: boolean = false
    ) {
        this.id = id;
        this.name = name;
        this.odooVersion = odooVersion;
        this.isActive = isActive;
        this.createdAt = new Date();
        this.updatedAt = new Date();

        // Baseline settings for partial payloads (full defaults are managed by VersionsService/config).
        this.settings = {
            debuggerName: 'odoo:19.0',
            debuggerVersion: "1.0.0",
            portNumber: 8019,
            shellPortNumber: 5019,
            limitTimeReal: 0,
            limitTimeCpu: 0,
            maxCronThreads: 0,
            extraParams: "--log-handler,odoo.addons.base.models.ir_attachment:WARNING",
            devMode: "--dev=all",
            dumpsFolder: "/dumps",
            odooPath: "./odoo",
            enterprisePath: "./enterprise",
            designThemesPath: "./design-themes",
            customAddonsPath: "./custom-addons",
            pythonPath: "./venv/bin/python",
            subModulesPaths: "",
            installApps: "",
            upgradeApps: "",
            preCheckoutCommands: [],
            postCheckoutCommands: [],
            managedPaths: [],
            ...settings
        };
        this.settings.preCheckoutCommands = Array.isArray(this.settings.preCheckoutCommands) ? this.settings.preCheckoutCommands : [];
        this.settings.postCheckoutCommands = Array.isArray(this.settings.postCheckoutCommands) ? this.settings.postCheckoutCommands : [];
        this.settings.managedPaths = Array.isArray(this.settings.managedPaths) ? this.settings.managedPaths : [];
    }

    updateSettings(newSettings: Partial<VersionSettings>): void {
        this.settings = { ...this.settings, ...newSettings };
        this.updatedAt = new Date();
    }

    clone(newName?: string): VersionModel {
        return new VersionModel(
            newName || `${this.name} (Copy)`,
            this.odooVersion,
            { ...this.settings },
            randomUUID(),
            false
        );
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            odooVersion: this.odooVersion,
            settings: this.settings,
            isActive: this.isActive,
            createdAt: this.createdAt.toISOString(),
            updatedAt: this.updatedAt.toISOString()
        };
    }

    static fromJSON(data: any): VersionModel {
        const version = new VersionModel(
            data.name,
            data.odooVersion,
            data.settings,
            data.id,
            data.isActive
        );
        version.createdAt = new Date(data.createdAt);
        version.updatedAt = new Date(data.updatedAt);
        return version;
    }
}
