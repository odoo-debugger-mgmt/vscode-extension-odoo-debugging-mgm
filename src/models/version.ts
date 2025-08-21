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

        // Default settings with overrides
        this.settings = {
            debuggerName: `odoo:${odooVersion}`,
            debuggerVersion: "1.0.0",
            portNumber: this.getDefaultPort(odooVersion),
            shellPortNumber: this.getDefaultShellPort(odooVersion),
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
            ...settings
        };
    }

    private getDefaultPort(odooVersion: string): number {
        // Extract version number for port calculation
        const versionRegex = /(\d+)/;
        const versionMatch = versionRegex.exec(odooVersion);
        if (versionMatch) {
            const majorVersion = parseInt(versionMatch[1]);
            return 8000 + majorVersion; // e.g., 17.0 -> 8017, 16.0 -> 8016
        }
        return 8069; // Default Odoo port
    }

    private getDefaultShellPort(odooVersion: string): number {
        return this.getDefaultPort(odooVersion) - 3000; // e.g., 8017 -> 5017
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
