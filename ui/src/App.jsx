import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { ViewModeProvider } from './context/ViewModeContext';
import { PipelineProvider } from './context/PipelineContext';
import Layout from './components/layout/Layout';
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

function PrivateRoute({ children, adminOnly }) {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ padding: 32, color: 'var(--text-muted)' }}>Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && user.role !== 'admin') return <Navigate to="/dashboard" replace />;
  return children;
}

function AppRoutes() {
  const { user, loading } = useAuth();
  if (loading) return null;

  return (
    <Suspense fallback={PageLoading}>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/dashboard" replace /> : <Login />} />
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
          <Route path="dashboard"        element={<Dashboard />} />
          <Route path="automation"       element={<Automation />} />
          <Route path="setup"            element={<Setup />} />
          <Route path="invoices"         element={<Invoices />} />
          <Route path="invoices/:id"     element={<InvoiceReview />} />
          {/* /xero-insights was the financial page's path before the rename —
              kept as a redirect so existing bookmarks still land somewhere real. */}
          <Route path="xero-insights"    element={<Navigate to="/dashboard" replace />} />
          <Route
            path="admin"
            element={
              <PrivateRoute adminOnly>
                <Admin />
              </PrivateRoute>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ViewModeProvider>
        <AuthProvider>
          <PipelineProvider>
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
          </PipelineProvider>
        </AuthProvider>
      </ViewModeProvider>
    </ThemeProvider>
  );
}
