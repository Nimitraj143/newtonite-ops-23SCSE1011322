import { useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth.jsx";
import { http, newKey } from "../lib/http";
import { StatusBadge, PriorityBadge, label } from "../components/Badges.jsx";

const PRIORITIES = ["low", "medium", "high", "urgent"];

function describe(ev) {
  const p = ev.payload || {};
  if (p.body) return `"${p.body}"`;
  const parts = Object.entries(p).map(([k, v]) =>
    typeof v === "object" && v !== null ? `${k}: ${JSON.stringify(v)}` : `${k}: ${v}`
  );
  return parts.join(", ");
}

export default function ItemPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [comment, setComment] = useState("");
  const commentKey = useRef(newKey());

  const item = useQuery({
    queryKey: ["item", id],
    queryFn: () => http(`/items/${id}`),
    refetchInterval: 15000,
  });

  const activity = useInfiniteQuery({
    queryKey: ["activity", id],
    initialPageParam: undefined,
    queryFn: ({ pageParam }) =>
      http(`/items/${id}/activity?limit=30${pageParam ? `&cursor=${pageParam}` : ""}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 15000,
  });

  function refreshAll() {
    qc.invalidateQueries({ queryKey: ["item", id] });
    qc.invalidateQueries({ queryKey: ["activity", id] });
    qc.invalidateQueries({ queryKey: ["items"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
  }

  function onError(e) {
    if (e.status === 409) {
      setNotice("Someone else changed this item (or claimed it first). Showing the latest version. Please review and try again.");
      refreshAll();
    } else if (e.status === 403) {
      setNotice("You are not allowed to do that.");
      refreshAll();
    } else if (e.status === 422) {
      setNotice(e.message || "That change is not allowed.");
      refreshAll();
    } else {
      setNotice(e.message || "Something went wrong.");
    }
  }

  const act = useMutation({
    mutationFn: ({ path, method = "POST", body }) =>
      http(`/items/${id}${path}`, { method, body }),
    onSuccess: () => { setNotice(""); setEditing(false); refreshAll(); },
    onError,
  });

  const addComment = useMutation({
    mutationFn: () =>
      http(`/items/${id}/comments`, {
        method: "POST",
        key: commentKey.current,
        body: { body: comment },
      }),
    onSuccess: () => {
      setComment("");
      commentKey.current = newKey(); // naya comment = nayi key
      setNotice("");
      refreshAll();
    },
    onError,
  });

  if (item.isLoading) return <div className="page"><p className="muted">Loading...</p></div>;
  if (item.isError) {
    return (
      <div className="page">
        <Link to="/">← Back</Link>
        <p className="error">
          {item.error.status === 404 ? "Item not found (or you do not have access)." : item.error.message}
        </p>
      </div>
    );
  }

  const it = item.data;
  const v = it.version;
  const events = activity.data?.pages.flatMap((p) => p.events) ?? [];

  function startEdit() {
    setDraft({ title: it.title, description: it.description, priority: it.priority });
    setEditing(true);
  }

  return (
    <div className="page">
      <Link to="/">← Back to dashboard</Link>

      {notice && <div className="notice">{notice}</div>}

      <div className="card">
        {editing ? (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              act.mutate({ path: "", method: "PATCH", body: { ...draft, version: v } });
            }}
          >
            <label>Title
              <input required value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </label>
            <label>Description
              <textarea rows={4} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </label>
            <label>Priority
              <select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}>
                {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
              </select>
            </label>
            <div className="row">
              <button type="submit" disabled={act.isPending}>Save</button>
              <button type="button" className="ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        ) : (
          <>
            <h2>#{it.id} · {it.title}</h2>
            <div className="row">
              <StatusBadge status={it.status} />
              <PriorityBadge priority={it.priority} />
              <span className="badge">{label(it.type)}</span>
              <span className="muted">{it.team_name}</span>
            </div>
            <p>{it.description || <span className="muted">No description.</span>}</p>
            <p className="muted">
              Assignee: {it.assignee_name || "unassigned"} · Created by {it.created_by_name} ·
              Updated {new Date(it.updated_at).toLocaleString()} · version {it.version}
            </p>

            <div className="row">
              {it.can?.claim && (
                <button disabled={act.isPending} onClick={() => act.mutate({ path: "/claim", body: { version: v } })}>
                  Claim
                </button>
              )}
              {it.can?.assign && (
                <>
                  <button className="ghost" disabled={act.isPending}
                    onClick={() => act.mutate({ path: "/assign", body: { assignee_id: user.id, version: v } })}>
                    Assign to me
                  </button>
                  {it.assignee_id && (
                    <button className="ghost" disabled={act.isPending}
                      onClick={() => act.mutate({ path: "/assign", body: { assignee_id: null, version: v } })}>
                      Unassign
                    </button>
                  )}
                </>
              )}
              {it.can?.edit && <button className="ghost" onClick={startEdit}>Edit</button>}
            </div>

            {it.allowed_transitions?.length > 0 && (
              <div className="row" style={{ marginTop: 12 }}>
                <span className="muted">Move to:</span>
                {it.allowed_transitions.map((to) => (
                  <button key={to} className="ghost" disabled={act.isPending}
                    onClick={() => act.mutate({ path: "/transition", body: { to, version: v } })}>
                    {label(to)}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {it.can?.comment && (
        <form
          className="card form"
          onSubmit={(e) => { e.preventDefault(); if (comment.trim()) addComment.mutate(); }}
        >
          <label>Add a comment
            <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
          <div className="row">
            <button type="submit" disabled={addComment.isPending || !comment.trim()}>
              {addComment.isPending ? "Posting..." : "Post comment"}
            </button>
          </div>
        </form>
      )}

      <div className="card">
        <h3>History</h3>
        {activity.isLoading && <p className="muted">Loading...</p>}
        <ul className="timeline">
          {events.map((ev) => (
            <li key={ev.id}>
              <strong>{label(ev.kind)}</strong> by {ev.actor_name || "system"}
              <span className="muted"> · {new Date(ev.created_at).toLocaleString()}</span>
              {describe(ev) && <div className="muted">{describe(ev)}</div>}
            </li>
          ))}
        </ul>
        {activity.hasNextPage && (
          <button className="ghost" onClick={() => activity.fetchNextPage()}>Load older</button>
        )}
      </div>
    </div>
  );
}