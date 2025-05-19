export type ModuleState = 'install' | 'upgrade' | 'none';
export class ModuleModel {
    name: string;
    state: ModuleState;
    constructor(name: string, state: ModuleState = 'none') {
        this.name = name;
        this.state = state;
    }
}
