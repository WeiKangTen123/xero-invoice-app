import { Component } from 'react';

// Without this, any error thrown while rendering unmounts the whole tree and
// leaves a blank screen with nothing to click. The common cause is not a bug in
// a page: every page is a lazily loaded chunk (see App.jsx), a deploy deletes
// the previous build's chunks, and a tab opened before the deploy then asks for
// a file that is now a 404. Reloading fetches the new build, so that is the one
// thing offered.
//
// `resetKey` clears the error when it changes. App.jsx passes the path, so
// navigating to another page from the sidebar tries again instead of the
// message following you everywhere. A class component because error boundaries
// still have no hook equivalent.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // React logs the error itself in development only; keep a trace in
    // production too, so a report of "it went blank" has something behind it.
    console.error('Render failed', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" style={{ padding: 32, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
          Something went wrong — reload the page
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-muted)', maxWidth: 520 }}>
          This usually means the app was updated while this tab was open. Reloading
          loads the new version; nothing you saved is lost.
        </div>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
