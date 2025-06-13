export class RepoModel {
    name: string;
    path: string;
    isSelected: boolean = false;
    constructor(
        name: string,
        path: string,
        isSelected: boolean = false
    ) {
        this.name = name;
        this.path = path;
        this.isSelected = isSelected;
    }
}
