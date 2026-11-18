const vscode = acquireVsCodeApi();
const element = (id) => document.getElementById(id);
const isSettings = document.body.dataset.page === "settings";
let templates = [];
let busy = false;
let selectedTemplate;

for (const command of isSettings ? ["add"] : ["settings", "refresh"]) {
  element(command).addEventListener("click", () => vscode.postMessage({ command }));
}
if (!isSettings) {
  element("create").addEventListener("click", () => {
    vscode.postMessage({ command: "create", id: element("templates").value });
  });
  element("templates").addEventListener("change", renderDetails);
}

function renderDetails() {
  const template = templates.find((item) => item.id === element("templates").value);
  element("details").hidden = !template;
  element("create").disabled = busy || !template;
  if (!template) {
    return;
  }
  selectedTemplate = template;
  for (const field of ["name", "description", "scope", "repository", "path"]) {
    element(field).textContent = template[field];
  }
  element("ref").textContent = `${template.ref} - ${template.commit.slice(0, 12)}`;
  element("features").replaceChildren(...template.features.map((feature) => {
    const item = document.createElement("li");
    item.textContent = feature;
    return item;
  }));
}

window.addEventListener("message", ({ data }) => {
  templates = data.templates;
  busy = data.busy;
  element("repository-summary").textContent = `Repositories (${data.repositories.length})`;
  element("repository-empty").hidden = data.repositories.length > 0;
  element("repository-list").replaceChildren(...data.repositories.map((repository) => {
    const item = document.createElement("li");
    const info = document.createElement("div");
    const url = document.createElement("div");
    url.textContent = repository.url || "Invalid repository";
    const ref = document.createElement("small");
    ref.textContent = repository.ref || "(default branch)";
    info.append(url, ref);
    item.append(info);
    if (isSettings) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary-button";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove repository ${repository.url || "invalid entry"} at ${repository.ref || "default branch"}`);
      remove.addEventListener("click", () => vscode.postMessage({ command: "remove", repository }));
      item.append(remove);
    }
    return item;
  }));
  element("errors").hidden = !data.errors.length;
  element("errors").replaceChildren(...data.errors.map((error) => {
    const item = document.createElement("li");
    item.textContent = error;
    return item;
  }));
  if (isSettings) {
    element("status").textContent = busy ? "Working..." : "Repository changes are saved automatically to VS Code settings.";
    return;
  }
  element("status").textContent = busy ? "Working..." : templates.length
    ? `${templates.length} templates available`
    : "No templates available. Open settings to add a repository, or check the errors below, then refresh.";
  element("refresh").disabled = busy;
  element("templates").disabled = busy || !templates.length;
  element("templates").replaceChildren(...templates.map((template) => {
    const option = document.createElement("option");
    option.value = template.id;
    option.textContent = `${template.name} (${template.scope}) - ${template.repository} @ ${template.ref}`;
    return option;
  }));
  const previous = selectedTemplate && templates.find((item) =>
    item.repository === selectedTemplate.repository && item.ref === selectedTemplate.ref && item.path === selectedTemplate.path);
  if (previous) {
    element("templates").value = previous.id;
  }
  renderDetails();
});

vscode.postMessage({ command: "ready" });
