import type { CommandDeps } from './index';
import { registerCommand } from './registerCommand';

export function registerViewDoctorCommands(deps: CommandDeps): void {
    const { context, providers } = deps;

    context.subscriptions.push(registerCommand('viewDoctor.refresh', () => providers.views.refresh()));
}
