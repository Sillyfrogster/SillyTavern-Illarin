import { expect, test } from "bun:test";
import { TavernAdapter } from "../src/tavern";
import type { Install, Send } from "../src/protocol";

for (const type of ["lorebook", "preset", "theme"]) test(`${type} imports use the work name and keep separate copies on retries and name collisions`, async () => {
    const copies = new Map<string, any>();
    const data = type === "lorebook" ? { entries: {} } : type === "preset" ? { prompts: [], prompt_order: [] } : { font_scale: 1 };
    const request = (async (url, options) => {
        const path = String(url);
        const body = JSON.parse(options!.body as string);
        if (path === "/api/settings/get") return Response.json({
            world_names: [...copies.keys()], openai_setting_names: [...copies.keys()],
            openai_settings: [...copies.values()].map(value => JSON.stringify(value)),
            themes: [...copies].map(([name, value]) => ({ ...value, name })),
        });
        if (path === "/api/worldinfo/get") return Response.json(copies.get(body.name));
        if (path === "/api/worldinfo/edit") copies.set(body.name, body.data);
        else if (path === "/api/themes/save") copies.set(body.name, body);
        else throw new Error(`Unexpected native request: ${path}`);
        return Response.json({});
    }) as typeof fetch;
    const context = { getRequestHeaders: () => ({}), updateWorldInfoList: async () => {}, getPresetManager: () => ({ savePreset: async (name: string, value: unknown) => { copies.set(name, value); } }) };
    const adapter = new TavernAdapter(context as never, "1.19.0", request);
    const send: Send = { id: "b42b9b0f-f3f9-44c1-8e16-1a88c53f50ac", workId: "synthetic-work", versionNumber: 1, name: "Paper library", type, format: `${type}_sillytavern`, files: [] };
    let reserved: Install | undefined;
    const reserve = async (proposed: Install) => reserved ||= proposed;
    const first = await adapter.install(send, new Blob([JSON.stringify(data)]), reserve);
    expect(first.localId).toBe("Paper library");
    copies.set(first.localId, { ...data, localEdit: true });
    expect((await adapter.install(send, new Blob([JSON.stringify(data)]), reserve)).localId).toBe(first.localId);
    expect(copies.get(first.localId).localEdit).toBe(true);
    const second = await adapter.install({ ...send, id: "b42b9b0f-f3f9-44c1-8e16-1a88c53f50ad" }, new Blob([JSON.stringify(data)]));
    expect(second.localId).toBe("Paper library (2)");
    expect(copies.size).toBe(2);
});

function characterPNG(content: string): Blob {
    const text = new TextEncoder().encode("chara\0" + btoa(JSON.stringify({ data: { description: content } })));
    const bytes = new Uint8Array(text.length + 32);
    bytes.set([137,80,78,71,13,10,26,10]);
    new DataView(bytes.buffer).setUint32(8, text.length);
    bytes.set(new TextEncoder().encode("tEXt"), 12);
    bytes.set(text, 16);
    bytes.set(new TextEncoder().encode("IEND"), text.length + 24);
    return new Blob([bytes]);
}

test("an interrupted character import recovers the stored copy without replacing it", async () => {
    const send: Send = { id: "b42b9b0f-f3f9-44c1-8e16-1a88c53f50ac", workId: "68be0ebd-e77f-4804-90f7-eef8fa374dc6", versionNumber: 2, name: "Paper librarian", format: "charx", type: "character", files: [] };
    const requests: string[] = [];
    const request = (async (url: string | URL | Request) => {
        requests.push(String(url));
        return Response.json([{ avatar: `Illarin-${send.id}.png` }]);
    }) as typeof fetch;
    const adapter = new TavernAdapter({ getRequestHeaders: () => ({}) } as never, "1.19.0", request);
    const installed = await adapter.install(send, new Blob(["unused"]));
    expect(installed.localId).toBe(`Illarin-${send.id}.png`);
    expect(requests).toEqual(["/api/characters/all"]);
});

test("an edited lorebook is kept only after confirmation and cancellation writes nothing", async () => {
    const old = { entries: { "0": { content: "My edits" } } };
    const writes: { name: string; data: unknown }[] = [];
    const send: Send = { id: "b42b9b0f-f3f9-44c1-8e16-1a88c53f50ac", workId: "68be0ebd-e77f-4804-90f7-eef8fa374dc6", versionNumber: 2, name: "Paper library", format: "lorebook_sillytavern", type: "lorebook", files: [] };
    const installed: Install = { workId: send.workId, versionNumber: 1, type: "lorebook", localId: "Paper library", fingerprint: "before-my-edits" };
    let confirmed = false;
    const request = (async (url: string | URL | Request, options?: RequestInit) => {
        if (String(url).endsWith("/get")) return Response.json(old);
        writes.push(JSON.parse(options!.body as string));
        return Response.json({});
    }) as typeof fetch;
    const context = { getRequestHeaders: () => ({}), updateWorldInfoList: async () => {}, Popup: { show: { confirm: async () => confirmed } } };
    const adapter = new TavernAdapter(context as never, "1.19.0", request);
    const file = new Blob([JSON.stringify({ entries: { "0": { content: "Published update" } } })]);
    expect(await adapter.update(send, file, installed, async () => {})).toBeNull();
    expect(writes).toEqual([]);
    confirmed = true;
    const result = await adapter.update(send, file, installed, async () => {});
    expect(writes[0].name).toContain("edited copy");
    expect(writes[0].data).toEqual(old);
    expect(writes[1]).toEqual({ name: installed.localId, data: { entries: { "0": { content: "Published update" } } } });
    expect(result?.localId).toBe(installed.localId);
    expect(result?.versionNumber).toBe(2);
});

test("the browser fetch function keeps its global receiver", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(function (this: unknown) {
        if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
        return Promise.resolve(Response.json([{ avatar: "synthetic.png" }]));
    }, { preconnect: original.preconnect });
    try {
        const adapter = new TavernAdapter({ getRequestHeaders: () => ({}) } as never, "1.19.0");
        expect(await adapter.installed([{ type: "character", localId: "synthetic.png", workId: "synthetic", versionNumber: 1 }])).toHaveLength(1);
    } finally {
        globalThis.fetch = original;
    }
});

for (const failChatRestore of [false, true]) test(`character updates keep chats${failChatRestore ? " and restore the old copy after failure" : " without asking for an unedited copy"}`, async () => {
    const send: Send = { id: "b42b9b0f-f3f9-44c1-8e16-1a88c53f50ac", workId: "68be0ebd-e77f-4804-90f7-eef8fa374dc6", versionNumber: 1, name: "Paper librarian", format: "chara_card_v3", type: "character", files: [] };
    const copies = new Map<string, { content: string; chat: string }>();
    const requests: string[] = [];
    let failed = false;
    const request = (async (url: string | URL | Request, options?: RequestInit) => {
        const path = String(url);
        requests.push(path);
        if (path.endsWith("/import")) {
            const form = options!.body as FormData;
            const stem = form.get("preserved_name") as string;
            const file = form.get("avatar") as File;
            const bytes = new Uint8Array(await file.arrayBuffer());
            const metadata = bytes[0] === 137 ? new TextDecoder().decode(bytes.slice(22, 16 + new DataView(bytes.buffer).getUint32(8))) : "";
            const content = metadata ? JSON.parse(atob(metadata)).data.description : await file.text();
            copies.set(`${stem}.png`, { content, chat: "New default chat" });
            return Response.json({ file_name: stem });
        }
        const body = JSON.parse(options!.body as string);
        if (path.endsWith("/all")) return Response.json([...copies.keys()].map(avatar => ({ avatar })));
        const copy = copies.get(body.avatar_url || body.avatar)!;
        if (path.endsWith("/export")) {
            expect(body.format).toBe("png");
            return new Response(characterPNG(copy.content));
        }
        if (path.endsWith("/get")) return Response.json({ chat: copy.chat, create_date: "2026-01-01", fav: false });
        if (path.endsWith("/rename")) {
            copies.set(`${body.new_name}.png`, copy);
            copies.delete(body.avatar_url);
            return Response.json({ avatar: `${body.new_name}.png` });
        }
        if (path.endsWith("/merge-attributes")) {
            if (failChatRestore && !failed) { failed = true; return new Response(null, { status: 500 }); }
            copy.chat = body.chat;
            return Response.json({});
        }
        throw new Error(`Unexpected write: ${path}`);
    }) as typeof fetch;
    const context = { getRequestHeaders: () => ({}), getCharacters: async () => {}, Popup: { show: { confirm: async () => { throw new Error("Unedited copy should not ask"); } } } };
    const adapter = new TavernAdapter(context as never, "1.19.0", request);
    const installed = await adapter.install(send, new Blob(["Original character"]));
    copies.get(installed.localId)!.chat = "Existing conversation";
    const updating = adapter.update({ ...send, versionNumber: 2 }, new Blob(["Published update"]), installed, async () => {
        expect(installed.recovery?.chat).toBe("Existing conversation");
        expect(copies.get(installed.localId)?.content).toBe("Original character");
    });
    if (failChatRestore) await expect(updating).rejects.toThrow("could not save");
    else expect((await updating)?.localId).toBe(installed.localId);
    expect(copies.get(installed.localId)).toEqual({ content: failChatRestore ? "Original character" : "Published update", chat: "Existing conversation" });
    expect([...copies].some(([id, copy]) => id.includes("previous copy") && copy.content === "Original character")).toBe(true);
    expect(requests.some(path => path.includes("/delete"))).toBe(false);
});

test("canceling while an edited-copy confirmation is open prevents all writes", async () => {
    const controller = new AbortController();
    const writes: string[] = [];
    const request = (async (url: string | URL | Request) => {
        if (String(url).endsWith("/get")) return Response.json({ entries: {} });
        writes.push(String(url));
        return Response.json({});
    }) as typeof fetch;
    const context = { getRequestHeaders: () => ({}), Popup: { show: { confirm: async () => { controller.abort(); return true; } } } };
    const adapter = new TavernAdapter(context as never, "1.19.0", request);
    const send: Send = { id: "b42b9b0f-f3f9-44c1-8e16-1a88c53f50ac", workId: "synthetic-work", versionNumber: 2, name: "Library", type: "lorebook", format: "lorebook_sillytavern", files: [] };
    await expect(adapter.update(send, new Blob(), { workId: send.workId, versionNumber: 1, type: "lorebook", localId: "Library" }, async () => {}, controller.signal)).rejects.toThrow();
    expect(writes).toEqual([]);
});

test("a saved interrupted character update restores its original current chat", async () => {
    const recovery = { chat: "Original conversation", create_date: "2026-01-01", fav: true, data: { extensions: { fav: true } } };
    const install: Install = { workId: "synthetic-work", versionNumber: 1, type: "character", localId: "synthetic.png", recovery };
    let restored: unknown;
    const adapter = new TavernAdapter({ getRequestHeaders: () => ({}) } as never, "1.19.0", async (url, options) => {
        if (String(url).endsWith("/all")) return Response.json([{ avatar: install.localId }]);
        restored = JSON.parse(options!.body as string);
        return Response.json({});
    });
    await adapter.recover([install]);
    expect(restored).toEqual({ ...recovery, avatar: "synthetic.png" });
    expect(install.recovery).toBeUndefined();
});

test("recovery forgets a confirmed deletion but keeps its record when the library cannot be read", async () => {
    const install: Install = { workId: "synthetic-work", versionNumber: 1, type: "character", localId: "deleted.png", recovery: { chat: "Original conversation", data: { extensions: { fav: false } } } };
    let unavailable = true;
    const adapter = new TavernAdapter({ getRequestHeaders: () => ({}) } as never, "1.19.0", async url => {
        expect(String(url)).toBe("/api/characters/all");
        return unavailable ? new Response(null, { status: 500 }) : Response.json([]);
    });
    await expect(adapter.recover([install])).rejects.toThrow();
    expect(install.recovery?.chat).toBe("Original conversation");
    unavailable = false;
    await adapter.recover([install]);
    expect(install.recovery).toBeUndefined();
});

test("opening a character chat does not turn native card metadata into an edit", async () => {
    let edit = "";
    const png = (metadata: string) => {
        const chunk = (type: string, value: string) => {
            const bytes = new Uint8Array(value.length + 12);
            new DataView(bytes.buffer).setUint32(0, value.length);
            bytes.set(new TextEncoder().encode(type + value), 4);
            return bytes;
        };
        const card = { chat: metadata, data: { description: edit === "description" ? "My edits" : "Same character", ...(openedChat ? { tags: [] } : {}), extensions: openedChat ? { fav: false, world: "", talkativeness: "0.5", depth_prompt: { prompt: "", depth: 4, role: "system" } } : {} } };
        return new Blob([new Uint8Array([137,80,78,71,13,10,26,10]), chunk("IDAT", edit === "portrait" ? "changed portrait" : "portrait"), chunk("tEXt", "chara\0" + btoa(JSON.stringify(card))), chunk("IEND", "")]);
    };
    let openedChat = false;
    const send: Send = { id: "b42b9b0f-f3f9-44c1-8e16-1a88c53f50ac", workId: "synthetic-work", versionNumber: 1, name: "Library", type: "character", format: "chara_card_v3", files: [] };
    let imported = false;
    const request = (async (url, options) => {
        const path = String(url);
        if (path.endsWith("/import")) { imported = true; return Response.json({ file_name: (options!.body as FormData).get("preserved_name") }); }
        if (path.endsWith("/all")) return Response.json(imported ? [{ avatar: `Illarin-${send.id}.png` }] : []);
        const body = JSON.parse(options!.body as string);
        if (path.endsWith("/export")) {
            expect(body.format).toBe("png");
            return new Response(png(openedChat ? "rewritten with chat metadata" : "original metadata"));
        }
        if (path.endsWith("/get")) return Response.json({ chat: "My existing chat" });
        return Response.json({});
    }) as typeof fetch;
    let confirmations = 0;
    const context = { getRequestHeaders: () => ({}), getCharacters: async () => {}, Popup: { show: { confirm: async () => { confirmations++; return false; } } } };
    const adapter = new TavernAdapter(context as never, "1.19.0", request);
    const installed = await adapter.install(send, png("original metadata"));
    openedChat = true;
    expect((await adapter.update({ ...send, versionNumber: 2 }, png("update"), installed, async () => {}))?.versionNumber).toBe(2);
    expect(confirmations).toBe(0);
    for (edit of ["description", "portrait"]) expect(await adapter.update({ ...send, versionNumber: 2 }, png("update"), installed, async () => {})).toBeNull();
    expect(confirmations).toBe(2);
});
