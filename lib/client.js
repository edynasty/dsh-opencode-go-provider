import { useCallback, useEffect, useId, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/contract.ts
/**
* Shared Host/Client contract values for the OpenCode Go provider bundle.
*
* Imported by both the Host entry (`src/index.ts`) and the Web client seam
* (`src/client/index.tsx`); each tsdown build bundles its own copy. Keeping
* the values in one module prevents the Host and Client programs from
* drifting apart on the route, row, and credential names.
*/
/** Stable bundle/plugin name; must match package.json and the patch row. */
const PLUGIN_NAME = "dsh-opencode-go-provider";
/** DSH credentials environment variable resolved at operation time. */
const API_KEY_ENV = "OPENCODE_GO_API_KEY";
/** Provider route registered on ctx.llm and addressed by the settings card. */
const PROVIDER_ROUTE = "opencode-go";
//#endregion
//#region src/client/connect-card.tsx
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
const cardStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 14,
	padding: "18px 20px",
	border: "1px solid var(--dsw-alias-border-l2)",
	borderRadius: 12,
	background: "var(--dsw-alias-bg-module-platform)"
};
const titleStyle = {
	margin: 0,
	fontSize: 16,
	lineHeight: "24px",
	fontWeight: 600,
	color: "var(--dsw-alias-label-primary)"
};
const bodyStyle = {
	margin: 0,
	fontSize: 13,
	lineHeight: "20px",
	color: "var(--dsw-alias-label-secondary)"
};
const statusStyle = {
	display: "flex",
	alignItems: "center",
	gap: 8,
	fontSize: 14,
	fontWeight: 500,
	color: "var(--dsw-alias-label-primary)"
};
const rowStyle = {
	display: "flex",
	alignItems: "center",
	gap: 10,
	flexWrap: "wrap"
};
const buttonStyle = {
	boxSizing: "border-box",
	minHeight: 34,
	padding: "6px 14px",
	border: "1px solid var(--dsw-alias-border-l2)",
	borderRadius: 18,
	background: "var(--dsw-alias-bg-layer-1)",
	color: "var(--dsw-alias-label-primary)",
	font: "inherit",
	fontSize: 13,
	cursor: "pointer"
};
const primaryButtonStyle = {
	...buttonStyle,
	borderColor: "var(--dsw-alias-brand-primary)",
	background: "var(--dsw-alias-brand-primary)",
	color: "white"
};
const noticeStyle = {
	...bodyStyle,
	color: "var(--dsw-alias-state-error-primary)"
};
function noticeText(notice, t) {
	switch (notice.kind) {
		case "invalid-key": return t("invalidKey");
		case "store-failed": return t("storeFailed");
		case "status-unavailable": return t("statusUnavailable");
		case "test-failed": return t("testFailed");
	}
}
function doctorText(doctor, t) {
	switch (doctor.kind) {
		case "configured": return `${t("testResultPrefix")}${doctor.liveModelCount}`;
		case "unconfigured": return t("testUnconfigured");
		case "unavailable": return t("testUnavailable");
		case "failed": return `${t("testFailed")} (${doctor.code})`;
	}
}
/**
* The Connect card. The key input value lives only in local state and reaches
* exactly one destination: `remote.connect`. Every action — resolved or
* rejected — clears it; the unmount cleanup only cancels in-flight reads and
* never updates state.
*/
function ConnectCard({ remote, t }) {
	const keyInputId = useId();
	const keyHelpId = useId();
	const [phase, setPhase] = useState({ phase: "loading" });
	const [keyInput, setKeyInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState(void 0);
	const [doctor, setDoctor] = useState(void 0);
	useEffect(() => {
		let cancelled = false;
		remote.status().then((status) => {
			if (!cancelled) setPhase(status.configured ? { phase: "connected" } : { phase: "disconnected" });
		}, () => {
			if (!cancelled) {
				setPhase({ phase: "disconnected" });
				setNotice({ kind: "status-unavailable" });
			}
		});
		return () => {
			cancelled = true;
		};
	}, [remote]);
	const refreshStatus = useCallback(async () => {
		const status = await remote.status();
		setPhase(status.configured ? { phase: "connected" } : { phase: "disconnected" });
	}, [remote]);
	const handleConnect = useCallback(async () => {
		const key = keyInput;
		if (key.length === 0) return;
		setBusy(true);
		setNotice(void 0);
		setDoctor(void 0);
		try {
			const result = await remote.connect(key);
			setKeyInput("");
			if (result.kind === "connected") await refreshStatus();
			else setNotice(result.kind === "invalid" ? { kind: "invalid-key" } : { kind: "store-failed" });
		} catch {
			setKeyInput("");
			setNotice({ kind: "store-failed" });
		} finally {
			setBusy(false);
		}
	}, [
		keyInput,
		remote,
		refreshStatus
	]);
	const handleTest = useCallback(async () => {
		setBusy(true);
		setDoctor(void 0);
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
	const handleDisconnect = useCallback(async () => {
		setBusy(true);
		setNotice(void 0);
		try {
			const result = await remote.disconnect();
			setKeyInput("");
			if (result.kind === "disconnected") await refreshStatus();
			else setNotice({ kind: "store-failed" });
		} catch {
			setKeyInput("");
			setNotice({ kind: "store-failed" });
		} finally {
			setBusy(false);
		}
	}, [remote, refreshStatus]);
	const connected = phase.phase === "connected";
	return /* @__PURE__ */ jsxs("section", {
		style: cardStyle,
		"aria-label": t("title"),
		children: [
			/* @__PURE__ */ jsx("h2", {
				style: titleStyle,
				children: t("title")
			}),
			/* @__PURE__ */ jsx("p", {
				style: bodyStyle,
				children: t("intro")
			}),
			/* @__PURE__ */ jsx("div", {
				style: statusStyle,
				role: "status",
				children: phase.phase === "loading" ? t("loading") : connected ? t("connected") : t("notConnected")
			}),
			/* @__PURE__ */ jsx("label", {
				htmlFor: keyInputId,
				children: t("keyLabel")
			}),
			/* @__PURE__ */ jsxs("div", {
				style: rowStyle,
				children: [
					/* @__PURE__ */ jsx("input", {
						id: keyInputId,
						type: "password",
						autoComplete: "new-password",
						spellCheck: false,
						placeholder: t("keyPlaceholder"),
						value: keyInput,
						onChange: (event) => setKeyInput(event.target.value),
						disabled: busy,
						"aria-describedby": keyHelpId
					}),
					/* @__PURE__ */ jsx("button", {
						type: "button",
						style: primaryButtonStyle,
						onClick: () => void handleConnect(),
						disabled: busy || keyInput.length === 0,
						children: t("connect")
					}),
					/* @__PURE__ */ jsx("button", {
						type: "button",
						style: buttonStyle,
						onClick: () => void handleTest(),
						disabled: busy,
						children: t("testConnection")
					}),
					connected ? /* @__PURE__ */ jsx("button", {
						type: "button",
						style: buttonStyle,
						onClick: () => void handleDisconnect(),
						disabled: busy,
						children: t("disconnect")
					}) : null
				]
			}),
			/* @__PURE__ */ jsx("p", {
				id: keyHelpId,
				style: bodyStyle,
				children: t("keyHelp")
			}),
			notice !== void 0 ? /* @__PURE__ */ jsx("p", {
				style: noticeStyle,
				role: "alert",
				children: noticeText(notice, t)
			}) : null,
			doctor !== void 0 ? /* @__PURE__ */ jsx("p", {
				style: bodyStyle,
				children: doctorText(doctor, t)
			}) : null
		]
	});
}
//#endregion
//#region src/guards.ts
/**
* Runtime type guards and the exhaustive-match sink.
*
* Guards narrow `unknown` values into typed values at trust boundaries (JSON
* payloads, state files). They are runtime checks, not casts. Production and
* test code share these; nothing else imports node builtins.
*/
/** True when `value` is a plain object (not null, not an array). */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** True when `value` is a canonical finite ISO-8601 instant (toISOString form). */
function isCanonicalIsoInstant(value) {
	if (typeof value !== "string") return false;
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) return false;
	return new Date(ms).toISOString() === value;
}
//#endregion
//#region src/client/connect-remote.ts
/**
* Browser-side remote for the OpenCode Go Connect card.
*
* The card talks to the Host control seam over same-origin plugin routes
* (the `ctx.webServer` registrations in `src/web-routes.ts`). Responses cross
* the fetch boundary here and are treated as HOSTILE: unknown payloads are
* parsed with runtime guards into the narrow client types, arbitrary Host
* message text is replaced by fixed local messages, failure codes pass an
* explicit safe allowlist (unknown → `MALFORMED`/`UNKNOWN`), and numeric/
* string fields are strictly validated (finite nonnegative integers,
* canonical ISO instants). No Host string, code, count or timestamp can
* reach the card or the DOM raw.
*/
/** Plugin-owned same-origin routes; the Host registers them on `ctx.webServer`. */
const CONNECT_ROUTES = {
	status: "/plugins/dsh-opencode-go/status",
	connect: "/plugins/dsh-opencode-go/connect",
	disconnect: "/plugins/dsh-opencode-go/disconnect",
	doctor: "/plugins/dsh-opencode-go/doctor"
};
/** Fixed local messages: Host payload text never crosses this boundary. */
const FIXED_REQUEST_FAILED = "the connection request failed";
const FIXED_KEY_REFUSED = "the key was refused before storing";
const FIXED_UNKNOWN_CODE = "UNKNOWN";
const FIXED_MALFORMED_CODE = "MALFORMED";
/** The Host's stable doctor failure codes; anything else is MALFORMED. */
const SAFE_DOCTOR_CODES = [
	"MISSING_CREDENTIAL",
	"INVALID_CREDENTIAL",
	"LIVE_HTTP_401",
	"LIVE_HTTP_403",
	"LIVE_HTTP_429",
	"LIVE_HTTP_503",
	"LIVE_HTTP_5XX",
	"LIVE_HTTP_ERROR",
	"LIVE_PARSE",
	"NO_LIVE_BASE_URL",
	"FETCH_FAILED",
	"TIMEOUT",
	"ABORTED",
	"INTERNAL"
];
/** The Host's stable refresh attempt codes; anything else is UNKNOWN. */
const SAFE_ATTEMPT_CODES = [
	"MISSING_CREDENTIAL",
	"INVALID_CREDENTIAL",
	"MODELS_DEV_HTTP_401",
	"MODELS_DEV_HTTP_403",
	"MODELS_DEV_HTTP_503",
	"MODELS_DEV_HTTP_5XX",
	"MODELS_DEV_HTTP_ERROR",
	"MODELS_DEV_PARSE",
	"LIVE_HTTP_401",
	"LIVE_HTTP_403",
	"LIVE_HTTP_429",
	"LIVE_HTTP_503",
	"LIVE_HTTP_5XX",
	"LIVE_HTTP_ERROR",
	"LIVE_PARSE",
	"NO_LIVE_BASE_URL",
	"FETCH_FAILED",
	"TIMEOUT",
	"ABORTED",
	"INTERNAL",
	"CACHE_WRITE_FAILED"
];
function isSafeCode(value, allowlist) {
	return typeof value === "string" && allowlist.some((code) => code === value);
}
function isFiniteNonnegativeInteger(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && Number.isFinite(value);
}
/** Parse the connect response; Host message text is never propagated. */
function parseConnectResult(value) {
	if (!isRecord(value)) return {
		kind: "store-failed",
		message: FIXED_REQUEST_FAILED
	};
	switch (value.kind) {
		case "connected": return { kind: "connected" };
		case "invalid": return {
			kind: "invalid",
			message: FIXED_KEY_REFUSED
		};
		case "store-failed": return {
			kind: "store-failed",
			message: FIXED_REQUEST_FAILED
		};
		default: return {
			kind: "store-failed",
			message: FIXED_REQUEST_FAILED
		};
	}
}
/** Parse the disconnect response; Host message text is never propagated. */
function parseDisconnectResult(value) {
	if (!isRecord(value)) return {
		kind: "store-failed",
		message: FIXED_REQUEST_FAILED
	};
	switch (value.kind) {
		case "disconnected": return { kind: "disconnected" };
		case "store-failed": return {
			kind: "store-failed",
			message: FIXED_REQUEST_FAILED
		};
		default: return {
			kind: "store-failed",
			message: FIXED_REQUEST_FAILED
		};
	}
}
/** Parse the doctor response; only allowlisted codes and sane counts pass. */
function parseDoctorSummary(value) {
	if (!isRecord(value)) return {
		kind: "failed",
		code: FIXED_MALFORMED_CODE
	};
	switch (value.kind) {
		case "configured": return isFiniteNonnegativeInteger(value.liveModelCount) ? {
			kind: "configured",
			liveModelCount: value.liveModelCount
		} : {
			kind: "failed",
			code: FIXED_MALFORMED_CODE
		};
		case "unconfigured": return { kind: "unconfigured" };
		case "unavailable": return { kind: "unavailable" };
		case "failed": return isSafeCode(value.code, SAFE_DOCTOR_CODES) ? {
			kind: "failed",
			code: value.code
		} : {
			kind: "failed",
			code: FIXED_MALFORMED_CODE
		};
		default: return {
			kind: "failed",
			code: FIXED_MALFORMED_CODE
		};
	}
}
/** Parse the status response; a single malformed field fails the whole read. */
function parseStatus(value) {
	if (!isRecord(value) || typeof value.configured !== "boolean" || !isFiniteNonnegativeInteger(value.modelCount) || typeof value.refreshedAt !== "string" || !isCanonicalIsoInstant(value.refreshedAt) || !isRecord(value.lastAttempt)) throw new Error("the status response was malformed");
	const origin = value.origin;
	if (origin !== "embedded" && origin !== "cache" && origin !== "refreshed" && origin !== "corrupt") throw new Error("the status response was malformed");
	let lastAttempt;
	if (value.lastAttempt.kind === "ok" || value.lastAttempt.kind === "none") lastAttempt = { kind: value.lastAttempt.kind };
	else if (value.lastAttempt.kind === "failed" && isSafeCode(value.lastAttempt.code, SAFE_ATTEMPT_CODES)) lastAttempt = {
		kind: "failed",
		code: value.lastAttempt.code
	};
	else if (value.lastAttempt.kind === "failed") lastAttempt = {
		kind: "failed",
		code: FIXED_UNKNOWN_CODE
	};
	else throw new Error("the status response was malformed");
	return {
		configured: value.configured,
		origin,
		modelCount: value.modelCount,
		refreshedAt: value.refreshedAt,
		lastAttempt
	};
}
async function jsonRequest(path, method, body) {
	const response = await fetch(path, {
		method,
		headers: {
			accept: "application/json",
			...body === void 0 ? {} : { "content-type": "application/json" }
		},
		credentials: "same-origin",
		...body === void 0 ? {} : { body: JSON.stringify(body) }
	});
	const value = await response.json().catch(() => void 0);
	if (!response.ok) throw new Error("the connection request failed");
	return value;
}
/** The fetch-backed remote wired by the browser-plugin registration. */
function createConnectRemote() {
	return {
		connect: async (key) => {
			try {
				return parseConnectResult(await jsonRequest(CONNECT_ROUTES.connect, "POST", { key }));
			} catch {
				return {
					kind: "store-failed",
					message: FIXED_REQUEST_FAILED
				};
			}
		},
		disconnect: async () => {
			try {
				return parseDisconnectResult(await jsonRequest(CONNECT_ROUTES.disconnect, "POST", void 0));
			} catch {
				return {
					kind: "store-failed",
					message: FIXED_REQUEST_FAILED
				};
			}
		},
		status: async () => {
			try {
				return parseStatus(await jsonRequest(CONNECT_ROUTES.status, "GET", void 0));
			} catch {
				throw new Error("the status request failed");
			}
		},
		doctor: async () => {
			try {
				return parseDoctorSummary(await jsonRequest(CONNECT_ROUTES.doctor, "POST", void 0));
			} catch {
				return {
					kind: "failed",
					code: "REQUEST_FAILED"
				};
			}
		}
	};
}
//#endregion
//#region src/client/locales.ts
/**
* Bilingual Connect card copy, following the DSH client locale convention
* (a plain `en` dictionary plus a `zh` mirror typed by its keys).
*/
/** English copy for the OpenCode Go Connect card. */
const en = {
	title: "OpenCode Go",
	intro: "Connect your OpenCode Go API key.",
	keyLabel: "API key",
	keyPlaceholder: "sk-…",
	keyHelp: "The key is stored through DSH credentials and is never shown again.",
	connected: "Connected",
	notConnected: "Not connected",
	connect: "Connect",
	testConnection: "Test connection",
	disconnect: "Disconnect",
	loading: "Loading…",
	invalidKey: "The provided key was refused before storing.",
	storeFailed: "The credential could not be stored.",
	statusUnavailable: "The status could not be loaded.",
	testResultPrefix: "Live /models reports ",
	testUnconfigured: "No credential configured; connect first.",
	testUnavailable: "No usable live endpoint in the current catalog.",
	testFailed: "Connection test failed."
};
/** Chinese copy for the OpenCode Go Connect card. */
const zh = {
	title: "OpenCode Go",
	intro: "连接你的 OpenCode Go API Key。",
	keyLabel: "API Key",
	keyPlaceholder: "sk-…",
	keyHelp: "密钥仅通过 DSH 凭据存储，不会再次显示。",
	connected: "已连接",
	notConnected: "未连接",
	connect: "连接",
	testConnection: "测试连接",
	disconnect: "断开",
	loading: "加载中…",
	invalidKey: "提供的密钥在存储前被拒绝。",
	storeFailed: "凭据无法存储。",
	statusUnavailable: "无法加载状态。",
	testResultPrefix: "Live /models 报告 ",
	testUnconfigured: "尚未配置凭据，请先连接。",
	testUnavailable: "当前目录中没有可用的实时端点。",
	testFailed: "连接测试失败。"
};
//#endregion
//#region src/client/index.tsx
/** Stable browser-plugin name, namespaced to avoid colliding with the Host. */
const name = `${PLUGIN_NAME}-client`;
/** DSH client services this bundle consumes (declared for the web host). */
const inject = ["slots", "locale"];
/** Locale namespace owning this card's copy. */
const LOCALE_NS = "settings.opencode-go";
/** Browser-plugin registration: locale copy + the Connect card slot. */
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(LOCALE_NS, {
		zh,
		en
	}), `${PLUGIN_NAME}-client: settings copy`);
	const t = ctx.locale.bind(LOCALE_NS);
	const remote = createConnectRemote();
	ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
		name: "settings.plugin.item",
		id: "opencode-go",
		order: 30,
		inject: () => ({
			t,
			remote
		})
	}, ConnectCard));
}
/** Machine-consumed client contract surfaced by the `./client` entry. */
const clientContract = {
	name,
	providerRoute: PROVIDER_ROUTE,
	apiKeyEnv: API_KEY_ENV,
	inject,
	remoteRoutes: [
		"status",
		"connect",
		"disconnect",
		"doctor"
	]
};
//#endregion
export { CONNECT_ROUTES, ConnectCard, LOCALE_NS, apply, clientContract, createConnectRemote, en, inject, name, zh };
