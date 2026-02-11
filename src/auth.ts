import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import axios, { type AxiosInstance, type AxiosResponse } from 'axios'
import destr from 'destr'
import { ResultAsync } from 'neverthrow'
import { match } from 'ts-pattern'
import type { CancellationToken, SecretStorage } from 'vscode'
import type { QwenCredentials, QwenTokenResponse } from './types'

const QWEN_OAUTH_BASE_URL = 'https://chat.qwen.ai'
const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/device/code`
const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`
const QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56'
const QWEN_OAUTH_SCOPE = 'openid profile email model.completion'
const QWEN_OAUTH_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

const CREDENTIALS_PATH = path.join(os.homedir(), '.qwen', 'oauth_creds.json')
const TOKEN_REFRESH_BUFFER = 30 * 1000
const SECRET_STORAGE_KEY = 'qwen.oauth.credentials'
const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

interface DeviceAuthorizationData {
  device_code: string
  user_code: string
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

type DeviceTokenResponse = DeviceTokenSuccess | DeviceTokenPending | OAuthErrorResponse
type OAuthFormBody = Record<string, string>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isOAuthError = (value: unknown): value is OAuthErrorResponse =>
  isRecord(value) && typeof value.error === 'string'

const isDeviceTokenSuccess = (value: unknown): value is DeviceTokenSuccess =>
  isRecord(value) && typeof value.access_token === 'string' && typeof value.expires_in === 'number'

const isTokenResponse = (value: unknown): value is QwenTokenResponse =>
  isRecord(value) &&
  typeof value.access_token === 'string' &&
  typeof value.expires_in === 'number' &&
  typeof value.token_type === 'string'

const isCredentials = (value: unknown): value is QwenCredentials =>
  isRecord(value) &&
  typeof value.accessToken === 'string' &&
  typeof value.refreshToken === 'string' &&
  typeof value.expiresAt === 'number'

const isDeviceAuthorizationData = (value: unknown): value is DeviceAuthorizationData =>
  isRecord(value) &&
  typeof value.device_code === 'string' &&
  typeof value.user_code === 'string' &&
  typeof value.verification_uri_complete === 'string' &&
  typeof value.expires_in === 'number'

const isMissingFile = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'

const formatOAuthError = (prefix: string, error: OAuthErrorResponse): string =>
  `${prefix}: ${error.error}${error.error_description ? ` - ${error.error_description}` : ''}`

const toStringPayload = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value ?? '')

const asPromise = <T>(value: PromiseLike<T> | T): Promise<T> => Promise.resolve(value)

const toResult = <T>(value: PromiseLike<T> | T) =>
  ResultAsync.fromPromise(asPromise(value), (error) => error)

const ignoreResultError = <T>(result: ResultAsync<T, unknown>): Promise<T | null> =>
  result.match(
    (value) => value,
    () => null,
  )

const logError = (message: string) => (error: unknown): void => {
  console.error(message, error)
}

const logUnlessMissingFile = (message: string) => (error: unknown): void => {
  void match(isMissingFile(error))
    .with(false, () => console.error(message, error))
    .otherwise(() => undefined)
}

class QwenAuthHandler {
  private credentials: QwenCredentials | null = null
  private secretStorage: SecretStorage | null = null
  private http: AxiosInstance = axios.create({
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    validateStatus: () => true,
  })

  setSecretStorage(storage: SecretStorage): void {
    this.secretStorage = storage
  }

  async loadCredentials(): Promise<QwenCredentials | null> {
    const fromSecret = await this.loadCredentialsFromSecretStorage()
    if (fromSecret) {
      return this.setLoadedCredentials(fromSecret)
    }

    const fromFile = await ignoreResultError(
      toResult(fs.readFile(CREDENTIALS_PATH, 'utf-8'))
        .map((raw) => {
          const parsed = destr(raw)
          return isCredentials(parsed) ? parsed : null
        })
        .mapErr(logUnlessMissingFile('Failed to load credentials:')),
    )

    if (!fromFile) {
      return null
    }

    await toResult(this.secretStorage?.store(SECRET_STORAGE_KEY, JSON.stringify(fromFile)))
      .mapErr(logError('Failed to sync credentials to secret storage:'))
      .match(
        () => undefined,
        () => undefined,
      )

    return this.setLoadedCredentials(fromFile)
  }

  async saveCredentials(credentials: QwenCredentials): Promise<void> {
    await (this.secretStorage
      ? this.secretStorage.store(SECRET_STORAGE_KEY, JSON.stringify(credentials))
      : this.writeCredentialsToDisk(credentials))

    this.credentials = credentials
  }

  async getValidAccessToken(): Promise<string> {
    const token = this.credentials?.accessToken?.trim()
    if (!token) {
      throw new Error('No credentials found. Please authenticate first.')
    }

    if ((this.credentials?.expiresAt ?? 0) - Date.now() < TOKEN_REFRESH_BUFFER) {
      await this.refreshAccessToken()
    }

    return this.credentials?.accessToken ?? token
  }

  async clearCredentials(): Promise<void> {
    await Promise.allSettled([
      toResult(this.secretStorage?.delete(SECRET_STORAGE_KEY)).match(
        () => undefined,
        () => undefined,
      ),
      fs.rm(CREDENTIALS_PATH, { force: true }),
    ])

    this.credentials = null
  }

  isAuthenticated(): boolean {
    return Boolean(this.credentials?.accessToken?.trim())
  }

  getBaseUrl(): string {
    const resourceUrl = this.credentials?.resourceUrl?.trim()
    if (!resourceUrl) {
      return DEFAULT_BASE_URL
    }

    const normalized = /^https?:\/\//.test(resourceUrl) ? resourceUrl : `https://${resourceUrl}`
    return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
  }

  async startDeviceFlow(params: {
    onAuthUri?: (payload: {
      verificationUriComplete: string
      expiresIn: number
    }) => Promise<void> | void
    onProgress?: (message: string) => void
    cancellationToken?: CancellationToken
  }): Promise<QwenCredentials> {
    const { onAuthUri, onProgress, cancellationToken } = params
    const codeVerifier = this.generateCodeVerifier()
    const deviceAuth = await this.requestDeviceAuthorization(this.generateCodeChallenge(codeVerifier))

    await onAuthUri?.({
      verificationUriComplete: deviceAuth.verification_uri_complete,
      expiresIn: deviceAuth.expires_in,
    })

    let pollIntervalMs = 2000
    const deadline = Date.now() + deviceAuth.expires_in * 1000

    while (Date.now() < deadline) {
      if (cancellationToken?.isCancellationRequested) {
        throw new Error('Authentication cancelled.')
      }

      const tokenResponse = await this.pollDeviceToken(deviceAuth.device_code, codeVerifier)
      const result = match<DeviceTokenResponse, QwenCredentials | 'pending'>(tokenResponse)
        .with({ status: 'pending' }, (pending) => {
          pollIntervalMs = pending.slowDown ? Math.min(Math.floor(pollIntervalMs * 1.5), 10000) : pollIntervalMs
          onProgress?.('Waiting for authorization...')
          return 'pending'
        })
        .when(isOAuthError, (error) => {
          throw new Error(formatOAuthError('Device login failed', error))
        })
        .otherwise((success) => ({
          accessToken: success.access_token,
          refreshToken: success.refresh_token ?? '',
          tokenType: success.token_type,
          resourceUrl: success.resource_url,
          expiresAt: Date.now() + success.expires_in * 1000,
        }))

      if (result !== 'pending') {
        return result
      }

      await this.sleep(pollIntervalMs, cancellationToken)
    }

    throw new Error('Authentication timed out. Please try again.')
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.credentials) {
      throw new Error('Cannot refresh: no credentials stored')
    }

    const response = await this.postForm<QwenTokenResponse>(QWEN_OAUTH_TOKEN_ENDPOINT, {
      grant_type: 'refresh_token',
      refresh_token: this.credentials.refreshToken,
      client_id: QWEN_OAUTH_CLIENT_ID,
    })

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Token refresh failed: ${response.status} ${response.statusText}`)
    }

    const data = response.data
    if (!isTokenResponse(data)) {
      throw new Error(`Token refresh failed: invalid response ${toStringPayload(response.data)}`)
    }

    await this.saveCredentials({
      accessToken: data.access_token,
      refreshToken: data.refresh_token || this.credentials.refreshToken,
      tokenType: data.token_type,
      resourceUrl: data.resource_url,
      expiresAt: Date.now() + data.expires_in * 1000,
    })
  }

  private async requestDeviceAuthorization(codeChallenge: string): Promise<DeviceAuthorizationData> {
    const response = await this.postForm<DeviceAuthorizationData | OAuthErrorResponse>(
      QWEN_OAUTH_DEVICE_CODE_ENDPOINT,
      {
        client_id: QWEN_OAUTH_CLIENT_ID,
        scope: QWEN_OAUTH_SCOPE,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      },
    )

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Device authorization failed: ${response.status} ${response.statusText}. ${toStringPayload(response.data)}`,
      )
    }

    return match(response.data)
      .when(isOAuthError, (error) => {
        throw new Error(formatOAuthError('Device authorization failed', error))
      })
      .when(isDeviceAuthorizationData, (data) => data)
      .otherwise(() => {
        throw new Error(`Device authorization failed: invalid response ${toStringPayload(response.data)}`)
      })
  }

  private async pollDeviceToken(deviceCode: string, codeVerifier: string): Promise<DeviceTokenResponse> {
    const response = await this.postForm<unknown>(QWEN_OAUTH_TOKEN_ENDPOINT, {
      grant_type: QWEN_OAUTH_GRANT_TYPE,
      client_id: QWEN_OAUTH_CLIENT_ID,
      device_code: deviceCode,
      code_verifier: codeVerifier,
    })

    if (response.status >= 200 && response.status < 300) {
      if (isDeviceTokenSuccess(response.data)) {
        return response.data
      }
      throw new Error(`Device token poll failed: invalid response ${toStringPayload(response.data)}`)
    }

    const oauthError = this.toOAuthError(response.data)
    if (!oauthError) {
      throw new Error(
        `Device token poll failed: ${response.status} ${response.statusText}. ${toStringPayload(response.data)}`,
      )
    }

    return match<[number, string], DeviceTokenResponse>([response.status, oauthError.error])
      .with([400, 'authorization_pending'], () => ({ status: 'pending' }))
      .with([429, 'slow_down'], () => ({ status: 'pending', slowDown: true }))
      .otherwise(() => oauthError)
  }

  private async loadCredentialsFromSecretStorage(): Promise<QwenCredentials | null> {
    if (!this.secretStorage) {
      return null
    }

    return ignoreResultError(
      toResult(this.secretStorage.get(SECRET_STORAGE_KEY))
        .map((stored) => {
          if (!stored) {
            return null
          }
          const parsed = destr(stored)
          return isCredentials(parsed) ? parsed : null
        })
        .mapErr(logError('Failed to load credentials from secret storage:')),
    )
  }

  private async writeCredentialsToDisk(credentials: QwenCredentials): Promise<void> {
    await fs.mkdir(path.dirname(CREDENTIALS_PATH), { recursive: true })
    await fs.writeFile(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), 'utf-8')
  }

  private toOAuthError(value: unknown): OAuthErrorResponse | null {
    return match(value)
      .when(isOAuthError, (error) => error)
      .when((entry) => typeof entry === 'string', (entry) => {
        const parsed = destr(entry)
        return isOAuthError(parsed) ? parsed : null
      })
      .otherwise(() => null)
  }

  private postForm<T>(url: string, body: OAuthFormBody): Promise<AxiosResponse<T>> {
    return this.http.post<T>(url, new URLSearchParams(body).toString())
  }

  private setLoadedCredentials(credentials: QwenCredentials): QwenCredentials {
    this.credentials = credentials
    return credentials
  }

  private generateCodeVerifier(): string {
    return crypto.randomBytes(32).toString('base64url')
  }

  private generateCodeChallenge(codeVerifier: string): string {
    return crypto.createHash('sha256').update(codeVerifier).digest('base64url')
  }

  private async sleep(ms: number, cancellationToken?: CancellationToken): Promise<void> {
    if (ms <= 0) {
      return
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, ms)
      cancellationToken?.onCancellationRequested(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }
}

export const authHandler = new QwenAuthHandler()
