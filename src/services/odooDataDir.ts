/**
 * Where Odoo keeps its data dir, found the way Odoo itself finds it
 * (odoo/tools/config.py, 15.0-19.0): `--data-dir` on the command line, else
 * `data_dir` in the config file, else the platform default from appdirs. The
 * filestore of database `x` is `<data dir>/filestore/x`. Pure: the caller
 * passes the environment and a file reader.
 */
import * as path from 'node:path';

export interface DataDirInputs {
    /** The version's comma-separated extra parameters, as passed to odoo-bin. */
    extraParams: string;
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    home: string;
    /** Where odoo-bin runs; relative paths resolve here. */
    cwd: string;
    /** The version's odoo folder: on Windows, Odoo's default config file sits next to odoo-bin. */
    odooPath: string;
    /** A file's text, or undefined when it cannot be read. */
    readText(file: string): string | undefined;
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
    return platform === 'win32' ? path.win32 : path.posix;
}

/** The value of an option in comma-split extra params; the last one wins, as with optparse. */
export function extraParamValue(tokens: string[], long: string, short: string): string | undefined {
    let value: string | undefined;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === long || token === short) {
            if (i + 1 < tokens.length) {
                value = tokens[++i];
            }
        } else if (token.startsWith(`${long}=`) || token.startsWith(`${long} `)) {
            value = token.slice(long.length + 1);
        } else if (token.startsWith(short) && !token.startsWith('--')) {
            value = token.slice(short.length);
        }
    }
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

/** `data_dir` from an Odoo config file's [options] section. */
export function readConfigDataDir(text: string): string | undefined {
    let section = '';
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith(';') || line.startsWith('#')) {
            continue;
        }
        const header = /^\[(.+)\]$/.exec(line);
        if (header) {
            section = header[1].trim();
            continue;
        }
        if (section !== 'options') {
            continue;
        }
        const match = /^data_dir\s*[=:]\s*(.*)$/.exec(line);
        if (match) {
            const value = match[1].trim();
            return value && value !== 'False' && value !== 'None' ? value : undefined;
        }
    }
    return undefined;
}

/** `~`, `$VAR`, `${VAR}` and `%VAR%` expanded, then made absolute against `cwd`. */
function expandPath(value: string, inputs: DataDirInputs): string {
    const p = pathApi(inputs.platform);
    let expanded = value.replace(/^~(?=$|[\\/])/, inputs.home);
    expanded = expanded.replace(/\$\{(\w+)\}|\$(\w+)|%(\w+)%/g, (whole, a, b, c) => {
        const name = a ?? b ?? c;
        if (name === 'HOME' && inputs.env.HOME === undefined) {
            return inputs.home;
        }
        return inputs.env[name] ?? whole;
    });
    return p.resolve(inputs.cwd, expanded);
}

function defaultConfigFile(inputs: DataDirInputs): string | undefined {
    const p = pathApi(inputs.platform);
    if (inputs.platform === 'win32') {
        return p.join(inputs.odooPath, 'odoo.conf');
    }
    const current = p.join(inputs.home, '.odoorc');
    const legacy = p.join(inputs.home, '.openerp_serverrc');
    if (inputs.readText(current) === undefined && inputs.readText(legacy) !== undefined) {
        return legacy;
    }
    return current;
}

function platformDefault(inputs: DataDirInputs): string {
    const p = pathApi(inputs.platform);
    if (inputs.platform === 'win32') {
        const local = inputs.env.LOCALAPPDATA || p.join(inputs.home, 'AppData', 'Local');
        return p.join(local, 'OpenERP S.A.', 'Odoo');
    }
    if (inputs.platform === 'darwin') {
        return p.join(inputs.home, 'Library', 'Application Support', 'Odoo');
    }
    return p.join(inputs.env.XDG_DATA_HOME || p.join(inputs.home, '.local', 'share'), 'Odoo');
}

export function resolveOdooDataDir(inputs: DataDirInputs): string {
    const tokens = inputs.extraParams.split(',').map(token => token.trim()).filter(Boolean);

    const fromArgs = extraParamValue(tokens, '--data-dir', '-D');
    if (fromArgs) {
        return expandPath(fromArgs, inputs);
    }

    const configArg = extraParamValue(tokens, '--config', '-c');
    const configFile = configArg
        ? expandPath(configArg, inputs)
        : inputs.env.ODOO_RC || inputs.env.OPENERP_SERVER || defaultConfigFile(inputs);
    const text = configFile ? inputs.readText(configFile) : undefined;
    const fromConfig = text === undefined ? undefined : readConfigDataDir(text);
    if (fromConfig) {
        return expandPath(fromConfig, inputs);
    }

    return platformDefault(inputs);
}

export function filestoreRootOf(dataDir: string, platform: NodeJS.Platform = process.platform): string {
    return pathApi(platform).join(dataDir, 'filestore');
}
