import Module from "module";
import { DatabaseModel } from "./db";
import { RepoModel } from "./repo";
export class ProjectModel {
    name: string; // project sh name
    createdAt: Date;
    dbs: DatabaseModel[];
    repos: RepoModel[] = [];
    isSelected: boolean = false;
    constructor(
        name: string,
        createdAt: Date,
        dbs: DatabaseModel[] = [],
        repos: RepoModel[] = [],
        isSelected: boolean = false
    ) {
        this.name = name;
        this.dbs = dbs;
        this.repos = repos;
        this.createdAt = createdAt;
        this.isSelected = isSelected;
    }
}
