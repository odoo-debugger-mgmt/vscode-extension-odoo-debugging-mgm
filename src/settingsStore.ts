import { SettingsModel } from './models/settings';
import { readFromFile, DebuggerData, showError, getWorkspacePath } from './utils';
import { ProjectModel } from './models/project';
import { modify, applyEdits } from "jsonc-parser";
import fs from 'fs';
import path from 'path';


export class SettingsStore {
    /**
     * Helper function to read raw file content for JSON modification
     */
    private static async readRawFileContent(fileName: string): Promise<string | null> {
        const workspacePath = getWorkspacePath();
        if (!workspacePath) {
            return null;
        }

        try {
            const filePath = path.join(workspacePath, '.vscode', fileName);
            if (!fs.existsSync(filePath)) {
                return null;
            }
            return fs.readFileSync(filePath, 'utf-8');
        } catch (error) {
            showError(`Failed to read raw content from ${fileName}: ${error}`);
            return null;
        }
    }

    static async get(fileName: string): Promise<DebuggerData> {
        const data = await readFromFile(fileName);
        if (!data) {
            throw new Error(`Error reading file: ${fileName}`);
        }
        return data;
    }
    static async saveWithComments(value: any, jsonPath: any[], fileName: string, options: any = {}): Promise<void> {
        const workspacePath = getWorkspacePath();
        if (!workspacePath) {
            return;
        }

        const rawData = await this.readRawFileContent(fileName);
        if (!rawData) {
            return;
        }

        const filePath = path.join(workspacePath, '.vscode', fileName);
        let edits = modify(rawData, jsonPath, value, options);
        const updatedJson = applyEdits(rawData, edits);
        fs.writeFileSync(filePath, updatedJson, 'utf8');
    }

    /**
     * Saves the entire data object to file
     */
    static async saveWithoutComments(data: DebuggerData, fileName: string = 'odoo-debugger-data.json'): Promise<void> {
        const workspacePath = getWorkspacePath();
        if (!workspacePath) {
            return;
        }

        const filePath = path.join(workspacePath, '.vscode', fileName);
        const jsonString = JSON.stringify(data, null, 4);
        fs.writeFileSync(filePath, jsonString, 'utf8');
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
        await this.saveWithoutComments(data);
    }

    static async getProjects(): Promise<ProjectModel[]> {
        const data = await this.load();
        return data.projects || [];
    }

    static async updateProjects(projects: ProjectModel[]): Promise<void> {
        const data = await this.load();
        data.projects = projects;
        await this.saveWithoutComments(data);
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
