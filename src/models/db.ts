import { ModuleModel } from "./module";

export class DatabaseModel {
    name: string;
    isItABackup: boolean;
    createdAt: Date;
    modules: ModuleModel[];
    isSelected: boolean = false;
    sqlFilePath: string = '';
    id: string = '';
    isExisting: boolean = false;
    branchName: string = '';
    odooVersion: string = '';
    constructor(
        name: string,
        createdAt: Date,
        modules: ModuleModel[] = [],
        isItABackup: boolean = false,
        isSelected: boolean = false,
        sqlFilePath: string = '',
        isExisting: boolean = false,
        branchName: string = '',
        odooVersion: string = ''
    ) {
        this.name = name;
        this.createdAt = createdAt;
        this.modules = modules;
        this.isItABackup = isItABackup;
        this.isSelected = isSelected;
        this.sqlFilePath = sqlFilePath;
        this.isExisting = isExisting;
        this.branchName = branchName;
        this.odooVersion = odooVersion;
        if(isExisting) {
            this.id = name;
        } else {
            this.id = `${name}-${createdAt.toISOString().split('T')[0]}-${createdAt.toTimeString().split(' ')[0]}`;
        }
    }
}
