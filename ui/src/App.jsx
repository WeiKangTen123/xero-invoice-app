import { lazy, Suspense } from 'react';
import { createBrowserRouter, RouterProvider, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { ViewModeProvider } from './context/ViewModeContext';
import { PipelineProvider } from './context/PipelineContext';
import { ConfirmProvider } from './context/ConfirmContext';
import { ToastProvider } from './context/ToastContext';
import Layout from './components/layout/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import { returnPathFrom } from './utils/returnTo';
// Login stays eager: it is the first paint for anyone signed out, and making it
// wait on a chunk to render a single form trades a real delay for no saving.
// Every other page is loaded on demand — the financial dashboard alone pulls in
// ~2k lines of chart panels that a user who only ever reviews invoices was
// previously downloading anyway.
import Login from './pages/Login';

const Capture       = lazy(() => import('./pages/Capture'));
const Setup         = lazy(() => import('./pages/Setup'));
const Invoices      = lazy(() => import('./pages/Invoices'));
const InvoiceReview = lazy(() => import('./pages/InvoiceReview'));
const Admin         = lazy(() => import('./pages/Admin'));
// The filenames still carry the pre-rename names: pages/Dashboard.jsx is the
// email→Xero control panel (now "Automation") and pages/XeroInsights.jsx is the
// financial reporting page (now "Dashboard"). Aliased so the route table below
// reads in the current vocabulary rather than the old one.
const Automation    = lazy(() => import('./pages/Dashboard'));
const Dashboard     = lazy(() => import('./pages/XeroInsights'));

const PageLoading = <div style={{ padding: 32, color: 'var(--text-muted)' }}>Loading...</div>;

// The session could not be checked — the server is down or out of reach — which
// is not the same as being signed out. The token is kept, so Retry is usually
// all it takes once the server is back; signing out is offered for a token the
// user would rather not wait on.
function SessionRetry() {
  const { authError, checking, retrySession, logout } = useAuth();
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'var(--bg-primary)' }}>
      <div className="card" role="alert" style={{ maxWidth: 420, width: '100%', textAlign: 'center' }}>
        <div style={{ fontSize: 28, marginBottom: 10 }}>⚡</div>
        <div className="card-title" style={{ marginBottom: 6 }}>Cannot reach the server</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.55, marginBottom: 18 }}>
          You are still signed in — the app just could not check with the server.
          {authError && <><br /><span style={{ fontSize: 12 }}>({authError})</span></>}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button type="button" className="btn btn-primary" onClick={retrySession} disabled={checking}>
            {checking ? <><span className="btn-spinner" /> Retrying…</> : 'Retry'}
          </button>
          <button type="button" className="btn btn-outline" onClick={logout} disabled={checking}>Sign out</button>
        </div>
      </div>
    </div>
  );
}

function PrivateRoute({ children, adminOnly }) {
  const { user, loading, authError } = useAuth();
  const location = useLocation();
  if (loading) return <div style={{ padding: 32, color: 'var(--text-muted)' }}>Loading...</div>;
  if (!user && authError) return <SessionRetry />;
  // The page asked for goes along, so signing in leads back to it.
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  if (adminOnly && user.role !== 'admin') return <Navigate to="/dashboard" replace />;
  return children;
}

function AppRoutes() {
  const { user, loading } = useAuth();
  const location = useLocation();
  const { pathname } = location;
  if (loading) return null;

  // Two layers. Each page inside the layout gets its own boundary, so a page
  // that fails (most often a chunk deleted by a deploy) is replaced by the
  // reload message while the sidebar stays usable. The outer one catches the
  // rest — the layout itself, Login, Capture — which would otherwise leave a
  // blank screen. Both reset when the path changes.
  const page = el => <ErrorBoundary resetKey={pathname}>{el}</ErrorBoundary>;

  return (
    <ErrorBoundary resetKey={pathname}>
      <Suspense fallback={PageLoading}>
        <Routes>
          {/* Signing in sets `user`, which re-renders this before Login's own
              navigate runs — so both send to the same place: the page that
              sent the user here, else the dashboard. */}
          <Route path="/login" element={user ? <Navigate to={returnPathFrom(location)} replace /> : <Login />} />
          {/* Outside the auth guard on purpose: the pairing token in the URL is the
              phone's only credential, and it grants upload and nothing else. */}
          <Route path="/capture/:token" element={<Capture />} />
          <Route
            path="/"
            element={
              <PrivateRoute>
                <Layout />
              </PrivateRoute>
            }
          >
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard"        element={page(<Dashboard />)} />
            <Route path="automation"       element={page(<Automation />)} />
            <Route path="setup"            element={page(<Setup />)} />
            <Route path="invoices"         element={page(<Invoices />)} />
            <Route path="invoices/:id"     element={page(<InvoiceReview />)} />
            {/* /xero-insights was the financial page's path before the rename —
                kept as a redirect so existing bookmarks still land somewhere real. */}
            <Route path="xero-insights"    element={<Navigate to="/dashboard" replace />} />
            <Route
              path="admin"
              element={page(
                <PrivateRoute adminOnly>
                  <Admin />
                </PrivateRoute>
              )}
            />
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

// A data router rather than <BrowserRouter>, for one feature: useBlocker, which
// lets a page with unsaved edits ask before a navigation throws them away (see
// utils/useUnsavedChanges.js) and exists only on a data router. The route table
// itself is unchanged — it stays in <AppRoutes> as descendant routes under one
// catch-all, because it reads the signed-in user, which a route list built
// once at module load could not.
const router = createBrowserRouter([{ path: '*', element: <AppRoutes /> }]);

export default function App() {
  return (
    <ThemeProvider>
      <ViewModeProvider>
        <AuthProvider>
          <PipelineProvider>
            <ToastProvider>
              <ConfirmProvider>
                <RouterProvider router={router} />
              </ConfirmProvider>
            </ToastProvider>
          </PipelineProvider>
        </AuthProvider>
      </ViewModeProvider>
    </ThemeProvider>
  );
}
