import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth";

const DEMO = [
  ["admin@demo.com", "Admin (all teams)"],
  ["raj@demo.com", "Raj, Lead (Payments)"],
  ["maya@demo.com", "Maya, Member (Payments)"],
  ["vik@demo.com", "Vik, Viewer (Payments)"],
  ["sana@demo.com", "Sana, Member (Platform)"],
  ["leo@demo.com", "Leo, Lead (Platform)"],
  ["ivy@demo.com", "Ivy, Member (Support), Viewer (Compliance)"],
  ["dev@demo.com", "Dev, Member (Payments + Platform)"],
];

export default function Login() {
  const { user, login } = useAuth();
  const [email, setEmail] = useState("maya@demo.com");
  const [password, setPassword] = useState("Password123!");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <h1>Operations</h1>
      <form onSubmit={submit}>
        <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <h3>Demo accounts (password: Password123!)</h3>
      <ul className="demo">
        {DEMO.map(([e, label]) => (
          <li key={e}><button type="button" className="link" onClick={() => setEmail(e)}>{label}</button></li>
        ))}
      </ul>
    </div>
  );
}