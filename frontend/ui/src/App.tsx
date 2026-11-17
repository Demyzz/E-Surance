import { LogOut } from "lucide-react";
import { useEffect } from "react";
import { Brand, roleLabel } from "./components/Shell";
import { Button } from "./components/ui";
import type { Role } from "./lib/api";
import { navigate, useLocation } from "./lib/router";
import { useSession } from "./lib/session";
import { AdminApp } from "./pages/AdminApp";
import { AgentApp } from "./pages/AgentApp";
import { CustomerApp } from "./pages/CustomerApp";
import { Home } from "./pages/Home";
import { Login } from "./pages/Login";

const roles: Role[] = ["customer", "agent", "admin"];

export function App() {
  const { path, query } = useLocation();
  const [, first = "", section = ""] = path.split("/");
  const role = roles.find((r) => r === first);
  return role ? <RolePage role={role} section={section} query={query} /> : <Home />;
}

function RolePage({ role, section, query }: { role: Role; section: string; query: URLSearchParams }) {
  const { session, logout } = useSession();

  useEffect(() => {
    if (session) document.title = `E-Surance · ${roleLabel[role]}`;
  }, [session, role]);

  if (!session) return <Login role={role} />;

  if (session.user.role !== role) {
    return (
      <div className="grid min-h-screen place-items-center px-4">
        <div className="card max-w-md p-8 text-center">
          <div className="flex justify-center"><Brand tone="dark" /></div>
          <p className="mt-6 text-[15px]">
            This tab is logged in as <strong>@{session.user.username}</strong>, a {roleLabel[session.user.role].toLowerCase()}.
          </p>
          <p className="mt-1 text-[14px] text-ink-soft">Open another browser tab to log in to the {roleLabel[role].toLowerCase()} portal.</p>
          <div className="mt-6 flex justify-center gap-2">
            <Button onClick={() => navigate(`/${session.user.role}`)}>Go to my portal</Button>
            <Button variant="secondary" icon={<LogOut className="size-4" />} onClick={logout}>Log out</Button>
          </div>
        </div>
      </div>
    );
  }

  if (role === "customer") return <CustomerApp section={section} query={query} />;
  if (role === "agent") return <AgentApp section={section} query={query} />;
  return <AdminApp section={section} query={query} />;
}
