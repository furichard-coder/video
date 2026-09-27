import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConcatRenderRequest } from "../src/shared/domain";
import { RemoteControlServer } from "../src/main/services/remote-control-server";
import { RenderCommandState } from "../src/main/services/render-command-state";

const running: RemoteControlServer[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((server) => server.stop())); });

async function paired(server: RemoteControlServer) {
  const status = await server.start();
  running.push(server);
  const pairing = new URL(status.pairingUrl!);
  const pairToken = pairing.hash.slice("#pair=".length);
  pairing.hash = "";
  const origin = pairing.origin;
  const response = await fetch(new URL("/api/pair", origin), {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: decodeURIComponent(pairToken) }),
  });
  const body = await response.json() as { csrfToken: string };
  const setCookie = response.headers.get("set-cookie")!;
  return { origin, cookie: setCookie.split(";")[0], setCookie, csrf: body.csrfToken, pairToken };
}

async function firstSseSnapshot(origin: string, headers: Record<string, string>) {
  const abort = new AbortController();
  const response = await fetch(new URL("/api/events", origin), { headers, signal: abort.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let packet = "";
  while (!packet.includes("\n\n")) {
    const next = await reader.read();
    if (next.done) throw new Error("SSE ended before the initial snapshot.");
    packet += decoder.decode(next.value, { stream: true });
  }
  await reader.cancel();
  abort.abort();
  const id = Number(/^id:\s*(\d+)/m.exec(packet)?.[1]);
  const payload = /^data:(.+)$/m.exec(packet)?.[1];
  return { id, snapshot: JSON.parse(payload!) as { revision: number; projectName: string } };
}

describe("RemoteControlServer", () => {
  it("uses one-time fragment pairing, HttpOnly Strict cookie, CSRF and exact LAN host/origin", async () => {
    const state = new RenderCommandState("LAN Project");
    const server = new RemoteControlServer(state);
    const auth = await paired(server);
    expect(auth.setCookie).toContain("HttpOnly");
    expect(auth.setCookie).toContain("SameSite=Strict");
    expect(server.status().pairingUrl).toBeUndefined();
    const cookieHeader = (await fetch(new URL("/", auth.origin))).headers.get("set-cookie");
    expect(cookieHeader).toBeNull();
    const denied = await fetch(new URL("/api/state", auth.origin), { headers: { Cookie: auth.cookie, Origin: auth.origin } });
    expect(denied.status).toBe(401);
    const accepted = await fetch(new URL("/api/state", auth.origin), { headers: { Cookie: auth.cookie, Origin: auth.origin, "X-Scenery-CSRF": auth.csrf } });
    expect(accepted.status).toBe(200);
    const replay = await fetch(new URL("/api/pair", auth.origin), { method: "POST", headers: { Origin: auth.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: auth.pairToken }) });
    expect(replay.status).toBe(401);
  });

  it("requires a server-issued second-stage nonce for cancel and disconnect does not cancel render", async () => {
    const state = new RenderCommandState("LAN Project");
    const cancel = vi.fn(async () => undefined);
    state.setHandlers({ startPrepared: async () => { throw new Error("unused"); }, resumeCheckpoint: async () => { throw new Error("unused"); }, cancel });
    const request = { outputToken: "x", orderedAssetIds: ["a".repeat(64)], transitionSeconds: 0.3, resolution: "1080P" } as ConcatRenderRequest;
    state.markStarting(request);
    const server = new RemoteControlServer(state);
    const auth = await paired(server);
    const headers = { Cookie: auth.cookie, Origin: auth.origin, "X-Scenery-CSRF": auth.csrf, "Content-Type": "application/json" };
    const direct = await fetch(new URL("/api/command/cancel", auth.origin), { method: "POST", headers, body: JSON.stringify({ confirmation: "CANCEL" }) });
    expect(direct.status).toBe(409);
    const intentResponse = await fetch(new URL("/api/command/cancel-intent", auth.origin), { method: "POST", headers, body: "{}" });
    const intent = await intentResponse.json() as { cancelNonce: string };
    const confirmed = await fetch(new URL("/api/command/cancel", auth.origin), { method: "POST", headers, body: JSON.stringify({ confirmation: "CANCEL", cancelNonce: intent.cancelNonce }) });
    expect(confirmed.status).toBe(202);
    expect(cancel).toHaveBeenCalledOnce();
    const nonceReplay = await fetch(new URL("/api/command/cancel", auth.origin), { method: "POST", headers, body: JSON.stringify({ confirmation: "CANCEL", cancelNonce: intent.cancelNonce }) });
    expect(nonceReplay.status).toBe(409);
    expect(cancel).toHaveBeenCalledOnce();
    await server.stop();
    running.length = 0;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rotates pairing and invalidates every prior session across a stop/restart", async () => {
    const state = new RenderCommandState("LAN Project");
    const server = new RemoteControlServer(state);
    const oldAuth = await paired(server);
    await server.stop();
    running.length = 0;
    const restarted = await server.start();
    running.push(server);
    expect(restarted.pairingUrl).toBeTruthy();
    expect(restarted.pairingUrl).not.toContain(encodeURIComponent(oldAuth.pairToken));
    const newOrigin = new URL(restarted.pairingUrl!).origin;
    const oldSession = await fetch(new URL("/api/state", newOrigin), {
      headers: { Cookie: oldAuth.cookie, Origin: newOrigin, "X-Scenery-CSRF": oldAuth.csrf },
    });
    expect(oldSession.status).toBe(401);
    const oldPairing = await fetch(new URL("/api/pair", newOrigin), {
      method: "POST",
      headers: { Origin: newOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ token: oldAuth.pairToken }),
    });
    expect(oldPairing.status).toBe(401);
  });

  it("reconnects SSE with a fresh authoritative snapshot without affecting render state", async () => {
    const state = new RenderCommandState("Initial Project");
    const server = new RemoteControlServer(state);
    const auth = await paired(server);
    const headers = { Cookie: auth.cookie, Origin: auth.origin, "X-Scenery-CSRF": auth.csrf };
    const unauthenticated = await fetch(new URL("/api/events", auth.origin));
    expect(unauthenticated.status).toBe(401);
    const first = await firstSseSnapshot(auth.origin, headers);
    expect(first.snapshot.projectName).toBe("Initial Project");
    state.setProjectName("Reconnected Project");
    const reconnected = await firstSseSnapshot(auth.origin, headers);
    expect(reconnected.id).toBeGreaterThan(first.id);
    expect(reconnected.snapshot).toMatchObject({
      revision: reconnected.id,
      projectName: "Reconnected Project",
    });
    expect(state.snapshot().state).toBe("IDLE");
  });
});
