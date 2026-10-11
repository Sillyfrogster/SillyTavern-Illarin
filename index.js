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
  async cycle(signal) {
    const state = await this.storage.read();
    if (!state.credentials)
      return;
    const standing = await this.authorized(state, "/api/v1/connected-apps/me", undefined, signal);
    const app = await standing.json();
    state.credentials.connectedApp.permissions = app.permissions;
    await this.storage.save(state);
    const permissions = app.permissions;
    if (permissions.includes("library:sync"))
      await this.sync(state, signal);
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
          const install = await this.tavern.install(send, await file.blob());
          state.installs.push(install);
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
  async sync(state, signal) {
    const installed = await this.tavern.installed(state.installs);
    const versions = new Map;
    for (const item of installed)
      versions.set(item.workId, Math.max(item.versionNumber, versions.get(item.workId) || 0));
    const entries = [...versions].map(([workId, versionNumber]) => ({ workId, versionNumber }));
    const snapshot = Date.now() - state.lastSnapshot > 3600000;
    const changed = entries.filter((item) => !state.mirrored.some((old) => old.workId === item.workId && old.versionNumber === item.versionNumber));
    const removed = state.mirrored.filter((old) => !versions.has(old.workId)).map((item) => item.workId);
    if (!snapshot && !changed.length && !removed.length)
      return;
    if (entries.length > 2000 || removed.length > 2000)
      throw new Error("Your Illarin library exceeds the report limit.");
    await this.authorized(state, "/api/v1/library/sync", {
      snapshot,
      appVersion: this.tavern.version,
      entries: snapshot ? entries : changed,
      ...snapshot ? {} : { removed }
    }, signal);
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
      if (install.type === rename.type && install.localId === rename.oldId)
        install.localId = rename.newId;
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
  async post(path, body) {
    const multipart = body instanceof FormData;
    const response = await this.request(path, {
      method: "POST",
      headers: this.context.getRequestHeaders({ omitContentType: multipart }),
      body: multipart ? body : JSON.stringify(body),
      cache: "no-store"
    });
    if (!response.ok)
      throw new Error("SillyTavern could not save the file. Check its connection and try again.");
    return response;
  }
  async installed(installs) {
    if (!installs.length)
      return [];
    const characters = installs.some((item) => item.type === "character") ? await (await this.post("/api/characters/all", {})).json() : [];
    const settings = installs.some((item) => item.type !== "character") ? await (await this.post("/api/settings/get", {})).json() : { world_names: [], openai_setting_names: [], themes: [] };
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
      ...send.type === "preset" ? { apiId: "openai" } : {}
    };
    if ((await this.installed([installed])).length)
      return installed;
    if (send.type === "character") {
      const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
      const format = send.format === "charx" ? "charx" : signature[0] === 137 && signature[1] === 80 ? "png" : "json";
      const body = new FormData;
      body.append("avatar", file, `${stem}.${format}`);
      body.append("file_type", format);
      body.append("preserved_name", stem);
      const result = await (await this.post("/api/characters/import", body)).json();
      if (result.error || result.file_name !== stem)
        throw new Error("SillyTavern could not import the character.");
      await this.context.getCharacters();
    } else {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("SillyTavern could not read the file.");
      switch (send.type) {
        case "lorebook":
          if (!data.entries || typeof data.entries !== "object")
            throw new Error("This lorebook has no entries.");
          await this.post("/api/worldinfo/edit", { name, data });
          await this.context.updateWorldInfoList();
          break;
        case "preset":
          if (!Array.isArray(data.prompts) || !Array.isArray(data.prompt_order))
            throw new Error("This preset has no prompts.");
          await this.context.getPresetManager("openai").savePreset(name, data);
          break;
        case "theme":
          await this.post("/api/themes/save", { ...data, name });
          break;
      }
    }
    if (!(await this.installed([installed])).length)
      throw new Error("SillyTavern did not keep the imported file. Try again.");
    return installed;
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
  const tavern = new TavernAdapter(context, version.pkgVersion);
  const client = new Client(storage, tavern, async (input, options) => {
    await storage.renew();
    return fetch(input, { ...options, signal: AbortSignal.any([options?.signal || new AbortController().signal, AbortSignal.timeout(45000)]) });
  });
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
  async function render() {
    const state = await storage.read();
    address.value = state.base;
    address.disabled = !!state.credentials || !!operation;
    disconnect.hidden = !state.credentials;
    check.hidden = !state.credentials;
    connect.hidden = !!state.credentials;
    element("library").textContent = state.credentials?.connectedApp.permissions.includes("library:sync") ? `${state.mirrored.length} installed ${state.mirrored.length === 1 ? "work" : "works"} shared with Illarin` : "Your library is not shared.";
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
    await operation;
  }
  let delay = 1000;
  async function background() {
    if (backgroundRunning) {
      checkRequested = true;
      return;
    }
    backgroundRunning = true;
    clearTimeout(timer);
    delay = 1000;
    try {
      const state = await storage.read();
      if (!stopped && state.credentials && !operation) {
        await run(async (signal) => {
          await client.cycle(signal);
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
      checkRequested = false;
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
