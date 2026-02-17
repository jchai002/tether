import { BusinessContextProvider } from "./businessContextProvider";
import { CodingAgent } from "./codingAgent";
import { ConversationalAgent } from "./conversationalAgent";

/**
 * Central registry for business context providers and coding agents.
 * Extension registers available providers on activate; orchestration
 * looks them up by ID from user config.
 *
 * Three registries:
 * - Business context providers (Slack, Teams, etc.)
 * - Coding agents — pipeline path (one-shot prompt → result)
 * - Conversational agents — SDK path (multi-turn streaming with MCP tools)
 */
export class ProviderRegistry {
  private businessContextProviders = new Map<string, BusinessContextProvider>();
  private codingAgents = new Map<string, CodingAgent>();
  private conversationalAgents = new Map<string, ConversationalAgent>();

  registerBusinessContext(provider: BusinessContextProvider): void {
    this.businessContextProviders.set(provider.id, provider);
  }

  registerCodingAgent(agent: CodingAgent): void {
    this.codingAgents.set(agent.id, agent);
  }

  registerConversationalAgent(agent: ConversationalAgent): void {
    this.conversationalAgents.set(agent.id, agent);
  }

  getBusinessContext(id: string): BusinessContextProvider | undefined {
    return this.businessContextProviders.get(id);
  }

  getCodingAgent(id: string): CodingAgent | undefined {
    return this.codingAgents.get(id);
  }

  getConversationalAgent(id: string): ConversationalAgent | undefined {
    return this.conversationalAgents.get(id);
  }

  getAllBusinessContextProviders(): BusinessContextProvider[] {
    return Array.from(this.businessContextProviders.values());
  }

  getAllCodingAgents(): CodingAgent[] {
    return Array.from(this.codingAgents.values());
  }

  getAllConversationalAgents(): ConversationalAgent[] {
    return Array.from(this.conversationalAgents.values());
  }
}
