export const label = (s) => (s || "").replace(/_/g, " ");

export function StatusBadge({ status }) {
  return <span className={`badge st-${status}`}>{label(status)}</span>;
}

export function PriorityBadge({ priority }) {
  return <span className={`badge pr-${priority}`}>{priority}</span>;
}