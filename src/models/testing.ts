export interface TestTag {
    id: string;
    value: string;
    state: 'include' | 'exclude' | 'disabled';
    type: 'tag' | 'module' | 'class' | 'method';
}

export type LogLevel = 'disabled' | 'critical' | 'error' | 'warn' | 'debug';

export interface TestingConfig {
    isEnabled: boolean;
    testTags: TestTag[];
    testFile?: string;
    stopAfterInit: boolean;
    logLevel: LogLevel;
    // Store the module states before enabling tests
    savedModuleStates?: Array<{name: string, state: string}>;
}

export class TestingConfigModel implements TestingConfig {
    public isEnabled: boolean;
    public testTags: TestTag[];
    public testFile?: string;
    public stopAfterInit: boolean;
    public logLevel: LogLevel;
    public savedModuleStates?: Array<{name: string, state: string}>;

    constructor(
        isEnabled: boolean = false,
        testTags: TestTag[] = [],
        testFile?: string,
        stopAfterInit: boolean = false,
        logLevel: LogLevel = 'disabled',
        savedModuleStates?: Array<{name: string, state: string}>
    ) {
        this.isEnabled = isEnabled;
        this.testTags = testTags;
        this.testFile = testFile;
        this.stopAfterInit = stopAfterInit;
        this.logLevel = logLevel;
        this.savedModuleStates = savedModuleStates;
    }

    /**
     * Generates the test tags string for the --test-tags option
     * Converts user-friendly format to proper Odoo syntax: [-][tag][/module][:class][.method]
     */
    getTestTagsString(): string {
        const activeTags = this.testTags.filter(tag => tag.state !== 'disabled');
        if (activeTags.length === 0) {
            return '';
        }

        return activeTags
            .map(tag => {
                const prefix = tag.state === 'exclude' ? '-' : '';
                let formattedValue = '';

                switch (tag.type) {
                    case 'tag':
                        // Simple tags remain as-is: "post_install"
                        formattedValue = tag.value;
                        break;
                    case 'module':
                        // Module tests need "/" prefix: "/account"
                        formattedValue = `/${tag.value}`;
                        break;
                    case 'class':
                        // Class tests: user enters "TestSalesAccessRights", we format as ":TestSalesAccessRights"
                        formattedValue = `:${tag.value}`;
                        break;
                    case 'method':
                        // Method tests: user enters "test_workflow_invoice", we format as ".test_workflow_invoice"
                        formattedValue = `.${tag.value}`;
                        break;
                    default:
                        formattedValue = tag.value;
                }

                return prefix + formattedValue;
            })
            .join(',');
    }
}
