/**
 * Qwen Code API client wrapper
 * Uses OpenAI-compatible API at dashscope.aliyuncs.com
 */

import OpenAI from 'openai'
import { authHandler } from './auth'
import type { QwenModelId, QwenMessage, QwenStreamEvent, QwenTool, QwenToolChoice } from './types'

const QWEN_API_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

class QwenClient {
  private client: OpenAI | null = null
  private apiKey: string | null = null

  async initialize(): Promise<void> {
    await this.ensureClient()
  }

  /**
   * Get available models
   */
  async listModels(): Promise<string[]> {
    return ['qwen3-coder-plus', 'qwen3-coder-flash']
  }

  /**
   * Stream chat completion
   * Yields message chunks as they arrive
   */
  async *streamChatCompletion(params: {
    model: QwenModelId
    messages: QwenMessage[]
    tools?: QwenTool[]
    toolChoice?: QwenToolChoice
    maxTokens?: number
    temperature?: number
  }): AsyncGenerator<QwenStreamEvent> {
    await this.ensureClient()
    if (!this.client) {
      throw new Error('Client not initialized')
    }

    const request: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: params.model,
      messages: params.messages,
      max_tokens: params.maxTokens || 4096,
      temperature: params.temperature ?? 0.3,
      stream: true,
    }

    if (params.tools && params.tools.length > 0) {
      request.tools = params.tools
      if (params.toolChoice) {
        request.tool_choice = params.toolChoice
      }
    }

    const stream = await this.client.chat.completions.create(request)
    const toolCallsByIndex = new Map<
      number,
      { id: string; name?: string; arguments: string }
    >()

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta
      const content = delta?.content
      if (content) {
        yield { type: 'text', text: content }
      }

      const toolCalls = delta?.tool_calls
      if (toolCalls) {
        for (const call of toolCalls) {
          const index = typeof call.index === 'number' ? call.index : 0
          const existing =
            toolCallsByIndex.get(index) ?? {
              id: call.id ?? `tool_call_${index}`,
              arguments: '',
            }

          if (call.id) {
            existing.id = call.id
          }
          if (call.function?.name) {
            existing.name = call.function.name
          }
          if (call.function?.arguments) {
            existing.arguments += call.function.arguments
          }

          toolCallsByIndex.set(index, existing)
        }
      }
    }

    if (toolCallsByIndex.size > 0) {
      const ordered = Array.from(toolCallsByIndex.entries()).sort((a, b) => a[0] - b[0])
      for (const [, call] of ordered) {
        const name = call.name ?? 'tool'
        let input: object = {}

        if (call.arguments.trim().length > 0) {
          try {
            input = JSON.parse(call.arguments)
          } catch {
            input = { _raw: call.arguments }
          }
        }

        yield {
          type: 'tool_call',
          callId: call.id,
          name,
          input,
        }
      }
    }
  }

  /**
   * Count tokens in a message
   * Uses rough estimation: ~4 chars per token
   */
  async countTokens(messages: QwenMessage[]): Promise<number> {
    let totalChars = 0

    for (const msg of messages) {
      const content = (msg as { content?: unknown }).content
      if (typeof content === 'string') {
        totalChars += content.length
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === 'object' && part && 'text' in part) {
            totalChars += String((part as { text?: string }).text ?? '').length
          }
        }
      }

      const toolCalls = (msg as { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> })
        .tool_calls
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          if (call.function?.name) {
            totalChars += call.function.name.length
          }
          if (call.function?.arguments) {
            totalChars += call.function.arguments.length
          }
        }
      }
    }

    return Math.ceil(totalChars / 4) + messages.length * 3
  }

  /**
   * Check if client is initialized and authenticated
   */
  isReady(): boolean {
    return this.client !== null
  }

  /**
   * Reset client (on logout or token refresh)
   */
  reset(): void {
    this.client = null
    this.apiKey = null
  }

  private async ensureClient(): Promise<void> {
    const apiKey = await authHandler.getValidAccessToken()
    if (this.client && this.apiKey === apiKey) {
      return
    }

    const baseURL = authHandler.getBaseUrl() || QWEN_API_BASE
    this.client = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders: {
        'User-Agent': 'vscode-qwen-copilot/0.1.0',
      },
    })
    this.apiKey = apiKey
  }
}

export const qwenClient = new QwenClient()
