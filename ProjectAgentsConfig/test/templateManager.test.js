const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const {
  parseManifest, resolveTemplatePath, fetchRepository, createProject, validateProjectName,
} = require("../templateManager");

const execute = promisify(execFile);
const manifest = (source = ".") => `templates:
  - name: Example
    description: A starter project
    scope: Backend
    path: "${source}"
    features:
      - Tests
      - Routing
`;

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "template-manager-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function git(root, ...args) {
  const { stdout } = await execute("git", ["-C", root, ...args], { windowsHide: true });
  return stdout.trim();
}

async function fixture(t) {
  const root = await temporaryDirectory(t);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "user.name", "Template Test");
  await git(root, "config", "core.autocrlf", "false");
  // Disable globally configured hooks/signing for isolated test commits.
  await git(root, "config", "core.hooksPath", path.join(root, "no-hooks"));
  await git(root, "config", "commit.gpgsign", "false");
  await fs.mkdir(path.join(root, ".template"));
  await fs.mkdir(path.join(root, "starters", "api"), { recursive: true });
  await fs.writeFile(path.join(root, ".template", "templates.yml"), manifest("starters/api"));
  await fs.writeFile(path.join(root, "starters", "api", "app.txt"), "version one");
  await fs.writeFile(path.join(root, "starters", "api", ".env.example"), "PORT=3000");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "First template");
  const first = await git(root, "rev-parse", "HEAD");
  await git(root, "tag", "v1");
  await fs.writeFile(path.join(root, "starters", "api", "app.txt"), "version two");
  await git(root, "commit", "-am", "Update template");
  const second = await git(root, "rev-parse", "HEAD");
  return { root, first, second };
}

async function fetchForTest(t, repository) {
  const result = await fetchRepository(repository);
  t.after(() => fs.rm(result.cache, { recursive: true, force: true }));
  return result;
}

test("parses one or multiple templates and requires complete metadata", () => {
  const [template] = parseManifest(manifest());
  assert.deepEqual(template, {
    name: "Example", description: "A starter project", scope: "Backend",
    path: ".", features: ["Tests", "Routing"],
  });
  const multiple = manifest() + manifest("starters/api").replace("templates:\n", "");
  assert.equal(parseManifest(multiple).length, 2);
  assert.deepEqual(parseManifest(manifest().replace("features:\n      - Tests\n      - Routing", "features: []"))[0].features, []);
  for (const invalid of ["", "templates: []", "templates: text", "templates: [null]",
    manifest().replace("scope: Backend", "scope: 3"),
    manifest().replace("features:\n      - Tests\n      - Routing", "features: Tests"),
    "templates: []\ntemplates: []"]) {
    assert.throws(() => parseManifest(invalid));
  }
});

test("rejects escaping, absolute, and reserved template paths", () => {
  for (const source of ["../outside", "starter/../../outside", "/absolute", "C:/outside",
    "..\\outside", "\\\\server\\share", ".git", "starter/.template", ".GIT"]) {
    // YAML single quoting preserves backslashes literally.
    const yaml = manifest().replace('path: "."', `path: '${source}'`);
    assert.throws(() => parseManifest(yaml), /path must stay inside/);
  }
});

test("fetches the default branch, tag, and exact commit, then copies only the selected directory", async (t) => {
  const { root, first, second } = await fixture(t);
  for (const [ref, expectedCommit, expectedContent] of [
    [undefined, second, "version two"], ["v1", first, "version one"], [first, first, "version one"],
  ]) {
    const { templates } = await fetchForTest(t, { url: root, ref });
    assert.equal(templates[0].commit, expectedCommit);
    assert.equal(templates[0].path, "starters/api");
    const parent = await temporaryDirectory(t);
    const destination = await createProject(templates[0], parent, "new-project");
    assert.equal(await fs.readFile(path.join(destination, "app.txt"), "utf8"), expectedContent);
    assert.equal(await fs.readFile(path.join(destination, ".env.example"), "utf8"), "PORT=3000");
    assert.deepEqual((await fs.readdir(destination)).sort(), [".env.example", "app.txt"]);
  }
});

test("root templates exclude Git and manifest metadata at every level", async (t) => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, ".template", "templates.yml"), manifest());
  await fs.mkdir(path.join(root, "starters", "api", ".template"));
  await fs.writeFile(path.join(root, "starters", "api", ".template", "internal.yml"), "internal: true");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "Use repository root");
  const { templates } = await fetchForTest(t, { url: root });
  const parent = await temporaryDirectory(t);
  const destination = await createProject(templates[0], parent, "root-project");
  assert.deepEqual(await fs.readdir(destination), ["starters"]);
  assert.equal(await fs.readFile(path.join(destination, "starters", "api", "app.txt"), "utf8"), "version two");
  await assert.rejects(fs.stat(path.join(destination, "starters", "api", ".template")), /ENOENT/);
});

test("invalid revisions, manifests, and missing template paths fail explicitly", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(fetchRepository({ url: root, ref: "missing-tag" }), /Command failed/);
  await assert.rejects(fetchRepository({ url: root, ref: 42 }), /ref must be a string/);
  await fs.writeFile(path.join(root, ".template", "templates.yml"), manifest("missing-directory"));
  await git(root, "commit", "-am", "Broken path");
  await assert.rejects(fetchRepository({ url: root }), /ENOENT/);
  await fs.writeFile(path.join(root, ".template", "templates.yml"), "templates: []");
  await git(root, "commit", "-am", "Broken manifest");
  await assert.rejects(fetchRepository({ url: root }), /non-empty templates list/);
  await fs.unlink(path.join(root, ".template", "templates.yml"));
  await fs.writeFile(path.join(root, ".template", "README.md"), "A manifest is missing.");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "Missing manifest");
  await assert.rejects(fetchRepository({ url: root }), /must contain templates\.yml or templates\.yaml/);
});

test("discovers the bundled .yaml example and creates a runnable project", async (t) => {
  const { root } = await fixture(t);
  const projectRoot = path.join(__dirname, "..");
  await fs.unlink(path.join(root, ".template", "templates.yml"));
  await fs.copyFile(
    path.join(projectRoot, ".template", "templates.yaml"),
    path.join(root, ".template", "templates.yaml"),
  );
  await fs.cp(path.join(projectRoot, "ExampleTemplate"), path.join(root, "ExampleTemplate"), { recursive: true });
  await git(root, "add", ".");
  await git(root, "commit", "-m", "Add bundled example");
  const { templates } = await fetchForTest(t, { url: root });
  assert.equal(templates.length, 1);
  assert.equal(templates[0].path, "ExampleTemplate");
  const parent = await temporaryDirectory(t);
  const destination = await createProject(templates[0], parent, "example-project");
  const { stdout } = await execute(process.execPath, [path.join(destination, "folderExample", "index.js")]);
  assert.equal(stdout.trim(), "Hello from your new project!");
  assert.ok((await fs.stat(path.join(destination, "package.json"))).isFile());
  assert.ok((await fs.stat(path.join(destination, "README.md"))).isFile());
});

test(".yml takes precedence over .yaml and does not fall back on validation errors", async (t) => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, ".template", "templates.yaml"), manifest());
  await git(root, "add", ".");
  await git(root, "commit", "-m", "Add alternative manifest");
  const { templates } = await fetchForTest(t, { url: root });
  assert.equal(templates[0].path, "starters/api");
  await fs.writeFile(path.join(root, ".template", "templates.yml"), "templates: []");
  await git(root, "commit", "-am", "Invalidate preferred manifest");
  await assert.rejects(fetchRepository({ url: root }), /non-empty templates list/);
});

test("does not overwrite existing projects and validates folder names", async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, "existing"));
  await fs.writeFile(path.join(root, "existing", "keep.txt"), "keep");
  await assert.rejects(createProject({ source: root }, root, "existing"), /EEXIST/);
  assert.equal(await fs.readFile(path.join(root, "existing", "keep.txt"), "utf8"), "keep");
  for (const name of ["", " ", ".", "..", "../escape", "a\\b", "CON", "nul.txt", "name.", "name ", "a:b"]) {
    assert.ok(validateProjectName(name), name);
  }
  assert.equal(validateProjectName("my-app"), undefined);
  await assert.rejects(createProject({ source: root }, root, "../escape"), /valid folder name/);
});

test("copy failures remove only the newly created project directory", async (t) => {
  const parent = await temporaryDirectory(t);
  await fs.writeFile(path.join(parent, "keep.txt"), "keep");
  await assert.rejects(createProject({ source: path.join(parent, "missing") }, parent, "new-project"), /ENOENT/);
  assert.deepEqual(await fs.readdir(parent), ["keep.txt"]);
});

test("rejects symlinked template ancestors and files without leaving partial projects", async (t) => {
  const parent = await temporaryDirectory(t);
  const source = path.join(parent, "source");
  const external = path.join(parent, "external");
  await fs.mkdir(source);
  await fs.mkdir(external);
  await fs.mkdir(path.join(external, "child"));
  await fs.writeFile(path.join(source, "a.txt"), "partially copied");
  // Directory junctions do not require Windows symlink privileges.
  await fs.symlink(external, path.join(source, "link"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(resolveTemplatePath(source, "link/child"), /without symbolic links/);
  await assert.rejects(createProject({ source }, parent, "new-project"), /symbolic links/);
  await assert.rejects(fs.stat(path.join(parent, "new-project")), /ENOENT/);
  assert.ok((await fs.stat(external)).isDirectory());
});
