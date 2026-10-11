import { expect, test } from "bun:test";
import { TavernAdapter } from "../src/tavern";
import type { Send } from "../src/protocol";

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
