/**
 * Shared Markdown renderer for assistant messages and plan text.
 *
 * Uses react-markdown (renders React elements, not innerHTML) so it works
 * with VS Code's strict CSP (default-src 'none'). remark-gfm adds GitHub
 * Flavored Markdown: tables, strikethrough, task lists, autolinks.
 *
 * Wrapped in React.memo — markdown text is immutable once rendered,
 * so there's no reason to re-parse on parent re-renders.
 */
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownProps {
  children: string;
  className?: string;
}

export const Markdown = memo(function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={`markdown-body ${className ?? ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
});
