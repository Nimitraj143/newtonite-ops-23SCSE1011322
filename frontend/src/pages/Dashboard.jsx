import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth.jsx";
import { http } from "../lib/http";
import { StatusBadge, PriorityBadge } from "../components/Badges.jsx";
import NewItemForm from "../components/NewItemForm.jsx";

const STATUSES = ["open", "in_progress", "awaiting_approval", "resolved", "closed"];
const PRIORITIES = ["low", "medium", "high", "urgent"];

const TILES = [
  { view: "", title: "All items", field: null },
  { view: "assigned_to_me", title: "Assigned to me", field: "assigned_to_me" },
  { view: "unassigned_urgent", title: "Unassigned urgent", field: "unassigned_urgent" },
  { view: "awaiting_my_approval", title: "Awaiting my approval", field: "awaiting_my_approval" },
];

export default function Dashboard() {
  const { user, logout } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [showForm, setShowForm] = useState(false);

  const view = sp.get("view") || "";
  const status = sp.get("status") || "";
  const priority = sp.get("priority") || "";
  const q = sp.get("q") || "";

  // search box: local text, URL update thoda ruk kar (debounce)
  const [text, setText] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setParam("q", text.trim()), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  function setParam(key, value) {
    const next = new URLSearchParams(sp);
    if (value) next.set(key, value); else next.delete(key);
    setSp(next, { replace: true });
  }

  const summary = useQuery({
    queryKey: ["summary"],
    queryFn: () => http("/items/summary"),
    refetchInterval: 20000,
  });

  const items = useInfiniteQuery({
    queryKey: ["items", { view, status, priority, q }],
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams();
      if (view) p.set("view", view);
      if (status) p.set("status", status);
      if (priority) p.set("priority", priority);
      if (q) p.set("q", q);
      if (pageParam) p.set("cursor", pageParam);
      p.set("limit", "25");
      return http(`/items?${p.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 20000,
  });

  const rows = items.data?.pages.flatMap((pg) => pg.items) ?? [];
  const creatableTeams = (user.teams || []).filter((t) => t.role !== "viewer");

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <strong>Operations</strong>
          <span className="muted"> · {user.name}</span>
        </div>
        <div className="row">
          {creatableTeams.length > 0 && (
            <button onClick={() => setShowForm(true)}>+ New item</button>
          )}
          <button className="ghost" onClick={logout}>Sign out</button>
        </div>
      </header>

      <div className="tiles">
        {TILES.map((t) => (
          <button
            key={t.title}
            className={`tile ${view === t.view ? "active" : ""}`}
            onClick={() => setParam("view", t.view)}
          >
            <div className="tile-num">
              {t.field ? (summary.data?.[t.field] ?? "–") : "•"}
            </div>
            <div className="muted">{t.title}</div>
          </button>
        ))}
      </div>

      {showForm && (
        <NewItemForm teams={creatableTeams} onClose={() => setShowForm(false)} />
      )}

      <div className="filters">
        <input
          placeholder="Search title or description..."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select value={status} onChange={(e) => setParam("status", e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </select>
        <select value={priority} onChange={(e) => setParam("priority", e.target.value)}>
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
        </select>
      </div>

      {items.isError && <p className="error">{items.error.message}</p>}
      {items.isLoading && <p className="muted">Loading...</p>}

      <table className="table">
        <thead>
          <tr>
            <th>#</th><th>Title</th><th>Team</th><th>Status</th>
            <th>Priority</th><th>Assignee</th><th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((it) => (
            <tr key={it.id}>
              <td>{it.id}</td>
              <td><Link to={`/items/${it.id}`}>{it.title}</Link></td>
              <td>{it.team_name}</td>
              <td><StatusBadge status={it.status} /></td>
              <td><PriorityBadge priority={it.priority} /></td>
              <td>{it.assignee_name || <span className="muted">unassigned</span>}</td>
              <td className="muted">{new Date(it.updated_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {!items.isLoading && rows.length === 0 && <p className="muted">No items match.</p>}

      {items.hasNextPage && (
        <button className="ghost" onClick={() => items.fetchNextPage()} disabled={items.isFetchingNextPage}>
          {items.isFetchingNextPage ? "Loading..." : "Load more"}
        </button>
      )}
    </div>
  );
}