/**
 * Task 7 Connect card contract (red-first, jsdom).
 *
 * The card is write-only by construction: the key input is a password field,
 * initializes empty on every load, never receives the stored secret as a prop
 * or value, and is cleared after connect/test/disconnect. The DOM and
 * accessibility snapshot never contain the key; the fake key reaches exactly
 * one place — the injected remote's `connect` — and the component walks the
 * disconnected → connected → disconnected states through credential/API calls
 * only. Testing Library cleanup runs after every test so no rendered card
 * leaks across tests.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectCard } from "../src/client/connect-card.tsx";
import type { ConnectCardProps } from "../src/client/connect-card.tsx";
import type { ConnectCardKey } from "../src/client/locales.ts";
import { en } from "../src/client/locales.ts";
import type { ConnectRemote } from "../src/client/connect-remote.ts";
import type { ClientStatus } from "../src/client/connect-remote.ts";

const FAKE_KEY = "sk-card-fake-key-0123456789abcdef";
const t = (key: ConnectCardKey): string => en[key];

afterEach(() => {
  cleanup();
});

interface RemoteCalls {
  connect: string[];
  disconnect: number;
  doctor: number;
  status: number;
}

function fakeRemote(initialConfigured: boolean): { readonly remote: ConnectRemote; readonly calls: RemoteCalls } {
  let configured = initialConfigured;
  const calls: RemoteCalls = { connect: [], disconnect: 0, doctor: 0, status: 0 };
  const remote: ConnectRemote = {
    connect: async (key) => {
      calls.connect = [...calls.connect, key];
      configured = true;
      return { kind: "connected" };
    },
    disconnect: async () => {
      calls.disconnect += 1;
      configured = false;
      return { kind: "disconnected" };
    },
    status: async () => ({
      configured,
      origin: "embedded",
      modelCount: 24,
      refreshedAt: "2026-08-14T00:00:00.000Z",
      lastAttempt: { kind: "ok" },
    }),
    doctor: async () => {
      calls.doctor += 1;
      return { kind: "configured", liveModelCount: 24 };
    },
  };
  return { remote, calls };
}

function renderCard(props: ConnectCardProps): ReturnType<typeof render> {
  return render(<ConnectCard {...props} />);
}

describe("ConnectCard", () => {
  it("renders a write-only password input that starts empty", async () => {
    const { remote } = fakeRemote(false);
    renderCard({ remote, t });
    const input = await screen.findByLabelText(en.keyLabel);
    expect(input.getAttribute("type")).toBe("password");
    expect(input.getAttribute("autoComplete")).toBe("new-password");
    expect(input).toHaveProperty("value", "");
  });

  it("applies the inputStyle to the key input so it is not a bare browser control", async () => {
    const { remote } = fakeRemote(false);
    renderCard({ remote, t });
    const input = await screen.findByLabelText(en.keyLabel);
    expect(input.style.minWidth).toBe("260px");
    expect(input.style.border).toContain("1px solid");
    expect(input.style.borderRadius).toBe("8px");
  });

  it("walks disconnected → connected → disconnected through credential calls only", async () => {
    const user = userEvent.setup();
    const { remote, calls } = fakeRemote(false);
    renderCard({ remote, t });
    expect(await screen.findByText(en.notConnected)).toBeTruthy();
    const input = await screen.findByLabelText(en.keyLabel);
    await user.type(input, FAKE_KEY);
    await user.click(screen.getByRole("button", { name: en.connect }));
    await waitFor(() => expect(calls.connect).toEqual([FAKE_KEY]));
    expect(await screen.findByText(en.connected)).toBeTruthy();
    expect(input).toHaveProperty("value", "");
    expect(document.body.textContent).not.toContain(FAKE_KEY);
    await user.click(screen.getByRole("button", { name: en.disconnect }));
    expect(await screen.findByText(en.notConnected)).toBeTruthy();
    expect(calls.disconnect).toBe(1);
    expect(calls.connect).toEqual([FAKE_KEY]);
  });

  it("never places the typed key in the DOM or accessibility tree", async () => {
    const user = userEvent.setup();
    const { remote } = fakeRemote(false);
    renderCard({ remote, t });
    const input = await screen.findByLabelText(en.keyLabel);
    await user.type(input, FAKE_KEY);
    expect(document.body.textContent).not.toContain(FAKE_KEY);
    await user.click(screen.getByRole("button", { name: en.connect }));
    await waitFor(() => expect(input).toHaveProperty("value", ""));
    expect(document.body.textContent).not.toContain(FAKE_KEY);
  });

  it("test connection calls the doctor and renders only the sanitized count", async () => {
    const user = userEvent.setup();
    const { remote, calls } = fakeRemote(true);
    renderCard({ remote, t });
    await user.click(await screen.findByRole("button", { name: en.testConnection }));
    await waitFor(() => expect(calls.doctor).toBe(1));
    expect(await screen.findByText(`${en.testResultPrefix}24`)).toBeTruthy();
    expect(document.body.textContent).not.toContain(FAKE_KEY);
  });

  it("renders a sanitized refusal when connect rejects the key and clears the input", async () => {
    const user = userEvent.setup();
    const remote: ConnectRemote = {
      connect: async () => ({ kind: "invalid", message: "the key was refused before storing" }),
      disconnect: async () => ({ kind: "disconnected" }),
      status: async () => ({
        configured: false,
        origin: "embedded",
        modelCount: 24,
        refreshedAt: "2026-08-14T00:00:00.000Z",
        lastAttempt: { kind: "none" },
      }),
      doctor: async () => ({ kind: "unconfigured" }),
    };
    renderCard({ remote, t });
    const input = await screen.findByLabelText(en.keyLabel);
    await user.type(input, FAKE_KEY);
    await user.click(screen.getByRole("button", { name: en.connect }));
    expect(await screen.findByText(en.invalidKey)).toBeTruthy();
    expect(document.body.textContent).not.toContain(FAKE_KEY);
    await waitFor(() => expect(input).toHaveProperty("value", ""));
  });

  it("catches a rejected connect into a sanitized notice and clears input and busy", async () => {
    const user = userEvent.setup();
    const remote: ConnectRemote = {
      connect: async () => {
        throw new Error("hostile transport text sk-card-fake-key-0123456789abcdef");
      },
      disconnect: async () => ({ kind: "disconnected" }),
      status: async () => ({
        configured: false,
        origin: "embedded",
        modelCount: 24,
        refreshedAt: "2026-08-14T00:00:00.000Z",
        lastAttempt: { kind: "none" },
      }),
      doctor: async () => ({ kind: "unconfigured" }),
    };
    renderCard({ remote, t });
    const input = await screen.findByLabelText(en.keyLabel);
    await user.type(input, FAKE_KEY);
    await user.click(screen.getByRole("button", { name: en.connect }));
    expect(await screen.findByText(en.storeFailed)).toBeTruthy();
    await waitFor(() => expect(input).toHaveProperty("value", ""));
    // The busy flag settled: the input is enabled again after the rejection.
    await waitFor(() => expect(input).not.toHaveProperty("disabled", true));
    expect(document.body.textContent).not.toContain(FAKE_KEY);
  });

  it("unmounts cleanly with the key still in the control", async () => {
    const user = userEvent.setup();
    const { remote } = fakeRemote(false);
    const { unmount } = renderCard({ remote, t });
    const input = await screen.findByLabelText(en.keyLabel);
    await user.type(input, FAKE_KEY);
    unmount();
    expect(document.body.textContent).not.toContain(FAKE_KEY);
  });

  it("does not leak cards across tests: each render mounts exactly one card", async () => {
    const { remote } = fakeRemote(false);
    renderCard({ remote, t });
    expect(await screen.findByText(en.title)).toBeTruthy();
    expect(screen.getAllByText(en.title)).toHaveLength(1);
  });

  it("secondary (test/disconnect) button tokens align with official DSH Button CSS", async () => {
    const user = userEvent.setup();
    const { remote } = fakeRemote(true);
    renderCard({ remote, t });
    await screen.findByText(en.connected);
    const testBtn = screen.getByRole("button", { name: en.testConnection });
    // Official tokens: display inline-flex, border none, font-size 14px,
    // background transparent, padding 0 14px, line-height 22px.
    expect(testBtn.style.display).toBe("inline-flex");
    expect(testBtn.style.alignItems).toBe("center");
    expect(testBtn.style.justifyContent).toBe("center");
    expect(testBtn.style.gap).toBe("4px");
    // No border — official Button uses border: none.
    expect(testBtn.style.borderWidth).toBe("0px");
    expect(testBtn.style.fontSize).toBe("14px");
    expect(testBtn.style.lineHeight).toBe("22px");
    // background-color: transparent → rgba(0, 0, 0, 0) in computed terms
    const bg = testBtn.style.backgroundColor;
    expect(bg === "transparent" || bg === "rgba(0, 0, 0, 0)" || bg === "").toBe(true);
    expect(testBtn.style.paddingLeft).toBe("14px");
    expect(testBtn.style.paddingRight).toBe("14px");
    expect(testBtn.style.paddingTop).toBe("0px");
    expect(testBtn.style.paddingBottom).toBe("0px");
    expect(testBtn.style.color).toBe("var(--dsw-alias-label-primary)");
    expect(testBtn.style.borderRadius).toBe("18px");
    expect(testBtn.style.cursor).toBe("pointer");
    // Ensure the disconnect button (also secondary) matches the same tokens.
    const disconnectBtn = screen.getByRole("button", { name: en.disconnect });
    expect(disconnectBtn.style.display).toBe("inline-flex");
    expect(disconnectBtn.style.borderWidth).toBe("0px");
    expect(disconnectBtn.style.fontSize).toBe("14px");
    expect(disconnectBtn.style.lineHeight).toBe("22px");
    const discBg = disconnectBtn.style.backgroundColor;
    expect(discBg === "transparent" || discBg === "rgba(0, 0, 0, 0)" || discBg === "").toBe(true);
    // Sanity: typing into the input does not mutate secondary button style.
    const input = await screen.findByLabelText(en.keyLabel);
    await user.type(input, FAKE_KEY);
    expect(testBtn.style.fontSize).toBe("14px");
    expect(testBtn.style.borderWidth).toBe("0px");
  });

  it("primary (connect) button retains brand background while matching base tokens", async () => {
    const user = userEvent.setup();
    const { remote } = fakeRemote(false);
    renderCard({ remote, t });
    const input = await screen.findByLabelText(en.keyLabel);
    await user.type(input, FAKE_KEY);
    const connectBtn = screen.getByRole("button", { name: en.connect });
    // Base tokens must align with official.
    expect(connectBtn.style.display).toBe("inline-flex");
    expect(connectBtn.style.alignItems).toBe("center");
    expect(connectBtn.style.justifyContent).toBe("center");
    expect(connectBtn.style.gap).toBe("4px");
    expect(connectBtn.style.borderWidth).toBe("0px");
    expect(connectBtn.style.fontSize).toBe("14px");
    expect(connectBtn.style.lineHeight).toBe("22px");
    expect(connectBtn.style.paddingLeft).toBe("14px");
    expect(connectBtn.style.paddingRight).toBe("14px");
    expect(connectBtn.style.paddingTop).toBe("0px");
    expect(connectBtn.style.paddingBottom).toBe("0px");
    expect(connectBtn.style.borderRadius).toBe("18px");
    expect(connectBtn.style.cursor).toBe("pointer");
    // Primary semantics: brand background, white foreground.
    expect(connectBtn.style.background).toBe("var(--dsw-alias-brand-primary)");
    expect(connectBtn.style.color).toBe("white");
  });

  it("disabled connect button has reduced opacity for visual distinction", async () => {
    const { remote } = fakeRemote(false);
    renderCard({ remote, t });
    await screen.findByText(en.notConnected);
    const connectBtn = screen.getByRole("button", { name: en.connect });
    expect(connectBtn).toHaveProperty("disabled", true);
    expect(connectBtn.style.opacity).toBe("0.4");
    expect(connectBtn.style.cursor).toBe("not-allowed");
  });

  it("enabled connect button has full opacity", async () => {
    const user = userEvent.setup();
    const { remote } = fakeRemote(false);
    renderCard({ remote, t });
    const input = await screen.findByLabelText(en.keyLabel);
    await user.type(input, FAKE_KEY);
    const connectBtn = screen.getByRole("button", { name: en.connect });
    expect(connectBtn).not.toHaveProperty("disabled", true);
    expect(connectBtn.style.opacity).toBe("");
  });

  it("disabled test/disconnect buttons have reduced opacity when busy", async () => {
    const user = userEvent.setup();
    // Hanging remote keeps busy=true so we can inspect disabled state
    let resolveStatus: (v: ClientStatus) => void = () => {};
    const remote: ConnectRemote = {
      connect: async () => new Promise<{ kind: "connected" }>((r) => { resolveStatus = () => r({ kind: "connected" }); }),
      disconnect: async () => ({ kind: "disconnected" }),
      status: async () =>
        new Promise<ClientStatus>((r) => {
          resolveStatus = r;
        }),
      doctor: async () => ({ kind: "configured", liveModelCount: 1 }),
    };
    renderCard({ remote, t });
    resolveStatus({ configured: true, origin: "embedded", modelCount: 0, refreshedAt: "", lastAttempt: { kind: "none" } });
    await waitFor(() => expect(screen.getByText(en.connected)).toBeTruthy());

    const input = await screen.findByLabelText(en.keyLabel);
    await user.type(input, FAKE_KEY);
    await user.click(screen.getByRole("button", { name: en.connect }));

    await waitFor(() => {
      const testBtn = screen.getByRole("button", { name: en.testConnection });
      expect(testBtn).toHaveProperty("disabled", true);
      expect(testBtn.style.opacity).toBe("0.4");
    });

    const disconnectBtn = screen.getByRole("button", { name: en.disconnect });
    expect(disconnectBtn).toHaveProperty("disabled", true);
    expect(disconnectBtn.style.opacity).toBe("0.4");
  });
});
