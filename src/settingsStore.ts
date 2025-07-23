import { SettingsModel } from './models/settings';
import { readFromFile, DebuggerData, showError } from './utils';
import { ProjectModel } from './models/project';
import { parse, modify, applyEdits } from "jsonc-parser";
import fs from 'fs';


export class SettingsStore {
    static async get(fileName: string): Promise<DebuggerData> {
        const data = await readFromFile(fileName);
        if (!data) {
            throw new Error(`Error reading file: ${fileName}`);
        }
        return parse(data, undefined, { allowTrailingComma: true });
    }
    static async save(value: any, path: any[], fileName: string, options: any = {}): Promise<void> {
        const data = await readFromFile(fileName);
        if (!data) {
            return;
        }
        let edits = modify(data, path, value, options);
        const updatedJson = applyEdits(data, edits);
        fs.writeFileSync(fileName, updatedJson, 'utf8');
    }
    static async load(): Promise<DebuggerData> {
        const data = await readFromFile('odoo-debugger-data.json') || {};

        return {
            settings: Object.assign(new SettingsModel(), data.settings || {}),
            projects: data.projects || [],
            // ...add other top-level keys if needed
        };
    }

    static async getSettings(): Promise<SettingsModel> {
        const data = await this.load();
        return data.settings;
    }

    static async updateSettings(partial: Partial<SettingsModel>): Promise<void> {
        const data = await this.load();
        const updated = Object.assign(new SettingsModel(), data.settings, partial);
        data.settings = updated;
        await this.save(data);
    }

    static async getProjects(): Promise<ProjectModel[]> {
        const data = await this.load();
        return data.projects || [];
    }

    static async updateProjects(projects: ProjectModel[]): Promise<void> {
        const data = await this.load();
        data.projects = projects;
        await this.save(data);
    }

    /**
     * Gets the currently selected project with validation
     */
    static async getSelectedProject(): Promise<{ data: DebuggerData; project: ProjectModel } | null> {
        const data = await this.get('odoo-debugger-data.json');

        const projects: ProjectModel[] = data.projects;
        if (!projects || projects.length === 0) {
            showError('Error reading projects, please create a project first');
            return null;
        }

        if (typeof projects !== 'object') {
            showError('Error reading projects');
            return null;
        }

        const project = projects.find((p: ProjectModel) => p.isSelected === true);
        if (!project) {
            showError('No project selected');
            return null;
        }

        return { data, project };
    }
}
