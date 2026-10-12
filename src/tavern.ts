import type { Fetch, Install, Send, Tavern } from "./protocol";

export interface Context {
    getRequestHeaders(options?: { omitContentType: boolean }): Record<string, string>;
    getCharacters(): Promise<void>;
    updateWorldInfoList(): Promise<void>;
    getPresetManager(apiId: string): { savePreset(name: string, data: unknown, options?: { skipUpdate: boolean }): Promise<void> };
    eventSource: { on(event: string, handler: (...args: any[]) => void): void };
    eventTypes: Record<string, string>;
    Popup: { show: { confirm(title: string, content: string): Promise<boolean> } };
}

interface Settings {
    world_names: string[];
    openai_setting_names: string[];
    openai_settings?: string[];
    themes: { name: string; [key: string]: unknown }[];
}

export class TavernAdapter implements Tavern {
    constructor(private context: Context, public version: string, private request: Fetch = (input, options) => fetch(input, options)) {}

    private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
        const multipart = body instanceof FormData;
        const response = await this.request(path, {
            method: "POST", headers: this.context.getRequestHeaders({ omitContentType: multipart }),
            body: multipart ? body : JSON.stringify(body), cache: "no-store", signal,
        });
        if (!response.ok) throw new Error("SillyTavern could not save the file. Check its connection and try again.");
        return response;
    }

    async installed(installs: Install[], signal?: AbortSignal): Promise<Install[]> {
        if (!installs.length) return [];
        const characters = installs.some(item => item.type === "character")
            ? await (await this.post("/api/characters/all", {}, signal)).json() as { avatar: string }[] : [];
        const settings: Settings = installs.some(item => item.type !== "character")
            ? await (await this.post("/api/settings/get", {}, signal)).json() : { world_names: [], openai_setting_names: [], themes: [] };
        if (!Array.isArray(characters) || !Array.isArray(settings.world_names) || !Array.isArray(settings.openai_setting_names) || !Array.isArray(settings.themes)) throw new Error("SillyTavern could not read your library. Nothing was removed from Illarin.");
        return installs.filter(item => {
            switch (item.type) {
                case "character": return characters.some(character => character.avatar === item.localId);
                case "lorebook": return settings.world_names.includes(item.localId);
                case "preset": return settings.openai_setting_names.includes(item.localId);
                case "theme": return settings.themes.some(theme => theme.name === item.localId);
                default: return false;
            }
        });
    }

    async install(send: Send, file: Blob, reserve?: (install: Install) => Promise<Install>): Promise<Install> {
        const types: Record<string, string> = { charx: "character", chara_card_v3: "character", chara_card_v2: "character", lorebook_sillytavern: "lorebook", preset_sillytavern: "preset", theme_sillytavern: "theme" };
        if (types[send.format] !== send.type || !/^[0-9a-f-]{36}$/.test(send.id)) throw new Error("SillyTavern cannot import this file.");
        const stem = `Illarin-${send.id}`;
        const name = send.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").trim().slice(0, 80) || send.type;
        let installed: Install = {
            workId: send.workId, versionNumber: send.versionNumber, type: send.type,
            localId: send.type === "character" ? `${stem}.png` : name, name: send.name,
            ...(send.type === "preset" ? { apiId: "openai" } : {}),
        };
        if (send.type !== "character") {
            for (let number = 2; (await this.installed([installed])).length; number++) installed.localId = `${name} (${number})`;
        }
        if (reserve) installed = await reserve(installed);
        if ((await this.installed([installed])).length) return installed;
        await this.write(send, file, installed.localId);
        if (send.type === "character") await this.context.getCharacters();
        if (!(await this.installed([installed])).length) throw new Error("SillyTavern did not keep the imported file. Try again.");
        installed.fingerprint = await this.fingerprint(await this.read(installed), installed);
        return installed;
    }

    private async read(install: Install, signal?: AbortSignal): Promise<Blob> {
        if (install.type === "character") return await (await this.post("/api/characters/export", { avatar_url: install.localId, format: "png" }, signal)).blob();
        let data: unknown;
        if (install.type === "lorebook") data = await (await this.post("/api/worldinfo/get", { name: install.localId }, signal)).json();
        else {
            const settings = await (await this.post("/api/settings/get", {}, signal)).json() as Settings;
            data = install.type === "theme" ? settings.themes.find(item => item.name === install.localId)
                : JSON.parse(settings.openai_settings?.[settings.openai_setting_names.indexOf(install.localId)] || "null");
        }
        if (!data || typeof data !== "object") throw new Error("SillyTavern could not read the installed copy. Nothing was replaced.");
        return new Blob([JSON.stringify(data, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)]);
    }

    private async fingerprint(file: Blob, install: Install): Promise<string> {
        if (install.type === "character") {
            const png = new Uint8Array(await file.arrayBuffer());
            const parts: BlobPart[] = [];
            let metadata = "", v3 = "";
            if (png[0] !== 137 || png[1] !== 80) throw new Error("SillyTavern could not read the portrait. Nothing was replaced.");
            parts.push(png.slice(0, 8));
            for (let offset = 8; offset < png.length;) {
                if (offset + 12 > png.length) throw new Error("SillyTavern returned an incomplete portrait.");
                const size = new DataView(png.buffer).getUint32(offset) + 12;
                if (size > png.length - offset) throw new Error("SillyTavern returned an incomplete portrait.");
                const type = new TextDecoder().decode(png.slice(offset + 4, offset + 8));
                if (!["tEXt", "zTXt", "iTXt"].includes(type)) parts.push(png.slice(offset, offset + size));
                if (type === "tEXt") {
                    const text = new TextDecoder().decode(png.slice(offset + 8, offset + size - 4));
                    const separator = text.indexOf("\0");
                    const keyword = text.slice(0, separator).toLowerCase();
                    if (keyword === "chara") metadata = text.slice(separator + 1);
                    if (keyword === "ccv3") v3 = text.slice(separator + 1);
                }
                offset += size;
            }
            const card = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(v3 || metadata), char => char.charCodeAt(0))));
            if (!card.data || typeof card.data !== "object") throw new Error("SillyTavern could not read the character. Nothing was replaced.");
            const extensions = { ...card.data.extensions };
            delete extensions.fav;
            extensions.talkativeness = String(extensions.talkativeness ?? 0.5);
            extensions.world ??= "";
            extensions.depth_prompt = { prompt: "", depth: 4, role: "system", ...extensions.depth_prompt };
            parts.push(JSON.stringify({ ...card.data, tags: card.data.tags ?? [], extensions }, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
                ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value));
            file = new Blob(parts);
        }
        const bytes = await file.arrayBuffer();
        if (crypto.subtle) return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
        return btoa(Array.from(new Uint8Array(bytes), byte => String.fromCharCode(byte)).join(""));
    }

    async recover(installs: Install[], signal?: AbortSignal): Promise<void> {
        const pending = installs.filter(install => install.recovery);
        const present = await this.installed(pending, signal);
        for (const install of pending) {
            if (present.includes(install)) await this.post("/api/characters/merge-attributes", { ...install.recovery, avatar: install.localId }, signal);
            delete install.recovery;
        }
    }

    async update(send: Send, file: Blob, install: Install, remember: () => Promise<void>, signal?: AbortSignal): Promise<Install | null> {
        if (send.workId !== install.workId || send.type !== install.type || send.versionNumber <= install.versionNumber) throw new Error("This file is not a newer version of your copy.");
        const old = await this.read(install, signal);
        const fingerprint = await this.fingerprint(old, install);
        const edited = !install.fingerprint || fingerprint !== install.fingerprint;
        if (edited && !await this.context.Popup.show.confirm("Replace your edited copy?", "SillyTavern keeps your copy under a name containing ‘edited copy’ before replacing it. Your chats stay with the updated character.")) return null;
        signal?.throwIfAborted();
        const suffix = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join("-");
        const label = `${install.type === "character" ? send.name : install.localId} (${edited ? "edited copy" : "previous copy"} ${suffix})`;
        if (install.type === "character") {
            const previous = await (await this.post("/api/characters/get", { avatar_url: install.localId }, signal)).json();
            if (typeof previous.chat !== "string") throw new Error("SillyTavern could not read your current chat. Nothing was replaced.");
            const backupId = `Illarin-backup-${suffix}.png`;
            await this.write({ ...send, format: "chara_card_v3" }, old, backupId, false, signal);
            await this.post("/api/characters/rename", { avatar_url: backupId, new_name: label }, signal);
            if (fingerprint !== await this.fingerprint(await this.read(install, signal), install)) throw new Error("Your copy changed while the update was open. Try again.");
            install.recovery = { chat: previous.chat, create_date: previous.create_date, fav: previous.fav, data: { extensions: { fav: previous.data?.extensions?.fav || false } } };
            await remember();
            const local = { ...install.recovery, avatar: install.localId };
            try {
                signal?.throwIfAborted();
                await this.write(send, file, install.localId, false, signal);
                await this.post("/api/characters/merge-attributes", local, signal);
            } catch (error) {
                await this.write({ ...send, format: "chara_card_v3" }, old, install.localId);
                await this.post("/api/characters/merge-attributes", local);
                throw error;
            }
            await this.context.getCharacters();
        } else {
            await this.write(send, old, label, true, signal);
            if (fingerprint !== await this.fingerprint(await this.read(install, signal), install)) throw new Error("Your copy changed while the update was open. Try again.");
            signal?.throwIfAborted();
            await this.write(send, file, install.localId, false, signal);
        }
        delete install.recovery;
        return { ...install, versionNumber: send.versionNumber, fingerprint: await this.fingerprint(await this.read(install, signal), install) };
    }

    private async write(send: Send, file: Blob, localId: string, backup = false, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        const stem = localId.replace(/\.png$/, "");
        const name = localId;
        if (send.type === "character") {
            const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
            const format = send.format === "charx" ? "charx" : signature[0] === 137 && signature[1] === 80 ? "png" : "json";
            const body = new FormData();
            body.append("avatar", file, `${stem}.${format}`);
            body.append("file_type", format);
            body.append("preserved_name", stem);
            const result = await (await this.post("/api/characters/import", body, signal)).json();
            if (result.error || result.file_name !== stem) throw new Error("SillyTavern could not import the character.");
        } else {
            const data = JSON.parse(await file.text());
            if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("SillyTavern could not read the file.");
            signal?.throwIfAborted();
            switch (send.type) {
                case "lorebook":
                    if (!data.entries || typeof data.entries !== "object") throw new Error("This lorebook has no entries.");
                    await this.post("/api/worldinfo/edit", { name, data }, signal);
                    await this.context.updateWorldInfoList();
                    break;
                case "preset":
                    if (!Array.isArray(data.prompts) || !Array.isArray(data.prompt_order)) throw new Error("This preset has no prompts.");
                    await this.context.getPresetManager("openai").savePreset(name, data, { skipUpdate: backup });
                    break;
                case "theme":
                    await this.post("/api/themes/save", { ...data, name }, signal);
                    break;
            }
        }
    }
}
