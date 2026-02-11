import stringify from 'safe-stable-stringify';
import {ResultAsync} from 'neverthrow';
import {P, match} from 'ts-pattern';
import * as vscode from 'vscode';
import {authHandler} from './auth';
import {qwenClient} from './qwen-client';
import {QWEN_MODELS} from './types';
import type {QwenMessage, QwenModelId, QwenTool, QwenToolChoice} from './types';

type ModelOptions = Readonly<Record<string, unknown>>;

export class QwenLanguageModelChatProvider
  implements vscode.LanguageModelChatProvider
{
  async provideLanguageModelChatInformation(): Promise<
    vscode.LanguageModelChatInformation[]
  > {
    return Object.values(QWEN_MODELS).map(model => ({
      id: model.id,
      name: model.displayName,
      family: model.family,
      version: model.version,
      detail: 'Qwen',
      maxInputTokens: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: {toolCalling: true},
    }));
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    await this.ensureAuthenticated();
    await (qwenClient.isReady() ? Promise.resolve() : qwenClient.initialize());

    const tools = this.convertTools(options.tools);
    const abortController = new AbortController();
    const cancellationSubscription = token.onCancellationRequested(() =>
      abortController.abort(),
    );
    const stream = qwenClient.streamChatCompletion({
      model: model.id as QwenModelId,
      messages: this.convertMessages(messages),
      tools,
      toolChoice: this.resolveToolChoice(options.toolMode, tools),
      maxTokens: this.resolveMaxTokens(model, options.modelOptions),
      temperature: this.resolveTemperature(options.modelOptions),
      abortSignal: abortController.signal,
    });

    try {
      for await (const chunk of stream) {
        if (token.isCancellationRequested) {
          break;
        }

        match(chunk)
          .with({type: 'text'}, ({text}) =>
            progress.report(new vscode.LanguageModelTextPart(text)),
          )
          .with({type: 'tool_call'}, ({callId, name, input}) =>
            progress.report(
              new vscode.LanguageModelToolCallPart(callId, name, input),
            ),
          )
          .exhaustive();
      }
    } catch (error) {
      if (!this.isAbortError(error, token)) {
        throw error;
      }
    } finally {
      cancellationSubscription.dispose();
    }
  }

  provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Promise<number> {
    if (token.isCancellationRequested) {
      return Promise.resolve(0);
    }

    const fallback = Math.ceil(
      (typeof text === 'string' ? text : '').length / 4,
    );
    const clampToModel = (count: number) =>
      Math.min(count, model.maxInputTokens);

    if (typeof text === 'string') {
      return Promise.resolve(clampToModel(Math.ceil(text.length / 4)));
    }

    return ResultAsync.fromPromise(
      qwenClient.countTokens(this.convertMessages([text])),
      error => error,
    )
      .mapErr(error => {
        console.error('Token count error:', error);
        return error;
      })
      .match(
        count => clampToModel(count),
        () => clampToModel(fallback),
      );
  }

  private async ensureAuthenticated(): Promise<void> {
    if (authHandler.isAuthenticated()) {
      return;
    }

    const action = await vscode.window.showInformationMessage(
      'Qwen Copilot needs authentication before it can respond.',
      'Manage Sign-In',
    );

    await match(action)
      .with('Manage Sign-In', () =>
        vscode.commands.executeCommand('qwen-copilot.manage'),
      )
      .otherwise(() => Promise.resolve());

    throw new Error(
      'Not authenticated. Use "Qwen Copilot: Manage" to sign in.',
    );
  }

  private convertMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
  ): QwenMessage[] {
    const converted: QwenMessage[] = [];

    for (const message of messages) {
      const role =
        message.role === vscode.LanguageModelChatMessageRole.Assistant
          ? 'assistant'
          : 'user';
      const toolCalls: vscode.LanguageModelToolCallPart[] = [];
      let textBuffer = '';

      for (const part of message.content ?? []) {
        match(part)
          .with(P.instanceOf(vscode.LanguageModelToolCallPart), call =>
            toolCalls.push(call),
          )
          .with(P.instanceOf(vscode.LanguageModelToolResultPart), result => {
            this.pushTextMessage(converted, role, textBuffer, message.name);
            textBuffer = '';
            converted.push({
              role: 'tool',
              tool_call_id: result.callId,
              content: this.serializeToolResult(result),
            });
          })
          .otherwise(entry => {
            textBuffer += this.partToText(entry);
          });
      }

      match<[typeof role, number]>([role, toolCalls.length])
        .with(['assistant', P.when(count => count > 0)], () => {
          converted.push(
            this.buildAssistantToolCallMessage(
              toolCalls,
              textBuffer,
              message.name,
            ),
          );
        })
        .otherwise(() =>
          this.pushTextMessage(converted, role, textBuffer, message.name),
        );
    }

    return converted;
  }

  private pushTextMessage(
    target: QwenMessage[],
    role: 'user' | 'assistant',
    text: string,
    name?: string,
  ): void {
    if (!text) {
      return;
    }

    target.push(name ? {role, content: text, name} : {role, content: text});
  }

  private buildAssistantToolCallMessage(
    toolCalls: vscode.LanguageModelToolCallPart[],
    text: string,
    name?: string,
  ): QwenMessage {
    return {
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.map(call => ({
        id: call.callId,
        type: 'function',
        function: {
          name: call.name,
          arguments: this.toJson(call.input ?? {}),
        },
      })),
      ...(name ? {name} : {}),
    } as QwenMessage;
  }

  private serializeToolResult(
    part: vscode.LanguageModelToolResultPart,
  ): string {
    return part.content.map(entry => this.partToText(entry)).join('');
  }

  private partToText(part: unknown): string {
    return match(part)
      .with(P.instanceOf(vscode.LanguageModelTextPart), ({value}) => value)
      .with(P.instanceOf(vscode.LanguageModelPromptTsxPart), ({value}) =>
        this.toJson(value),
      )
      .with(P.instanceOf(vscode.LanguageModelDataPart), data =>
        this.dataPartToText(data),
      )
      .otherwise(value => this.toJson(value));
  }

  private dataPartToText(part: vscode.LanguageModelDataPart): string {
    const mime = part.mimeType || 'application/octet-stream';
    const buffer = Buffer.from(part.data);

    return match(mime)
      .when(
        value => value.startsWith('text/'),
        () => buffer.toString('utf-8'),
      )
      .with('application/json', () => buffer.toString('utf-8'))
      .otherwise(value => `[${value} base64:${buffer.toString('base64')}]`);
  }

  private toJson(value: unknown): string {
    return stringify(value) ?? String(value);
  }

  private convertTools(
    tools: readonly vscode.LanguageModelChatTool[] | undefined,
  ): QwenTool[] | undefined {
    return tools?.length
      ? tools.map(tool => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: (tool.inputSchema ?? {
              type: 'object',
              properties: {},
            }) as Record<string, unknown>,
          },
        }))
      : undefined;
  }

  private resolveToolChoice(
    toolMode: vscode.LanguageModelChatToolMode,
    tools?: QwenTool[],
  ): QwenToolChoice | undefined {
    return tools?.length
      ? toolMode === vscode.LanguageModelChatToolMode.Required
        ? 'required'
        : 'auto'
      : undefined;
  }

  private resolveMaxTokens(
    model: vscode.LanguageModelChatInformation,
    modelOptions?: ModelOptions,
  ): number | undefined {
    const requested = this.firstNumber(
      modelOptions?.maxOutputTokens,
      modelOptions?.maxTokens,
      modelOptions?.max_tokens,
    );

    return requested !== undefined
      ? Math.max(1, Math.min(requested, model.maxOutputTokens))
      : undefined;
  }

  private resolveTemperature(modelOptions?: ModelOptions): number {
    return this.firstNumber(modelOptions?.temperature) ?? 0.3;
  }

  private firstNumber(...values: unknown[]): number | undefined {
    return values.find((value): value is number => typeof value === 'number');
  }

  private isAbortError(
    error: unknown,
    token: vscode.CancellationToken,
  ): boolean {
    return (
      token.isCancellationRequested ||
      (error instanceof Error && /abort|cancel/i.test(error.message))
    );
  }
}
