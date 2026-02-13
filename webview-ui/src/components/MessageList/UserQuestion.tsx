/**
 * Thin wrapper that converts a UserQuestionItem (from AskUserQuestion tool
 * calls) into generic UserResponsePanel props.
 *
 * Handles dispatching the answer to state and posting it to the extension.
 * The actual card UI is rendered by UserResponsePanel.
 */
import type { UserQuestionItem } from "../../context/types";
import { useExtensionState } from "../../context/ExtensionStateContext";
import { usePostMessage } from "../../hooks/usePostMessage";
import { UserResponsePanel } from "./tools/UserResponsePanel";

interface UserQuestionProps {
  item: UserQuestionItem;
}

export function UserQuestion({ item }: UserQuestionProps) {
  const { dispatch } = useExtensionState();
  const post = usePostMessage();

  return (
    <UserResponsePanel
      className="user-question"
      label="Question"
      questions={item.questions.map((q) => ({
        header: q.header,
        text: q.question,
        options: q.options,
        multiSelect: q.multiSelect,
      }))}
      allowCustom
      resolvedAnswers={item.answers}
      onCancel={() => post({ type: "cancel" })}
      onSubmit={(answers) => {
        dispatch({ type: "ui/answer-question", requestId: item.requestId, answers });
        post({ type: "user-question-response", requestId: item.requestId, answers });
      }}
    />
  );
}
