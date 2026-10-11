# Illarin for SillyTavern

Connect SillyTavern to your Illarin account, then send works from Illarin straight into SillyTavern.

Requires SillyTavern 1.19.0 or newer. No server plugin or SillyTavern configuration change is needed.

## Install

In SillyTavern, open **Extensions**, choose **Install extension**, and enter this repository's git URL. Reload SillyTavern when installation finishes. The built `index.js` is included, so users need no build tools.

For local development, put this folder in `public/scripts/extensions/third-party/SillyTavern-Illarin`, then reload SillyTavern.

## Connect

1. Open **Extensions → Illarin**.
2. Enter your Illarin address and press **Connect**.
3. Open Illarin through the link shown, type the matching code, and choose your permissions. Both start unchecked.

Receiving works and sharing your library are separate permissions. You can change them in your Illarin account settings. The extension uses the manual device flow because a browser extension cannot bind a loopback listener.

HTTPS is required for Illarin, except for a local site such as `http://localhost:8000`. Your SillyTavern can run on a different origin. The extension sends no Illarin cookies.

## Send works

On an Illarin work page, send the work to **SillyTavern / Illarin extension**. Keep a SillyTavern tab open to receive it.

Characters, lorebooks, chat completion presets and themes are supported. Characters prefer CharX, which carries embedded pictures. The extension also reads CCv2 and CCv3 character files. It does not declare support for separate picture downloads, packs or installing other extensions.

Sends create separate copies. Existing characters, chats and edited copies stay intact. A repeated delivery of the same send imports once. Each received copy is recorded against its Illarin work and version outside the creator's file. Themes are saved without applying them; reload SillyTavern to see a new theme in its list.

## Update installed works

With library sharing on, **Extensions → Illarin** shows **Update available** beside an outdated copy, with the creator's version notes. Press **Update character**, **Update lorebook**, **Update preset** or **Update theme** to replace that copy. Receiving works must also be on. Checks run about once a minute while SillyTavern is open; **Check now** checks immediately.

If you edited the copy, SillyTavern asks before replacing it and keeps it under a name containing **edited copy**. Copies received before this extension recorded their original content also ask. Cancel leaves your copy unchanged. An unedited copy updates without a question and is kept under a name containing **previous copy**. Character updates keep the same identifier and current chat, so existing chats and group references survive. Updates do not apply themes. Updating a preset selects the updated preset; reload SillyTavern to see a saved old preset in the list.

With library sharing on, the extension reports installed copies and removes deleted copies from the mirror. Only Illarin work IDs and version numbers leave SillyTavern. Local files, prompts and chats are not sent. Reports are incremental, with a full snapshot each hour. Illarin accepts at most 2,000 works per report. Saved old copies stay local and are not reported as separate installations.

One tab handles requests at a time. Other tabs can take over when it closes. Credentials and import records belong to the current SillyTavern user in this browser. Another browser needs its own connection.

## Disconnect

**Disconnect** removes credentials from this browser. Revoke the matching connection in your Illarin account settings to end its access on the server. Imported works stay in SillyTavern.

Credentials live in IndexedDB, separate from exported SillyTavern settings. Any script running on the same SillyTavern origin can read them. An interrupted credential rotation stops the connection rather than reusing a potentially spent refresh token; connect again if prompted.

## Develop

Install [Bun](https://bun.sh/), then run:

```sh
make install
make check
```

`make check` typechecks the source, runs tests and rebuilds `index.js`. Use `make test TEST=tests/protocol.test.ts` for a focused check. Commit the rebuilt `index.js` with source changes.

The tests use synthetic credentials and works. Browser verification needs a local Illarin site and a fresh SillyTavern installation.

Licensed under AGPL-3.0. See [LICENSE](LICENSE).
