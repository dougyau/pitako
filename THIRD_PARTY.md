# Third-party notices

Pitako composes Pi packages and vendors selected MIT skills. It does not ship BSL Caveman runtime.

## Dependencies

| Project | License | Use |
| --- | --- | --- |
| [@dietrichgebert/ponytail](https://github.com/DietrichGebert/ponytail) 5.3.2 | MIT | Skills `ponytail` and `ponytail-review`. The Pi extension is installed but not loaded. |
| [@juicesharp/rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) 2.15.0 | MIT | Session-local `todo` tool, `/todos`, overlay, and branch replay. `@juicesharp/rpiv-i18n` stays optional. |
| [pi-web-access](https://github.com/nicobailon/pi-web-access) 0.45.0 (Nico Bailon) | MIT | Web search, page extraction, and source checking. Bundled into the Pitako package tarball. |
| [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory) 0.9.11 (Chandra Teja) | MIT | Persistent memory and conversation search. Bundled unchanged, independent of the Board. |
| [pi-subagents](https://github.com/nicobailon/pi-subagents) 0.83.0 (Nico Bailon) | MIT | Native delegation, scripted workflows and missions through the published extension. Bundled unchanged with its LICENSE; Pitako's former managed runtime stays retired. |
| [pi-lsp-client](https://github.com/code-yeongyu/pi-lsp-client) | MIT | LSP tools |
| [pi-codex-tools](https://github.com/jvm/pi-mono/tree/main/packages/pi-codex-tools) 0.4.0 | Apache-2.0; OpenAI Codex attribution | Official extension registers `apply_patch` and invokes upstream install telemetry. Bundled unchanged. |
| [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) 0.1.83 (ranxianglei) | MIT | ACP context compression through the public factory. Bundled unchanged, with delegation and updates off by default. |
| [acp-kernel](https://github.com/ranxianglei/acp-kernel) 0.0.98 (ranxianglei) | MIT with an additional visible-attribution term | Compression engine bundled inline in billion-context-pi's `dist/index.js`. Pitako uses acp-kernel through that package. |
| [@vndv/pi-codegraph](https://github.com/vndv/pi-codegraph) | MIT | CodeGraph tools |
| [@colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) | MIT | CodeGraph CLI |
| [Pi](https://github.com/earendil-works/pi) | MIT | Host |
| [smol-toml](https://github.com/squirrelchat/smol-toml) 1.9.1 | BSD-3-Clause | Read Herdr worktree configuration without executing it. |

License text for pi-hermes-memory: `docs/licenses/pi-hermes-memory-LICENSE`. License texts for pi-web-access: `docs/licenses/pi-web-access-LICENSE`. For Ponytail, see `docs/licenses/ponytail-LICENSE` and the package's own `LICENSE` after install. For pi-codex-tools, see `docs/licenses/pi-codex-tools-LICENSE` and `docs/licenses/pi-codex-tools-NOTICE`.

## Owned provider source

The imported MIT projects below are maintained as ordinary Pitako source. Their
separate full license texts are retained; neither upstream project publishes a
separate NOTICE. The owned dev-tools entry is registered once; the sampler is library-only.
Neither external package is required at runtime or bundled.

| Project | Source revision | Imported paths | License |
| --- | --- | --- | --- |
| [pi-dev-tools 0.6.0](https://github.com/nredd/pi-harness/tree/6104beaf45d34933efd13e4c6b7e2be54c552f16/packages/dev-tools) | `6104beaf45d34933efd13e4c6b7e2be54c552f16` | `extensions/dev-tools/`, adapted tests and fixtures in `tests/dev-tools/` | MIT, Copyright (c) 2026 Redd; `docs/licenses/pi-dev-tools-LICENSE` |
| [pi-resource-sampler 0.1.1](https://github.com/nredd/pi-harness/tree/aebee47ecd4e852a0f80134c376690ff4e33deb7/packages/resource-sampler) | `aebee47ecd4e852a0f80134c376690ff4e33deb7` | `extensions/resource-sampler/`, adapted tests in `tests/resource-sampler/` | MIT, Copyright (c) 2026 Redd; `docs/licenses/pi-resource-sampler-LICENSE` |

Dev-tools locally removes synthetic Git attribution, uses the owned sampler,
reports secondary disposal failures, and fixes queue release after cancelled
waiters or failed wait callbacks. Sampler source is unchanged from its recorded
Git tree; its npm artifact contains built output instead of source. See
`docs/provenance.json` for precise source mappings, test origins and local changes.
No full source-to-package equality or signature authentication is claimed.

## Other dependency notices

`agents/reviewer.md` and `agents/worker.md` adapt pi-subagents 0.82.0
`agents/reviewer.md` and `agents/worker.md`; its MIT license is
included at `node_modules/pi-subagents/LICENSE` in the bundled package.

License texts for ACP: `docs/licenses/billion-context-pi-LICENSE` and `docs/licenses/acp-kernel-LICENSE`. The latter includes the upstream "Attribution on Product Surfaces" term. Pitako's README and this document provide the required visible attribution and link. Neither upstream npm package ships a separate NOTICE.

The official Codex entry invokes installation reporting to `https://mocito.dev/api/report-install` under upstream policy and stores its state under Pi's agent directory. Disable it with `PI_OFFLINE=1` or `"enableInstallTelemetry": false` in Pi's agent `settings.json`. There is no Pitako telemetry toggle. ACP configuration overrides are described in the [README](README.md#context-compression).

## Vendored

| Project | Revision | License | Local tree |
| --- | --- | --- | --- |
| [Matt Pocock skills](https://github.com/mattpocock/skills) | `5beb35b040e3de97e54fa9e386d7e42d15c295c2` | MIT, Copyright (c) 2026 Matt Pocock | `skills/grilling` (exact bytes) |
| [Caveman](https://github.com/JuliusBrussee/caveman) skills | `ae26f3a4775574bd49dc8bdb61c0287bbc3cd268` | MIT | `skills/caveman`, `skills/investigate-first` |
| [pstack](https://github.com/cursor/plugins/tree/main/pstack) (Lauren Tan) | plugin `6ed0f7a9504f577d7529064103cecce9be7dfc5e` | MIT | `skills/practical/*`, `skills/principles/*`, `skills/language/typescript-best-practices` |

`skills/practical/verify-behavior` adapts the useful responsibilities of three retired pstack skills into one Pitako contract. It retains the pstack attribution above. The source mapping and local modifications are in `docs/provenance.json`.

License texts: `docs/licenses/mattpocock-skills-LICENSE`, `docs/licenses/caveman-LICENSE`, `docs/licenses/pstack-LICENSE`.

Caveman engine, proxy, browse, MCP, compression, and memory backends are not included.

## Update

See `docs/provenance.json` and `scripts/vendor-engineering-layer.py`.
