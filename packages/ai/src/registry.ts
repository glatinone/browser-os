import type { ModelProvider, ModelTier } from '@browser-os/protocol';
import { type Config, ConfigSchema } from '@browser-os/protocol';
import { AnthropicProvider } from './anthropic.js';
import { FakeModelProvider } from './fake-provider.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';

export type RegistryConfig = Config['models'];

export class ModelRegistry {
  private constructor(private readonly providers: Partial<Record<ModelTier, ModelProvider>>) {}

  static fromConfig(config: unknown, env: NodeJS.ProcessEnv = process.env): ModelRegistry {
    const parsed = ConfigSchema.shape.models.parse(config);
    void env;
    const providers: Partial<Record<ModelTier, ModelProvider>> = {};
    for (const tier of ['fast', 'capable', 'vision'] as const) {
      const modelConfig = parsed[tier];
      if (!modelConfig) continue;
      if (modelConfig.provider === 'fake') {
        providers[tier] = new FakeModelProvider({
          responder: modelConfig.truthFile ? { ref: null } : { ref: null },
          latencyMs: modelConfig.latencyMs,
          model: modelConfig.model ?? 'fake',
        });
      } else if (modelConfig.provider === 'openai-compatible') {
        providers[tier] = new OpenAiCompatibleProvider({
          baseUrl: modelConfig.baseUrl ?? 'http://localhost:11434/v1',
          model: modelConfig.model ?? 'default',
          apiKeyEnv: modelConfig.apiKeyEnv ?? 'OPENAI_API_KEY',
          supportsJsonSchema: modelConfig.supportsJsonSchema,
          maxTokensParam: modelConfig.maxTokensParam,
        });
      } else {
        providers[tier] = new AnthropicProvider({
          baseUrl: modelConfig.baseUrl,
          model: modelConfig.model ?? 'claude',
          apiKeyEnv: modelConfig.apiKeyEnv ?? 'ANTHROPIC_API_KEY',
        });
      }
    }
    return new ModelRegistry(providers);
  }

  get(tier: ModelTier): ModelProvider | null {
    return this.providers[tier] ?? null;
  }
}
