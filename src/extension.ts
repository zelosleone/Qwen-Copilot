/**
 * VS Code extension entry point
 * Registers the Qwen Language Model Chat Provider and commands
 */

import * as vscode from 'vscode'
import { QwenLanguageModelChatProvider } from './provider'
import { authHandler } from './auth'
import { qwenClient } from './qwen-client'

const provider = new QwenLanguageModelChatProvider()

export async function activate(context: vscode.ExtensionContext) {
  console.log('Qwen Copilot extension activated')

  authHandler.setSecretStorage(context.secrets)

  const disposable = vscode.lm.registerLanguageModelChatProvider('qwen', provider)
  context.subscriptions.push(disposable)

  await authHandler.loadCredentials()

  context.subscriptions.push(
    vscode.commands.registerCommand('qwen-copilot.authenticate', async () => {
      await commandAuthenticate()
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('qwen-copilot.logout', async () => {
      await commandLogout()
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('qwen-copilot.manage', async () => {
      await commandManage()
    }),
  )
}

export function deactivate() {
  console.log('Qwen Copilot extension deactivated')
  qwenClient.reset()
}

/**
 * Authenticate command
 * Initiates OAuth flow or shows authentication instructions
 */
async function commandAuthenticate() {
  try {
    if (authHandler.isAuthenticated()) {
      vscode.window.showInformationMessage('Already authenticated with Qwen.')
      return
    }

    await runDeviceFlowLogin()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    vscode.window.showErrorMessage(`Authentication error: ${message}`)
  }
}

/**
 * Logout command
 * Clears stored credentials
 */
async function commandLogout() {
  try {
    await authHandler.clearCredentials()
    qwenClient.reset()
    vscode.window.showInformationMessage('Logged out from Qwen.')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    vscode.window.showErrorMessage(`Logout error: ${message}`)
  }
}

async function commandManage() {
  const isAuthed = authHandler.isAuthenticated()
  const items: vscode.QuickPickItem[] = isAuthed
    ? [
        { label: 'Sign Out', description: 'Clear stored Qwen tokens' },
        { label: 'Re-authenticate', description: 'Start Qwen device login in browser' },
      ]
    : [
        { label: 'Sign In', description: 'Start Qwen device login in browser' },
      ]

  const selection = await vscode.window.showQuickPick(items, {
    placeHolder: 'Manage Qwen Copilot authentication',
  })

  if (!selection) {
    return
  }

  if (selection.label === 'Sign Out') {
    await commandLogout()
    return
  }

  await runDeviceFlowLogin()
}

async function runDeviceFlowLogin() {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Qwen OAuth',
      cancellable: true,
    },
    async (progress, cancellationToken) => {
      progress.report({ message: 'Requesting device authorization...' })
      const credentials = await authHandler.startDeviceFlow({
        cancellationToken,
        onAuthUri: async ({ verificationUriComplete, userCode }) => {
          await vscode.env.openExternal(vscode.Uri.parse(verificationUriComplete))
          await vscode.window.showInformationMessage(
            `Authorize Qwen using code: ${userCode}`,
            'Copy Code',
          ).then((action) => {
            if (action === 'Copy Code') {
              void vscode.env.clipboard.writeText(userCode)
            }
          })
        },
        onProgress: (message) => progress.report({ message }),
      })

      await authHandler.saveCredentials(credentials)
      qwenClient.reset()
      await qwenClient.initialize()
      vscode.window.showInformationMessage('Successfully authenticated with Qwen!')
    },
  )
}
