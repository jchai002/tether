import { BusinessContextProvider } from "./businessContextProvider";
import { ConversationalAgent } from "./conversationalAgent";

/**
 * Central registry for business context providers and conversational agents.
 * Extension registers available providers on activate; orchestration
 * looks them up by ID from user config.
 *
 * Two registries:
 * - Business context providers (Slack, Teams, etc.)
 * - Conversational agents (Claude, Codex, etc.) — multi-turn streaming with MCP tools
 */
export class ProviderRegistry {
  private businessContextProviders = new Map<string, BusinessContextProvider>();
  private conversationalAgents = new Map<string, ConversationalAgent>();

  registerBusinessContext(provider: BusinessContextProvider): void {
    this.businessContextProviders.set(provider.id, provider);
  }

  registerConversationalAgent(agent: ConversationalAgent): void {
    this.conversationalAgents.set(agent.id, agent);
  }

  getBusinessContext(id: string): BusinessContextProvider | undefined {
    return this.businessContextProviders.get(id);
  }

  getConversationalAgent(id: string): ConversationalAgent | undefined {
    return this.conversationalAgents.get(id);
  }

  getAllBusinessContextProviders(): BusinessContextProvider[] {
    return Array.from(this.businessContextProviders.values());
  }

  getAllConversationalAgents(): ConversationalAgent[] {
    return Array.from(this.conversationalAgents.values());
  }
}
