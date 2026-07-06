import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	test('extension activates', async function () {
		this.timeout(30000);
		const extension = vscode.extensions.getExtension('AhmadMansour.odoo-devtools-vscode');
		assert.ok(extension, 'extension not found in test host');
		await extension.activate();
		assert.strictEqual(extension.isActive, true);
	});

	test('core commands are registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		const expected = [
			'dbSelector.create',
			'dbSelector.selectDb',
			'odoo.createVersion',
			'odoo.setActiveVersion',
			'projectSelector.create',
			'odoo.startServer',
			'odoo.startShell'
		];
		for (const command of expected) {
			assert.ok(commands.includes(command), `command not registered: ${command}`);
		}
	});
});
