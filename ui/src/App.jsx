import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { PipelineProvider } from './context/PipelineContext';
import Layout from './components/layout/Layout';
import Login from './pages/Login';
import Setup from './pages/Setup';
import Invoices from './pages/Invoices';
import InvoiceReview from './pages/InvoiceReview';
import Admin from './pages/Admin';
// The filenames still carry the pre-rename names: pages/Dashboard.jsx is the
// email→Xero control panel (now "Automation") and pages/XeroInsights.jsx is the
// financial reporting page (now "Dashboard"). Aliased so the route table below
// reads in the current vocabulary rather than the old one.
import Automation from './pages/Dashboard';
import Dashboard from './pages/XeroInsights';

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
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/dashboard" replace /> : <Login />} />
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
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <PipelineProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </PipelineProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
