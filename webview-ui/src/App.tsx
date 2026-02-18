/**
 * Top-level App component — composes the main UI layout.
 *
 * Responsibilities:
 * - Wraps everything in ExtensionStateProvider (React Context for state)
 * - Registers the extension message listener via useExtensionMessage hook
 * - Lays out the main UI sections: header, messages, status, input
 *
 * Components are swapped in/out based on state:
 * - showWelcome → WelcomeScreen (no active conversation)
 * - showSessionList → SessionList (browsing past conversations)
 * - else → MessageList (active conversation with messages)
 */
import { ExtensionStateProvider, useExtensionState } from "./context/ExtensionStateContext";
import { useExtensionMessage } from "./hooks/useExtensionMessage";
import { useAutoScroll } from "./hooks/useAutoScroll";
import { Header } from "./components/Header";
import { SetupScreen } from "./components/SetupScreen";
import { WelcomeScreen } from "./components/WelcomeScreen";

import { StatusBar } from "./components/StatusBar";
import { MessageList } from "./components/MessageList/MessageList";
import { InputArea } from "./components/InputArea/InputArea";

interface AppProps {
  vscodeApi: { postMessage(msg: unknown): void };
}

export function App({ vscodeApi }: AppProps) {
  return (
    <ExtensionStateProvider vscodeApi={vscodeApi}>
      <AppContent />
    </ExtensionStateProvider>
  );
}

/** Inner component that has access to the Context (must be inside the Provider) */
function AppContent() {
  useExtensionMessage();
  const { state } = useExtensionState();
  // Auto-scroll must be on #messages — it's the element with overflow-y: auto.
  // MessageList is a child, so scrolling it directly wouldn't work.
  const scrollRef = useAutoScroll([state.messages.length]);

  // Setup is needed if we've checked and either CLI is missing or not authenticated.
  // setupStatus === null means "still checking" — SetupScreen handles that internally.
  const setupNeeded =
    state.setupStatus !== null &&
    (!state.setupStatus.cliInstalled || !state.setupStatus.cliAuthenticated);

  return (
    <>
      <Header />
      <div id="messages" ref={scrollRef}>
        {setupNeeded ? (
          <SetupScreen />
        ) : state.showWelcome ? (
          <WelcomeScreen />
        ) : (
          <MessageList />
        )}
      </div>
      <StatusBar />
      <InputArea />
    </>
  );
}
