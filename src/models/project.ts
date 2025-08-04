import { DatabaseModel } from "./db";
import { RepoModel } from "./repo";
import { randomUUID } from "crypto";
export class ProjectModel {
    name: string; // project sh name
    createdAt: Date;
    dbs: DatabaseModel[];
    repos: RepoModel[] = [];
    isSelected: boolean = false;
    uid: string; // unique identifier for the project
    includedPsaeInternalPaths: string[] = []; // Manually included psae-internal paths
    constructor(
        name: string,
        createdAt: Date,
        dbs: DatabaseModel[] = [],
        repos: RepoModel[] = [],
        isSelected: boolean = false,
        uid: string = randomUUID(),
        includedPsaeInternalPaths: string[] = []
    ) {
        this.name = name;
        this.dbs = dbs;
        this.repos = repos;
        this.createdAt = createdAt;
        this.isSelected = isSelected;
        this.uid = uid;
        this.includedPsaeInternalPaths = includedPsaeInternalPaths;
    }
}
