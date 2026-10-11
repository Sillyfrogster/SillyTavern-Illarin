import { baseURL, Client, RequestError, type Fetch } from "./protocol";
import { BrowserStorage } from "./storage";
import { TavernAdapter, type Context } from "./tavern";

declare const SillyTavern: { getContext(): Context };

async function start() {
    const context = SillyTavern.getContext();
    const [userResponse, versionResponse] = await Promise.all([
        fetch("/api/users/me", { headers: context.getRequestHeaders(), cache: "no-store" }),
        fetch("/version", { cache: "no-store" }),
    ]);
    if (!userResponse.ok || !versionResponse.ok) throw new Error("SillyTavern could not read your account. Reload the page.");
    const user = await userResponse.json();
    const version = await versionResponse.json();
    if (typeof user.handle !== "string" || typeof version.pkgVersion !== "string") throw new Error("SillyTavern could not read your account. Reload the page.");
    const storage = new BrowserStorage(user.handle);
    const request: Fetch = async (input, options) => {
        await storage.renew();
        return fetch(input, { ...options, signal: AbortSignal.any([options?.signal || new AbortController().signal, AbortSignal.timeout(45_000)]) });
    };
    const tavern = new TavernAdapter(context, version.pkgVersion, request);
    const client = new Client(storage, tavern, request);
    const panel = document.createElement("div");
    panel.className = "illarin-settings";
    panel.innerHTML = `<div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header"><b>Illarin</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
      <div class="inline-drawer-content">
        <label for="illarin-address">Illarin address</label>
        <input id="illarin-address" class="text_pole" type="url" autocomplete="url" spellcheck="false">
        <div class="flex-container"><button type="button" class="menu_button" id="illarin-connect">Connect</button><button type="button" class="menu_button" id="illarin-check">Check now</button><button type="button" class="menu_button" id="illarin-disconnect">Disconnect</button></div>
        <p id="illarin-status" role="status" aria-live="polite"></p>
        <div id="illarin-approval" hidden><p>Type this code on Illarin: <strong id="illarin-code"></strong></p><a id="illarin-verify" target="_blank" rel="noopener noreferrer">Open Illarin</a><p>Approve only a connection you started, and check only the permissions you want.</p></div>
        <p id="illarin-library"></p>
        <div id="illarin-updates"></div>
        <p>Credentials stay in this browser. Scripts on this SillyTavern origin can read them. Revoke access in your Illarin account settings.</p>
      </div>
    </div>`;
    document.querySelector("#extensions_settings2")!.append(panel);
    const element = <T extends HTMLElement>(id: string) => panel.querySelector<T>(`#illarin-${id}`)!;
    const address = element<HTMLInputElement>("address");
    const connect = element<HTMLButtonElement>("connect");
    const disconnect = element<HTMLButtonElement>("disconnect");
    const check = element<HTMLButtonElement>("check");
    const status = element("status");
    let operation: Promise<void> | undefined;
    let controller: AbortController | undefined;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    let backgroundRunning = false;
    let checkRequested = false;
    let updateRequested = false;

    async function render() {
        const state = await storage.read();
        address.value = state.base;
        address.disabled = !!state.credentials || !!operation;
        disconnect.hidden = !state.credentials;
        check.hidden = !state.credentials;
        connect.hidden = !!state.credentials;
        element("library").textContent = state.credentials?.connectedApp.permissions.includes("library:sync")
            ? `${state.mirrored.length} installed ${state.mirrored.length === 1 ? "work" : "works"} shared with Illarin` : "Your library is not shared.";
        element("updates").replaceChildren();
        for (const update of state.updates || []) {
            for (const copy of state.installs.filter(item => item.workId === update.workId && item.versionNumber < update.versionNumber)) {
                const row = document.createElement("div");
                const name = document.createElement("p");
                name.textContent = `${copy.name || copy.localId} — Update available`;
                const notes = document.createElement("p");
                notes.textContent = update.notes;
                notes.className = "illarin-version-notes";
                const button = document.createElement("button");
                button.type = "button";
                button.className = "menu_button";
                const pending = state.pendingUpdates?.some(item => item.workId === copy.workId);
                button.textContent = pending ? "Retry update" : `Update ${copy.type}`;
                button.disabled = updateRequested || (!!operation && !backgroundRunning) || !state.credentials?.connectedApp.permissions.includes("work:receive");
                button.addEventListener("click", () => { void (async () => {
                    if (updateRequested) return;
                    updateRequested = true;
                    await render();
                    await operation;
                    try {
                        await run(async signal => {
                            await client.update(copy.workId, copy.localId, signal);
                            await client.cycle(signal, true);
                            status.textContent = "Update check finished.";
                        });
                    } finally { updateRequested = false; await render(); }
                })(); });
                row.append(name, notes, button);
                element("updates").append(row);
            }
        }
    }

    const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timeout); reject(new DOMException("Cancelled", "AbortError")); };
        const timeout = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
    });

    async function run(task: (signal: AbortSignal) => Promise<void>) {
        if (operation) return;
        controller = new AbortController();
        const signal = controller.signal;
        operation = (async () => {
            try {
                const ran = await storage.exclusive(lockSignal => task(AbortSignal.any([signal, lockSignal])));
                if (!ran) status.textContent = "Illarin is active in another SillyTavern tab.";
                failures = 0;
            } catch (error) {
                if (signal.aborted) return;
                failures++;
                if (error instanceof RequestError && error.status === 403) stopped = true;
                const retry = error instanceof RequestError ? error.retryAfter : 0;
                delay = Math.max(delay, retry * 1000);
                status.textContent = error instanceof Error ? error.message : "Illarin could not connect. Try again.";
            } finally {
                operation = undefined;
                controller = undefined;
                await render();
            }
        })();
        await render();
        await operation;
    }

    let delay = 1000;
    async function background() {
        if (backgroundRunning) { checkRequested = true; return; }
        backgroundRunning = true;
        const force = checkRequested;
        checkRequested = false;
        clearTimeout(timer);
        delay = 1000;
        try {
            const state = await storage.read();
            if (!stopped && state.credentials && !operation) {
                await run(async signal => {
                    await client.cycle(signal, force);
                    const latest = await storage.read();
                    const permissions = latest.credentials?.connectedApp.permissions || [];
                    status.textContent = permissions.includes("work:receive") ? "Connected. Waiting for works from Illarin." : "Connected. Receiving works is off in your Illarin account settings.";
                });
            }
        } finally {
            backgroundRunning = false;
            timer = setTimeout(() => { void background(); }, checkRequested ? 0 : Math.max(delay, failures ? Math.min(60_000, 2000 * 2 ** Math.min(failures, 5)) * (1 + Math.random()) : 5000));
        }
    }

    connect.addEventListener("click", () => {
        if (operation) { controller?.abort(); return; }
        const base = address.value;
        void run(async signal => {
            const normalized = baseURL(base);
            const pending = await client.begin(normalized, signal);
            const verification = new URL(pending.verificationUrl);
            if (verification.origin !== new URL(normalized).origin) throw new Error("Illarin returned an unexpected sign-in address.");
            element("code").textContent = pending.userCode;
            element<HTMLAnchorElement>("verify").href = verification.href;
            element("approval").hidden = false;
            connect.textContent = "Cancel connection";
            status.textContent = "Open Illarin and type the code to choose your permissions.";
            let interval = Math.max(1, pending.interval) * 1000;
            let networkFailures = 0;
            try {
                while (Date.now() < Date.parse(pending.expiresAt)) {
                    await pause(interval, signal);
                    try {
                        const result = await client.poll(normalized, pending.deviceCode, signal);
                        networkFailures = 0;
                        if (result.status === "connected") {
                            await client.connected(normalized, result, signal);
                            stopped = false;
                            status.textContent = "Connected.";
                            return;
                        }
                        if (result.status !== "pending") throw new Error("Illarin did not finish connecting. Try again.");
                    } catch (error) {
                        if (error instanceof RequestError) {
                            if (error.status !== 429) throw error;
                            interval = Math.max(interval + 1000, error.retryAfter * 1000);
                        } else if (error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError")) {
                            networkFailures++;
                            interval = Math.max(interval, Math.min(60_000, 2000 * 2 ** Math.min(networkFailures, 5)));
                        } else throw error;
                    }
                }
                throw new Error("This code expired. Connect again.");
            } finally {
                element("approval").hidden = true;
                connect.textContent = "Connect";
            }
        });
    });
    disconnect.addEventListener("click", () => {
        void (async () => {
            stopped = true;
            controller?.abort();
            await operation;
            await run(async () => {
                const state = await storage.read();
                await client.disconnect();
                status.textContent = `Disconnected here. Revoke “SillyTavern / Illarin extension” (${state.credentials?.connectedApp.id}) in your Illarin account settings to end its access.`;
            });
        })();
    });
    check.addEventListener("click", () => { stopped = false; checkRequested = true; void background(); });
    for (const [event, renamed] of [["CHARACTER_RENAMED", true], ["PRESET_RENAMED", false]] as const) {
        context.eventSource.on(context.eventTypes[event], (...args: any[]) => {
            if (renamed) void storage.rename("character", args[0], args[1]);
            else if (args[0].apiId === "openai") void storage.rename("preset", args[0].oldName, args[0].newName);
        });
    }
    await render();
    void background();
}

const context = SillyTavern.getContext();
context.eventSource.on(context.eventTypes.APP_READY, () => {
    setTimeout(() => { void start().catch(() => {
        const notice = document.createElement("p");
        notice.textContent = "Illarin could not start. Reload SillyTavern and try again.";
        document.querySelector("#extensions_settings2")?.append(notice);
    }); }, 0);
});
