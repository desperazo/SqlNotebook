import { useEffect, useState } from "react";
import {
  backend,
  defaultPort,
  engineLabel,
  type ConnectionSpec,
  type ConnectionView,
  type EngineKind,
} from "../lib/backend";

type Props = {
  mode: "new" | "connect";
  existing?: ConnectionView;
  /** Existing group names, offered as suggestions in the Group field. */
  groups?: string[];
  onSubmit: (spec: ConnectionSpec, password: string) => void;
  onClose: () => void;
};

export default function ConnectionDialog({ mode, existing, groups, onSubmit, onClose }: Props) {
  const [kind, setKind] = useState<EngineKind>(existing?.kind ?? "mysql");
  const [name, setName] = useState(existing?.name ?? "");
  const [host, setHost] = useState(existing?.host ?? "127.0.0.1");
  const [port, setPort] = useState(String(existing?.port ?? 3306));
  const [user, setUser] = useState(existing?.user ?? "");
  const [database, setDatabase] = useState(existing?.database ?? "");
  const [group, setGroup] = useState(existing?.group ?? "");
  const [encrypt, setEncrypt] = useState(existing?.encryption !== "off");
  const [savePassword, setSavePassword] = useState(existing?.savePassword ?? false);
  const [password, setPassword] = useState("");

  // Prefill from the OS keychain when this connection opted into saving it.
  useEffect(() => {
    if (mode !== "connect" || !existing?.savePassword) return;
    let cancelled = false;
    backend.getPassword(existing.id).then((stored) => {
      if (!cancelled && stored) setPassword(stored);
    });
    return () => {
      cancelled = true;
    };
  }, [mode, existing]);

  const changeKind = (next: EngineKind) => {
    setKind(next);
    // Only follow the engine switch when the port was never customized.
    if (!port.trim() || Number(port) === defaultPort(kind)) setPort(String(defaultPort(next)));
  };

  const submit = () => {
    const spec: ConnectionSpec =
      mode === "connect" && existing
        ? { ...existing, savePassword }
        : {
            id: existing?.id ?? crypto.randomUUID(),
            name: name.trim() || host.trim(),
            host: host.trim(),
            port: Number(port) || defaultPort(kind),
            user: user.trim(),
            database: database.trim(),
            group: group.trim() || undefined,
            kind,
            encryption: kind === "mssql" ? (encrypt ? "required" : "off") : undefined,
            savePassword,
          };
    onSubmit(spec, password);
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <h2>{mode === "new" ? "New Connection" : `Connect to ${existing?.name ?? ""}`}</h2>

        {mode === "connect" && existing ? (
          <p className="dialog-hint">
            {engineLabel(existing.kind)} · {existing.user}@{existing.host}:{existing.port}
            {existing.database ? ` / ${existing.database}` : ""}
          </p>
        ) : (
          <div className="dialog-grid">
            <label>
              Engine
              <select value={kind} onChange={(e) => changeKind(e.target.value as EngineKind)}>
                <option value="mysql">MySQL</option>
                <option value="mssql">SQL Server</option>
              </select>
            </label>
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Production" />
            </label>
            <label>
              Host
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" />
            </label>
            <label>
              Port
              <input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                inputMode="numeric"
                placeholder={String(defaultPort(kind))}
              />
            </label>
            <label>
              User
              <input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder={kind === "mssql" ? "sa" : "root"}
              />
            </label>
            <label>
              Database <span className="optional">(optional)</span>
              <input
                value={database}
                onChange={(e) => setDatabase(e.target.value)}
                placeholder="case-sensitive"
                title="Leave empty to browse every database. Names are case-sensitive."
              />
            </label>
            <label>
              Group <span className="optional">(optional)</span>
              <input
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                list="connection-groups"
                placeholder="e.g. Production"
                title="Connections sharing a group name appear under one folder in the sidebar."
              />
              <datalist id="connection-groups">
                {(groups ?? []).map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </label>
            {kind === "mssql" && (
              <label
                className="checkbox-row"
                title="Uncheck only if the server aborts the TLS handshake (legacy TLS versions). Credentials then travel unencrypted."
              >
                <input
                  type="checkbox"
                  checked={encrypt}
                  onChange={(e) => setEncrypt(e.target.checked)}
                />
                Encrypt connection
              </label>
            )}
          </div>
        )}

        <label className="password-row">
          Password{" "}
          <span className="optional">{savePassword ? "(saved in keychain)" : "(not stored on disk)"}</span>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </label>

        <label
          className="checkbox-row remember-row"
          title="Stores the password in the OS keychain (macOS Keychain, Windows Credential Manager). It never touches connections.json."
        >
          <input
            type="checkbox"
            checked={savePassword}
            onChange={(e) => setSavePassword(e.target.checked)}
          />
          Save password
        </label>

        <div className="dialog-actions">
          <button className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button" onClick={submit} disabled={!password && mode === "connect"}>
            {mode === "new" ? "Save & Connect" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
