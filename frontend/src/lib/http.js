const BASE = import.meta.env.VITE_API_URL || "http://localhost:4000";

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function http(path, { method = "GET", body, key } = {}) {
  const headers = { "Content-Type": "application/json" };
  let token = null;
  try { token = localStorage.getItem("ops_token"); } catch {}
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers["Idempotency-Key"] = key;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401) window.dispatchEvent(new Event("auth:expired"));
  if (!res.ok) {
    const e = data?.error;
    throw new HttpError(
      res.status,
      (typeof e === "string" ? e : e?.message) || data?.message || `Error ${res.status}`,
      e?.details || data?.details
    );
  }
  return data;
}

export const newKey = () => crypto.randomUUID();