export class RepoModel {
    name: string; // project sh name
    repoLink: string;
    repoPath: string;
    createdAt: Date;
    currentBranch: string;
    repoId: string;
    constructor(name: string, repoLink: string, repoPath: string, createdAt: Date, currentBranch: string) {
        this.currentBranch = currentBranch;
        this.name = name;
        this.repoLink = repoLink;
        this.repoPath = repoPath;
        this.createdAt = createdAt;
    }
}
