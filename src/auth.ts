/**
 * OAuth authentication handler for Qwen
 * Manages token refresh, credential caching at ~/.qwen/oauth_creds.json
 */

import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import type { CancellationToken } from 'vscode'
import type { QwenCredentials, QwenTokenResponse } from './types'
import type { SecretStorage } from 'vscode'

const QWEN_OAUTH_BASE_URL = 'https://chat.qwen.ai'
const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/device/code`
const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`
const QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56'
const QWEN_OAUTH_SCOPE = 'openid profile email model.completion'
const QWEN_OAUTH_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

const CREDENTIALS_PATH = path.join(os.homedir(), '.qwen', 'oauth_creds.json')
const TOKEN_REFRESH_BUFFER = 30 * 1000 // 30 seconds before expiry
const SECRET_STORAGE_KEY = 'qwen.oauth.credentials'

interface DeviceAuthorizationData {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
}

interface DeviceTokenSuccess {
  access_token: string
  refresh_token?: string
  token_type: string
  expires_in: number
  resource_url?: string
}

interface DeviceTokenPending {
  status: 'pending'
  slowDown?: boolean
}

interface OAuthErrorResponse {
  error: string
  error_description?: string
}

function isDeviceTokenPending(
  response: DeviceTokenSuccess | DeviceTokenPending | OAuthErrorResponse,
): response is DeviceTokenPending {
  return 'status' in response && response.status === 'pending'
}

function isDeviceTokenError(
  response: DeviceTokenSuccess | DeviceTokenPending | OAuthErrorResponse,
): response is OAuthErrorResponse {
  return 'error' in response
}

function isDeviceTokenSuccess(
  response: DeviceTokenSuccess | DeviceTokenPending | OAuthErrorResponse,
): response is DeviceTokenSuccess {
  return 'access_token' in response
}

class QwenAuthHandler {
  private credentials: QwenCredentials | null = null
  private secretStorage: SecretStorage | null = null

  setSecretStorage(storage: SecretStorage): void {
    this.secretStorage = storage
  }

  async loadCredentials(): Promise<QwenCredentials | null> {
    try {
      if (this.secretStorage) {
        const stored = await this.secretStorage.get(SECRET_STORAGE_KEY)
        if (stored) {
          this.credentials = JSON.parse(stored) as QwenCredentials
          return this.credentials
        }
      }

      const data = await fs.readFile(CREDENTIALS_PATH, 'utf-8')
      this.credentials = JSON.parse(data) as QwenCredentials
      if (this.secretStorage && this.credentials) {
        await this.secretStorage.store(SECRET_STORAGE_KEY, JSON.stringify(this.credentials))
      }
      return this.credentials
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to load credentials:', error)
      }
      return null
    }
  }

  async saveCredentials(credentials: QwenCredentials): Promise<void> {
    try {
      if (this.secretStorage) {
        await this.secretStorage.store(SECRET_STORAGE_KEY, JSON.stringify(credentials))
      } else {
        const dir = path.dirname(CREDENTIALS_PATH)
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), 'utf-8')
      }
      this.credentials = credentials
    } catch (error) {
      console.error('Failed to save credentials:', error)
      throw error
    }
  }

  async getValidAccessToken(): Promise<string> {
    if (!this.credentials) {
      throw new Error('No credentials found. Please authenticate first.')
    }
    if (!this.credentials.accessToken || this.credentials.accessToken.trim().length === 0) {
      throw new Error('Access token is empty. Please authenticate again.')
    }

    const now = Date.now()
    if (this.credentials.expiresAt - now < TOKEN_REFRESH_BUFFER) {
      await this.refreshAccessToken()
    }

    return this.credentials.accessToken
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.credentials) {
      throw new Error('Cannot refresh: no credentials stored')
    }

    try {
      const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: this.objectToUrlEncoded({
          grant_type: 'refresh_token',
          refresh_token: this.credentials.refreshToken,
          client_id: QWEN_OAUTH_CLIENT_ID,
        }),
      })

      if (!response.ok) {
        throw new Error(`Token refresh failed: ${response.statusText}`)
      }

      const data = (await response.json()) as QwenTokenResponse
      const expiresAt = Date.now() + data.expires_in * 1000

      const updated: QwenCredentials = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || this.credentials.refreshToken,
        tokenType: data.token_type,
        resourceUrl: data.resource_url,
        expiresAt,
      }

      await this.saveCredentials(updated)
    } catch (error) {
      console.error('Failed to refresh token:', error)
      throw error
    }
  }

  async initiateOAuthFlow(): Promise<QwenCredentials> {
    throw new Error(
      'OAuth flow must be implemented with proper callback handling. ' +
        'Visit https://chat.qwen.ai/api/v1/oauth2/authorize to get credentials.',
    )
  }

  async clearCredentials(): Promise<void> {
    try {
      if (this.secretStorage) {
        await this.secretStorage.delete(SECRET_STORAGE_KEY)
      } else {
        await fs.unlink(CREDENTIALS_PATH)
      }
      this.credentials = null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to clear credentials:', error)
      }
    }
  }

  isAuthenticated(): boolean {
    return (
      this.credentials !== null &&
      typeof this.credentials.accessToken === 'string' &&
      this.credentials.accessToken.trim().length > 0
    )
  }

  getBaseUrl(): string {
    const resourceUrl = this.credentials?.resourceUrl
    if (!resourceUrl || resourceUrl.trim().length === 0) {
      return 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    }

    const normalized = resourceUrl.startsWith('http://') || resourceUrl.startsWith('https://')
      ? resourceUrl
      : `https://${resourceUrl}`

    return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
  }

  async startDeviceFlow(params: {
    onAuthUri?: (payload: {
      verificationUriComplete: string
      userCode: string
      expiresIn: number
    }) => Promise<void> | void
    onProgress?: (message: string) => void
    cancellationToken?: CancellationToken
  }): Promise<QwenCredentials> {
    const { onAuthUri, onProgress, cancellationToken } = params
    const { codeVerifier, codeChallenge } = this.generatePkcePair()

    const deviceAuth = await this.requestDeviceAuthorization(codeChallenge)
    onAuthUri?.({
      verificationUriComplete: deviceAuth.verification_uri_complete,
      userCode: deviceAuth.user_code,
      expiresIn: deviceAuth.expires_in,
    })

    const pollStart = Date.now()
    let pollIntervalMs = 2000
    const timeoutMs = deviceAuth.expires_in * 1000

    while (Date.now() - pollStart < timeoutMs) {
      if (cancellationToken?.isCancellationRequested) {
        throw new Error('Authentication cancelled.')
      }

      const tokenResponse = await this.pollDeviceToken(deviceAuth.device_code, codeVerifier)
      if (isDeviceTokenPending(tokenResponse)) {
        if (tokenResponse.slowDown) {
          pollIntervalMs = Math.min(Math.floor(pollIntervalMs * 1.5), 10000)
        }
        onProgress?.('Waiting for authorization...')
        await this.sleep(pollIntervalMs, cancellationToken)
        continue
      }

      if (isDeviceTokenError(tokenResponse)) {
        throw new Error(
          `Device login failed: ${tokenResponse.error}${tokenResponse.error_description ? ` - ${tokenResponse.error_description}` : ''}`,
        )
      }

      if (!isDeviceTokenSuccess(tokenResponse)) {
        throw new Error('Device login failed: invalid response.')
      }

      const expiresAt = Date.now() + tokenResponse.expires_in * 1000
      const credentials: QwenCredentials = {
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token ?? '',
        tokenType: tokenResponse.token_type,
        resourceUrl: tokenResponse.resource_url,
        expiresAt,
      }
      return credentials
    }

    throw new Error('Authentication timed out. Please try again.')
  }

  private async requestDeviceAuthorization(codeChallenge: string): Promise<DeviceAuthorizationData> {
    const response = await fetch(QWEN_OAUTH_DEVICE_CODE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: this.objectToUrlEncoded({
        client_id: QWEN_OAUTH_CLIENT_ID,
        scope: QWEN_OAUTH_SCOPE,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }),
    })

    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`Device authorization failed: ${response.status} ${response.statusText}. ${detail}`)
    }

    const result = (await response.json()) as DeviceAuthorizationData | OAuthErrorResponse
    if ('error' in result) {
      throw new Error(
        `Device authorization failed: ${result.error}${result.error_description ? ` - ${result.error_description}` : ''}`,
      )
    }

    return result
  }

  private async pollDeviceToken(
    deviceCode: string,
    codeVerifier: string,
  ): Promise<DeviceTokenSuccess | DeviceTokenPending | OAuthErrorResponse> {
    const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: this.objectToUrlEncoded({
        grant_type: QWEN_OAUTH_GRANT_TYPE,
        client_id: QWEN_OAUTH_CLIENT_ID,
        device_code: deviceCode,
        code_verifier: codeVerifier,
      }),
    })

    if (!response.ok) {
      const responseText = await response.text()
      let errorData: OAuthErrorResponse | null = null
      try {
        errorData = JSON.parse(responseText) as OAuthErrorResponse
      } catch {
        throw new Error(`Device token poll failed: ${response.status} ${response.statusText}. ${responseText}`)
      }

      if (response.status === 400 && errorData.error === 'authorization_pending') {
        return { status: 'pending' }
      }
      if (response.status === 429 && errorData.error === 'slow_down') {
        return { status: 'pending', slowDown: true }
      }

      return errorData
    }

    return (await response.json()) as DeviceTokenSuccess
  }

  private generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = this.generateCodeVerifier()
    const codeChallenge = this.generateCodeChallenge(codeVerifier)
    return { codeVerifier, codeChallenge }
  }

  private generateCodeVerifier(): string {
    return crypto.randomBytes(32).toString('base64url')
  }

  private generateCodeChallenge(codeVerifier: string): string {
    const hash = crypto.createHash('sha256')
    hash.update(codeVerifier)
    return hash.digest('base64url')
  }

  private objectToUrlEncoded(data: Record<string, string>): string {
    return Object.keys(data)
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`)
      .join('&')
  }

  private async sleep(ms: number, cancellationToken?: CancellationToken): Promise<void> {
    if (ms <= 0) {
      return
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, ms)
      if (cancellationToken) {
        cancellationToken.onCancellationRequested(() => {
          clearTimeout(timeout)
          resolve()
        })
      }
    })
  }
}

export const authHandler = new QwenAuthHandler()
