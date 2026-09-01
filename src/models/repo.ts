/**
 * Repository model: a git repo belonging to a project.
 */

/**
 * How a repository satisfies a database's branch assignment.
 *
 * `checkout` runs `git checkout` in the one working copy - the original
 * behaviour, and right for ordinary development where a feature branch simply
 * follows staging and prod.
 *
 * `worktree` gives each branch its own directory so two versions can run
 * against their own custom code at once. Opted into per repository, because it
 * is a per-repository situation: usually one repo is mid-upgrade and the rest
 * are not.
 */
export type RepoBranchMode = 'checkout' | 'worktree';

export function normalizeBranchMode(value: unknown): RepoBranchMode {
    return value === 'worktree' ? 'worktree' : 'checkout';
}

export class RepoModel {
    name: string;
    path: string;
    isSelected: boolean = false;
    addedAt?: string;
    branchMode: RepoBranchMode;
    constructor(
        name: string,
        path: string,
        isSelected: boolean = false,
        addedAt?: string,
        branchMode: RepoBranchMode = 'checkout'
    ) {
        this.name = name;
        this.path = path;
        this.isSelected = isSelected;
        this.addedAt = addedAt ?? new Date().toISOString();
        this.branchMode = normalizeBranchMode(branchMode);
    }
}
