/**
 * The write-only Connect card for OpenCode Go.
 *
 * The key input is a password field that initializes empty on every load,
 * never receives the stored secret as a prop or value, and is cleared on
 * every resolved or rejected connect/test/disconnect. Disconnected →
 * connected → disconnected states are driven purely by credential/API calls
 * through the narrow `ConnectRemote` surface. Rejected remote actions become
 * sanitized locale notices; the busy flag always settles in a `finally`.
 */
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useId } from "react";
import type { ConnectCardKey } from "./locales.ts";
import type { ClientDoctorSummary, ConnectRemote } from "./connect-remote.ts";

export interface ConnectCardProps {
  readonly remote: ConnectRemote;
  readonly t: (key: ConnectCardKey) => string;
}

type CardState =
  | { readonly phase: "loading" }
  | { readonly phase: "disconnected" }
  | { readonly phase: "connected" };

type Notice =
  | { readonly kind: "invalid-key" }
  | { readonly kind: "store-failed" }
  | { readonly kind: "status-unavailable" }
  | { readonly kind: "test-failed" };

const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
  padding: "18px 20px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 12,
  background: "var(--dsw-alias-bg-module-platform)",
};
const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  lineHeight: "24px",
  fontWeight: 600,
  color: "var(--dsw-alias-label-primary)",
};
const bodyStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: "20px",
  color: "var(--dsw-alias-label-secondary)",
};
const statusStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 14,
  fontWeight: 500,
  color: "var(--dsw-alias-label-primary)",
};
const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" };
const inputStyle: CSSProperties = {
  boxSizing: "border-box",
  minWidth: 260,
  minHeight: 34,
  padding: "6px 10px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 8,
  background: "var(--dsw-alias-bg-layer-1)",
  color: "var(--dsw-alias-label-primary)",
  font: "inherit",
  fontSize: 13,
};
const buttonStyle: CSSProperties = {
  boxSizing: "border-box",
  minHeight: 34,
  padding: "6px 14px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: 18,
  background: "var(--dsw-alias-bg-layer-1)",
  color: "var(--dsw-alias-label-primary)",
  font: "inherit",
  fontSize: 13,
  cursor: "pointer",
};
const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: "var(--dsw-alias-brand-primary)",
  background: "var(--dsw-alias-brand-primary)",
  color: "white",
};
const disabledButtonStyle: CSSProperties = { opacity: 0.4, cursor: "not-allowed" };

const noticeStyle: CSSProperties = { ...bodyStyle, color: "var(--dsw-alias-state-error-primary)" };

function buttonDisabledStyle(disabled: boolean, base: CSSProperties): CSSProperties {
  return disabled ? { ...base, ...disabledButtonStyle } : base;
}

function noticeText(notice: Notice, t: ConnectCardProps["t"]): string {
  switch (notice.kind) {
    case "invalid-key":
      return t("invalidKey");
    case "store-failed":
      return t("storeFailed");
    case "status-unavailable":
      return t("statusUnavailable");
    case "test-failed":
      return t("testFailed");
  }
}

function doctorText(doctor: ClientDoctorSummary, t: ConnectCardProps["t"]): string {
  switch (doctor.kind) {
    case "configured":
      return `${t("testResultPrefix")}${doctor.liveModelCount}`;
    case "unconfigured":
      return t("testUnconfigured");
    case "unavailable":
      return t("testUnavailable");
    case "failed":
      return `${t("testFailed")} (${doctor.code})`;
  }
}

/**
 * The Connect card. The key input value lives only in local state and reaches
 * exactly one destination: `remote.connect`. Every action — resolved or
 * rejected — clears it; the unmount cleanup only cancels in-flight reads and
 * never updates state.
 */
export function ConnectCard({ remote, t }: ConnectCardProps): JSX.Element {
  const keyInputId = useId();
  const keyHelpId = useId();
  const [phase, setPhase] = useState<CardState>({ phase: "loading" });
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [doctor, setDoctor] = useState<ClientDoctorSummary | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void remote.status().then(
      (status) => {
        if (!cancelled) {
          setPhase(status.configured ? { phase: "connected" } : { phase: "disconnected" });
        }
      },
      () => {
        if (!cancelled) {
          setPhase({ phase: "disconnected" });
          setNotice({ kind: "status-unavailable" });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [remote]);

  const refreshStatus = useCallback(async (): Promise<void> => {
    const status = await remote.status();
    setPhase(status.configured ? { phase: "connected" } : { phase: "disconnected" });
  }, [remote]);

  const handleConnect = useCallback(async (): Promise<void> => {
    const key = keyInput;
    if (key.length === 0) return;
    setBusy(true);
    setNotice(undefined);
    setDoctor(undefined);
    try {
      const result = await remote.connect(key);
      setKeyInput("");
      if (result.kind === "connected") {
        await refreshStatus();
      } else {
        setNotice(result.kind === "invalid" ? { kind: "invalid-key" } : { kind: "store-failed" });
      }
    } catch {
      setKeyInput("");
      setNotice({ kind: "store-failed" });
    } finally {
      setBusy(false);
    }
  }, [keyInput, remote, refreshStatus]);

  const handleTest = useCallback(async (): Promise<void> => {
    setBusy(true);
    setDoctor(undefined);
    try {
      const outcome = await remote.doctor();
      setKeyInput("");
      setDoctor(outcome);
    } catch {
      setKeyInput("");
      setNotice({ kind: "test-failed" });
    } finally {
      setBusy(false);
    }
  }, [remote]);

  const handleDisconnect = useCallback(async (): Promise<void> => {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await remote.disconnect();
      setKeyInput("");
      if (result.kind === "disconnected") {
        await refreshStatus();
      } else {
        setNotice({ kind: "store-failed" });
      }
    } catch {
      setKeyInput("");
      setNotice({ kind: "store-failed" });
    } finally {
      setBusy(false);
    }
  }, [remote, refreshStatus]);

  const connected = phase.phase === "connected";

  return (
    <section style={cardStyle} aria-label={t("title")}>
      <h2 style={titleStyle}>{t("title")}</h2>
      <p style={bodyStyle}>{t("intro")}</p>
      <div style={statusStyle} role="status">
        {phase.phase === "loading"
          ? t("loading")
          : connected
            ? t("connected")
            : t("notConnected")}
      </div>
      <label htmlFor={keyInputId}>{t("keyLabel")}</label>
      <div style={rowStyle}>
        <input
          id={keyInputId}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          placeholder={t("keyPlaceholder")}
          value={keyInput}
          onChange={(event) => setKeyInput(event.target.value)}
          disabled={busy}
          aria-describedby={keyHelpId}
        />
        <button type="button" style={buttonDisabledStyle(busy || keyInput.length === 0, primaryButtonStyle)} onClick={() => void handleConnect()} disabled={busy || keyInput.length === 0}>
          {t("connect")}
        </button>
        <button type="button" style={buttonDisabledStyle(busy, buttonStyle)} onClick={() => void handleTest()} disabled={busy}>
          {t("testConnection")}
        </button>
        {connected ? (
          <button type="button" style={buttonDisabledStyle(busy, buttonStyle)} onClick={() => void handleDisconnect()} disabled={busy}>
            {t("disconnect")}
          </button>
        ) : null}
      </div>
      <p id={keyHelpId} style={bodyStyle}>
        {t("keyHelp")}
      </p>
      {notice !== undefined ? <p style={noticeStyle} role="alert">{noticeText(notice, t)}</p> : null}
      {doctor !== undefined ? <p style={bodyStyle}>{doctorText(doctor, t)}</p> : null}
    </section>
  );
}
