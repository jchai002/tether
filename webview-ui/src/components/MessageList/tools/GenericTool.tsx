/**
 * Fallback renderer for tool calls that don't have a specialized component
 * (e.g., MCP tools like search_slack, resolve_slack_user, etc.).
 *
 * Instead of dumping raw JSON, parses the input and renders structured
 * key-value rows — similar to how Grep shows "/{pattern}/ in path".
 * Falls back to raw JSON only if parsing fails.
 */
import type { ToolCall } from "../../../context/types";
import { ToolResult } from "./ToolResult";
import { ToolParams } from "./ToolParams";

interface GenericToolProps {
  tool: ToolCall;
}

export function GenericTool({ tool }: GenericToolProps) {
  return (
    <div className="message tool-call" data-tool-call-id={tool.toolCallId}>
      <div className="message-label">{tool.toolName}</div>
      <ToolParams input={tool.input} />
      <ToolResult result={tool.result} />
    </div>
  );
}
