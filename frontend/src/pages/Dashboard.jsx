import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useAuth } from "../auth";

export default function Dashboard() {
  const { user, logout } = useAuth();
  const summary = useQuery({ queryKey: ["summary"], queryFn: () => api("/items/summary") });

  return (
    <div className="page">
      <header className="top">
        <strong>Operations</strong>
        <span>{user.name} <button className="link" onClick={logout}>Sign out</button></span>
      </header>
      <p>Teams: {user.teams.map((t) => `${t.name} (${t.role})`).join(", ")}</p>
      {summary.isLoading && <p>Loading…</p>}
      {summary.error && <p className="error">{summary.error.message}</p>}
      {summary.data && <pre>{JSON.stringify(summary.data, null, 2)}</pre>}
    </div>
  );
}