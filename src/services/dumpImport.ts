import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, ChildProcess } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { runCommand } from './process';
import { errorMessage, logger } from './logger';

/**
 * Dump discovery and import: finds dump sources (dump.sql folders, .zip
 * archives, .sql/.sql.gz files) and restores them into PostgreSQL, streaming
 * unzip/gunzip output straight into psql where the toolchain allows it, with
 * a temp-file fallback. No shell is ever involved; archives and database
 * names are always passed as process arguments.
 */

export interface DumpSelection {
    label: string;
    kind: 'folder' | 'zip' | 'file';
    path: string;
}

export interface PreparedDump {
    kind: 'file' | 'stream';
    originalPath: string;
    progressMessage?: string;
    sqlPath?: string;
    openStream?: () => OpenedDumpStream;
    cleanup?: () => void;
}

interface OpenedDumpStream {
    stream: Readable;
    dispose: () => void;
}

/** Recursively finds restorable dump sources under `root` (bounded depth). */
export async function collectDumpSources(root: string, maxDepth = 2): Promise<DumpSelection[]> {
    const results: DumpSelection[] = [];
    const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];

    while (stack.length > 0) {
        const { dir, depth } = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch (error) {
            logger.warn(`Failed to read dumps directory ${dir}:`, error);
            continue;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativeLabel = path.relative(root, fullPath) || entry.name;

            if (entry.isDirectory()) {
                const dumpSqlPath = path.join(fullPath, 'dump.sql');
                if (await pathExists(dumpSqlPath)) {
                    results.push({ label: relativeLabel, kind: 'folder', path: fullPath });
                }
                if (depth < maxDepth) {
                    stack.push({ dir: fullPath, depth: depth + 1 });
                }
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
                results.push({ label: relativeLabel, kind: 'zip', path: fullPath });
            } else if (entry.isFile() && (entry.name.toLowerCase().endsWith('.sql') || entry.name.toLowerCase().endsWith('.gz'))) {
                results.push({ label: relativeLabel, kind: 'file', path: fullPath });
            }
        }
    }

    return results;
}

export async function pathExists(target: string): Promise<boolean> {
    try {
        await fsp.access(target);
        return true;
    } catch {
        return false;
    }
}

export function isToolchainUnavailableError(error: unknown): boolean {
    const message = errorMessage(error).toLowerCase();
    return message.includes('enoent')
        || message.includes('not found')
        || message.includes('failed to start unzip')
        || message.includes('failed to start gunzip');
}

function createProcessStream(child: ChildProcess, label: string): OpenedDumpStream {
    if (!child.stdout || !child.stderr) {
        throw new Error(`${label} process did not expose readable stdio streams.`);
    }

    const output = new PassThrough();
    let stderr = '';

    child.stderr.on('data', chunk => {
        stderr += chunk.toString();
    });
    child.stdout.pipe(output);

    child.on('error', error => {
        output.destroy(new Error(`Failed to start ${label}: ${errorMessage(error)}`));
    });
    child.on('close', code => {
        if (code !== 0) {
            const details = stderr.trim();
            output.destroy(new Error(`${label} exited with code ${code}${details ? `: ${details}` : ''}`));
        }
    });

    return {
        stream: output,
        dispose: () => {
            if (!child.killed) {
                child.kill('SIGTERM');
            }
            output.destroy();
        }
    };
}

function createCommandStream(command: string, args: string[], label: string): OpenedDumpStream {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    return createProcessStream(child, label);
}

function createZipGzipStream(dumpPath: string, entry: string): OpenedDumpStream {
    const unzipProcess = spawn('unzip', ['-p', dumpPath, entry], { stdio: ['ignore', 'pipe', 'pipe'] });
    const gunzipProcess = spawn('gunzip', ['-c'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = new PassThrough();

    let unzipStderr = '';
    let gunzipStderr = '';

    unzipProcess.stderr.on('data', chunk => {
        unzipStderr += chunk.toString();
    });
    gunzipProcess.stderr.on('data', chunk => {
        gunzipStderr += chunk.toString();
    });

    unzipProcess.stdout.pipe(gunzipProcess.stdin);
    gunzipProcess.stdout.pipe(output);

    unzipProcess.on('error', error => {
        output.destroy(new Error(`Failed to start unzip: ${errorMessage(error)}`));
    });
    gunzipProcess.on('error', error => {
        output.destroy(new Error(`Failed to start gunzip: ${errorMessage(error)}`));
    });

    unzipProcess.on('close', code => {
        if (code !== 0) {
            const details = unzipStderr.trim();
            output.destroy(new Error(`unzip exited with code ${code}${details ? `: ${details}` : ''}`));
            if (!gunzipProcess.killed) {
                gunzipProcess.kill('SIGTERM');
            }
        }
    });
    gunzipProcess.on('close', code => {
        if (code !== 0) {
            const details = gunzipStderr.trim();
            output.destroy(new Error(`gunzip exited with code ${code}${details ? `: ${details}` : ''}`));
        }
    });

    return {
        stream: output,
        dispose: () => {
            if (!unzipProcess.killed) {
                unzipProcess.kill('SIGTERM');
            }
            if (!gunzipProcess.killed) {
                gunzipProcess.kill('SIGTERM');
            }
            output.destroy();
        }
    };
}

async function listZipEntries(dumpPath: string): Promise<string[]> {
    const { stdout } = await runCommand('unzip', ['-Z1', dumpPath]);
    return stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

/** Prepares a dump source for import, preferring streaming pipelines. */
export async function prepareDumpForImport(dumpPath: string): Promise<PreparedDump> {
    if (dumpPath.endsWith('.zip')) {
        const entries = await listZipEntries(dumpPath);
        if (entries.length === 0) {
            throw new Error('Archive is empty.');
        }
        const sqlEntry = entries.find(entry => entry.toLowerCase().endsWith('.sql') && !entry.toLowerCase().endsWith('.sql.gz'));
        const gzEntry = entries.find(entry => entry.toLowerCase().endsWith('.sql.gz'));
        const selectedEntry = sqlEntry ?? gzEntry ?? entries[0];

        if (selectedEntry.toLowerCase().endsWith('.sql.gz')) {
            return {
                kind: 'stream',
                originalPath: dumpPath,
                progressMessage: 'Unzipping, decompressing, and importing dump archive...',
                openStream: () => createZipGzipStream(dumpPath, selectedEntry)
            };
        }

        return {
            kind: 'stream',
            originalPath: dumpPath,
            progressMessage: 'Unzipping and importing dump archive...',
            openStream: () => createCommandStream('unzip', ['-p', dumpPath, selectedEntry], 'unzip')
        };
    }

    if (dumpPath.endsWith('.gz')) {
        return {
            kind: 'stream',
            originalPath: dumpPath,
            progressMessage: 'Decompressing and importing dump file...',
            openStream: () => createCommandStream('gunzip', ['-c', dumpPath], 'gunzip')
        };
    }

    return {
        kind: 'file',
        originalPath: dumpPath,
        progressMessage: 'Importing dump file...',
        sqlPath: dumpPath
    };
}

async function importDumpStream(dbName: string, stream: Readable): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const psqlProcess = spawn('psql', ['-d', dbName], { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        let settled = false;

        const finish = (error?: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            if (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            resolve();
        };

        psqlProcess.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });
        psqlProcess.on('error', error => {
            finish(new Error(`Failed to start psql: ${errorMessage(error)}`));
        });
        psqlProcess.on('close', code => {
            if (code === 0) {
                finish();
                return;
            }
            const details = stderr.trim();
            finish(new Error(`psql exited with code ${code}${details ? `: ${details}` : ''}`));
        });

        stream.on('error', error => {
            if (!psqlProcess.killed) {
                psqlProcess.kill('SIGTERM');
            }
            finish(error);
        });
        psqlProcess.stdin.on('error', error => {
            const ioError = error as NodeJS.ErrnoException;
            if (ioError.code !== 'EPIPE') {
                finish(error);
            }
        });

        stream.pipe(psqlProcess.stdin);
    });
}

/** Imports a prepared dump into `dbName` (file via psql -f, or streamed). */
export async function importPreparedDump(dbName: string, preparedDump: PreparedDump): Promise<void> {
    if (preparedDump.kind === 'file') {
        if (!preparedDump.sqlPath) {
            throw new Error('No dump path available for file-based import.');
        }
        await runCommand('psql', ['-d', dbName, '-q', '-f', preparedDump.sqlPath]);
        return;
    }

    if (!preparedDump.openStream) {
        throw new Error('No stream provider configured for this dump source.');
    }

    const openedStream = preparedDump.openStream();
    try {
        await importDumpStream(dbName, openedStream.stream);
    } finally {
        openedStream.dispose();
    }
}

async function extractStreamToFile(opened: OpenedDumpStream, targetPath: string): Promise<void> {
    try {
        await pipeline(opened.stream, fs.createWriteStream(targetPath));
    } finally {
        opened.dispose();
    }
}

/**
 * Fallback used when the streaming pipeline is unavailable: extracts the dump
 * into a temporary SQL file and imports from there. The returned PreparedDump
 * owns the temp directory via cleanup().
 */
export async function prepareDumpViaTempFile(dumpPath: string): Promise<PreparedDump> {
    if (!dumpPath.endsWith('.zip') && !dumpPath.endsWith('.gz')) {
        return { kind: 'file', originalPath: dumpPath, sqlPath: dumpPath };
    }

    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'odoo-dump-'));
    const tempSqlPath = path.join(tempDir, 'dump.sql');
    const cleanup = () => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (cleanupError) {
            logger.warn('Failed to cleanup temporary dump folder:', cleanupError);
        }
    };

    try {
        if (dumpPath.endsWith('.zip')) {
            const entries = await listZipEntries(dumpPath);
            if (entries.length === 0) {
                throw new Error('Archive is empty.');
            }
            const sqlEntry = entries.find(entry => entry.toLowerCase().endsWith('.sql') && !entry.toLowerCase().endsWith('.sql.gz'));
            const gzEntry = entries.find(entry => entry.toLowerCase().endsWith('.sql.gz'));

            if (sqlEntry) {
                await extractStreamToFile(createCommandStream('unzip', ['-p', dumpPath, sqlEntry], 'unzip'), tempSqlPath);
            } else if (gzEntry) {
                await extractStreamToFile(createZipGzipStream(dumpPath, gzEntry), tempSqlPath);
            } else {
                await extractStreamToFile(createCommandStream('unzip', ['-p', dumpPath], 'unzip'), tempSqlPath);
            }
        } else {
            await extractStreamToFile(createCommandStream('gunzip', ['-c', dumpPath], 'gunzip'), tempSqlPath);
        }

        return { kind: 'file', originalPath: dumpPath, sqlPath: tempSqlPath, cleanup };
    } catch (error) {
        cleanup();
        throw error;
    }
}
