import destr from 'destr';
import {P, match} from 'ts-pattern';
import OpenAI from 'openai';
import {authHandler} from './auth';
import type {
  QwenMessage,
  QwenModelId,
  QwenStreamEvent,
  QwenTool,
  QwenToolChoice,
} from './types';

const QWEN_API_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

class QwenClient {
  private client: OpenAI | null = null;
  private apiKey: string | null = null;

  async initialize(): Promise<void> {
    await this.ensureClient();
  }

  async *streamChatCompletion(params: {
    model: QwenModelId;
    messages: QwenMessage[];
    tools?: QwenTool[];
    toolChoice?: QwenToolChoice;
    maxTokens?: number;
    temperature?: number;
    abortSignal?: AbortSignal;
  }): AsyncGenerator<QwenStreamEvent> {
    await this.ensureClient();

    const stream = await this.requireClient().chat.completions.create(
      {
        model: params.model,
        messages: params.messages,
        ...(params.maxTokens !== undefined
          ? {max_tokens: params.maxTokens}
          : {}),
        temperature: params.temperature ?? 0.3,
        stream: true,
        ...(params.tools?.length
          ? {
              tools: params.tools,
              ...(params.toolChoice ? {tool_choice: params.toolChoice} : {}),
            }
          : {}),
      },
      {
        ...(params.abortSignal ? {signal: params.abortSignal} : {}),
      },
    );

    const toolCalls = new Map<
      number,
      {id: string; name?: string; arguments: string}
    >();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        yield {type: 'text', text: delta.content};
      }

      for (const call of delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const current = toolCalls.get(index) ?? {
          id: call.id ?? `tool_call_${index}`,
          arguments: '',
        };

        toolCalls.set(index, {
          id: call.id ?? current.id,
          name: call.function?.name ?? current.name,
          arguments: `${current.arguments}${call.function?.arguments ?? ''}`,
        });
      }
    }

    for (const [, call] of [...toolCalls.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      yield {
        type: 'tool_call',
        callId: call.id,
        name: call.name ?? 'tool',
        input: this.parseToolInput(call.arguments),
      };
    }
  }

  async countTokens(messages: QwenMessage[]): Promise<number> {
    let totalChars = 0;

    for (const message of messages) {
      const content = (message as {content?: unknown}).content;
      totalChars += match(content)
        .when(
          (value): value is string => typeof value === 'string',
          value => value.length,
        )
        .when(Array.isArray, value =>
          value
            .filter(
              (part): part is {text?: string} =>
                typeof part === 'object' && part !== null,
            )
            .reduce((sum, part) => sum + String(part.text ?? '').length, 0),
        )
        .otherwise(() => 0);

      totalChars += (
        (
          message as {
            tool_calls?: Array<{
              function?: {name?: string; arguments?: string};
            }>;
          }
        ).tool_calls ?? []
      ).reduce(
        (sum, call) =>
          sum +
          (call.function?.name?.length ?? 0) +
          (call.function?.arguments?.length ?? 0),
        0,
      );
    }

    return Math.ceil(totalChars / 4) + messages.length * 3;
  }

  isReady(): boolean {
    return this.client !== null;
  }

  reset(): void {
    this.client = null;
    this.apiKey = null;
  }

  private parseToolInput(raw: string): object {
    return match(destr(raw))
      .with(P.nullish, () => ({}))
      .when(
        value => typeof value === 'object',
        value => (value as object) ?? {},
      )
      .otherwise(() => (raw.trim() ? {_raw: raw} : {}));
  }

  private requireClient(): OpenAI {
    return (
      this.client ??
      (() => {
        throw new Error('Client not initialized');
      })()
    );
  }

  private async ensureClient(): Promise<void> {
    const apiKey = await authHandler.getValidAccessToken();
    if (this.client && this.apiKey === apiKey) {
      return;
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: authHandler.getBaseUrl() || QWEN_API_BASE,
      maxRetries: 0,
      defaultHeaders: {
        'User-Agent': 'vscode-qwen-copilot/0.3.1',
      },
    });
    this.apiKey = apiKey;
  }
}

export const qwenClient = new QwenClient();
