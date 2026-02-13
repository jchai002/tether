/**
 * Maps the messages[] array from state to the appropriate React component
 * for each message type. Uses the discriminated union's `kind` field to
 * select the right renderer.
 *
 * Auto-scrolling is handled by the parent (App.tsx) on the #messages div,
 * since that's the element with overflow-y: auto.
 */
import { useExtensionState } from "../../context/ExtensionStateContext";
import { ChatMessage } from "./ChatMessage";
import { ToolCallMessage } from "./ToolCallMessage";
import { PermissionRequest } from "./PermissionRequest";
import { TodoList } from "./TodoList";
import { UserQuestion } from "./UserQuestion";
import { PlanReview } from "./PlanReview";
import { CompactSummary } from "./CompactSummary";

export function MessageList() {
  const { state } = useExtensionState();

  return (
    <>
      {state.messages.map((item) => {
        switch (item.kind) {
          case "chat-message":
            return <ChatMessage key={item.id} message={item} />;
          case "tool-call":
            return <ToolCallMessage key={item.id} tool={item} />;
          case "permission-request":
            return <PermissionRequest key={item.id} item={item} />;
          case "todo-list":
            return <TodoList key={item.id} item={item} />;
          case "user-question":
            return <UserQuestion key={item.id} item={item} />;
          case "plan-review":
            return <PlanReview key={item.id} item={item} />;
          case "compact-summary":
            return <CompactSummary key={item.id} item={item} />;
        }
      })}
    </>
  );
}
