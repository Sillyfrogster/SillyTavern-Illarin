export const formats = ["charx", "chara_card_v3", "chara_card_v2", "lorebook_sillytavern", "preset_sillytavern", "theme_sillytavern"];
export type Fetch = (input: RequestInfo | URL, options?: RequestInit) => Promise<Response>;

export interface Credentials {
    accessToken: string;
    accessTokenExpiresAt: string;
    refreshToken: string;
    connectedApp: { id: string; permissions: string[] };
}

export interface Send {
    id: string;
    workId: string;
    versionNumber: number;
    type: string;
    format: string;
    name: string;
    files: { type: string; url: string }[];
}

export interface Install {
    workId: string;
    versionNumber: number;
    type: string;
    localId: string;
    apiId?: string;
}

export interface State {
    base: string;
    credentials?: Credentials;
    refreshing?: boolean;
    installs: Install[];
    receipts: string[];
    acknowledged: string[];
    mirrored: { workId: string; versionNumber: number }[];
    lastSnapshot: number;
}

export interface Storage {
    read(): Promise<State>;
    save(state: State): Promise<void>;
}

export interface Tavern {
    version: string;
    install(send: Send, file: Blob): Promise<Install>;
    installed(installs: Install[]): Promise<Install[]>;
}

export class RequestError extends Error {
    constructor(public status: number, public retryAfter = 0) {
        super(status === 403 ? "This permission is off. Change it in your Illarin account settings." : `Illarin could not finish the request (${status}).`);
    }
}

export function baseURL(value: string): string {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) {
        throw new Error("Use an HTTPS address, or HTTP for a local Illarin site.");
    }
    return url.href.replace(/\/$/, "");
}

export class Client {
    constructor(private storage: Storage, private tavern: Tavern, private request: Fetch = (input, options) => fetch(input, options)) {}

    async json(base: string, path: string, body?: unknown, token?: string, signal?: AbortSignal): Promise<Response> {
        const response = await this.request(`${base}${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
            credentials: "omit", cache: "no-store", redirect: "error", signal,
        });
        if (!response.ok) throw new RequestError(response.status, Number(response.headers.get("Retry-After")) || 0);
        return response;
    }

    async begin(base: string, signal?: AbortSignal) {
        const response = await this.json(baseURL(base), "/api/v1/connect/requests", {
            appName: "SillyTavern", name: "Illarin extension", appVersion: this.tavern.version,
            protocolVersion: 1, capabilities: [], acceptedFormats: formats,
            permissions: ["work:receive", "library:sync"],
        }, undefined, signal);
        return await response.json() as { deviceCode: string; userCode: string; verificationUrl: string; expiresAt: string; interval: number };
    }

    async poll(base: string, deviceCode: string, signal?: AbortSignal) {
        const response = await this.json(base, "/api/v1/connect/poll", { deviceCode }, undefined, signal);
        return await response.json() as Credentials & { status: string };
    }

    async connected(base: string, credentials: Credentials, signal?: AbortSignal) {
        const state = await this.storage.read();
        signal?.throwIfAborted();
        if (state.base !== base) {
            state.installs = [];
            state.receipts = [];
            state.acknowledged = [];
            state.mirrored = [];
        }
        state.base = base;
        state.credentials = credentials;
        state.refreshing = false;
        state.lastSnapshot = 0;
        await this.storage.save(state);
    }

    async disconnect() {
        const state = await this.storage.read();
        delete state.credentials;
        state.refreshing = false;
        await this.storage.save(state);
    }

    async refresh(state: State) {
        if (state.refreshing) throw new Error("The last credential refresh did not finish. Connect again.");
        state.refreshing = true;
        await this.storage.save(state);
        try {
            const response = await this.json(state.base, "/api/v1/connect/refresh", { refreshToken: state.credentials!.refreshToken });
            state.credentials = await response.json();
            state.refreshing = false;
            await this.storage.save(state);
        } catch (error) {
            await this.disconnect();
            throw new Error("Illarin could not renew this connection. Connect again.");
        }
    }

    async authorized(state: State, path: string, body?: unknown, signal?: AbortSignal) {
        if (state.refreshing) throw new Error("The last credential refresh did not finish. Connect again.");
        if (Date.parse(state.credentials!.accessTokenExpiresAt) < Date.now() + 60_000) await this.refresh(state);
        try {
            return await this.json(state.base, path, body, state.credentials!.accessToken, signal);
        } catch (error) {
            if (!(error instanceof RequestError) || error.status !== 401) throw error;
            await this.refresh(state);
            return await this.json(state.base, path, body, state.credentials!.accessToken, signal);
        }
    }

    async cycle(signal?: AbortSignal) {
        const state = await this.storage.read();
        if (!state.credentials) return;
        const standing = await this.authorized(state, "/api/v1/connected-apps/me", undefined, signal);
        const app = await standing.json();
        state.credentials!.connectedApp.permissions = app.permissions;
        await this.storage.save(state);
        const permissions = app.permissions as string[];
        if (permissions.includes("library:sync")) await this.sync(state, signal);
        if (!permissions.includes("work:receive")) return;
        const acknowledged = [...state.acknowledged];
        const response = await this.authorized(state, "/api/v1/sends/collect", { acknowledge: acknowledged }, signal);
        state.acknowledged = state.acknowledged.filter(id => !acknowledged.includes(id));
        await this.storage.save(state);
        if (response.status === 204) return;
        const collected = await response.json() as { sends: Send[] };
        let failure: unknown;
        for (const send of collected.sends) {
            try {
                if (!state.receipts.includes(send.id)) {
                    if (!formats.includes(send.format)) throw new Error("SillyTavern cannot read this format.");
                    const main = send.files.find(file => file.type === "export");
                    if (!main) throw new Error("Illarin sent no file to import.");
                    const url = new URL(main.url, `${state.base}/`);
                    const base = new URL(state.base);
                    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/send/`)) throw new Error("Illarin returned an unexpected download address.");
                    const file = await this.request(url, { credentials: "omit", cache: "no-store", redirect: "error", signal });
                    if (!file.ok) throw new RequestError(file.status);
                    const install = await this.tavern.install(send, await file.blob());
                    state.installs.push(install);
                    state.receipts.push(send.id);
                }
                if (!state.acknowledged.includes(send.id)) state.acknowledged.push(send.id);
                await this.storage.save(state);
            } catch (error) {
                failure = error;
            }
        }
        if (permissions.includes("library:sync")) await this.sync(state, signal);
        if (failure) throw failure;
    }

    async sync(state: State, signal?: AbortSignal) {
        const installed = await this.tavern.installed(state.installs);
        const versions = new Map<string, number>();
        for (const item of installed) versions.set(item.workId, Math.max(item.versionNumber, versions.get(item.workId) || 0));
        const entries = [...versions].map(([workId, versionNumber]) => ({ workId, versionNumber }));
        const snapshot = Date.now() - state.lastSnapshot > 3_600_000;
        const changed = entries.filter(item => !state.mirrored.some(old => old.workId === item.workId && old.versionNumber === item.versionNumber));
        const removed = state.mirrored.filter(old => !versions.has(old.workId)).map(item => item.workId);
        if (!snapshot && !changed.length && !removed.length) return;
        if (entries.length > 2000 || removed.length > 2000) throw new Error("Your Illarin library exceeds the report limit.");
        await this.authorized(state, "/api/v1/library/sync", {
            snapshot, appVersion: this.tavern.version, entries: snapshot ? entries : changed,
            ...(snapshot ? {} : { removed }),
        }, signal);
        state.mirrored = entries;
        if (snapshot) state.lastSnapshot = Date.now();
        await this.storage.save(state);
    }
}
