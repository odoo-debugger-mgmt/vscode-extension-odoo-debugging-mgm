import Module from "module";
import { DatabaseModel } from "./db";
export class ProjectModel {
    name: string; // project sh name
    repoPath: string;
    createdAt: Date;
    dbs: DatabaseModel[];
    isSelected: boolean = false;
    constructor(
        name: string,
        repoPath: string,
        createdAt: Date,
        dbs: DatabaseModel[] = [],
        isSelected: boolean = false
    ) {
        this.name = name;
        this.repoPath = repoPath;
        this.dbs = dbs;
        this.createdAt = createdAt;
        this.isSelected = isSelected;
    }
}
