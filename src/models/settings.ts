export class SettingsModel {
    portNumber: number;
    shellPortNumber: number;
    limitTimeReal: number;
    limitTimeCpu: number;
    maxCronThreads: number;
    isTestingEnabled: boolean;
    testFile: string;
    testTags: string;
    extraParams: string;
    devMode: string;
    dumpsFolder: string = "/dumps";
    odooPath: string = "./odoo";
    enterprisePath: string = "./enterprise";
    customAddonsPath: string = "./custom-addons";
    venvPath: string = "./venv";
    constructor(
        portNumber: number = 8018,
        shellPortNumber: number = 5018,
        limitTimeReal: number = 0,
        limitTimeCpu: number = 0,
        maxCronThreads: number = 0,
        isTestingEnabled: boolean = false,
        testFile: string = "",
        testTags: string = "",
        extraParams: string = "--log-handler odoo.addons.base.models.ir_attachment:WARNING",
        devMode: string = "--dev all",
        dumpsFolder: string = "/dumps",
        odooPath: string = "./odoo",
        enterprisePath: string = "./enterprise",
        customAddonsPath: string = "./custom-addons",
        venvPath: string = "./venv"
    ) {
        this.portNumber = portNumber;
        this.shellPortNumber = shellPortNumber;
        this.limitTimeReal = limitTimeReal;
        this.limitTimeCpu = limitTimeCpu;
        this.maxCronThreads = maxCronThreads;
        this.isTestingEnabled = isTestingEnabled;
        this.testFile = testFile;
        this.testTags = testTags;
        this.extraParams = extraParams;
        this.devMode = devMode;
        this.dumpsFolder = dumpsFolder;
        this.odooPath = odooPath;
        this.enterprisePath = enterprisePath;
        this.customAddonsPath = customAddonsPath;
        this.venvPath = venvPath;
    }
}
