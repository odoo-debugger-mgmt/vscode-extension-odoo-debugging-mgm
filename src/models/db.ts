import { ModuleModel } from "./module";

export class DatabaseModel {
    projectName: string;
    isItABackup: boolean;
    createdAt: Date;
    modules: ModuleModel[];
    isSelected: boolean = false;
    constructor(
        createdAt: Date,
        modules: ModuleModel[] = [],
        isItABackup: boolean = false,
        isSelected: boolean = false
    ) {
        this.createdAt = createdAt;
        this.modules = modules;
        this.isItABackup = isItABackup;
        this.isSelected = isSelected;
    }
}

