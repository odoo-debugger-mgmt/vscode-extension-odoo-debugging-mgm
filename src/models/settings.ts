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
        devMode: string = "--dev all"
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
    }
}

