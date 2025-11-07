import { DatabaseModel } from "./db";
import { RepoModel } from "./repo";
import { TestingConfigModel } from "./testing";
import { randomUUID } from "crypto";
export class ProjectModel {
    name: string; // project sh name
    createdAt: string | Date;
    dbs: DatabaseModel[];
    repos: RepoModel[] = [];
    isSelected: boolean = false;
    uid: string; // unique identifier for the project
    includedPsaeInternalPaths: string[] = []; // Manually included psae-internal paths
    testingConfig: TestingConfigModel; // Testing configuration
    constructor(
        name: string,
        createdAt: string | Date,
        dbs: DatabaseModel[] = [],
        repos: RepoModel[] = [],
        isSelected: boolean = false,
        uid: string = randomUUID(),
        includedPsaeInternalPaths: string[] = [],
        testingConfig: TestingConfigModel = new TestingConfigModel()
    ) {
        this.name = name;
        this.dbs = dbs;
        this.repos = repos;
        this.createdAt = createdAt;
        this.isSelected = isSelected;
        this.uid = uid;
        this.includedPsaeInternalPaths = includedPsaeInternalPaths;
        this.testingConfig = testingConfig;
    }
}
