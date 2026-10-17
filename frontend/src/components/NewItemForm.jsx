import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { http, newKey } from "../lib/http";

const TYPES = ["incident", "customer_issue", "payment", "compliance", "task"];
const PRIORITIES = ["low", "medium", "high", "urgent"];

export default function NewItemForm({ teams, onClose }) {
  const qc = useQueryClient();
  const keyRef = useRef(newKey()); // ek form = ek idempotency key
  const [form, setForm] = useState({
    team_id: teams[0]?.id ?? "",
    title: "",
    description: "",
    priority: "medium",
    type: TYPES[0],
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const create = useMutation({
    mutationFn: () =>
      http("/items", {
        method: "POST",
        key: keyRef.current,
        body: { ...form, team_id: Number(form.team_id) },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["items"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
      onClose();
    },
  });

  return (
    <form className="card form" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <h3>New item</h3>
      <label>Team
        <select value={form.team_id} onChange={set("team_id")}>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <label>Title
        <input required value={form.title} onChange={set("title")} />
      </label>
      <label>Description
        <textarea rows={3} value={form.description} onChange={set("description")} />
      </label>
      <div className="row">
        <label>Priority
          <select value={form.priority} onChange={set("priority")}>
            {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
        <label>Type
          <select value={form.type} onChange={set("type")}>
            {TYPES.map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
      </div>
      {create.isError && <p className="error">{create.error.message}</p>}
      <div className="row">
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating..." : "Create"}
        </button>
        <button type="button" className="ghost" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}