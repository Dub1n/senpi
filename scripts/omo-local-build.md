# Local OmO builds

Run these commands from the canonical Senpi checkout:

```sh
bash scripts/omo-local-build.sh --preflight --nicknames
bash scripts/omo-local-build.sh --nicknames
bash scripts/omo-local-build.sh --binary /absolute/path/to/omo-linux-x64
```

`--preflight` verifies the pinned source patches without installing dependencies
or building. A source build creates a candidate without installing it by default. Use the printed
candidate path and verify the adjacent `SHA256SUMS`. Test the change against
that candidate before using `--binary … --activate`, which also runs the
packaged transcript and thinking checks and saves a rollback copy. An explicit
source `--activate` runs the same prebuilt validation and install sequence after
the source build succeeds.

`OMO_SENPI_BUILD_HOME` defaults to `~/.local/share/omo-local-builds/senpi`.
It holds the pinned `toolchain/bun`, history-only `recipe/{engine,omo}.git`
repositories, checksum-pinned `recipe/packager.patch`, and build outputs under
`runs/`. Neither release repository needs a permanent checkout. `OMO_SENPI_NODE`
can select the pinned Node executable. For `--nicknames`, `OMO_NICKNAME_SOURCE`
can select a Git repository containing the pinned OmO nickname revision;
the default is `~/dev/omo`. The prebuilt terminal drivers remain local:
`local-ignore/qa-evidence/20261123-dense-card-polish/dense-card-qa.mjs` and
`local-ignore/omo-live-thinking-smoke.mjs`. They need `@xterm/headless` under
`local-ignore/node_modules/`. Set `OMO_MEMORY_RENDERER_SOURCE` if the pinned
OmO memory fixture needs a different provisioned renderer.
