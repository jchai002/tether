/**
 * Reusable interactive response panel for when Claude needs user input.
 *
 * This is a generic, props-driven UI component — it doesn't know about
 * specific message types (permissions, questions, plan mode). Callers
 * convert their data into the generic props and provide an onSubmit callback.
 *
 * Used by:
 *   - UserQuestion (AskUserQuestion tool calls)
 *   - PermissionRequest (tool permission allow/deny)
 *   - (future) PlanResponse (plan mode accept/deny/feedback)
 *
 * Renders:
 *   - A message label (e.g., "Question", tool name)
 *   - Optional children (e.g., tool input for permissions)
 *   - Question sections with header badge, text, and clickable option cards
 *   - An optional "Other" card with text input for custom answers
 *
 * Behavior:
 *   - Single question, single select → clicking a card auto-submits
 *   - Multi-select or multiple questions → shows a Submit button
 *   - After answering → dims the block and shows the selected answer
 */
import { useState, useEffect, type ReactNode } from "react";

interface ResponseOption {
  label: string;
  description?: string;
}

interface ResponseQuestion {
  header: string;
  text: string;
  options: ResponseOption[];
  multiSelect?: boolean;
}

export interface UserResponsePanelProps {
  /** CSS class on the outer div — controls accent color (e.g., "user-question", "permission-request") */
  className?: string;
  /** Label shown in the message header (e.g., "Question", tool name) */
  label: string;
  /** Question sections — each renders a header badge, question text, and option cards */
  questions: ResponseQuestion[];
  /** Whether to show an "Other" custom text input after each question's options */
  allowCustom?: boolean;
  /** If set, show resolved/dimmed state with these answers (keyed by header) */
  resolvedAnswers?: Record<string, string>;
  /** Called when the user submits their selection */
  onSubmit: (answers: Record<string, string>) => void;
  /** Called when the user presses ESC — cancels the pending request.
   *  If provided, a subtle "Press ESC to cancel" hint is shown at the bottom. */
  onCancel?: () => void;
  /** Optional content rendered between the label and the question sections
   *  (e.g., tool input for permission requests, plan diff for plan mode) */
  children?: ReactNode;
}

export function UserResponsePanel({
  className = "user-question",
  label,
  questions,
  allowCustom = false,
  resolvedAnswers,
  onSubmit,
  onCancel,
  children,
}: UserResponsePanelProps) {
  // Track selected options per question (keyed by header)
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  // Track custom text per question (keyed by header)
  const [customTexts, setCustomTexts] = useState<Record<string, string>>({});
  // Track which questions have the "Other" input open
  const [showCustom, setShowCustom] = useState<Record<string, boolean>>({});

  // ESC key cancels the pending request (sends "cancel" like the stop button).
  // Only active when onCancel is provided and not yet resolved.
  useEffect(() => {
    if (!onCancel || resolvedAnswers) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onCancel!();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, resolvedAnswers]);

  // Single question + single select = auto-submit on click
  const isAutoSubmit = questions.length === 1 && !questions[0]?.multiSelect;

  /** Build the answers map and call onSubmit */
  function submit(overrideAnswers?: Record<string, string>) {
    const answers: Record<string, string> = overrideAnswers ?? {};
    if (!overrideAnswers) {
      for (const q of questions) {
        const custom = customTexts[q.header];
        if (custom) {
          answers[q.header] = custom;
        } else {
          const selected = selections[q.header] || [];
          answers[q.header] = selected.join(", ");
        }
      }
    }
    onSubmit(answers);
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
  if (resolvedAnswers) {
    return (
      <div className={`message ${className} question-resolved`}>
        <div className="message-label">{label}</div>
        {children}
        {questions.map((q) => (
          <div key={q.header} className="question-section">
            <span className="question-header">{q.header}</span>
            <div className="question-text">{q.text}</div>
            <div className="question-answer">
              {resolvedAnswers[q.header] || "(no answer)"}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Check if submit is ready (at least one answer per question)
  const canSubmit = questions.every((q) => {
    const selected = selections[q.header] || [];
    const custom = customTexts[q.header] || "";
    return selected.length > 0 || custom.length > 0;
  });

  return (
    <div className={`message ${className}`}>
      <div className="message-label">{label}</div>
      {children}
      {questions.map((q) => (
        <div key={q.header} className="question-section">
          <span className="question-header">{q.header}</span>
          <div className="question-text">{q.text}</div>
          <div className="question-options">
            {q.options.map((opt) => {
              const isSelected = (selections[q.header] || []).includes(opt.label);
              return (
                <button
                  key={opt.label}
                  className={`question-option${isSelected ? " selected" : ""}`}
                  onClick={() => handleOptionClick(q.header, opt.label, q.multiSelect ?? false)}
                >
                  <div className="question-option-label">{opt.label}</div>
                  {opt.description && (
                    <div className="question-option-description">{opt.description}</div>
                  )}
                </button>
              );
            })}

            {/* "Other" option — always last, only if allowCustom is true */}
            {allowCustom && (
              showCustom[q.header] ? (
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
              )
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

      {/* Subtle ESC hint — only when onCancel is provided */}
      {onCancel && (
        <div className="response-cancel-hint">Press ESC to cancel</div>
      )}
    </div>
  );
}
