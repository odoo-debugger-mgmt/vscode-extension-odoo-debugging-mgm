import { execFile } from 'node:child_process';
import * as util from 'node:util';
import { InstalledModuleInfo } from '../models/module';
import { runtimeCache, invalidateInstalledModulesCache } from './runtimeCache';

const execFileAsync = util.promisify(execFile);

const INSTALLED_MODULES_QUERY = `
    SELECT id, name, shortdesc, latest_version, state, application
    FROM ir_module_module
    WHERE state IN ('installed', 'to upgrade')
    ORDER BY name;
`.trim();

const INSTALLED_MODULE_NAMES_QUERY = `
    SELECT name
    FROM ir_module_module
    WHERE state IN ('installed', 'to upgrade')
    ORDER BY name;
`.trim();

const TABLE_EXISTS_QUERY = `
    SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'ir_module_module'
    );
`.trim();

function validateDatabaseName(dbName: string): void {
    // Basic sanity check to avoid shell injection when invoking psql
    if (!/^[\w\-.:]+$/.test(dbName)) {
        throw new Error(`Invalid database identifier: ${dbName}`);
    }
}

async function runPsqlQuery(dbName: string, query: string, fieldSeparator = '|'): Promise<string> {
    validateDatabaseName(dbName);
    try {
        const args = [
            '--no-psqlrc',
            '--no-align',
            '--tuples-only',
            '-F',
            fieldSeparator,
            '-d',
            dbName,
            '-c',
            query
        ];

        const { stdout } = await execFileAsync('psql', args, {
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024 // Allow reasonably large result sets
        });
        return stdout.trim();
    } catch (error) {
        console.warn(`psql command failed for database "${dbName}":`, error);
        throw error;
    }
}

export async function databaseHasModuleTable(dbName: string): Promise<boolean> {
    try {
        const result = await runPsqlQuery(dbName, TABLE_EXISTS_QUERY);
        return result === 't';
    } catch {
        return false;
    }
}

export async function getInstalledModules(dbName: string): Promise<InstalledModuleInfo[]> {
    return runtimeCache.getInstalledModules(dbName, async () => {
        const modules: InstalledModuleInfo[] = [];

        if (!(await databaseHasModuleTable(dbName))) {
            console.debug(`Database ${dbName} does not contain Odoo tables yet.`);
            return modules;
        }

        let output: string;
        try {
            output = await runPsqlQuery(dbName, INSTALLED_MODULES_QUERY);
        } catch (error) {
            console.warn(`Failed to fetch installed modules for database "${dbName}":`, error);
            return modules;
        }

        if (!output) {
            return modules;
        }

        for (const line of output.split('\n').map(entry => entry.trim()).filter(Boolean)) {
            const [id, name, shortdesc, latestVersion, state, application] = line.split('|');

            let description = shortdesc || '';
            if (shortdesc) {
                try {
                    const parsed = JSON.parse(shortdesc);
                    const locales = Object.keys(parsed);
                    if (locales.length > 0) {
                        description = parsed.en_US ?? parsed[locales[0]] ?? '';
                    }
                } catch {
                    // Keep original string when JSON parsing fails
                    description = shortdesc;
                }
            }

            modules.push({
                id: Number.parseInt(id ?? '', 10),
                name: name ?? '',
                shortdesc: description ?? '',
                installed_version: latestVersion || null,
                latest_version: latestVersion || null,
                state: state ?? '',
                application: application === 't'
            });
        }

        return modules;
    });
}

export async function getInstalledModuleNames(dbName: string): Promise<Set<string>> {
    const names = await runtimeCache.getInstalledModuleNames(dbName, async () => {
        if (!(await databaseHasModuleTable(dbName))) {
            return [];
        }

        let output: string;
        try {
            output = await runPsqlQuery(dbName, INSTALLED_MODULE_NAMES_QUERY);
        } catch (error) {
            console.warn(`Failed to fetch installed module names for database "${dbName}":`, error);
            return [];
        }

        if (!output) {
            return [];
        }

        return output
            .split('\n')
            .map(entry => entry.trim())
            .filter(Boolean);
    });

    return new Set(names);
}

export function clearInstalledModuleCache(dbName?: string): void {
    invalidateInstalledModulesCache(dbName);
}
