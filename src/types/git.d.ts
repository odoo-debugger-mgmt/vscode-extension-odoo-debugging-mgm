import * as vscode from 'vscode';

export interface GitExtension {
    readonly enabled: boolean;
    readonly onDidChangeEnablement: vscode.Event<boolean>;
    getAPI(version: 1): API;
}

export interface API {
    readonly git: Git;
    readonly repositories: Repository[];
}

export interface Git {
    readonly path: string;
}

export interface BranchQuery {
    readonly remote?: boolean;
    readonly pattern?: string;
}

export type BranchType = 'local' | 'remote';

export interface Branch {
    readonly name?: string;
    readonly type: BranchType;
    readonly commit?: string;
}

export interface Repository {
    readonly rootUri: vscode.Uri;
    checkout(treeish: string, detached?: boolean): Promise<void>;
    getBranches(query?: BranchQuery): Promise<Branch[]>;
}
