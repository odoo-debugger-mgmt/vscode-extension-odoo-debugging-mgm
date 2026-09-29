/**
 * Database model: a PostgreSQL database linked to a version profile with
 * per-repo branch assignments.
 */
import { ModuleModel } from "./module";
import { VersionsService } from "../versionsService";
import { logger } from '../services/logger';

export interface DatabaseOptions {
    modules?: ModuleModel[];
    isItABackup?: boolean;
    isSelected?: boolean;
    sqlFilePath?: string;
    isExisting?: boolean;
    odooVersion?: string;
    versionId?: string;
    displayName?: string;
    internalName?: string;
    kind?: string;
    projectRepoBranches?: ProjectRepoBranchAssignment[];
    testingModuleStates?: SavedModuleState[];
}

/** A module's install/upgrade mark, as stashed while testing mode is on. */
export interface SavedModuleState {
    name: string;
    state: string;
}

export interface ProjectRepoBranchAssignment {
    repoName: string;
    repoPath: string;
    branch: string;
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
    odooVersion?: string; // Optional - only used when no version is assigned
    versionId?: string; // Reference to the VersionModel
    displayName?: string;
    internalName?: string;
    kind?: string;
    projectRepoBranches: ProjectRepoBranchAssignment[] = [];
    /**
     * This database's own module marks, stashed while testing mode has
     * cleared them. Kept on the database rather than the project, so the
     * marks go back to the database they came from.
     */
    testingModuleStates?: SavedModuleState[];

    constructor(name: string, createdAt: Date, options: DatabaseOptions = {}) {
        this.displayName = options.displayName || name;
        this.name = this.displayName;
        this.createdAt = createdAt;
        this.modules = options.modules || [];
        this.isItABackup = options.isItABackup || false;
        this.isSelected = options.isSelected || false;
        this.sqlFilePath = options.sqlFilePath || '';
        this.isExisting = options.isExisting || false;
        this.odooVersion = options.odooVersion; // Optional - undefined when version is assigned
        this.versionId = options.versionId;
        this.kind = options.kind;
        this.projectRepoBranches = Array.isArray(options.projectRepoBranches)
            ? options.projectRepoBranches
                .filter(entry => !!entry && typeof entry.branch === 'string' && entry.branch.trim() !== '')
                .map(entry => ({
                    repoName: entry.repoName || '',
                    repoPath: entry.repoPath || '',
                    branch: entry.branch.trim()
                }))
            : [];
        this.testingModuleStates = Array.isArray(options.testingModuleStates) ? options.testingModuleStates : undefined;

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
                logger.warn(`Failed to get version for database ${this.name}:`, error);
                // Fall through to legacy property
            }
        }
        // Fall back to legacy odooVersion property for backward compatibility
        return this.odooVersion || undefined;
    }
}
