// The frame of the pages someone reaches without signing in, from a link in
// an email or from the sign-in page: the set-password and forgot-password
// pages. One card in the middle of the window under the app's name, as the
// "Cannot reach the server" card in App.jsx is drawn. The sign-in page keeps
// its own, livelier frame.
export default function PublicShell({ children }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 16px', background: 'var(--bg-primary)' }}>
      <div style={{ width: '100%', maxWidth: 420, animation: 'scaleIn 0.3s ease' }}>
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <div aria-hidden="true" style={{
            width: 44, height: 44, borderRadius: 13, margin: '0 auto 12px',
            background: 'var(--accent-gradient)', boxShadow: '0 6px 22px rgba(99,102,241,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
          }}>
            ⚡
          </div>
          <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.4px', color: 'var(--text-primary)' }}>Financial Automation</div>
        </div>
        <main className="card" style={{ padding: '26px 26px 22px' }}>
          {children}
        </main>
      </div>
    </div>
  );
}
