Use Qwen Code models with VS Code Copilot's built-in agent experience.

- Access to Qwen Code models (e.g. `coder-model` as configured in the extension)
- OAuth sign-in via the same device-flow style used by Qwen Code
- Native tool calling

## Qwen free tier

Per the [Qwen Code README](https://github.com/QwenLM/qwen-code/blob/main/README.md), **the Qwen OAuth free tier is discontinued** as of **2026-04-15**. **There is no remaining free tier on that path.** Qwen Code documents API keys (Model Studio), Coding Plan, OpenRouter, Fireworks AI, and similar options instead.

This extension uses the Qwen device OAuth flow. For current Qwen pricing and auth, see their README and docs.

## Get started

1. Install the extension.
2. Open the Command Palette and run **Qwen Copilot: Manage**, then **Authenticate** (or **Qwen Copilot: Authenticate** when available).
3. Start chatting in VS Code and pick a Qwen model.

## Requirements

- VS Code 1.108.0 or later (see `package.json` `engines.vscode` for the exact minimum)
- OAuth used https://chat.qwen.ai. Current Qwen auth options are listed in [Qwen Code](https://github.com/QwenLM/qwen-code).

## License

MIT
