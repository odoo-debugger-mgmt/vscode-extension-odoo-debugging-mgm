import * as vscode from 'vscode';

/**
 * Shared base for the extension's tree data providers: owns the change
 * emitter (and disposes it), and exposes refresh() supporting both full and
 * element-scoped updates. Register instances in context.subscriptions so the
 * emitter is cleaned up on deactivation.
 */
export abstract class BaseTreeProvider<T> implements vscode.TreeDataProvider<T>, vscode.Disposable {
    protected readonly _onDidChangeTreeData = new vscode.EventEmitter<T | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<T | undefined | null | void> = this._onDidChangeTreeData.event;

    /** Refreshes the whole tree, or only `element` when provided. */
    refresh(element?: T): void {
        this._onDidChangeTreeData.fire(element);
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }

    abstract getTreeItem(element: T): vscode.TreeItem | Thenable<vscode.TreeItem>;
    abstract getChildren(element?: T): vscode.ProviderResult<T[]>;
}
