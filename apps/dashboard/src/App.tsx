import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Toaster } from "sonner";
import { Layout } from "@/components/layout";
import { AuthProvider, useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { AuditPage } from "@/pages/audit";
import { ChatPage } from "@/pages/chat";
import { KeysPage } from "@/pages/keys";
import { InvitePage, LoginPage } from "@/pages/login";
import { ServersPage } from "@/pages/servers";
import { TeamPage } from "@/pages/team";

function RequireAuth({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { user, loading } = useAuth();
  if (loading) {
    return <div className="text-muted-foreground flex min-h-svh items-center justify-center text-sm">Loading…</div>;
  }
  if (!user) return <Navigate to="/login" replace />;
  if (admin && user.role !== "admin") return <Navigate to="/" replace />;
  return <>{children}</>;
}

function ThemedToaster() {
  const { theme } = useTheme();
  return <Toaster theme={theme} richColors closeButton position="bottom-right" />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route index element={<ServersPage />} />
            <Route path="chat" element={<ChatPage />} />
            <Route path="keys" element={<KeysPage />} />
            <Route
              path="team"
              element={
                <RequireAuth admin>
                  <TeamPage />
                </RequireAuth>
              }
            />
            <Route path="audit" element={<AuditPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      <ThemedToaster />
    </AuthProvider>
  );
}
