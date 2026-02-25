/**
 * Renders a structured preview of a tool's input based on toolName.
 *
 * Used by PermissionRequest to show what Claude wants to do in a
 * human-readable format (diffs, terminal commands, file paths) instead
 * of raw JSON. Reuses DiffBlock for Edit/Write diffs and shares CSS
 * classes with the tool-specific components for visual consistency.
 *
 * Falls back to raw JSON for unknown tools.
 */
import { shortenPath } from "../../../utils/shortenPath";
import { DiffBlock } from "./DiffBlock";
import { ToolParams } from "./ToolParams";

interface ToolInputPreviewProps {
  toolName: string;
  input: string;
}

export function ToolInputPreview({ toolName, input }: ToolInputPreviewProps) {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(input);
  } catch {
    return <div className="message-content tool-input">{input}</div>;
  }

  switch (toolName) {
    case "Edit": {
      const filePath = (parsed.file_path as string) || "";
      const oldLines = ((parsed.old_string as string) || "").split("\n");
      const newLines = ((parsed.new_string as string) || "").split("\n");
      return (
        <>
          <div className="diff-file-path" title={filePath}>{shortenPath(filePath)}</div>
          <DiffBlock removedLines={oldLines} addedLines={newLines} />
        </>
      );
    }

    case "Write": {
      const filePath = (parsed.file_path as string) || "";
      const lines = ((parsed.content as string) || "").split("\n");
      return (
        <>
          <div className="diff-file-path" title={filePath}>{shortenPath(filePath)} (new)</div>
          <DiffBlock addedLines={lines} maxLines={40} />
        </>
      );
    }

    case "Bash": {
      const command = (parsed.command as string) || "";
      return (
        <div className="bash-command">
          <span className="bash-prompt">$ </span>
          <span className="bash-cmd-text">{command}</span>
        </div>
      );
    }

    case "Read": {
      const filePath = (parsed.file_path as string) || "";
      const offset = parsed.offset as number | undefined;
      const limit = parsed.limit as number | undefined;
      let rangeSuffix = "";
      if (offset !== undefined && limit !== undefined) {
        rangeSuffix = ` (line ${offset}, ${limit} lines)`;
      } else if (offset !== undefined) {
        rangeSuffix = ` (line ${offset})`;
      } else if (limit !== undefined) {
        rangeSuffix = ` (${limit} lines)`;
      }
      return (
        <div className="diff-file-path" title={filePath}>
          {shortenPath(filePath)}{rangeSuffix}
        </div>
      );
    }

    case "Glob": {
      const pattern = (parsed.pattern as string) || "";
      const searchPath = (parsed.path as string) || "";
      return (
        <div className="search-query">
          {pattern}
          {searchPath && <>{" "}in {shortenPath(searchPath)}</>}
        </div>
      );
    }

    case "Grep": {
      const pattern = (parsed.pattern as string) || "";
      const glob = (parsed.glob as string) || "";
      const searchPath = (parsed.path as string) || "";
      return (
        <div className="search-query">
          /{pattern}/
          {glob && <> {glob}</>}
          {searchPath && <> in {shortenPath(searchPath)}</>}
        </div>
      );
    }

    case "WebSearch": {
      const query = (parsed.query as string) || "";
      return <div className="search-query">{query}</div>;
    }

    default:
      return <ToolParams input={input} />;
  }
}
