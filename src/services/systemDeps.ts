/**
 * Detects the non-Python dependencies an Odoo server needs and reports what
 * breaks without each. Reports and suggests only: nothing here executes an
 * installer or escalates privileges.
 */
import * as fs from 'node:fs';
import { tryRunCommand } from './process';
import { venvPythonPath } from './pythonToolchain';

export type PlatformId = 'apt' | 'dnf' | 'brew' | 'windows' | 'unknown';

export interface SystemDepReport {
    id: string;
    label: string;
    present: boolean;
    impact: string;
    installHint?: string;
}

const INSTALL_HINTS: Record<string, Partial<Record<PlatformId, string>>> = {
    wkhtmltopdf: {
        apt: 'sudo apt install wkhtmltopdf',
        dnf: 'sudo dnf install wkhtmltopdf',
        brew: 'brew install --cask wkhtmltopdf'
    },
    psql: {
        apt: 'sudo apt install postgresql-client',
        dnf: 'sudo dnf install postgresql',
        brew: 'brew install libpq'
    },
    rtlcss: {
        apt: 'sudo npm install -g rtlcss',
        dnf: 'sudo npm install -g rtlcss',
        brew: 'npm install -g rtlcss'
    },
    buildDeps: {
        apt: 'sudo apt install libxml2-dev libxslt1-dev libldap2-dev libsasl2-dev libssl-dev python3-dev',
        dnf: 'sudo dnf install libxml2-devel libxslt-devel openldap-devel cyrus-sasl-devel openssl-devel python3-devel',
        brew: 'brew install libxmlsec1 openldap'
    }
};

export function detectPlatform(): PlatformId {
    if (process.platform === 'win32') {
        return 'windows';
    }
    if (process.platform === 'darwin') {
        return 'brew';
    }
    if (fs.existsSync('/usr/bin/apt') || fs.existsSync('/usr/bin/apt-get')) {
        return 'apt';
    }
    if (fs.existsSync('/usr/bin/dnf')) {
        return 'dnf';
    }
    return 'unknown';
}

export function installHintFor(id: string, platform: PlatformId): string | undefined {
    return INSTALL_HINTS[id]?.[platform];
}

export function summarizeMissing(reports: SystemDepReport[]): string | undefined {
    const missing = reports.filter(entry => !entry.present);
    if (missing.length === 0) {
        return undefined;
    }
    return missing.map(entry => `${entry.label}: ${entry.impact}`).join('; ');
}

async function onPath(command: string, args: string[] = ['--version']): Promise<boolean> {
    return (await tryRunCommand(command, args)) !== undefined;
}

async function canImport(venvPath: string, moduleName: string): Promise<boolean> {
    const interpreter = venvPythonPath(venvPath);
    if (!fs.existsSync(interpreter)) {
        return false;
    }
    return (await tryRunCommand(interpreter, ['-c', `import ${moduleName}`])) !== undefined;
}

export async function checkSystemDeps(venvPath?: string): Promise<SystemDepReport[]> {
    const platform = detectPlatform();
    const reports: SystemDepReport[] = [];

    const add = (id: string, label: string, present: boolean, impact: string) => {
        reports.push({ id, label, present, impact, installHint: present ? undefined : installHintFor(id, platform) });
    };

    add('wkhtmltopdf', 'wkhtmltopdf', await onPath('wkhtmltopdf'), 'PDF reports will fail; everything else works');
    add('psql', 'PostgreSQL client tools', await onPath('psql'), 'Database features are unavailable');
    add('rtlcss', 'rtlcss', await onPath('rtlcss'), 'Right-to-left stylesheets are not generated');

    if (venvPath) {
        const missingModules: string[] = [];
        for (const moduleName of ['lxml', 'psycopg2', 'ldap']) {
            if (!(await canImport(venvPath, moduleName))) {
                missingModules.push(moduleName);
            }
        }
        add(
            'buildDeps',
            `Python modules (${missingModules.join(', ') || 'all present'})`,
            missingModules.length === 0,
            'The server will not start; build headers are probably missing'
        );
    }

    return reports;
}
