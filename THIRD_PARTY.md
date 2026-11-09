# Third-party notices

Pitako composes Pi packages and vendors selected MIT skills. It does not ship BSL Caveman runtime.

## Dependencies

| Project | License | Use |
| --- | --- | --- |
| [@dietrichgebert/ponytail](https://github.com/DietrichGebert/ponytail) 5.3.3 | MIT | Skills `ponytail` and `ponytail-review`. The Pi extension is installed but not loaded. |
| [@juicesharp/rpiv-config](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-config) 2.15.0 | MIT | Exact-pinned, bundled configuration dependency of the vendored TODO fork. |
| [@juicesharp/rpiv-ask-user-question](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) 2.15.0 | MIT | Structured questions through `ask_user_question`. Bundled unchanged with its LICENSE. |
| [pi-markdown-preview](https://github.com/omaclaren/pi-markdown-preview) 0.26.2 | MIT | Markdown and LaTeX previews and artifact export. Bundled unchanged with its LICENSE. |
| [pi-web-access](https://github.com/nicobailon/pi-web-access) 0.46.0 (Nico Bailon) | MIT | Web search, page extraction, and source checking. Bundled into the Pitako package tarball. |
| [pi-subagents](https://github.com/nicobailon/pi-subagents) 0.87.0 (Nico Bailon) | MIT | Native delegation, scripted workflows and missions through the published extension. Bundled unchanged with its LICENSE; Pitako's former managed runtime stays retired. |
| [pi-blackhole](https://github.com/k0valik/pi-blackhole) 0.5.17 | MIT | Automatic deterministic compaction, session observational memory, and `recall`. Bundled unchanged with its LICENSE. |
| [pi-lsp-client](https://github.com/code-yeongyu/pi-lsp-client) | MIT | LSP tools |
| [typescript-language-server](https://github.com/typescript-language-server/typescript-language-server) 5.3.0 | Apache-2.0 | TypeScript and JavaScript LSP server installed as an npm dependency. |
| [typescript](https://github.com/microsoft/TypeScript) 5.9.3 | Apache-2.0 | Classic `tsserver.js` for the LSP server. The gate retains TypeScript 7.0.2 through the `typescript-compiler` development alias. |
| [pyright](https://github.com/microsoft/pyright) 1.1.414 | MIT | Python LSP server installed as an npm dependency. |
| [intelephense](https://github.com/bmewburn/intelephense-docs) 1.18.5 | Proprietary, `LICENSE.txt` | PHP LSP server downloaded as an npm dependency, not redistributed in Pitako's tarball. Premium features require a licence. |
| [@nicknisi/pi-ast-grep](https://github.com/nicknisi/pi-extensions/tree/main/packages/ast-grep) 0.3.4 (Nick Nisi) | MIT | Syntax search and preview-first rewrites through Pitako's ast-grep CLI dependency. Bundled unchanged with its `LICENSE` and `THIRD_PARTY_NOTICES.md`. |
| [@ast-grep/cli](https://github.com/ast-grep/ast-grep) 0.51.0 | MIT | ast-grep CLI with platform-specific optional binaries. Bundled into the Pitako package tarball. |
| [pi-codex-tools](https://github.com/jvm/pi-mono/tree/main/packages/pi-codex-tools) 0.4.1 | Apache-2.0; OpenAI Codex attribution | Official extension registers `apply_patch` and invokes upstream install telemetry. Bundled unchanged. |
| [@vndv/pi-codegraph](https://github.com/vndv/pi-codegraph) | MIT | CodeGraph tools |
| [@colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) | MIT | CodeGraph CLI |
| [Pi](https://github.com/earendil-works/pi) | MIT | Host |
| [smol-toml](https://github.com/squirrelchat/smol-toml) 1.9.1 | BSD-3-Clause | Read Herdr worktree configuration without executing it. |

License text for pi-web-access: `docs/licenses/pi-web-access-LICENSE`. For Ponytail, see `docs/licenses/ponytail-LICENSE` and the package's own `LICENSE` after install. For pi-codex-tools, see `docs/licenses/pi-codex-tools-LICENSE` and `docs/licenses/pi-codex-tools-NOTICE`.

## Vendored TODO fork

[rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/ce6d3530410812ca504ec294995581a52170f9e1/packages/rpiv-todo) 2.15.0, MIT, is commit-pinned at `ce6d3530410812ca504ec294995581a52170f9e1`. Source and upstream tests are in `vendor/rpiv-todo/`, with its `LICENSE`, `PROVENANCE` and single local-delta record `pitako.patch`. `extensions/todo.ts` is the only Pi entry. `@juicesharp/rpiv-i18n` stays optional. Dependency automation reports upstream drift without updating the fork.

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

The official Codex entry invokes installation reporting to `https://mocito.dev/api/report-install` under upstream policy and stores its state under Pi's agent directory. Disable it with `PI_OFFLINE=1` or `"enableInstallTelemetry": false` in Pi's agent `settings.json`. There is no Pitako telemetry toggle.

## Vendored

| Project | Revision | License | Local tree |
| --- | --- | --- | --- |
| [Matt Pocock skills](https://github.com/mattpocock/skills) | `5beb35b040e3de97e54fa9e386d7e42d15c295c2` | MIT, Copyright (c) 2026 Matt Pocock | `skills/grilling` (exact bytes) |
| [BeautifulRust](https://github.com/morganlinton/BeautifulRust) | `40db61c6fee84bd121cf288755f0e2f22a50e995` | MIT, Copyright (c) 2026 Morgan Linton | `skills/language/rust-best-practices` with its reference digests, `skills/language/rust-review`, `skills/language/rust-port` (exact bytes) |
| [Caveman](https://github.com/JuliusBrussee/caveman) skills | `ae26f3a4775574bd49dc8bdb61c0287bbc3cd268` | MIT | `skills/caveman`, `skills/investigate-first` |
| [pstack](https://github.com/cursor/plugins/tree/main/pstack) (Lauren Tan) | plugin `6ed0f7a9504f577d7529064103cecce9be7dfc5e` | MIT | `skills/practical/*`, `skills/principles/*`, `skills/language/typescript-best-practices` |

`skills/practical/verify-behavior` adapts the useful responsibilities of three retired pstack skills into one Pitako contract. It retains the pstack attribution above. The source mapping and local modifications are in `docs/provenance.json`.

License texts: `docs/licenses/mattpocock-skills-LICENSE`, `docs/licenses/caveman-LICENSE`, `docs/licenses/pstack-LICENSE`.

BeautifulRust's license is `docs/licenses/beautiful-rust-LICENSE`. Its evals,
lint configurations, Claude plugin metadata, and benchmarks are not bundled.
Pitako supplies on-demand routing and preserves project verification and role
permissions without changing upstream skill bodies.

Caveman engine, proxy, browse, MCP, compression, and memory backends are not included.

## Update

See `docs/provenance.json` and `scripts/vendor-engineering-layer.py`.
