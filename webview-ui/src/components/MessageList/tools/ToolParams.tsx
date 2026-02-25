/**
 * Renders a tool's JSON input as structured key-value rows instead of
 * raw JSON. Used by GenericTool (for MCP tool calls) and ToolInputPreview
 * (for permission dialogs) so unknown tools look clean everywhere.
 *
 * Each JSON field becomes a row: dimmed key label + prominent value.
 * Long string values are truncated. Nested objects/arrays fall back to
 * compact JSON. If the input isn't valid JSON, shows the raw string.
 */

import { CollapsibleView } from "../../CollapsibleView";

interface ToolParamsProps {
  input: string;
}

/** Max characters for a single value before truncating. */
const MAX_VALUE_LENGTH = 200;

export function ToolParams({ input }: ToolParamsProps) {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input);
  } catch {
    // Not valid JSON — show raw string as-is
    return <div className="message-content tool-input">{input}</div>;
  }

  // Filter out keys with empty/undefined values
  const entries = Object.entries(parsed).filter(
    ([, v]) => v !== undefined && v !== null && v !== ""
  );

  if (entries.length === 0) {
    return null;
  }

  return (
    <CollapsibleView>
      <div className="tool-params">
        {entries.map(([key, value]) => (
          <div key={key} className="tool-param">
            <span className="tool-param-key">{formatKey(key)}</span>
            <span className="tool-param-value">{formatValue(value)}</span>
          </div>
        ))}
      </div>
    </CollapsibleView>
  );
}

/** Convert camelCase / snake_case keys to a readable label. */
function formatKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")  // camelCase → camel Case
    .replace(/_/g, " ")                     // snake_case → snake case
    .toLowerCase();
}

/** Format a value for display — strings are shown directly, others as JSON. */
function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length > MAX_VALUE_LENGTH
      ? value.slice(0, MAX_VALUE_LENGTH) + "..."
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // Arrays and objects — compact JSON
  const json = JSON.stringify(value);
  return json.length > MAX_VALUE_LENGTH
    ? json.slice(0, MAX_VALUE_LENGTH) + "..."
    : json;
}
