/**
 * Runtime settings shape shared by versions (paths, ports, params).
 */
export class SettingsModel {
    // Identity is derived from the version's branch (see versionIdentity.ts);
    // these blanks mark "not derived yet".
    debuggerName: string = "";
    debuggerVersion: string = "1.0.0";
    portNumber: number = 0;
    shellPortNumber: number = 0;
    limitTimeReal: number = 0;
    limitTimeCpu: number = 0;
    maxCronThreads: number = 0;
    extraParams: string = "--log-handler,odoo.addons.base.models.ir_attachment:WARNING";
    devMode: string = "--dev=all";
    dumpsFolder: string = "/dumps";
    odooPath: string = "./odoo";
    enterprisePath: string = "./enterprise";
    designThemesPath: string = "./design-themes";
    customAddonsPath: string = "./custom-addons";
    pythonPath: string = "./venv/bin/python";
    subModulesPaths: string = "";
    installApps: string = "";
    upgradeApps: string = "";
    postSwitchCommands: string[] = [];
    managedPaths: string[] = [];
    constructor(data?: Partial<SettingsModel>) {
        if (data) {
            Object.assign(this, data);
        }
        this.postSwitchCommands = Array.isArray(this.postSwitchCommands) ? this.postSwitchCommands : [];
        this.managedPaths = Array.isArray(this.managedPaths) ? this.managedPaths : [];
    }
}
