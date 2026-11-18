# Project Template Manager

Discover project templates from Git repositories in a dedicated VS Code Activity
Bar panel. Choose a template, review its scope, description and features, then
create a project in a new folder.

## Repository settings

Open **Project Template Manager** in the Activity Bar. In the **Project Templates**
panel, select the **gear** button (**Repository settings**) next to the heading.
This opens the extension's dedicated repository settings page. Select
**Add repository**, then enter an HTTPS/SSH Git URL or an absolute local Git repository path and an
optional tag or commit hash. Leave the revision blank to use the repository's
default branch. Use **Remove** next to an entry on the settings page to delete it.
Changes are saved automatically and refresh the available templates. The main
panel's collapsible **Repositories** list shows URLs and revisions read-only.
**Project Templates: Repository Settings** and the add/remove actions are also
available from the Command Palette.

The setting is `projectTemplates.repositories`:

```json
{
  "projectTemplates.repositories": [
    { "url": "https://github.com/your-org/project-templates.git" },
    { "url": "git@github.com:your-org/service-template.git", "ref": "v1.0.0" },
    { "url": "C:\\repos\\project-templates", "ref": "0123456789abcdef0123456789abcdef01234567" }
  ]
}
```

Add/remove actions update workspace settings when the list is already defined
there; otherwise they update user settings. Each repository can be listed at
multiple revisions.

Git must be installed and on PATH. Private repositories use your existing Git
credentials/SSH configuration; configure authentication outside the extension.
Do not embed access tokens in repository URLs. Git terminal prompts are disabled,
and each Git command has a two-minute timeout.

## Template manifest

Every repository must have a committed **`.template/templates.yml`** or
**`.template/templates.yaml`** file at its root. If both exist, `templates.yml`
takes precedence; an invalid file is reported rather than falling back to the
other filename. The same manifest is used for one template or a collection of templates:

```yaml
templates:
  - name: Node API
    description: A small HTTP API starter.
    scope: Backend service
    path: templates/node-api
    features:
      - HTTP routing
      - Unit tests
  - name: Web App
    description: A browser application starter.
    scope: Frontend application
    path: templates/web-app
    features:
      - Responsive layout
```

For a repository that is itself a template, use a single entry with `path: "."`.
All five fields are required: `name`, `description`, `scope`, `path`, and
`features`. `features` may be an empty list (`[]`). Quote YAML values that should
be strings, such as a numeric template name.

Paths are relative to the repository root and must name existing directories.
Absolute paths, parent traversal, and paths into `.git` or `.template` are
rejected. Symlinked template directories and manifest files are not supported.
A malformed manifest or missing template directory makes that repository
unavailable; other configured repositories still load. Errors appear in the
panel and the **Project Templates** Output channel.

### Bundled example

[ExampleTemplate](ExampleTemplate/README.md) is a runnable, dependency-free
Node.js console project registered in
[.template/templates.yaml](.template/templates.yaml). Its manifest includes all
required metadata and points to `ExampleTemplate` relative to the repository root.

To try discovery, commit the manifest and example in a template repository with
these paths at its Git root, add that repository in settings, and refresh. If
using this folder inside a larger repository, place the manifest at that larger
repository's root and adjust the template path accordingly. Uncommitted files
are not included when repositories are cloned.

## Creating a project

1. Select the cycle-arrow button (**Refresh templates**) next to the template
   dropdown to clone repositories at their selected revisions. The panel also
   refreshes on opening and settings changes.
2. Select a template from the dropdown. Expand **Template details** below the
   create button to review its metadata.
3. Select **Create project**, choose a parent folder, and enter a new folder name.
4. Optionally select **Open in New Window** after creation.

The destination must not already exist. Files, including ordinary dotfiles, are
copied from the selected template directory; `.git` and `.template` entries are
excluded at every level. Symbolic links and special files are rejected, and an
incomplete new project is removed if copying fails. No template scripts,
dependency installation, variable substitution, or Git initialization are run.
Git submodules and Git LFS content are not explicitly fetched by the extension.
Local repositories are cloned too, so uncommitted changes are not included.

Clones are temporary snapshots. Refresh fetches fresh snapshots rather than
modifying source repositories; old snapshots are removed on refresh or normal
extension disposal. A forcibly terminated extension host may leave temporary
`project-templates-*` directories in the system temp folder.

## Development

Requires Node.js 22 or newer and npm on PATH for development:

```sh
npm install
npm run build
npm test
```

Press `F5` to start the syntax-check watcher and launch an Extension Development
Host. Open **Project Template Manager** in its Activity Bar. The watcher checks extension,
template-manager, and webview JavaScript on changes; reload the Extension
Development Host to load updated code. Stop it with **Tasks: Terminate Task**.

The plain JavaScript extension needs no compilation. `Ctrl+Shift+B` runs the
syntax check. Tests use Node's test runner and temporary local Git repositories;
no network access is needed.

## Icon attribution

The extension uses Font Awesome Free 6.7.2's **wand-magic-sparkles** icon (Solid),
copyright 2024 Fonticons, Inc., licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
[Original icon](https://github.com/FortAwesome/Font-Awesome/blob/6.7.2/svgs/solid/wand-magic-sparkles.svg).
The Activity Bar SVG is tinted gray; the extension PNG is a purple rasterization.
