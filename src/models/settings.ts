export class SettingsModel {
    debuggerName: string = "odoo:18.0";
    debuggerVersion: string = "1.0.0";
    portNumber: number = 8018;
    shellPortNumber: number = 5018;
    limitTimeReal: number = 0;
    limitTimeCpu: number = 0;
    maxCronThreads: number = 0;
    isTestingEnabled: boolean = false;
    testFile: string = "";
    testTags: string = "";
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
    constructor(data?: Partial<SettingsModel>) {
        if (data) {
            Object.assign(this, data);
        }
    }
}
