import {ResultAsync} from 'neverthrow';
import {match} from 'ts-pattern';
import * as vscode from 'vscode';
import {authHandler} from './auth';
import {QwenLanguageModelChatProvider} from './provider';
import {qwenClient} from './qwen-client';

const provider = new QwenLanguageModelChatProvider();

export async function activate(context: vscode.ExtensionContext) {
  console.log('Qwen Copilot extension activated');

  authHandler.setSecretStorage(context.secrets);
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider('qwen', provider),
  );

  await authHandler.loadCredentials();

  const commands: Array<[string, () => Promise<void>]> = [
    ['qwen-copilot.authenticate', authenticate],
    ['qwen-copilot.logout', logout],
    ['qwen-copilot.manage', manage],
  ];

  for (const [command, handler] of commands) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, handler),
    );
  }
}

export function deactivate() {
  console.log('Qwen Copilot extension deactivated');
  qwenClient.reset();
}

async function authenticate() {
  return runWithUiError('Authentication', async () => {
    if (authHandler.isAuthenticated()) {
      vscode.window.showInformationMessage('Already authenticated with Qwen.');
      return;
    }

    await runDeviceFlowLogin();
  });
}

async function logout() {
  return runWithUiError('Logout', async () => {
    await authHandler.clearCredentials();
    qwenClient.reset();
    vscode.window.showInformationMessage('Logged out from Qwen.');
  });
}

async function manage() {
  const isAuthed = authHandler.isAuthenticated();
  const options: vscode.QuickPickItem[] = [
    {
      label: 'Authenticate',
      description: isAuthed
        ? 'Already authenticated. Select to re-authenticate in browser'
        : 'Start Qwen device login in browser',
    },
    {
      label: 'Logout',
      description: isAuthed ? 'Clear stored Qwen tokens' : 'No active session',
    },
  ];

  const selection = await vscode.window.showQuickPick(options, {
    placeHolder: 'Manage Qwen Copilot authentication',
  });

  await match(selection?.label)
    .with('Authenticate', () =>
      runWithUiError('Authentication', runDeviceFlowLogin),
    )
    .with('Logout', () => logout())
    .otherwise(() => Promise.resolve());
}

async function runDeviceFlowLogin() {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Qwen OAuth',
      cancellable: true,
    },
    async (progress, cancellationToken) => {
      progress.report({message: 'Requesting device authorization...'});

      const credentials = await authHandler.startDeviceFlow({
        cancellationToken,
        onAuthUri: async ({verificationUriComplete}) => {
          await vscode.env.openExternal(
            vscode.Uri.parse(verificationUriComplete),
          );
          progress.report({message: 'Complete sign-in in your browser...'});
        },
        onProgress: message => progress.report({message}),
      });

      await authHandler.saveCredentials(credentials);
      qwenClient.reset();
      await qwenClient.initialize();
      vscode.window.showInformationMessage(
        'Successfully authenticated with Qwen!',
      );
    },
  );
}

function runWithUiError(
  action: string,
  task: () => Promise<void>,
): Promise<void> {
  return ResultAsync.fromPromise(task(), error => error)
    .mapErr(error => {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`${action} error: ${message}`);
      return error;
    })
    .match(
      () => undefined,
      () => undefined,
    );
}
