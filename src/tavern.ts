import type { Fetch, Install, Send, Tavern } from "./protocol";

export interface Context {
    getRequestHeaders(options?: { omitContentType: boolean }): Record<string, string>;
    getCharacters(): Promise<void>;
    updateWorldInfoList(): Promise<void>;
    getPresetManager(apiId: string): { savePreset(name: string, data: unknown): Promise<void> };
    eventSource: { on(event: string, handler: (...args: any[]) => void): void };
    eventTypes: Record<string, string>;
}

interface Settings {
    world_names: string[];
    openai_setting_names: string[];
    themes: { name: string }[];
}

export class TavernAdapter implements Tavern {
    constructor(private context: Context, public version: string, private request: Fetch = (input, options) => fetch(input, options)) {}

    private async post(path: string, body: unknown): Promise<Response> {
        const multipart = body instanceof FormData;
        const response = await this.request(path, {
            method: "POST", headers: this.context.getRequestHeaders({ omitContentType: multipart }),
            body: multipart ? body : JSON.stringify(body), cache: "no-store",
        });
        if (!response.ok) throw new Error("SillyTavern could not save the file. Check its connection and try again.");
        return response;
    }

    async installed(installs: Install[]): Promise<Install[]> {
        if (!installs.length) return [];
        const characters = installs.some(item => item.type === "character")
            ? await (await this.post("/api/characters/all", {})).json() as { avatar: string }[] : [];
        const settings: Settings = installs.some(item => item.type !== "character")
            ? await (await this.post("/api/settings/get", {})).json() : { world_names: [], openai_setting_names: [], themes: [] };
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

    async install(send: Send, file: Blob): Promise<Install> {
        const types: Record<string, string> = { charx: "character", chara_card_v3: "character", chara_card_v2: "character", lorebook_sillytavern: "lorebook", preset_sillytavern: "preset", theme_sillytavern: "theme" };
        if (types[send.format] !== send.type || !/^[0-9a-f-]{36}$/.test(send.id)) throw new Error("SillyTavern cannot import this file.");
        const stem = `Illarin-${send.id}`;
        const name = `${send.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").trim().slice(0, 80) || send.type} (${stem})`;
        const installed: Install = {
            workId: send.workId, versionNumber: send.versionNumber, type: send.type,
            localId: send.type === "character" ? `${stem}.png` : name,
            ...(send.type === "preset" ? { apiId: "openai" } : {}),
        };
        if ((await this.installed([installed])).length) return installed;
        if (send.type === "character") {
            const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
            const format = send.format === "charx" ? "charx" : signature[0] === 137 && signature[1] === 80 ? "png" : "json";
            const body = new FormData();
            body.append("avatar", file, `${stem}.${format}`);
            body.append("file_type", format);
            body.append("preserved_name", stem);
            const result = await (await this.post("/api/characters/import", body)).json();
            if (result.error || result.file_name !== stem) throw new Error("SillyTavern could not import the character.");
            await this.context.getCharacters();
        } else {
            const data = JSON.parse(await file.text());
            if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("SillyTavern could not read the file.");
            switch (send.type) {
                case "lorebook":
                    if (!data.entries || typeof data.entries !== "object") throw new Error("This lorebook has no entries.");
                    await this.post("/api/worldinfo/edit", { name, data });
                    await this.context.updateWorldInfoList();
                    break;
                case "preset":
                    if (!Array.isArray(data.prompts) || !Array.isArray(data.prompt_order)) throw new Error("This preset has no prompts.");
                    await this.context.getPresetManager("openai").savePreset(name, data);
                    break;
                case "theme":
                    await this.post("/api/themes/save", { ...data, name });
                    break;
            }
        }
        if (!(await this.installed([installed])).length) throw new Error("SillyTavern did not keep the imported file. Try again.");
        return installed;
    }
}
