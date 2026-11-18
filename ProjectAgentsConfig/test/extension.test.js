const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");

async function harness(repositories) {
  const commands = new Map();
  const messages = [];
  const updates = [];
  const copies = [];
  const opened = [];
  const removedCaches = [];
  const inputs = [];
  const notifications = [];
  const panels = [];
  let provider;
  let onConfigurationChange;
  const disposable = { dispose() {} };
  const configuration = {
    get: () => repositories,
    inspect: () => ({ workspaceValue: repositories }),
    update: async (key, value, target) => {
      updates.push({ key, value, target });
      repositories = value;
    },
  };
  const template = {
    name: "API", description: "API starter", scope: "Backend", path: ".",
    features: ["Tests"], source: "cached-source", ref: "v1", commit: "a".repeat(40),
  };
  const vscode = {
    ConfigurationTarget: { Workspace: 2, WorkspaceFolder: 3, Global: 1 },
    ViewColumn: { Active: -1 },
    Uri: {
      joinPath: (uri, ...parts) => path.join(uri, ...parts),
      file: (file) => file,
    },
    workspace: {
      getConfiguration: () => configuration,
      onDidChangeConfiguration: (handler) => {
        onConfigurationChange = handler;
        return disposable;
      },
    },
    commands: {
      registerCommand: (name, handler) => {
        commands.set(name, handler);
        return disposable;
      },
      executeCommand: async (...args) => opened.push(args),
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createWebviewPanel: () => {
        const panel = {
          messages: [],
          revealCount: 0,
          reveal() { this.revealCount++; },
          onDidDispose(handler) {
            this.dispose = handler;
            return disposable;
          },
        };
        panel.webview = makeWebview(panel.messages);
        panels.push(panel);
        return panel;
      },
      registerWebviewViewProvider: (_, instance) => {
        provider = instance;
        return disposable;
      },
      showInputBox: async () => inputs.shift(),
      showQuickPick: async (items) => items[0],
      showOpenDialog: async () => [{ scheme: "file", fsPath: "C:\\projects" }],
      showInformationMessage: async (_, action) => action,
      showWarningMessage: async (message) => notifications.push(message),
      showErrorMessage: async (message) => notifications.push(message),
    },
  };
  const manager = {
    fetchRepository: async (repository) => {
      if (repository.url === "broken") {
        throw new Error("Missing manifest");
      }
      return { cache: `cache-${repository.url}`, templates: [{ ...template, repository: repository.url }] };
    },
    createProject: async (...args) => {
      copies.push(args);
      return "C:\\projects\\new-project";
    },
    validateProjectName: require("../templateManager").validateProjectName,
  };
  const sandbox = {
    module: { exports: {} },
    require: (name) => {
      if (name === "vscode") return vscode;
      if (name === "./templateManager") return manager;
      if (name === "node:fs/promises") return { rm: async (cache) => removedCaches.push(cache) };
      return require(name);
    },
  };
  const code = await fs.readFile(path.join(__dirname, "..", "extension.js"), "utf8");
  vm.runInNewContext(code, sandbox, { filename: "extension.js" });
  sandbox.module.exports.activate({ extensionUri: __dirname, subscriptions: [] });
  function makeWebview(targetMessages) {
    let onMessage;
    return {
      cspSource: "vscode-webview:",
      asWebviewUri: (uri) => uri,
      postMessage: async (message) => targetMessages.push(message),
      onDidReceiveMessage: (handler) => {
        onMessage = handler;
        return disposable;
      },
      send: (message) => onMessage(message),
    };
  }
  const webview = makeWebview(messages);
  provider.resolveWebviewView({ webview });
  return {
    provider, commands, messages, updates, copies, opened, removedCaches, inputs, notifications,
    webview, panels, send: (message) => webview.send(message),
    changed: () => onConfigurationChange({ affectsConfiguration: () => true }),
  };
}

test("panel loads healthy repositories despite failures and creates the selected project", async () => {
  const app = await harness([{ url: "good", ref: "v1" }, { url: "broken" }]);
  await app.send({ command: "ready" });
  const state = app.messages.at(-1);
  assert.equal(state.busy, false);
  assert.equal(state.templates.length, 1);
  assert.equal(state.errors[0], "broken: Missing manifest");
  assert.equal(state.repositories.length, 2);
  assert.equal(state.repositories[0].url, "good");
  assert.equal(state.repositories[0].ref, "v1");
  assert.equal(state.repositories[1].url, "broken");
  assert.equal("source" in state.templates[0], false);
  assert.match(app.webview.html, /Content-Security-Policy/);
  app.inputs.push("new-project");
  await app.send({ command: "create", id: state.templates[0].id });
  assert.equal(app.copies.length, 1);
  assert.equal(app.copies[0][0].repository, "good");
  assert.equal(app.copies[0][1], "C:\\projects");
  assert.equal(app.copies[0][2], "new-project");
  assert.equal(app.opened[0][0], "vscode.openFolder");
  assert.equal(app.opened[0][1], "C:\\projects\\new-project");
  await app.send({ command: "refresh" });
  assert.equal(app.removedCaches[0], "cache-good");
  await app.send({ command: "create", id: state.templates[0].id });
  assert.equal(app.copies.length, 1);
  assert.match(app.notifications.at(-1), /Select an available template/);
  app.provider.dispose();
});

test("inline removal targets the repository revision and rejects stale entries", async () => {
  const app = await harness([{ url: "same", ref: "v1" }, { url: "same", ref: "v2" }]);
  await app.send({ command: "settings" });
  const settings = app.panels[0].webview;
  await settings.send({ command: "ready" });
  await settings.send({ command: "remove", repository: { url: "same", ref: "v2" } });
  assert.equal(app.updates.length, 1);
  assert.equal(app.updates[0].value.length, 1);
  assert.equal(app.updates[0].value[0].ref, "v1");
  assert.equal(app.panels[0].messages.at(-1).repositories.length, 1);
  assert.equal(app.messages.at(-1).repositories.length, 1);
  await settings.send({ command: "remove", repository: { url: "missing" } });
  assert.equal(app.updates.length, 1);
  assert.match(app.notifications.at(-1), /no longer configured/);
  app.provider.dispose();
});

test("repository controls persist revisions, allow the default branch, and respect cancellation", async () => {
  const app = await harness([{ url: "original" }]);
  app.inputs.push("https://example.invalid/templates.git", "v2");
  await app.commands.get("projectTemplates.addRepository")();
  assert.equal(app.updates[0].key, "repositories");
  assert.equal(app.updates[0].target, 2);
  assert.equal(app.updates[0].value[1].ref, "v2");
  app.inputs.push("https://example.invalid/default.git", "");
  await app.commands.get("projectTemplates.addRepository")();
  assert.equal("ref" in app.updates[1].value[2], false);
  app.inputs.push(undefined);
  await app.commands.get("projectTemplates.addRepository")();
  assert.equal(app.updates.length, 2);
  await app.commands.get("projectTemplates.removeRepository")();
  assert.equal(app.updates[2].value.length, 2);
  app.provider.dispose();
});

test("the gear opens reusable dedicated settings and repository additions update both views", async () => {
  const app = await harness([{ url: "original" }]);
  assert.match(app.webview.html, /id="settings".*aria-label="Repository settings"/);
  assert.doesNotMatch(app.webview.html, /id="add"/);
  await app.send({ command: "settings" });
  assert.equal(app.panels.length, 1);
  const panel = app.panels[0];
  assert.match(panel.webview.html, /data-page="settings"/);
  assert.match(panel.webview.html, /id="add"/);
  assert.doesNotMatch(panel.webview.html, /id="create"/);
  await panel.webview.send({ command: "ready" });
  assert.equal(panel.messages.at(-1).repositories[0].url, "original");
  assert.equal(panel.messages.at(-1).templates.length, 0);
  app.inputs.push("https://example.invalid/templates.git", "v2");
  await panel.webview.send({ command: "add" });
  assert.equal(app.updates[0].value[1].ref, "v2");
  assert.equal(panel.messages.at(-1).repositories.length, 2);
  assert.equal(app.messages.at(-1).repositories.length, 2);
  await app.commands.get("projectTemplates.openSettings")();
  assert.equal(app.panels.length, 1);
  assert.equal(panel.revealCount, 1);
  panel.dispose();
  await app.send({ command: "settings" });
  assert.equal(app.panels.length, 2);
  app.provider.dispose();
});
