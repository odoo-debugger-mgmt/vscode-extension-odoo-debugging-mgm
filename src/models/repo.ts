export class RepoModel {
    name: string;
    path: string;
    isSelected: boolean = false;
    addedAt?: string;
    constructor(
        name: string,
        path: string,
        isSelected: boolean = false,
        addedAt?: string
    ) {
        this.name = name;
        this.path = path;
        this.isSelected = isSelected;
        this.addedAt = addedAt ?? new Date().toISOString();
    }
}
