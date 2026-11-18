const vscode = require("vscode");
const fs = require("node:fs/promises");
const { randomBytes } = require("node:crypto");
const { fetchRepository, createProject, validateProjectName } = require("./templateManager");

function activate(context) {
  const output = vscode.window.createOutputChannel("Project Templates");
  const provider = new TemplateProvider(context, output);
  context.subscriptions.push(
    output,
    provider,
    vscode.window.registerWebviewViewProvider("projectTemplates.view", provider),
    vscode.commands.registerCommand("projectTemplates.addRepository", () => provider.addRepository()),
    vscode.commands.registerCommand("projectTemplates.removeRepository", () => provider.removeRepository()),
    vscode.commands.registerCommand("projectTemplates.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("projectTemplates.openSettings", () => provider.openSettings()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("projectTemplates.repositories")) {
        void provider.refresh();
      }
    }),
  );
}

class TemplateProvider {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.templates = [];
    this.repositoryEntries = [];
    this.caches = [];
    this.errors = [];
    this.busy = false;
    this.disposed = false;
    this.refreshPending = false;
  }

  readRepositories() {
    const repositories = vscode.workspace.getConfiguration("projectTemplates").get("repositories", []);
    if (!Array.isArray(repositories)) {
      throw new Error("projectTemplates.repositories must be an array.");
    }
    this.repositoryEntries = repositories.map((repository) => ({
      url: repository?.url,
      ref: repository?.ref,
    }));
    return repositories;
  }

  resolveWebviewView(view) {
    this.view = view;
    this.configureWebview(view.webview, "templates");
  }

  openSettings() {
    if (this.settingsPanel) {
      this.settingsPanel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "projectTemplates.settings",
      "Project Template Manager Settings",
      vscode.ViewColumn.Active,
      { enableScripts: true },
    );
    this.settingsPanel = panel;
    this.context.subscriptions.push(
      panel,
      panel.onDidDispose(() => { this.settingsPanel = undefined; }),
    );
    this.configureWebview(panel.webview, "settings");
  }

  configureWebview(webview, page) {
    const isSettings = page === "settings";
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    const nonce = randomBytes(16).toString("hex");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "templates.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "templates.css"));
    const content = isSettings ? `
        <header class="panel-header">
          <h1>Repository settings</h1>
          <button id="add" type="button">Add repository</button>
        </header>
        <p>Add Git repository URLs or local paths with an optional tag or commit hash.
          Leave the revision blank to use the default branch.</p>
        <h2 id="repository-summary">Repositories (0)</h2>
        <ul id="repository-list"></ul>
        <p id="repository-empty">No repositories configured. Select Add repository to get started.</p>
      ` : `
        <header class="panel-header">
          <h2>Project Templates</h2>
          <button id="settings" class="icon-button" type="button" aria-label="Repository settings" title="Repository settings">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 1.5h3l.4 1.8 1.4.8 1.8-.5 1.5 2.6-1.3 1.3v1l1.3 1.3-1.5 2.6-1.8-.5-1.4.8-.4 1.8h-3l-.4-1.8-1.4-.8-1.8.5-1.5-2.6 1.3-1.3v-1L1.4 6.2l1.5-2.6 1.8.5 1.4-.8z"/><circle cx="8" cy="8" r="2.2"/></svg>
          </button>
        </header>
        <details id="repositories">
          <summary id="repository-summary">Repositories (0)</summary>
          <ul id="repository-list"></ul>
          <p id="repository-empty">No repositories configured. Open settings using the gear button to add one.</p>
        </details>
        <div class="template-picker">
          <label for="templates">Template</label>
          <div class="template-row">
            <select id="templates" disabled></select>
            <button id="refresh" class="icon-button" type="button" aria-label="Refresh templates" title="Refresh templates">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 6A5 5 0 0 0 4 4L2 6m0-4v4h4M3 10a5 5 0 0 0 9 2l2-2m0 4v-4h-4"/></svg>
            </button>
          </div>
        </div>
        <button id="create" type="button" disabled>Create project</button>
        <details id="details" hidden>
          <summary>Template details</summary>
          <h3 id="name"></h3><p id="description"></p>
          <dl><dt>Scope / application</dt><dd id="scope"></dd>
          <dt>Repository</dt><dd id="repository"></dd>
          <dt>Revision</dt><dd id="ref"></dd>
          <dt>Path</dt><dd id="path"></dd></dl>
          <h4>Features</h4><ul id="features"></ul>
        </details>`;
    webview.html = `<!DOCTYPE html>
      <html lang="en"><head><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${style}">
      <title>${isSettings ? "Repository Settings" : "Project Templates"}</title></head>
      <body data-page="${page}" class="${isSettings ? "settings-page" : ""}">
        ${content}
        <p id="status" role="status" aria-live="polite"></p>
        <ul id="errors" role="alert" hidden></ul>
        <script nonce="${nonce}" src="${script}"></script>
      </body></html>`;
    this.context.subscriptions.push(webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message?.command) {
          case "ready":
            if (isSettings) {
              this.readRepositories();
              this.publish();
            } else {
              await this.refresh();
            }
            break;
          case "refresh": await this.refresh(); break;
          case "add": await this.addRepository(); break;
          case "remove": await this.removeRepository(message.repository); break;
          case "settings": this.openSettings(); break;
          case "create": await this.create(message.id); break;
        }
      } catch (error) {
        this.report(error);
      }
    }));
  }

  report(error) {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(message);
    void vscode.window.showErrorMessage(`Project Templates: ${message}`);
  }

  publish() {
    if (!this.disposed) {
      const state = {
        templates: this.templates.map(({ source, ...template }) => template),
        errors: this.errors,
        busy: this.busy,
        repositories: this.repositoryEntries,
      };
      for (const webview of [this.view?.webview, this.settingsPanel?.webview]) {
        if (webview) {
          void webview.postMessage(state);
        }
      }
    }
  }

  async cleanup(caches) {
    for (const cache of caches) {
      try {
        await fs.rm(cache, { recursive: true, force: true });
      } catch (error) {
        this.report(error);
      }
    }
  }

  async refresh() {
    if (this.disposed) {
      return;
    }
    if (this.busy) {
      this.refreshPending = true;
      return;
    }
    this.busy = true;
    this.errors = [];
    this.templates = [];
    this.publish();
    const previousCaches = this.caches;
    this.caches = [];
    try {
      const repositories = this.readRepositories();
      this.publish();
      for (const repository of repositories) {
        if (this.disposed) {
          break;
        }
        try {
          const result = await fetchRepository(repository);
          this.caches.push(result.cache);
          this.templates.push(...result.templates.map((template) => ({
            ...template,
            id: randomBytes(16).toString("hex"),
          })));
        } catch (error) {
          const message = `${repository?.url || "Invalid repository"}: ${error.message}`;
          this.errors.push(message);
          this.output.appendLine(message);
        }
      }
    } catch (error) {
      this.errors.push(error.message);
      this.report(error);
    } finally {
      await this.cleanup(previousCaches);
      this.busy = false;
      if (this.disposed) {
        await this.cleanup(this.caches);
        this.caches = [];
      } else {
        this.publish();
        if (this.errors.length) {
          void vscode.window.showWarningMessage("Some template repositories could not be loaded. See the Project Templates panel and output channel.");
        }
        if (this.refreshPending) {
          this.refreshPending = false;
          await this.refresh();
        }
      }
    }
  }

  async updateRepositories(repositories) {
    const config = vscode.workspace.getConfiguration("projectTemplates");
    const inspected = config.inspect("repositories");
    const target = inspected?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await config.update("repositories", repositories, target);
    this.readRepositories();
    this.publish();
  }

  async addRepository() {
    try {
      const url = await vscode.window.showInputBox({
        title: "Add template repository",
        prompt: "Git URL (HTTPS/SSH) or absolute local Git repository path",
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? undefined : "Enter a repository URL or path.",
      });
      if (url === undefined) {
        return;
      }
      const ref = await vscode.window.showInputBox({
        title: "Repository revision",
        prompt: "Optional tag or commit hash. Leave blank for the default branch.",
        ignoreFocusOut: true,
      });
      if (ref === undefined) {
        return;
      }
      const repository = { url: url.trim() };
      if (ref.trim()) {
        repository.ref = ref.trim();
      }
      await this.updateRepositories([...this.readRepositories(), repository]);
    } catch (error) {
      this.report(error);
    }
  }

  async removeRepository(repository) {
    try {
      const repositories = this.readRepositories();
      if (!repositories.length) {
        void vscode.window.showInformationMessage("No template repositories are configured.");
        return;
      }
      let selected;
      if (repository !== undefined) {
        const index = repositories.findIndex((entry) =>
          entry?.url === repository?.url && entry?.ref === repository?.ref);
        if (index === -1) {
          throw new Error("This repository is no longer configured. Refresh the repository list.");
        }
        selected = { index };
      } else {
        selected = await vscode.window.showQuickPick(repositories.map((entry, index) => ({
          label: entry?.url || "Invalid repository",
          description: entry?.ref || "(default branch)",
          index,
        })), { title: "Remove template repository" });
      }
      if (selected) {
        await this.updateRepositories(repositories.filter((_, index) => index !== selected.index));
      }
    } catch (error) {
      this.report(error);
    }
  }

  async create(id) {
    if (this.busy) {
      return;
    }
    const template = this.templates.find((template) => template.id === id);
    if (!template) {
      throw new Error("Select an available template first.");
    }
    this.busy = true;
    this.publish();
    try {
      const parents = await vscode.window.showOpenDialog({
        title: "Choose the parent folder for your new project",
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Select parent folder",
      });
      if (!parents?.length) {
        return;
      }
      if (parents[0].scheme !== "file") {
        throw new Error("Choose a folder on the extension host's local filesystem.");
      }
      const name = await vscode.window.showInputBox({
        title: "New project name",
        prompt: "A new folder will be created inside the selected parent folder.",
        validateInput: validateProjectName,
        ignoreFocusOut: true,
      });
      if (name === undefined) {
        return;
      }
      const destination = await createProject(template, parents[0].fsPath, name);
      const action = await vscode.window.showInformationMessage(`Created "${name}".`, "Open in New Window");
      if (action) {
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(destination), { forceNewWindow: true });
      }
    } catch (error) {
      this.report(error);
    } finally {
      this.busy = false;
      if (this.disposed) {
        await this.cleanup(this.caches);
        this.caches = [];
      } else if (this.refreshPending) {
        this.refreshPending = false;
        await this.refresh();
      } else {
        this.publish();
      }
    }
  }

  dispose() {
    this.disposed = true;
    if (!this.busy) {
      void this.cleanup(this.caches);
    }
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
