export type ModuleState = 'install' | 'upgrade' | 'none';

export interface InstalledModuleInfo {
    id: number;
    name: string;
    shortdesc: string;
    installed_version: string | null;
    latest_version: string | null;
    state: string;
    application: boolean;
}

export class ModuleModel {
    name: string;
    state: ModuleState;
    isInstalled: boolean;

    constructor(name: string, state: ModuleState = 'none', isInstalled: boolean = false) {
        this.name = name;
        this.state = state;
        this.isInstalled = isInstalled;
    }
}
