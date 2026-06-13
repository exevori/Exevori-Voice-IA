// ============================================================
// VOICEDESK IA — APP REACT (Entry Point)
// Structure monorepo : tout sous frontend/src/
// ============================================================

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

// i18n - DOIT être importé avant tout autre composant
import "./i18n";

import Layout from "./components/layout/Layout.jsx";
import Login from "./components/auth/Login.jsx";
import InviteAccept from "./components/auth/InviteAccept.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Contacts from "./pages/Contacts.jsx";
import Calls from "./pages/Calls.jsx";
import Emails from "./pages/Emails.jsx";
import { AuthProvider, useAuth } from "./contexts/AuthContext.jsx";

import "./styles/global.css";

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading-screen">Chargement...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/invite/:token" element={<InviteAccept />} />

          <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
            <Route index element={<Dashboard />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="admin" element={<Dashboard />} />
            <Route path="admin/clients" element={<Dashboard />} />
            <Route path="crm" element={<Contacts />} />
            <Route path="contacts" element={<Contacts />} />
            <Route path="calls" element={<Calls />} />
            <Route path="emails" element={<Emails />} />
            {/* Autres pages à construire par Emergent dans frontend/src/pages/ */}
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
