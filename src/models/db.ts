import { ModuleModel } from "./module";
import { VersionsService } from "../versionsService";

export interface DatabaseOptions {
    modules?: ModuleModel[];
    isItABackup?: boolean;
    isSelected?: boolean;
    sqlFilePath?: string;
    isExisting?: boolean;
    branchName?: string;
    odooVersion?: string;
    versionId?: string;
    displayName?: string;
    internalName?: string;
    kind?: string;
}

export class DatabaseModel {
    name: string;
    isItABackup: boolean;
    createdAt: Date;
    modules: ModuleModel[];
    isSelected: boolean = false;
    sqlFilePath: string = '';
    id: string = '';
    isExisting: boolean = false;
    branchName: string = '';
    odooVersion?: string; // Optional - only used when no version is assigned
    versionId?: string; // Reference to the VersionModel
    displayName?: string;
    internalName?: string;
    kind?: string;

    constructor(name: string, createdAt: Date, options: DatabaseOptions = {}) {
        this.displayName = options.displayName || name;
        this.name = this.displayName;
        this.createdAt = createdAt;
        this.modules = options.modules || [];
        this.isItABackup = options.isItABackup || false;
        this.isSelected = options.isSelected || false;
        this.sqlFilePath = options.sqlFilePath || '';
        this.isExisting = options.isExisting || false;
        this.branchName = options.branchName || '';
        this.odooVersion = options.odooVersion; // Optional - undefined when version is assigned
        this.versionId = options.versionId;
        this.kind = options.kind;

        if (options.internalName) {
            this.internalName = options.internalName;
        } else if (this.isExisting) {
            this.internalName = name;
        } else {
            this.internalName = `${name}-${createdAt.toISOString().split('T')[0]}`;
        }

        this.id = this.internalName;
    }

    /**
     * Gets the effective Odoo version for this database.
     * First checks if there's a version assigned, then falls back to legacy odooVersion property.
     */
    getEffectiveOdooVersion(): string | undefined {
        if (this.versionId) {
            try {
                const versionsService = VersionsService.getInstance();
                const version = versionsService.getVersion(this.versionId);
                if (version) {
                    return version.odooVersion;
                }
            } catch (error) {
                console.warn(`Failed to get version for database ${this.name}:`, error);
                // Fall through to legacy property
            }
        }
        // Fall back to legacy odooVersion property for backward compatibility
        return this.odooVersion || undefined;
    }

    /**
     * Gets the version name if this database has a version assigned.
     */
    getVersionName(): string | undefined {
        if (this.versionId) {
            try {
                const versionsService = VersionsService.getInstance();
                const version = versionsService.getVersion(this.versionId);
                return version?.name;
            } catch (error) {
                console.warn(`Failed to get version name for database ${this.name}:`, error);
                return undefined;
            }
        }
        return undefined;
    }

    // Legacy constructor for backward compatibility
    static createLegacy(
        name: string,
        createdAt: Date,
        options?: {
            modules?: ModuleModel[];
            isItABackup?: boolean;
            isSelected?: boolean;
            sqlFilePath?: string;
            isExisting?: boolean;
            branchName?: string;
            odooVersion?: string;
        }
    ): DatabaseModel {
        return new DatabaseModel(name, createdAt, options);
    }
}
