/**
 * Reusable interactive response panel for when Claude needs user input.
 *
 * Currently used for AskUserQuestion tool calls, but designed to be reused
 * for other interactive prompts (e.g., plan mode accept/deny/feedback).
 *
 * Renders:
 *   - A header badge (e.g., "Approach", "Library")
 *   - The question text
 *   - Clickable option cards with label + description
 *   - An "Other" option with a text input for custom answers
 *
 * Behavior:
 *   - Single question, single select → clicking an option auto-submits
 *   - Multi-select or multiple questions → shows a Submit button
 *   - After answering → dims the block and shows the selected answer
 *
 * The user's answers are sent back to the extension via "user-question-response"
 * message, which injects them into the tool input's `answers` field via the
 * SDK's `updatedInput` mechanism.
 */
import { useState } from "react";
import type { UserQuestionItem } from "../../../context/types";
import { useExtensionState } from "../../../context/ExtensionStateContext";
import { usePostMessage } from "../../../hooks/usePostMessage";

interface UserResponsePanelProps {
  item: UserQuestionItem;
}

export function UserResponsePanel({ item }: UserResponsePanelProps) {
  const { dispatch } = useExtensionState();
  const post = usePostMessage();

  // Track selected options per question (keyed by header)
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  // Track custom text per question (keyed by header)
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});
  // Track which questions have the "Other" input open
  const [showCustom, setShowCustom] = useState<Record<string, boolean>>({});

  // Single question + single select = auto-submit on click
  const isAutoSubmit = item.questions.length === 1 && !item.questions[0]?.multiSelect;

  /** Build the answers map and send to extension */
  function submit(overrideAnswers?: Record<string, string>) {
    const answers: Record<string, string> = overrideAnswers ?? {};
    if (!overrideAnswers) {
      for (const q of item.questions) {
        const custom = customTexts[q.header];
        if (custom) {
          answers[q.header] = custom;
        } else {
          const selected = selections[q.header] || [];
          answers[q.header] = selected.join(", ");
        }
      }
    }
    dispatch({ type: "ui/answer-question", requestId: item.requestId, answers });
    post({ type: "user-question-response", requestId: item.requestId, answers });
  }

  /** Handle clicking a predefined option */
  function handleOptionClick(header: string, label: string, multiSelect: boolean) {
    if (multiSelect) {
      // Toggle the option in the selections array
      setSelections((prev) => {
        const current = prev[header] || [];
        const isSelected = current.includes(label);
        return {
          ...prev,
          [header]: isSelected
            ? current.filter((l) => l !== label)
            : [...current, label],
        };
      });
      // Clear custom text when selecting predefined options
      setCustomTexts((prev) => ({ ...prev, [header]: "" }));
      setShowCustom((prev) => ({ ...prev, [header]: false }));
    } else {
      // Single select: replace the selection
      setSelections((prev) => ({ ...prev, [header]: [label] }));
      setCustomTexts((prev) => ({ ...prev, [header]: "" }));
      setShowCustom((prev) => ({ ...prev, [header]: false }));

      // Auto-submit for single question + single select
      if (isAutoSubmit) {
        submit({ [header]: label });
      }
    }
  }

  /** Handle clicking the "Other" option */
  function handleOtherClick(header: string) {
    setShowCustom((prev) => ({ ...prev, [header]: true }));
    setSelections((prev) => ({ ...prev, [header]: [] }));
  }

  // Already answered — show resolved state
  if (item.answers) {
    return (
      <div className="message user-question question-resolved">
        <div className="message-label">Question</div>
        {item.questions.map((q) => (
          <div key={q.header} className="question-section">
            <span className="question-header">{q.header}</span>
            <div className="question-text">{q.question}</div>
            <div className="question-answer">
              {item.answers![q.header] || "(no answer)"}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Check if submit is ready (at least one answer per question)
  const canSubmit = item.questions.every((q) => {
    const selected = selections[q.header] || [];
    const custom = customTexts[q.header] || "";
    return selected.length > 0 || custom.length > 0;
  });

  return (
    <div className="message user-question">
      <div className="message-label">Question</div>
      {item.questions.map((q) => (
        <div key={q.header} className="question-section">
          <span className="question-header">{q.header}</span>
          <div className="question-text">{q.question}</div>
          <div className="question-options">
            {q.options.map((opt) => {
              const isSelected = (selections[q.header] || []).includes(opt.label);
              return (
                <button
                  key={opt.label}
                  className={`question-option${isSelected ? " selected" : ""}`}
                  onClick={() => handleOptionClick(q.header, opt.label, q.multiSelect)}
                >
                  <div className="question-option-label">{opt.label}</div>
                  {opt.description && (
                    <div className="question-option-description">{opt.description}</div>
                  )}
                </button>
              );
            })}

            {/* "Other" option — always last */}
            {showCustom[q.header] ? (
              <div className="question-option selected">
                <div className="question-option-label">Other</div>
                <input
                  type="text"
                  className="question-custom-input"
                  placeholder="Type your answer..."
                  value={customTexts[q.header] || ""}
                  onChange={(e) =>
                    setCustomTexts((prev) => ({ ...prev, [q.header]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && customTexts[q.header]?.trim()) {
                      submit({ [q.header]: customTexts[q.header].trim() });
                    }
                  }}
                  autoFocus
                />
              </div>
            ) : (
              <button
                className="question-option"
                onClick={() => handleOtherClick(q.header)}
              >
                <div className="question-option-label">Other</div>
                <div className="question-option-description">
                  Provide custom instructions
                </div>
              </button>
            )}
          </div>
        </div>
      ))}

      {/* Submit button — only shown for multi-select or multi-question */}
      {!isAutoSubmit && (
        <button
          className="question-submit-btn"
          disabled={!canSubmit}
          onClick={() => submit()}
        >
          Submit
        </button>
      )}
    </div>
  );
}
