/**
 * Renders a compact summary block — shown when the SDK compacts the
 * conversation context to free up the context window.
 *
 * Displays a header ("Context compacted") with the summary text below it
 * in a collapsible view (since summaries can be long). Styled with a
 * distinct border color to visually separate it from regular messages.
 */
import type { CompactSummaryItem } from "../../context/types";
import { CollapsibleView } from "../CollapsibleView";

interface CompactSummaryProps {
  item: CompactSummaryItem;
}

export function CompactSummary({ item }: CompactSummaryProps) {
  return (
    <div className="message compact-summary">
      <div className="message-label">context compacted</div>
      <CollapsibleView>
        <div className="message-content">{item.text}</div>
      </CollapsibleView>
    </div>
  );
}
