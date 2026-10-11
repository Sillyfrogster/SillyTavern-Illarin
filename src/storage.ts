import type { State, Storage } from "./protocol";

interface Rename { type: string; oldId: string; newId: string }

function renamed(state: State, renames: Rename[]): State {
    for (const rename of renames) {
        for (const install of state.installs) {
            if (install.type === rename.type && install.localId === rename.oldId) install.localId = rename.newId;
        }
    }
    return state;
}

export class BrowserStorage implements Storage {
    private owner = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join("-");
    private db: Promise<IDBDatabase>;

    constructor(user: string) {
        this.db = new Promise((resolve, reject) => {
            const request = indexedDB.open(`illarin:${user}`, 1);
            request.onupgradeneeded = () => request.result.createObjectStore("connection");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(new Error("Your browser could not open Illarin storage."));
        });
    }

    private async transaction<T>(action: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
        const db = await this.db;
        return new Promise((resolve, reject) => {
            const transaction = db.transaction("connection", "readwrite");
            let result: T;
            transaction.oncomplete = () => resolve(result);
            transaction.onerror = transaction.onabort = () => reject(new Error("Your browser could not save the Illarin connection."));
            action(transaction.objectStore("connection"), value => { result = value; });
        });
    }

    read(): Promise<State> {
        return this.transaction((store, done) => {
            const request = store.get("state");
            request.onsuccess = () => done(request.result || { base: "https://illarin.com", installs: [], receipts: [], acknowledged: [], mirrored: [], lastSnapshot: 0 });
        });
    }

    async rename(type: string, oldId: string, newId: string): Promise<void> {
        await this.transaction<void>((store, done) => {
            const request = store.get("renames");
            request.onsuccess = () => {
                store.put([...(request.result || []), { type, oldId, newId }], "renames");
                done();
            };
        });
    }

    async renew(): Promise<void> {
        await this.transaction<void>((store, done) => {
            const request = store.get("lock");
            request.onsuccess = () => {
                if (request.result?.owner !== this.owner) { store.transaction.abort(); return; }
                store.put({ owner: this.owner, expires: Date.now() + 60_000 }, "lock");
                done();
            };
        });
    }

    async save(state: State): Promise<void> {
        await this.transaction<void>((store, done) => {
            const request = store.get("lock");
            request.onsuccess = () => {
                if (request.result?.owner !== this.owner || request.result.expires <= Date.now()) { store.transaction.abort(); return; }
                const pending = store.get("renames");
                pending.onsuccess = () => {
                    store.put(renamed(state, pending.result || []), "state");
                    store.delete("renames");
                    done();
                };
            };
        });
    }

    async exclusive(action: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
        const acquired = await this.transaction<boolean>((store, done) => {
            const request = store.get("lock");
            request.onsuccess = () => {
                if (request.result?.expires > Date.now()) { done(false); return; }
                store.put({ owner: this.owner, expires: Date.now() + 60_000 }, "lock");
                done(true);
            };
        });
        if (!acquired) return false;
        const controller = new AbortController();
        const heartbeat = setInterval(() => { void this.renew().catch(() => controller.abort()); }, 10_000);
        try {
            await action(controller.signal);
        } finally {
            clearInterval(heartbeat);
            controller.abort();
            await this.transaction<void>((store, done) => {
                const request = store.get("lock");
                request.onsuccess = () => {
                    if (request.result?.owner === this.owner) store.delete("lock");
                    done();
                };
            });
        }
        return true;
    }
}
