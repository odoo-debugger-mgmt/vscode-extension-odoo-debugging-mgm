/**
 * Runtime settings shape shared by versions (paths, ports, params).
 */
export class SettingsModel {
    debuggerName: string = "odoo:19.0";
    debuggerVersion: string = "1.0.0";
    portNumber: number = 8019;
    shellPortNumber: number = 5019;
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
