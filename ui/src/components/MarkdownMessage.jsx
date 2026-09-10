import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Split into its own module so ChatAssistant can lazy-load it. react-markdown
// and remark-gfm are the single heaviest thing the UI depends on, and they are
// only ever needed once an assistant reply is on screen — which for most
// sessions is never. Keeping them out of the entry chunk means they no longer
// ship as part of the login screen.
//
// Assistant replies are markdown (the model is asked to use tables for
// multi-field summaries) — render it properly instead of showing literal ** and
// | characters. User messages are NOT rendered as markdown — a user's own words
// should show up exactly as typed, not be reinterpreted as formatting.
export default function MarkdownMessage({ content }) {
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
