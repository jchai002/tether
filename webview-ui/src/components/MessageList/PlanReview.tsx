/**
 * Thin wrapper that converts a PlanReviewItem (from ExitPlanMode) into
 * generic UserResponsePanel props.
 *
 * Offers 4 choices:
 *   1. Accept & auto-approve edits — proceeds with acceptEdits permission mode
 *   2. Accept & review edits — proceeds with default (ask) permission mode
 *   3. Continue planning — tells Claude to keep refining the plan
 *   4. Other — free-text feedback for the user to explain what to change
 *
 * The plan text is rendered as content between the label and the options.
 */
import type { PlanReviewItem } from "../../context/types";
import { useExtensionState } from "../../context/ExtensionStateContext";
import { usePostMessage } from "../../hooks/usePostMessage";
import { UserResponsePanel } from "./tools/UserResponsePanel";

interface PlanReviewProps {
  item: PlanReviewItem;
}

/** Map the user's option label to the action string sent to the extension.
 *  "accept-auto" and "accept-manual" trigger permission mode changes,
 *  "continue" tells Claude to keep planning, anything else is custom feedback. */
const OPTION_TO_ACTION: Record<string, string> = {
  "Accept & auto-approve edits": "accept-auto",
  "Accept & review edits": "accept-manual",
  "Continue planning": "continue",
};

export function PlanReview({ item }: PlanReviewProps) {
  const { dispatch } = useExtensionState();
  const post = usePostMessage();

  /** Convert the response string back to a display label for resolved state */
  function responseLabel(response: string): string {
    if (response === "accept-auto") return "Accepted (auto-approve edits)";
    if (response === "accept-manual") return "Accepted (review edits)";
    if (response === "continue") return "Continue planning";
    if (response === "_restored") return "(answered)";
    return response; // custom feedback text
  }

  return (
    <UserResponsePanel
      className="plan-review"
      label="Plan Review"
      questions={[{
        header: "Action",
        text: "Claude has finished planning. How would you like to proceed?",
        options: [
          { label: "Accept & auto-approve edits", description: "Start implementing — auto-approve file edits" },
          { label: "Accept & review edits", description: "Start implementing — ask before each edit" },
          { label: "Continue planning", description: "Tell Claude to keep refining the plan" },
        ],
      }]}
      allowCustom
      resolvedAnswers={
        item.response
          ? { Action: responseLabel(item.response) }
          : undefined
      }
      onCancel={() => post({ type: "cancel" })}
      onSubmit={(answers) => {
        const label = answers.Action || "";
        const action = OPTION_TO_ACTION[label] || label; // custom text falls through as-is
        dispatch({ type: "ui/plan-response", requestId: item.requestId, response: action });
        post({ type: "plan-review-response", requestId: item.requestId, action });
      }}
    >
      {/* Show the plan text as a scrollable block between the label and options */}
      {item.planText && (
        <div className="plan-text">{item.planText}</div>
      )}
    </UserResponsePanel>
  );
}
