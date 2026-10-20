import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cellKind } from './chat-layout';

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

// The text of a cell, through any bold or code inside it.
function textOf(children) {
  if (children == null || typeof children === 'boolean') return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  return children.props ? textOf(children.props.children) : '';
}

// A table wider than the chat used to be squeezed to its width, numbers broken
// over lines and the rest cut off, and the whole message list scrolled
// sideways. Each table now scrolls on its own, inside the bubble; amounts,
// dates and references stay on one line and sentences wrap (styles at the end
// of ChatAssistant.jsx). `node` is react-markdown's syntax node, not an
// attribute for the page.
const COMPONENTS = {
  table: ({ node, ...props }) => (
    <div className="chat-md-table" style={{ overflowX: 'auto' }}>
      <table {...props} />
    </div>
  ),
  td: ({ node, className, ...props }) => (
    <td {...props} className={[className, `cell-${cellKind(textOf(props.children))}`].filter(Boolean).join(' ')} />
  ),
};

export default function MarkdownMessage({ content }) {
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>{content}</ReactMarkdown>
    </div>
  );
}
