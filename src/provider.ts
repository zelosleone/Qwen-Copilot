/**
 * VS Code Language Model Chat Provider implementation for Qwen
 * Implements the LanguageModelChatProvider interface
 */

import * as vscode from 'vscode'
import { qwenClient } from './qwen-client'
import { authHandler } from './auth'
import { QWEN_MODELS } from './types'
import type { QwenMessage, QwenModelId, QwenTool, QwenToolChoice } from './types'

export class QwenLanguageModelChatProvider implements vscode.LanguageModelChatProvider {
  /**
   * Provide information about available language models
   */
  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    return Object.values(QWEN_MODELS).map((model) => ({
      id: model.id,
      name: model.displayName,
      family: model.family,
      version: model.version,
      detail: 'Qwen',
      maxInputTokens: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: {
        toolCalling: true,
      },
    }))
  }

  /**
   * Provide language model chat response (streaming)
   * This is called when a user sends a message to the language model
   */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    try {
      if (!authHandler.isAuthenticated()) {
        const action = await vscode.window.showInformationMessage(
          'Qwen Copilot needs authentication before it can respond.',
          'Manage Sign-In',
        )
        if (action === 'Manage Sign-In') {
          await vscode.commands.executeCommand('qwen-copilot.manage')
        }
        throw new Error('Not authenticated. Use "Qwen Copilot: Manage" to sign in.')
      }

      if (!qwenClient.isReady()) {
        await qwenClient.initialize()
      }

      const qwenMessages = this.convertMessages(messages)
      const tools = this.convertTools(options.tools)
      const toolChoice = this.resolveToolChoice(options.toolMode, tools)
      const modelId = model.id as QwenModelId
      const maxTokens = this.resolveMaxTokens(model, options.modelOptions)
      const temperature = this.resolveTemperature(options.modelOptions)
      const stream = qwenClient.streamChatCompletion({
        model: modelId,
        messages: qwenMessages,
        tools,
        toolChoice,
        maxTokens,
        temperature,
      })

      for await (const chunk of stream) {
        if (token.isCancellationRequested) {
          break
        }

        if (chunk.type === 'text') {
          progress.report(new vscode.LanguageModelTextPart(chunk.text))
        } else {
          progress.report(
            new vscode.LanguageModelToolCallPart(chunk.callId, chunk.name, chunk.input),
          )
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Qwen chat error: ${message}`)
    }
  }

  /**
   * Provide token count estimation for a message
   */
  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    try {
      if (typeof text === 'string') {
        return Math.ceil(text.length / 4)
      }

      const qwenMessages = this.convertMessages([text])
      return await qwenClient.countTokens(qwenMessages)
    } catch (error) {
      console.error('Token count error:', error)
      const content = typeof text === 'string' ? text : ''
      return Math.ceil(content.length / 4)
    }
  }

  /**
   * Convert VS Code message format to Qwen API format
   */
  private convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): QwenMessage[] {
    const converted: QwenMessage[] = []

    for (const msg of messages) {
      const role =
        msg.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user'
      let textBuffer = ''
      const toolCalls: vscode.LanguageModelToolCallPart[] = []

      for (const part of msg.content ?? []) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textBuffer += part.value
          continue
        }

        if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(part)
          continue
        }

        if (part instanceof vscode.LanguageModelToolResultPart) {
          if (textBuffer.length > 0) {
            converted.push(this.buildTextMessage(role, textBuffer, msg.name))
            textBuffer = ''
          }

          converted.push({
            role: 'tool',
            tool_call_id: part.callId,
            content: this.serializeToolResult(part),
          })
          continue
        }

        if (part instanceof vscode.LanguageModelPromptTsxPart) {
          textBuffer += this.safeJson(part.value)
          continue
        }

        if (part instanceof vscode.LanguageModelDataPart) {
          textBuffer += this.renderDataPart(part)
          continue
        }

        textBuffer += String(part)
      }

      if (role === 'assistant' && toolCalls.length > 0) {
        converted.push(this.buildAssistantToolCallMessage(toolCalls, textBuffer, msg.name))
      } else if (textBuffer.length > 0) {
        converted.push(this.buildTextMessage(role, textBuffer, msg.name))
      }
    }

    return converted
  }

  private buildTextMessage(
    role: 'user' | 'assistant',
    text: string,
    name?: string,
  ): QwenMessage {
    return name ? { role, content: text, name } : { role, content: text }
  }

  private buildAssistantToolCallMessage(
    toolCalls: vscode.LanguageModelToolCallPart[],
    text: string,
    name?: string,
  ): QwenMessage {
    const callPayload = toolCalls.map((call) => ({
      id: call.callId,
      type: 'function' as const,
      function: {
        name: call.name,
        arguments: this.safeJson(call.input ?? {}),
      },
    }))

    const message = {
      role: 'assistant',
      content: text.length > 0 ? text : null,
      tool_calls: callPayload,
      ...(name ? { name } : {}),
    } as QwenMessage

    return message
  }

  private serializeToolResult(part: vscode.LanguageModelToolResultPart): string {
    const chunks = part.content.map((entry) => {
      if (entry instanceof vscode.LanguageModelTextPart) {
        return entry.value
      }
      if (entry instanceof vscode.LanguageModelPromptTsxPart) {
        return this.safeJson(entry.value)
      }
      if (entry instanceof vscode.LanguageModelDataPart) {
        return this.renderDataPart(entry)
      }
      return this.safeJson(entry)
    })

    return chunks.join('')
  }

  private renderDataPart(part: vscode.LanguageModelDataPart): string {
    const mime = part.mimeType || 'application/octet-stream'
    const buffer = Buffer.from(part.data)

    if (mime.startsWith('text/')) {
      return buffer.toString('utf-8')
    }

    if (mime === 'application/json') {
      return buffer.toString('utf-8')
    }

    return `[${mime} base64:${buffer.toString('base64')}]`
  }

  private safeJson(value: unknown): string {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  private convertTools(
    tools: readonly vscode.LanguageModelChatTool[] | undefined,
  ): QwenTool[] | undefined {
    if (!tools || tools.length === 0) {
      return undefined
    }

    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<
          string,
          any
        >,
      },
    }))
  }

  private resolveToolChoice(
    toolMode: vscode.LanguageModelChatToolMode,
    tools?: QwenTool[],
  ): QwenToolChoice | undefined {
    if (!tools || tools.length === 0) {
      return undefined
    }

    return toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto'
  }

  private resolveMaxTokens(
    model: vscode.LanguageModelChatInformation,
    modelOptions?: { readonly [name: string]: any },
  ): number {
    const requested =
      typeof modelOptions?.maxOutputTokens === 'number'
        ? modelOptions.maxOutputTokens
        : typeof modelOptions?.maxTokens === 'number'
          ? modelOptions.maxTokens
          : typeof modelOptions?.max_tokens === 'number'
            ? modelOptions.max_tokens
            : undefined

    if (typeof requested === 'number') {
      return Math.min(requested, model.maxOutputTokens)
    }

    return model.maxOutputTokens
  }

  private resolveTemperature(modelOptions?: { readonly [name: string]: any }): number {
    return typeof modelOptions?.temperature === 'number' ? modelOptions.temperature : 0.3
  }
}
