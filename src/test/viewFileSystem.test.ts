import * as assert from 'assert';
import * as vscode from 'vscode';
import { ViewFileSystemProvider, parseViewUri, viewUri, type ViewRef } from '../views/viewFileSystem';
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

    test('reads the arch as UTF-8 and dates it by write_date, at a constant size', async () => {
        const backend = new FakeBackend();
        const provider = new ViewFileSystemProvider(backend, { onSaved: () => undefined });
        assert.strictEqual(Buffer.from(await provider.readFile(uri)).toString('utf-8'), '<data>é</data>');
        const before = await provider.stat(uri);
        assert.deepStrictEqual([before.type, before.mtime, before.size], [vscode.FileType.File, 1000, 0]);

        // Edited in Odoo's own UI meanwhile: the date moves, so VS Code sees a newer file.
        backend.writeDates.set(12, 2000);
        assert.strictEqual((await provider.stat(uri)).mtime, 2000);
        assert.strictEqual((await provider.stat(uri)).size, 0, 'a size that changed after reading would fake a conflict');
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

    test('views cannot be created, deleted, renamed or listed', () => {
        const provider = new ViewFileSystemProvider(new FakeBackend(), { onSaved: () => undefined });
        assert.throws(() => provider.delete(uri), vscode.FileSystemError);
        assert.throws(() => provider.rename(uri, uri), vscode.FileSystemError);
        assert.throws(() => provider.createDirectory(uri), vscode.FileSystemError);
        assert.throws(() => provider.readDirectory(uri), vscode.FileSystemError);
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
