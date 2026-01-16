/**
 * Type definitions for Qwen authentication and models
 */

import type OpenAI from 'openai'

export interface QwenCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  resourceUrl?: string
  tokenType?: string
}

export interface QwenTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  resource_url?: string
}

export const QWEN_MODELS = {
  'qwen3-coder-plus': {
    id: 'qwen3-coder-plus',
    displayName: 'Qwen 3 Coder Plus',
    family: 'qwen3-coder',
    version: 'plus',
    contextWindow: 1000000,
    maxOutputTokens: 65536,
  },
  'qwen3-coder-flash': {
    id: 'qwen3-coder-flash',
    displayName: 'Qwen 3 Coder Flash',
    family: 'qwen3-coder',
    version: 'flash',
    contextWindow: 1000000,
    maxOutputTokens: 65536,
  },
} as const

export type QwenModelId = keyof typeof QWEN_MODELS
export type QwenMessage = OpenAI.Chat.ChatCompletionMessageParam
export type QwenTool = OpenAI.Chat.ChatCompletionTool
export type QwenToolChoice = OpenAI.Chat.ChatCompletionToolChoiceOption

export type QwenStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; callId: string; name: string; input: object }
