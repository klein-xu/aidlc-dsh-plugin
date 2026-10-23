# AI-DLC bridge for DeepSeek Harness

Standalone distribution of AI-DLC's DSH profile plugin (`@aidlc/dsh-plugin`),
so it can be installed from a Git tag instead of a project-local
`.dsh/dsh-plugin` folder.

The plugin is the bridge that puts AI-DLC's deterministic surface inside
DeepSeek Harness: it records the person's turns, runs AI-DLC's guards on tool
calls, keeps the workflow loop alive, and writes the audit and sensor record.
AI-DLC's engine stays in the project's `.dsh/` tree — this bundle only listens
to DSH events and runs the matching engine hook. It is a **no-op in a project
without `.dsh/tools/aidlc.ts`**, and the engine hooks themselves are no-ops
outside an active workflow.

## Install

Once per DSH profile:

```sh
# via the DSH CLI (profile name: see ~/.dsh/profiles, e.g. web or desktop)
dsh plugin --profile desktop add github:klein-xu/aidlc-dsh-plugin#v1.0.0
```

Or in DeepSeek Harness: **Plugins → Install a third-party plugin → Git
repository**, and enter:

```text
klein-xu/aidlc-dsh-plugin#v1.0.0
```

From a local clone (development):

```sh
dsh plugin --profile desktop add /absolute/path/to/aidlc-dsh-plugin
```

Pin a tag or commit (`#v1.0.0`, `#<commit>`) so every machine runs the same
bridge. To upgrade, add the newer tag and remove/disable the old copy in the
Plugins page.

Prerequisites (same as the project-local bundle): DeepSeek Harness, **Bun**
(the engine is a Bun program; the plugin resolves `bun` from `PATH`, then
`~/.bun/bin/bun`, then `/usr/local/bin/bun`), and an AI-DLC project installed
with its `.dsh/` tree.

## Tags and this distribution

| Tag | AI-DLC version | Notes |
| --- | --- | --- |
| `v1.0.0` | 2.11.1 | first standalone build, synced from the `feat/deepseek-harness` fork |

Each tag's `package.json` version equals the tag without the leading `v`.
`SYNC.json` records the AI-DLC release and source commit the bundle was taken
from.

### Project-local link vs. this repo

The AI-DLC project's own install (`.dsh/dsh-plugin`) is a **link** the project
refreshes in place with `aidlc config` / `aidlc update`, so that copy always
matches its project's AI-DLC version. This repository is a **copy**: it does
not follow a project's refresh, and one tag is installed for every project in
the profile. Prefer the project-local link while actively developing AI-DLC;
use tags from here when you want one profile-wide bridge, or cannot keep a
project folder around.

### Sync from AI-DLC

```sh
AIDLC_SRC=/path/to/aidlc-workflows ./sync.sh
```

That copies `index.js`, `cordis.patch.yml`, `icon.svg`, `locale/*.json` and
`package.json` out of the checkout's `harness/deepseek/dsh-plugin`, refreshes
`SYNC.json`, and prints the diff. Release a new tag when the bundle changes:

```sh
# 1) bump "version" in package.json (e.g. 1.0.0 -> 1.1.0)
# 2) commit
git add -A && git commit -m "bridge: sync from AI-DLC <version> (<commit>)"
# 3) tag and push
git tag v1.1.0 && git push origin main --tags
```

The source of truth for the bundle is AI-DLC's
[`harness/deepseek/dsh-plugin`](https://github.com/klein-xu/aidlc-workflows/tree/main/harness/deepseek/dsh-plugin);
its README documents the full event → hook mapping and the guard result
contract.

## License

MIT No Attribution — see [LICENSE](LICENSE). Copyright Amazon.com, Inc. or its
affiliates. All Rights Reserved.
