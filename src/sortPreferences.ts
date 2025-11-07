import * as vscode from 'vscode';

export class SortPreferences {
    private readonly prefix = 'odooDebugger.sort.';

    constructor(private readonly workspaceState: vscode.Memento) {}

    get(viewId: string, fallback: string): string {
        return this.workspaceState.get<string>(`${this.prefix}${viewId}`, fallback) ?? fallback;
    }

    async set(viewId: string, optionId: string): Promise<void> {
        await this.workspaceState.update(`${this.prefix}${viewId}`, optionId);
    }
}
