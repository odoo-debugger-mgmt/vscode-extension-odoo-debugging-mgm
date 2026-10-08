/**
 * Read-only documents for one side of a comparison: a checkpoint's view, and
 * (Part C) a method, an XML element or a record. Each snapshot gets its own
 * uri, so two compares never share a document.
 */
import * as vscode from 'vscode';

export const COMPARE_SCHEME = 'odoo-compare';

export class CompareDocuments implements vscode.TextDocumentContentProvider {
    private readonly contents = new Map<string, string>();
    private counter = 0;

    snapshotUri(side: string, label: string, content: string): vscode.Uri {
        const n = ++this.counter;
        const safeLabel = label.replace(/\//g, '∕');
        const uri = vscode.Uri.from({ scheme: COMPARE_SCHEME, path: `/${side}/${safeLabel}`, query: `n=${n}` });
        this.contents.set(uri.toString(), content);
        return uri;
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.contents.get(uri.toString())
            ?? 'This comparison is no longer available. Run the compare again.';
    }
}

export const compareDocuments = new CompareDocuments();
