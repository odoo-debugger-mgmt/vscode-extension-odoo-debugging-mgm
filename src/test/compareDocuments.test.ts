import * as assert from 'assert';
import { CompareDocuments, COMPARE_SCHEME } from '../views/compareDocuments';

suite('Compare documents', () => {
    test('a snapshot reads back as it was stored, under its own uri', () => {
        const docs = new CompareDocuments();
        const a = docs.snapshotUri('left', 'shop__cp_1 · view.xml', '<form/>');
        const b = docs.snapshotUri('left', 'shop__cp_1 · view.xml', '<tree/>');
        assert.strictEqual(a.scheme, COMPARE_SCHEME);
        assert.notStrictEqual(a.toString(), b.toString());
        assert.strictEqual(docs.provideTextDocumentContent(a), '<form/>');
        assert.strictEqual(docs.provideTextDocumentContent(b), '<tree/>');
    });

    test('an unknown uri reads as a short explanation, not an error', () => {
        const docs = new CompareDocuments();
        const text = docs.provideTextDocumentContent(docs.snapshotUri('x', 'y', 'z').with({ query: 'n=999999' }));
        assert.ok(/no longer available/i.test(text));
    });

    test('a slash in the label does not split the path', () => {
        const docs = new CompareDocuments();
        const uri = docs.snapshotUri('left', 'a/b?c', 'x');
        assert.strictEqual(uri.path.split('/').length, 3);
        assert.strictEqual(docs.provideTextDocumentContent(uri), 'x');
    });
});
