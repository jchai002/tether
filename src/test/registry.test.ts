import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "../providers/registry";
import { BusinessContextProvider } from "../providers/businessContextProvider";
import type { ConversationalAgent, AgentConversation, ConversationOptions, OnAgentMessage, AgentSetupInfo } from "../providers/conversationalAgent";

const fakeProvider = (id: string): BusinessContextProvider => ({
  id,
  displayName: `Provider ${id}`,
  isConfigured: () => true,
  configure: async () => {},
  searchMessages: async () => [],
  getThread: async () => null,
});

const fakeConversationalAgent = (id: string): ConversationalAgent => ({
  id,
  displayName: `Agent ${id}`,
  isAvailable: async () => true,
  isAuthenticated: async () => true,
  isAuthError: () => false,
  getSetupInfo: (): AgentSetupInfo => ({ displayName: `Agent ${id}`, installCommand: "npm install", cliBinaryName: "agent" }),
  getSetupCommand: () => "agent",
  resetCache: () => {},
  createConversation: (_options: ConversationOptions, _onMessage: OnAgentMessage): AgentConversation => ({
    start: async () => {},
    followUp: async () => {},
    cancel: () => {},
    handlePermissionResponse: () => {},
    handleUserQuestionResponse: () => {},
    handlePlanReviewResponse: () => {},
    setPermissionMode: () => {},
    isRunning: false,
    sessionId: null,
  }),
  createConversationForResume: (_options: ConversationOptions, _onMessage: OnAgentMessage, _existingSessionId: string): AgentConversation => ({
    start: async () => {},
    followUp: async () => {},
    cancel: () => {},
    handlePermissionResponse: () => {},
    handleUserQuestionResponse: () => {},
    handlePlanReviewResponse: () => {},
    setPermissionMode: () => {},
    isRunning: false,
    sessionId: null,
  }),
});

describe("ProviderRegistry", () => {
  it("registers and retrieves a context provider", () => {
    const registry = new ProviderRegistry();
    const provider = fakeProvider("slack");
    registry.registerBusinessContext(provider);
    expect(registry.getBusinessContext("slack")).toBe(provider);
  });

  it("registers and retrieves a conversational agent", () => {
    const registry = new ProviderRegistry();
    const agent = fakeConversationalAgent("claude-code-cli");
    registry.registerConversationalAgent(agent);
    expect(registry.getConversationalAgent("claude-code-cli")).toBe(agent);
  });

  it("returns undefined for unknown provider", () => {
    const registry = new ProviderRegistry();
    expect(registry.getBusinessContext("nonexistent")).toBeUndefined();
  });

  it("returns undefined for unknown agent", () => {
    const registry = new ProviderRegistry();
    expect(registry.getConversationalAgent("nonexistent")).toBeUndefined();
  });

  it("lists all providers", () => {
    const registry = new ProviderRegistry();
    registry.registerBusinessContext(fakeProvider("slack"));
    registry.registerBusinessContext(fakeProvider("mock"));
    const all = registry.getAllBusinessContextProviders();
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.id)).toEqual(["slack", "mock"]);
  });

  it("lists all conversational agents", () => {
    const registry = new ProviderRegistry();
    registry.registerConversationalAgent(fakeConversationalAgent("claude-code-cli"));
    const all = registry.getAllConversationalAgents();
    expect(all).toHaveLength(1);
  });

  it("overwrites provider with same id", () => {
    const registry = new ProviderRegistry();
    const v1 = fakeProvider("slack");
    const v2 = fakeProvider("slack");
    registry.registerBusinessContext(v1);
    registry.registerBusinessContext(v2);
    expect(registry.getBusinessContext("slack")).toBe(v2);
    expect(registry.getAllBusinessContextProviders()).toHaveLength(1);
  });
});
