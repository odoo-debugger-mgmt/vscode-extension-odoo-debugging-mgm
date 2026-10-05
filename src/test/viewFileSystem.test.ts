import * as assert from 'assert';
import * as vscode from 'vscode';
import { ViewFileSystemProvider, clearViewDiagnostics, parseViewUri, viewFileSize, viewUri, type ViewRef } from '../views/viewFileSystem';
import type { SaveResult, ViewBackend } from '../services/views/viewService';

class FakeBackend implements ViewBackend {
    writeDates = new Map<number, number>([[12, 1000]]);
    arches = new Map<number, string>([[12, '<data>é</data>']]);
    saveResult: SaveResult = { active: true, activated: true, activationError: null };
    saveError: Error | undefined;
    async writeDate(_db: string, viewId: number) {
        return this.writeDates.get(viewId);
    }
    async getArch(_db: string, viewId: number) {
        return this.arches.get(viewId) ?? '';
    }
    async save(_db: string, viewId: number, arch: string) {
        if (this.saveError) {
            throw this.saveError;
        }
        this.arches.set(viewId, arch);
        this.writeDates.set(viewId, (this.writeDates.get(viewId) ?? 0) + 1);
        return this.saveResult;
    }
}

suite('View arch files', () => {
    const uri = viewUri('shop-18', 12, 'studio_customization.odoo studio/partner');

    test('a view is addressed by database and id, with a readable xml name', () => {
        assert.strictEqual(uri.scheme, 'odoo-view');
        assert.strictEqual(uri.path, '/shop-18/12/studio_customization.odoo_studio_partner.xml');
        assert.deepStrictEqual(parseViewUri(uri), { dbName: 'shop-18', viewId: 12 });
        assert.strictEqual(parseViewUri(vscode.Uri.parse('odoo-view:/shop-18/zero/x.xml')), undefined);
        assert.strictEqual(parseViewUri(vscode.Uri.parse('odoo-view:/')), undefined);
    });

    test('reads the arch as UTF-8 and dates it by write_date', async () => {
        const backend = new FakeBackend();
        const provider = new ViewFileSystemProvider(backend, { onSaved: () => undefined });
        assert.strictEqual(Buffer.from(await provider.readFile(uri)).toString('utf-8'), '<data>é</data>');
        const before = await provider.stat(uri);
        assert.deepStrictEqual([before.type, before.mtime], [vscode.FileType.File, 1000]);
        assert.deepStrictEqual(await provider.stat(uri), before, 'an unchanged view must stat the same, or every save would conflict');

        // Edited in Odoo's own UI meanwhile: the date moves, so VS Code sees a newer file.
        backend.writeDates.set(12, 2000);
        assert.strictEqual((await provider.stat(uri)).mtime, 2000);
    });

    test('an edit made in Odoo meanwhile trips VS Code\'s newer-file check', async () => {
        // VS Code's FileService.validateWriteFile, verbatim in substance: it pairs the
        // size on disk with the mtime it last saw.
        const etag = (stat: { mtime: number; size: number }) => stat.mtime.toString(29) + stat.size.toString(31);
        const modifiedSince = (seen: vscode.FileStat, now: vscode.FileStat) =>
            seen.mtime < now.mtime && etag(seen) !== etag({ mtime: seen.mtime, size: now.size });

        const backend = new FakeBackend();
        const provider = new ViewFileSystemProvider(backend, { onSaved: () => undefined });
        const opened = await provider.stat(uri);
        assert.strictEqual(modifiedSince(opened, await provider.stat(uri)), false);

        backend.writeDates.set(12, Date.parse('2026-10-02T16:50:01.518Z'));
        assert.strictEqual(modifiedSince(opened, await provider.stat(uri)), true);
    });

    test('the stand-in size follows the date and stays small', () => {
        const date = Date.parse('2026-10-02T16:48:22.309Z');
        assert.notStrictEqual(viewFileSize(date), viewFileSize(date + 1));
        assert.notStrictEqual(viewFileSize(date), viewFileSize(date + 31_000));
        assert.ok(viewFileSize(date) > 0 && viewFileSize(date) <= 1_000_000);
        assert.strictEqual(viewFileSize(date), viewFileSize(date));
    });

    test('a deleted view is not found', async () => {
        const backend = new FakeBackend();
        backend.writeDates.delete(12);
        const provider = new ViewFileSystemProvider(backend, { onSaved: () => undefined });
        await assert.rejects(Promise.resolve(provider.stat(uri)), (error: unknown) =>
            error instanceof vscode.FileSystemError && error.code === 'FileNotFound');
    });

    test('saving writes through Odoo and reports what happened', async () => {
        const backend = new FakeBackend();
        const saved: Array<[ViewRef, SaveResult, string]> = [];
        const provider = new ViewFileSystemProvider(backend, { onSaved: (ref, result, _uri, text) => saved.push([ref, result, text]) });
        const changed: vscode.FileChangeEvent[][] = [];
        provider.onDidChangeFile(events => changed.push(events));

        await provider.writeFile(uri, Buffer.from('<data>✓</data>'), { create: false, overwrite: true });
        assert.strictEqual(backend.arches.get(12), '<data>✓</data>');
        assert.deepStrictEqual(saved, [[{ dbName: 'shop-18', viewId: 12 }, backend.saveResult, '<data>✓</data>']]);
        assert.strictEqual(changed.length, 1);
    });

    test('an arch Odoo rejects fails the save and reports nothing', async () => {
        const backend = new FakeBackend();
        backend.saveError = new Error('Invalid view definition');
        let saved = 0;
        const provider = new ViewFileSystemProvider(backend, { onSaved: () => saved++ });
        await assert.rejects(Promise.resolve(provider.writeFile(uri, Buffer.from('<data'), { create: false, overwrite: true })), /Invalid view definition/);
        assert.strictEqual(saved, 0);
    });

    test('a read-only database\'s views stat read-only and refuse a save', async () => {
        const backend = new FakeBackend();
        const original = viewUri('shop-17', 12, 'x');
        const provider = new ViewFileSystemProvider(backend, { onSaved: () => undefined }, async dbName => dbName === 'shop-17');
        assert.strictEqual((await provider.stat(original)).permissions, vscode.FilePermission.Readonly);
        assert.strictEqual((await provider.stat(uri)).permissions, undefined);
        await assert.rejects(provider.writeFile(original, Buffer.from('<data/>'), { create: false, overwrite: true }), /read-only/);
        assert.strictEqual(backend.arches.get(12), '<data>é</data>', 'nothing reached the database');
    });

    test('views cannot be created, deleted, renamed or listed', () => {
        const provider = new ViewFileSystemProvider(new FakeBackend(), { onSaved: () => undefined });
        assert.throws(() => provider.delete(uri), vscode.FileSystemError);
        assert.throws(() => provider.rename(uri, uri), vscode.FileSystemError);
        assert.throws(() => provider.createDirectory(uri), vscode.FileSystemError);
        assert.throws(() => provider.readDirectory(uri), vscode.FileSystemError);
    });

    test('clears a view\'s diagnostics whatever label its URI carries, and only that view\'s', () => {
        const diagnostics = vscode.languages.createDiagnosticCollection('odoo-views-test');
        const problem = [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'stays off')];
        const sameView = viewUri('shop-18', 12, 'view-12');
        const otherView = viewUri('shop-18', 13, 'view-13');
        const otherDb = viewUri('shop-17', 12, 'view-12');
        for (const entry of [uri, sameView, otherView, otherDb]) {
            diagnostics.set(entry, problem);
        }
        clearViewDiagnostics(diagnostics, 'shop-18', 12);
        assert.deepStrictEqual([uri, sameView, otherView, otherDb].map(entry => diagnostics.has(entry)), [false, false, true, true]);
        diagnostics.dispose();
    });

    test('reports views changed elsewhere so clean editors reload', () => {
        const provider = new ViewFileSystemProvider(new FakeBackend(), { onSaved: () => undefined });
        const changed: vscode.FileChangeEvent[][] = [];
        provider.onDidChangeFile(events => changed.push(events));
        provider.notifyChanged([]);
        provider.notifyChanged([uri]);
        assert.deepStrictEqual(changed.map(events => events.map(event => event.uri.toString())), [[uri.toString()]]);
    });
});
