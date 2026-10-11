// src/protocol.ts
var formats = ["charx", "chara_card_v3", "chara_card_v2", "lorebook_sillytavern", "preset_sillytavern", "theme_sillytavern"];

class RequestError extends Error {
  status;
  retryAfter;
  constructor(status, retryAfter = 0) {
    super(status === 403 ? "This permission is off. Change it in your Illarin account settings." : `Illarin could not finish the request (${status}).`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
function baseURL(value) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTPS address, or HTTP for a local Illarin site.");
  }
  return url.href.replace(/\/$/, "");
}

class Client {
  storage;
  tavern;
  request;
  constructor(storage, tavern, request = (input, options) => fetch(input, options)) {
    this.storage = storage;
    this.tavern = tavern;
    this.request = request;
  }
  async json(base, path, body, token, signal) {
    const response = await this.request(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...body === undefined ? {} : { "Content-Type": "application/json" }, ...token ? { Authorization: `Bearer ${token}` } : {} },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal
    });
    if (!response.ok)
      throw new RequestError(response.status, Number(response.headers.get("Retry-After")) || 0);
    return response;
  }
  async begin(base, signal) {
    const response = await this.json(baseURL(base), "/api/v1/connect/requests", {
      appName: "SillyTavern",
      name: "Illarin extension",
      appVersion: this.tavern.version,
      protocolVersion: 1,
      capabilities: [],
      acceptedFormats: formats,
      permissions: ["work:receive", "library:sync"]
    }, undefined, signal);
    return await response.json();
  }
  async poll(base, deviceCode, signal) {
    const response = await this.json(base, "/api/v1/connect/poll", { deviceCode }, undefined, signal);
    return await response.json();
  }
  async connected(base, credentials, signal) {
    const state = await this.storage.read();
    signal?.throwIfAborted();
    if (state.base !== base) {
      state.installs = [];
      state.receipts = [];
      state.acknowledged = [];
      state.mirrored = [];
      state.updates = [];
      state.pendingUpdates = [];
    }
    state.base = base;
    state.credentials = credentials;
    state.refreshing = false;
    state.lastSnapshot = 0;
    state.lastCheck = 0;
    await this.storage.save(state);
  }
  async disconnect() {
    const state = await this.storage.read();
    if (state.installs.some((item) => item.recovery))
      await this.storage.save(state);
    await this.tavern.recover(state.installs);
    delete state.credentials;
    state.updates = [];
    state.pendingUpdates = [];
    state.refreshing = false;
    await this.storage.save(state);
  }
  async refresh(state) {
    if (state.refreshing)
      throw new Error("The last credential refresh did not finish. Connect again.");
    state.refreshing = true;
    await this.storage.save(state);
    try {
      const response = await this.json(state.base, "/api/v1/connect/refresh", { refreshToken: state.credentials.refreshToken });
      state.credentials = await response.json();
      state.refreshing = false;
      await this.storage.save(state);
    } catch (error) {
      await this.disconnect();
      throw new Error("Illarin could not renew this connection. Connect again.");
    }
  }
  async authorized(state, path, body, signal) {
    if (state.refreshing)
      throw new Error("The last credential refresh did not finish. Connect again.");
    if (Date.parse(state.credentials.accessTokenExpiresAt) < Date.now() + 60000)
      await this.refresh(state);
    try {
      return await this.json(state.base, path, body, state.credentials.accessToken, signal);
    } catch (error) {
      if (!(error instanceof RequestError) || error.status !== 401)
        throw error;
      await this.refresh(state);
      return await this.json(state.base, path, body, state.credentials.accessToken, signal);
    }
  }
  async update(workId, localId, signal) {
    let state = await this.storage.read();
    if (!state.credentials || !state.installs.some((item) => item.workId === workId && item.localId === localId))
      throw new Error("This copy is no longer connected to Illarin.");
    const queue = async () => await (await this.authorized(state, `/api/v1/works/${encodeURIComponent(workId)}/receive`, {}, signal)).json();
    let queued = await queue();
    if (state.receipts.includes(queued.id)) {
      await this.cycle(signal);
      state = await this.storage.read();
      queued = await queue();
      if (state.receipts.includes(queued.id))
        throw new Error("Illarin has not settled the previous update. Try again.");
    }
    state.pendingUpdates = [...(state.pendingUpdates || []).filter((item) => item.workId !== workId), { sendId: queued.id, workId, localId, expiresAt: queued.expiresAt }];
    await this.storage.save(state);
  }
  async cycle(signal, force = false) {
    const state = await this.storage.read();
    if (!state.credentials)
      return;
    if (state.installs.some((item) => item.recovery))
      await this.storage.save(state);
    await this.tavern.recover(state.installs, signal);
    state.pendingUpdates = state.pendingUpdates?.filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > Date.now());
    const standing = await this.authorized(state, "/api/v1/connected-apps/me", undefined, signal);
    const app = await standing.json();
    state.credentials.connectedApp.permissions = app.permissions;
    await this.storage.save(state);
    const permissions = app.permissions;
    if (permissions.includes("library:sync"))
      await this.sync(state, signal, force);
    else {
      state.updates = [];
      await this.storage.save(state);
    }
    if (!permissions.includes("work:receive"))
      return;
    const acknowledged = [...state.acknowledged];
    const response = await this.authorized(state, "/api/v1/sends/collect", { acknowledge: acknowledged }, signal);
    state.acknowledged = state.acknowledged.filter((id) => !acknowledged.includes(id));
    await this.storage.save(state);
    if (response.status === 204)
      return;
    const collected = await response.json();
    let failure;
    for (const send of collected.sends) {
      try {
        if (!state.receipts.includes(send.id)) {
          if (!formats.includes(send.format))
            throw new Error("SillyTavern cannot read this format.");
          const main = send.files.find((file) => file.type === "export");
          if (!main)
            throw new Error("Illarin sent no file to import.");
          const url = new URL(main.url, `${state.base}/`);
          const base = new URL(state.base);
          if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/send/`))
            throw new Error("Illarin returned an unexpected download address.");
          const file = await this.request(url, { credentials: "omit", cache: "no-store", redirect: "error", signal });
          if (!file.ok)
            throw new RequestError(file.status);
          const pending = state.pendingUpdates?.find((item) => item.sendId === send.id);
          const previous = pending && state.installs.find((item) => item.workId === pending.workId && item.localId === pending.localId);
          if (pending && !previous)
            throw new Error("The copy to update is no longer available.");
          const blob = await file.blob();
          const install = previous ? await this.tavern.update(send, blob, previous, () => this.storage.save(state), signal) : await this.tavern.install(send, blob);
          if (install) {
            if (previous)
              state.installs[state.installs.indexOf(previous)] = install;
            else
              state.installs.push(install);
          }
          state.pendingUpdates = state.pendingUpdates?.filter((item) => item.sendId !== send.id);
          state.receipts.push(send.id);
        }
        if (!state.acknowledged.includes(send.id))
          state.acknowledged.push(send.id);
        await this.storage.save(state);
      } catch (error) {
        failure = error;
      }
    }
    if (permissions.includes("library:sync"))
      await this.sync(state, signal);
    if (failure)
      throw failure;
  }
  async sync(state, signal, force = false) {
    const installed = await this.tavern.installed(state.installs);
    state.installs = installed;
    const versions = new Map;
    for (const item of installed)
      versions.set(item.workId, Math.max(item.versionNumber, versions.get(item.workId) || 0));
    const entries = [...versions].map(([workId, versionNumber]) => ({ workId, versionNumber }));
    const snapshot = Date.now() - state.lastSnapshot > 3600000;
    const changed = entries.filter((item) => !state.mirrored.some((old) => old.workId === item.workId && old.versionNumber === item.versionNumber));
    const removed = state.mirrored.filter((old) => !versions.has(old.workId)).map((item) => item.workId);
    if (!force && !snapshot && !changed.length && !removed.length && Date.now() - (state.lastCheck || 0) < 60000)
      return;
    if (entries.length > 2000 || removed.length > 2000)
      throw new Error("Your Illarin library exceeds the report limit.");
    const response = await this.authorized(state, "/api/v1/library/sync", {
      snapshot,
      appVersion: this.tavern.version,
      entries: snapshot ? entries : changed,
      ...snapshot ? {} : { removed }
    }, signal);
    const result = await response.json();
    state.updates = (result.entries || []).filter((item) => installed.some((copy) => copy.workId === item.workId && copy.versionNumber < item.versionNumber));
    state.lastCheck = Date.now();
    state.mirrored = entries;
    if (snapshot)
      state.lastSnapshot = Date.now();
    await this.storage.save(state);
  }
}

// src/storage.ts
function renamed(state, renames) {
  for (const rename of renames) {
    for (const install of state.installs) {
      if (install.type === rename.type && install.localId === rename.oldId) {
        for (const pending of state.pendingUpdates || []) {
          if (pending.workId === install.workId && pending.localId === rename.oldId)
            pending.localId = rename.newId;
        }
        install.localId = rename.newId;
      }
    }
  }
  return state;
}

class BrowserStorage {
  owner = Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16)).join("-");
  db;
  constructor(user) {
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open(`illarin:${user}`, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("connection");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Your browser could not open Illarin storage."));
    });
  }
  async transaction(action) {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("connection", "readwrite");
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () => reject(new Error("Your browser could not save the Illarin connection."));
      action(transaction.objectStore("connection"), (value) => {
        result = value;
      });
    });
  }
  read() {
    return this.transaction((store, done) => {
      const request = store.get("state");
      request.onsuccess = () => done(request.result || { base: "https://illarin.com", installs: [], receipts: [], acknowledged: [], mirrored: [], lastSnapshot: 0 });
    });
  }
  async rename(type, oldId, newId) {
    await this.transaction((store, done) => {
      const request = store.get("renames");
      request.onsuccess = () => {
        store.put([...request.result || [], { type, oldId, newId }], "renames");
        done();
      };
    });
  }
  async renew() {
    await this.transaction((store, done) => {
      const request = store.get("lock");
      request.onsuccess = () => {
        if (request.result?.owner !== this.owner) {
          store.transaction.abort();
          return;
        }
        store.put({ owner: this.owner, expires: Date.now() + 60000 }, "lock");
        done();
      };
    });
  }
  async save(state) {
    await this.transaction((store, done) => {
      const request = store.get("lock");
      request.onsuccess = () => {
        if (request.result?.owner !== this.owner || request.result.expires <= Date.now()) {
          store.transaction.abort();
          return;
        }
        const pending = store.get("renames");
        pending.onsuccess = () => {
          store.put(renamed(state, pending.result || []), "state");
          store.delete("renames");
          done();
        };
      };
    });
  }
  async exclusive(action) {
    const acquired = await this.transaction((store, done) => {
      const request = store.get("lock");
      request.onsuccess = () => {
        if (request.result?.expires > Date.now()) {
          done(false);
          return;
        }
        store.put({ owner: this.owner, expires: Date.now() + 60000 }, "lock");
        done(true);
      };
    });
    if (!acquired)
      return false;
    const controller = new AbortController;
    const heartbeat = setInterval(() => {
      this.renew().catch(() => controller.abort());
    }, 1e4);
    try {
      await action(controller.signal);
    } finally {
      clearInterval(heartbeat);
      controller.abort();
      await this.transaction((store, done) => {
        const request = store.get("lock");
        request.onsuccess = () => {
          if (request.result?.owner === this.owner)
            store.delete("lock");
          done();
        };
      });
    }
    return true;
  }
}

// src/tavern.ts
class TavernAdapter {
  context;
  version;
  request;
  constructor(context, version, request = (input, options) => fetch(input, options)) {
    this.context = context;
    this.version = version;
    this.request = request;
  }
  async post(path, body, signal) {
    const multipart = body instanceof FormData;
    const response = await this.request(path, {
      method: "POST",
      headers: this.context.getRequestHeaders({ omitContentType: multipart }),
      body: multipart ? body : JSON.stringify(body),
      cache: "no-store",
      signal
    });
    if (!response.ok)
      throw new Error("SillyTavern could not save the file. Check its connection and try again.");
    return response;
  }
  async installed(installs, signal) {
    if (!installs.length)
      return [];
    const characters = installs.some((item) => item.type === "character") ? await (await this.post("/api/characters/all", {}, signal)).json() : [];
    const settings = installs.some((item) => item.type !== "character") ? await (await this.post("/api/settings/get", {}, signal)).json() : { world_names: [], openai_setting_names: [], themes: [] };
    if (!Array.isArray(characters) || !Array.isArray(settings.world_names) || !Array.isArray(settings.openai_setting_names) || !Array.isArray(settings.themes))
      throw new Error("SillyTavern could not read your library. Nothing was removed from Illarin.");
    return installs.filter((item) => {
      switch (item.type) {
        case "character":
          return characters.some((character) => character.avatar === item.localId);
        case "lorebook":
          return settings.world_names.includes(item.localId);
        case "preset":
          return settings.openai_setting_names.includes(item.localId);
        case "theme":
          return settings.themes.some((theme) => theme.name === item.localId);
        default:
          return false;
      }
    });
  }
  async install(send, file) {
    const types = { charx: "character", chara_card_v3: "character", chara_card_v2: "character", lorebook_sillytavern: "lorebook", preset_sillytavern: "preset", theme_sillytavern: "theme" };
    if (types[send.format] !== send.type || !/^[0-9a-f-]{36}$/.test(send.id))
      throw new Error("SillyTavern cannot import this file.");
    const stem = `Illarin-${send.id}`;
    const name = `${send.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").trim().slice(0, 80) || send.type} (${stem})`;
    const installed = {
      workId: send.workId,
      versionNumber: send.versionNumber,
      type: send.type,
      localId: send.type === "character" ? `${stem}.png` : name,
      name: send.name,
      ...send.type === "preset" ? { apiId: "openai" } : {}
    };
    if ((await this.installed([installed])).length)
      return installed;
    await this.write(send, file, installed.localId);
    if (send.type === "character")
      await this.context.getCharacters();
    if (!(await this.installed([installed])).length)
      throw new Error("SillyTavern did not keep the imported file. Try again.");
    installed.fingerprint = await this.fingerprint(await this.read(installed), installed);
    return installed;
  }
  async read(install, signal) {
    if (install.type === "character")
      return await (await this.post("/api/characters/export", { avatar_url: install.localId, format: "png" }, signal)).blob();
    let data;
    if (install.type === "lorebook")
      data = await (await this.post("/api/worldinfo/get", { name: install.localId }, signal)).json();
    else {
      const settings = await (await this.post("/api/settings/get", {}, signal)).json();
      data = install.type === "theme" ? settings.themes.find((item) => item.name === install.localId) : JSON.parse(settings.openai_settings?.[settings.openai_setting_names.indexOf(install.localId)] || "null");
    }
    if (!data || typeof data !== "object")
      throw new Error("SillyTavern could not read the installed copy. Nothing was replaced.");
    return new Blob([JSON.stringify(data, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)]);
  }
  async fingerprint(file, install) {
    if (install.type === "character") {
      const png = new Uint8Array(await file.arrayBuffer());
      const parts = [];
      let metadata = "", v3 = "";
      if (png[0] !== 137 || png[1] !== 80)
        throw new Error("SillyTavern could not read the portrait. Nothing was replaced.");
      parts.push(png.slice(0, 8));
      for (let offset = 8;offset < png.length; ) {
        if (offset + 12 > png.length)
          throw new Error("SillyTavern returned an incomplete portrait.");
        const size = new DataView(png.buffer).getUint32(offset) + 12;
        if (size > png.length - offset)
          throw new Error("SillyTavern returned an incomplete portrait.");
        const type = new TextDecoder().decode(png.slice(offset + 4, offset + 8));
        if (!["tEXt", "zTXt", "iTXt"].includes(type))
          parts.push(png.slice(offset, offset + size));
        if (type === "tEXt") {
          const text = new TextDecoder().decode(png.slice(offset + 8, offset + size - 4));
          const separator = text.indexOf("\x00");
          const keyword = text.slice(0, separator).toLowerCase();
          if (keyword === "chara")
            metadata = text.slice(separator + 1);
          if (keyword === "ccv3")
            v3 = text.slice(separator + 1);
        }
        offset += size;
      }
      const card = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(v3 || metadata), (char) => char.charCodeAt(0))));
      if (!card.data || typeof card.data !== "object")
        throw new Error("SillyTavern could not read the character. Nothing was replaced.");
      const extensions = { ...card.data.extensions };
      delete extensions.fav;
      extensions.talkativeness = String(extensions.talkativeness ?? 0.5);
      extensions.world ??= "";
      extensions.depth_prompt = { prompt: "", depth: 4, role: "system", ...extensions.depth_prompt };
      parts.push(JSON.stringify({ ...card.data, tags: card.data.tags ?? [], extensions }, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value));
      file = new Blob(parts);
    }
    const bytes = await file.arrayBuffer();
    if (crypto.subtle)
      return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return btoa(Array.from(new Uint8Array(bytes), (byte) => String.fromCharCode(byte)).join(""));
  }
  async recover(installs, signal) {
    const pending = installs.filter((install) => install.recovery);
    const present = await this.installed(pending, signal);
    for (const install of pending) {
      if (present.includes(install))
        await this.post("/api/characters/merge-attributes", { ...install.recovery, avatar: install.localId }, signal);
      delete install.recovery;
    }
  }
  async update(send, file, install, remember, signal) {
    if (send.workId !== install.workId || send.type !== install.type || send.versionNumber <= install.versionNumber)
      throw new Error("This file is not a newer version of your copy.");
    const old = await this.read(install, signal);
    const fingerprint = await this.fingerprint(old, install);
    const edited = !install.fingerprint || fingerprint !== install.fingerprint;
    if (edited && !await this.context.Popup.show.confirm("Replace your edited copy?", "SillyTavern keeps your copy under a name containing ‘edited copy’ before replacing it. Your chats stay with the updated character."))
      return null;
    signal?.throwIfAborted();
    const suffix = Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16)).join("-");
    const label = `${install.type === "character" ? send.name : install.localId} (${edited ? "edited copy" : "previous copy"} ${suffix})`;
    if (install.type === "character") {
      const previous = await (await this.post("/api/characters/get", { avatar_url: install.localId }, signal)).json();
      if (typeof previous.chat !== "string")
        throw new Error("SillyTavern could not read your current chat. Nothing was replaced.");
      const backupId = `Illarin-backup-${suffix}.png`;
      await this.write({ ...send, format: "chara_card_v3" }, old, backupId, false, signal);
      await this.post("/api/characters/rename", { avatar_url: backupId, new_name: label }, signal);
      if (fingerprint !== await this.fingerprint(await this.read(install, signal), install))
        throw new Error("Your copy changed while the update was open. Try again.");
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
      if (fingerprint !== await this.fingerprint(await this.read(install, signal), install))
        throw new Error("Your copy changed while the update was open. Try again.");
      signal?.throwIfAborted();
      await this.write(send, file, install.localId, false, signal);
    }
    delete install.recovery;
    return { ...install, versionNumber: send.versionNumber, fingerprint: await this.fingerprint(await this.read(install, signal), install) };
  }
  async write(send, file, localId, backup = false, signal) {
    signal?.throwIfAborted();
    const stem = localId.replace(/\.png$/, "");
    const name = localId;
    if (send.type === "character") {
      const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
      const format = send.format === "charx" ? "charx" : signature[0] === 137 && signature[1] === 80 ? "png" : "json";
      const body = new FormData;
      body.append("avatar", file, `${stem}.${format}`);
      body.append("file_type", format);
      body.append("preserved_name", stem);
      const result = await (await this.post("/api/characters/import", body, signal)).json();
      if (result.error || result.file_name !== stem)
        throw new Error("SillyTavern could not import the character.");
    } else {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("SillyTavern could not read the file.");
      signal?.throwIfAborted();
      switch (send.type) {
        case "lorebook":
          if (!data.entries || typeof data.entries !== "object")
            throw new Error("This lorebook has no entries.");
          await this.post("/api/worldinfo/edit", { name, data }, signal);
          await this.context.updateWorldInfoList();
          break;
        case "preset":
          if (!Array.isArray(data.prompts) || !Array.isArray(data.prompt_order))
            throw new Error("This preset has no prompts.");
          await this.context.getPresetManager("openai").savePreset(name, data, { skipUpdate: backup });
          break;
        case "theme":
          await this.post("/api/themes/save", { ...data, name }, signal);
          break;
      }
    }
  }
}

// src/index.ts
async function start() {
  const context = SillyTavern.getContext();
  const [userResponse, versionResponse] = await Promise.all([
    fetch("/api/users/me", { headers: context.getRequestHeaders(), cache: "no-store" }),
    fetch("/version", { cache: "no-store" })
  ]);
  if (!userResponse.ok || !versionResponse.ok)
    throw new Error("SillyTavern could not read your account. Reload the page.");
  const user = await userResponse.json();
  const version = await versionResponse.json();
  if (typeof user.handle !== "string" || typeof version.pkgVersion !== "string")
    throw new Error("SillyTavern could not read your account. Reload the page.");
  const storage = new BrowserStorage(user.handle);
  const request = async (input, options) => {
    await storage.renew();
    return fetch(input, { ...options, signal: AbortSignal.any([options?.signal || new AbortController().signal, AbortSignal.timeout(45000)]) });
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
  document.querySelector("#extensions_settings2").append(panel);
  const element = (id) => panel.querySelector(`#illarin-${id}`);
  const address = element("address");
  const connect = element("connect");
  const disconnect = element("disconnect");
  const check = element("check");
  const status = element("status");
  let operation;
  let controller;
  let stopped = false;
  let failures = 0;
  let timer;
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
    element("library").textContent = state.credentials?.connectedApp.permissions.includes("library:sync") ? `${state.mirrored.length} installed ${state.mirrored.length === 1 ? "work" : "works"} shared with Illarin` : "Your library is not shared.";
    element("updates").replaceChildren();
    for (const update of state.updates || []) {
      for (const copy of state.installs.filter((item) => item.workId === update.workId && item.versionNumber < update.versionNumber)) {
        const row = document.createElement("div");
        const name = document.createElement("p");
        name.textContent = `${copy.name || copy.localId} — Update available`;
        const notes = document.createElement("p");
        notes.textContent = update.notes;
        notes.className = "illarin-version-notes";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "menu_button";
        const pending = state.pendingUpdates?.some((item) => item.workId === copy.workId);
        button.textContent = pending ? "Retry update" : `Update ${copy.type}`;
        button.disabled = updateRequested || !!operation && !backgroundRunning || !state.credentials?.connectedApp.permissions.includes("work:receive");
        button.addEventListener("click", () => {
          (async () => {
            if (updateRequested)
              return;
            updateRequested = true;
            await render();
            await operation;
            try {
              await run(async (signal) => {
                await client.update(copy.workId, copy.localId, signal);
                await client.cycle(signal, true);
                status.textContent = "Update check finished.";
              });
            } finally {
              updateRequested = false;
              await render();
            }
          })();
        });
        row.append(name, notes, button);
        element("updates").append(row);
      }
    }
  }
  const pause = (ms, signal) => new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Cancelled", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted)
      abort();
  });
  async function run(task) {
    if (operation)
      return;
    controller = new AbortController;
    const signal = controller.signal;
    operation = (async () => {
      try {
        const ran = await storage.exclusive((lockSignal) => task(AbortSignal.any([signal, lockSignal])));
        if (!ran)
          status.textContent = "Illarin is active in another SillyTavern tab.";
        failures = 0;
      } catch (error) {
        if (signal.aborted)
          return;
        failures++;
        if (error instanceof RequestError && error.status === 403)
          stopped = true;
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
    if (backgroundRunning) {
      checkRequested = true;
      return;
    }
    backgroundRunning = true;
    const force = checkRequested;
    checkRequested = false;
    clearTimeout(timer);
    delay = 1000;
    try {
      const state = await storage.read();
      if (!stopped && state.credentials && !operation) {
        await run(async (signal) => {
          await client.cycle(signal, force);
          const latest = await storage.read();
          const permissions = latest.credentials?.connectedApp.permissions || [];
          status.textContent = permissions.includes("work:receive") ? "Connected. Waiting for works from Illarin." : "Connected. Receiving works is off in your Illarin account settings.";
        });
      }
    } finally {
      backgroundRunning = false;
      timer = setTimeout(() => {
        background();
      }, checkRequested ? 0 : Math.max(delay, failures ? Math.min(60000, 2000 * 2 ** Math.min(failures, 5)) * (1 + Math.random()) : 5000));
    }
  }
  connect.addEventListener("click", () => {
    if (operation) {
      controller?.abort();
      return;
    }
    const base = address.value;
    run(async (signal) => {
      const normalized = baseURL(base);
      const pending = await client.begin(normalized, signal);
      const verification = new URL(pending.verificationUrl);
      if (verification.origin !== new URL(normalized).origin)
        throw new Error("Illarin returned an unexpected sign-in address.");
      element("code").textContent = pending.userCode;
      element("verify").href = verification.href;
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
            if (result.status !== "pending")
              throw new Error("Illarin did not finish connecting. Try again.");
          } catch (error) {
            if (error instanceof RequestError) {
              if (error.status !== 429)
                throw error;
              interval = Math.max(interval + 1000, error.retryAfter * 1000);
            } else if (error instanceof TypeError || error instanceof DOMException && error.name === "TimeoutError") {
              networkFailures++;
              interval = Math.max(interval, Math.min(60000, 2000 * 2 ** Math.min(networkFailures, 5)));
            } else
              throw error;
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
    (async () => {
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
  check.addEventListener("click", () => {
    stopped = false;
    checkRequested = true;
    background();
  });
  for (const [event, renamed] of [["CHARACTER_RENAMED", true], ["PRESET_RENAMED", false]]) {
    context.eventSource.on(context.eventTypes[event], (...args) => {
      if (renamed)
        storage.rename("character", args[0], args[1]);
      else if (args[0].apiId === "openai")
        storage.rename("preset", args[0].oldName, args[0].newName);
    });
  }
  await render();
  background();
}
var context = SillyTavern.getContext();
context.eventSource.on(context.eventTypes.APP_READY, () => {
  setTimeout(() => {
    start().catch(() => {
      const notice = document.createElement("p");
      notice.textContent = "Illarin could not start. Reload SillyTavern and try again.";
      document.querySelector("#extensions_settings2")?.append(notice);
    });
  }, 0);
});
