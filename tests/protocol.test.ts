import { expect, test } from "bun:test";
import { baseURL, Client, RequestError, type Credentials, type Fetch, type Install, type Send, type State, type Tavern } from "../src/protocol";

const credentials: Credentials = {
    accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
    accessTokenExpiresAt: "2099-01-01T00:00:00Z",
    connectedApp: { id: "synthetic-installation", permissions: ["work:receive", "library:sync"] },
};
const send: Send = {
    id: "b42b9b0f-f3f9-44c1-8e16-1a88c53f50ac", workId: "68be0ebd-e77f-4804-90f7-eef8fa374dc6",
    versionNumber: 4, name: "Paper librarian", type: "character", format: "charx",
    files: [{ type: "export", url: "https://example.invalid/send/synthetic/export?signature=synthetic" }],
};

function setup(permissions: string[], responder?: (path: string, options: RequestInit) => Response) {
    let saved: State = { base: "https://example.invalid", credentials: structuredClone(credentials), installs: [], receipts: [], acknowledged: [], mirrored: [], lastSnapshot: 0 };
    const requests: { path: string; options: RequestInit }[] = [];
    const installed: Install[] = [];
    let imports = 0;
    let failImport = false;
    const storage = { read: async () => structuredClone(saved), save: async (state: State) => { saved = structuredClone(state); } };
    const tavern: Tavern = {
        version: "1.19.0",
        install: async item => {
            if (failImport) throw new Error("Disk full");
            imports++;
            const value = { workId: item.workId, versionNumber: item.versionNumber, type: item.type, localId: "synthetic.png" };
            installed.push(value);
            return value;
        },
        installed: async items => items.filter(item => installed.some(local => local.localId === item.localId)),
    };
    const request: Fetch = async (input, options = {}) => {
        const path = new URL(String(input)).pathname;
        requests.push({ path, options });
        if (responder) return responder(path, options);
        if (path.endsWith("/me")) return Response.json({ permissions });
        if (path.endsWith("/collect")) return Response.json({ sends: [send], takedowns: [] });
        if (path.includes("/send/")) return new Response("synthetic-charx");
        return Response.json({ accepted: 1, removed: 0, ignored: 0 });
    };
    return { client: new Client(storage, tavern, request), storage, requests, installed, imports: () => imports, fail: () => { failImport = true; } };
}

test("grants from Illarin control collection and library sharing", async () => {
    const fixture = setup([]);
    await fixture.client.cycle();
    expect(fixture.requests.map(item => item.path)).toEqual(["/api/v1/connected-apps/me"]);
    expect((await fixture.storage.read()).credentials?.connectedApp.permissions).toEqual([]);
});

test("cancelling a connection cannot save the returned credentials", async () => {
    const fixture = setup([]);
    await fixture.client.disconnect();
    const controller = new AbortController();
    controller.abort();
    await expect(fixture.client.connected("https://example.invalid", credentials, controller.signal)).rejects.toThrow();
    expect((await fixture.storage.read()).credentials).toBeUndefined();
});

test("a send is stored before acknowledgement and a redelivery installs once", async () => {
    const fixture = setup(["work:receive", "library:sync"]);
    await fixture.client.cycle();
    expect(fixture.imports()).toBe(1);
    expect((await fixture.storage.read()).acknowledged).toEqual([send.id]);
    expect(JSON.parse(fixture.requests.find(item => item.path.endsWith("/collect"))!.options.body as string)).toEqual({ acknowledge: [] });
    await fixture.client.cycle();
    expect(fixture.imports()).toBe(1);
    const collects = fixture.requests.filter(item => item.path.endsWith("/collect"));
    expect(JSON.parse(collects[1].options.body as string)).toEqual({ acknowledge: [send.id] });
    const reports = fixture.requests.filter(item => item.path.endsWith("/sync"));
    expect(JSON.parse(reports[1].options.body as string)).toEqual({ snapshot: false, appVersion: "1.19.0", entries: [{ workId: send.workId, versionNumber: 4 }], removed: [] });
    expect(fixture.requests.every(item => item.options.credentials === "omit")).toBe(true);
    const download = fixture.requests.find(item => item.path.includes("/send/"))!;
    expect(download.options.headers).toBeUndefined();
});

test("an import failure leaves the send unacknowledged", async () => {
    const fixture = setup(["work:receive"]);
    fixture.fail();
    await expect(fixture.client.cycle()).rejects.toThrow("Disk full");
    expect((await fixture.storage.read()).acknowledged).toEqual([]);
    expect((await fixture.storage.read()).receipts).toEqual([]);
});

test("library sharing stays off when only receiving is granted", async () => {
    const fixture = setup(["work:receive"]);
    await fixture.client.cycle();
    expect(fixture.imports()).toBe(1);
    expect(fixture.requests.some(item => item.path.endsWith("/sync"))).toBe(false);
});

test("deleting an installed copy removes it from the mirror", async () => {
    const fixture = setup(["work:receive", "library:sync"]);
    await fixture.client.cycle();
    fixture.installed.length = 0;
    const state = await fixture.storage.read();
    await fixture.client.sync(state);
    const report = fixture.requests.at(-1)!;
    expect(JSON.parse(report.options.body as string)).toEqual({ snapshot: false, appVersion: "1.19.0", entries: [], removed: [send.workId] });
});

test("an access rejection refreshes once and commits the replacement before retrying", async () => {
    let attempts = 0;
    const fixture = setup([], (path, options) => {
        if (path.endsWith("/refresh")) return Response.json({ ...credentials, accessToken: "replacement-access", refreshToken: "replacement-refresh" });
        if (++attempts === 1) return new Response(null, { status: 401 });
        expect((options.headers as Record<string, string>).Authorization).toBe("Bearer replacement-access");
        return Response.json({ permissions: [] });
    });
    await fixture.client.cycle();
    expect(fixture.requests.map(item => item.path)).toEqual(["/api/v1/connected-apps/me", "/api/v1/connect/refresh", "/api/v1/connected-apps/me"]);
    expect((await fixture.storage.read()).credentials?.refreshToken).toBe("replacement-refresh");
});

test("a failed refresh removes credentials and stops further requests", async () => {
    const fixture = setup([], () => new Response(null, { status: 401 }));
    await expect(fixture.client.cycle()).rejects.toThrow("Connect again");
    expect((await fixture.storage.read()).credentials).toBeUndefined();
    const count = fixture.requests.length;
    await fixture.client.cycle();
    expect(fixture.requests).toHaveLength(count);
});

test("a permission rejection is not retried", async () => {
    const fixture = setup([], () => new Response(null, { status: 403 }));
    await expect(fixture.client.cycle()).rejects.toBeInstanceOf(RequestError);
    expect(fixture.requests).toHaveLength(1);
});

test("an unknown refresh outcome never reuses a possibly spent token", async () => {
    const fixture = setup([]);
    const state = await fixture.storage.read();
    state.refreshing = true;
    await fixture.storage.save(state);
    await expect(fixture.client.cycle()).rejects.toThrow("Connect again");
    expect(fixture.requests).toHaveLength(0);
});

test("a send cannot redirect the download to another server", async () => {
    const fixture = setup(["work:receive"], path => path.endsWith("/me") ? Response.json({ permissions: ["work:receive"] }) : Response.json({ sends: [{ ...send, files: [{ type: "export", url: "https://elsewhere.invalid/send/synthetic/export" }] }] }));
    await expect(fixture.client.cycle()).rejects.toThrow("unexpected download address");
    expect(fixture.requests).toHaveLength(2);
});

test("server identity keeps its path and refuses credentials and insecure remote addresses", () => {
    expect(baseURL("https://example.invalid/illarin/")).toBe("https://example.invalid/illarin");
    expect(baseURL("http://localhost:8000")).toBe("http://localhost:8000");
    expect(() => baseURL("http://example.invalid")).toThrow();
    expect(() => baseURL("https://user:secret@example.invalid")).toThrow();
});
