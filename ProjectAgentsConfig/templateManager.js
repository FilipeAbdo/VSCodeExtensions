const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const YAML = require("yaml");

const execute = promisify(execFile);
const excludedNames = new Set([".git", ".template"]);

async function git(args) {
  const { stdout } = await execute("git", args, {
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function parseManifest(content) {
  const manifest = YAML.parse(content, { maxAliasCount: 100, uniqueKeys: true });
  if (!manifest || !Array.isArray(manifest.templates) || !manifest.templates.length) {
    throw new Error("The manifest must contain a non-empty templates list.");
  }
  return manifest.templates.map((entry, index) => {
    const label = `templates[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label} must be an object.`);
    }
    const template = {
      name: requiredText(entry.name, `${label}.name`),
      description: requiredText(entry.description, `${label}.description`),
      scope: requiredText(entry.scope, `${label}.scope`),
      path: requiredText(entry.path, `${label}.path`),
      features: entry.features,
    };
    if (!Array.isArray(template.features) ||
        template.features.some((feature) => typeof feature !== "string" || !feature.trim())) {
      throw new Error(`${label}.features must be a list of non-empty strings (or []).`);
    }
    template.features = template.features.map((feature) => feature.trim());
    const segments = template.path.split(/[\\/]/);
    if (path.posix.isAbsolute(template.path) || path.win32.isAbsolute(template.path) ||
        template.path.includes(":") || template.path.includes("\0") ||
        segments.some((segment) => segment === ".." || excludedNames.has(segment.toLowerCase()))) {
      throw new Error(`${label}.path must stay inside the repository, outside .git and .template.`);
    }
    return template;
  });
}

async function resolveTemplatePath(root, relativePath) {
  const source = path.resolve(root, ...relativePath.split(/[\\/]/));
  const relative = path.relative(root, source);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Template path escapes the repository.");
  }
  // Reject symlinked ancestors as well as symlinked template directories.
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Template path must be a directory without symbolic links: ${relativePath}`);
    }
  }
  return source;
}

async function fetchRepository(repository) {
  const url = requiredText(repository?.url, "Repository URL");
  if (repository.ref !== undefined && typeof repository.ref !== "string") {
    throw new Error("Repository ref must be a string.");
  }
  const ref = repository.ref?.trim() || "HEAD";
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), "project-templates-"));
  const root = path.join(cache, "repository");
  try {
    await git(["clone", "--no-checkout", "--no-local", "--", url, root]);
    const commit = await git(["-C", root, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
    await git(["-C", root, "checkout", "--detach", commit]);
    const manifestPath = await resolveTemplatePath(root, ".template");
    const manifestFiles = await fs.readdir(manifestPath);
    const manifestName = ["templates.yml", "templates.yaml"].find((name) => manifestFiles.includes(name));
    if (!manifestName) {
      throw new Error(".template must contain templates.yml or templates.yaml.");
    }
    const manifestFile = path.join(manifestPath, manifestName);
    const manifestStat = await fs.lstat(manifestFile);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
      throw new Error(`.template/${manifestName} must be a regular file.`);
    }
    const entries = parseManifest(await fs.readFile(manifestFile, "utf8"));
    const templates = [];
    for (const entry of entries) {
      templates.push({
        ...entry,
        source: await resolveTemplatePath(root, entry.path),
        repository: url,
        ref: repository.ref?.trim() || "(default branch)",
        commit,
      });
    }
    return { cache, templates };
  } catch (error) {
    await fs.rm(cache, { recursive: true, force: true });
    throw error;
  }
}

function validateProjectName(name) {
  if (typeof name !== "string" || !name.trim() || name !== name.trim() ||
      /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name) ||
      name === "." || name === "..") {
    return "Enter a valid folder name (no paths, reserved names, or trailing dots/spaces).";
  }
  return undefined;
}

async function createProject(template, parent, name) {
  const validation = validateProjectName(name);
  if (validation) {
    throw new Error(validation);
  }
  const destination = path.join(parent, name);
  // mkdir without recursive mode reserves a new directory; existing projects are never overwritten.
  await fs.mkdir(destination);
  try {
    const sourceStat = await fs.lstat(template.source);
    if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
      throw new Error("Template source must be a directory without symbolic links.");
    }
    const options = {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: async (source) => {
        if (excludedNames.has(path.basename(source).toLowerCase())) {
          return false;
        }
        const stat = await fs.lstat(source);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
          throw new Error(`Cannot copy symbolic links or special files: ${source}`);
        }
        return true;
      },
    };
    for (const entry of await fs.readdir(template.source)) {
      await fs.cp(path.join(template.source, entry), path.join(destination, entry), options);
    }
    return destination;
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { parseManifest, resolveTemplatePath, fetchRepository, validateProjectName, createProject };
