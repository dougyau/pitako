# Third-party notices

Pitako composes Pi packages and vendors selected MIT skills. It does not ship BSL Caveman runtime.

## Dependencies

| Project | License | Use |
| --- | --- | --- |
| [@dietrichgebert/ponytail](https://github.com/DietrichGebert/ponytail) 4.10.0 (`e3ba2aa`) | MIT | Skill `ponytail` only. The Pi extension is installed but not loaded. |
| [@juicesharp/rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) 2.11.0 | MIT | Session-local `todo` tool, `/todos`, overlay, and branch replay. `@juicesharp/rpiv-i18n` stays optional. |
| [pi-web-access](https://github.com/nicobailon/pi-web-access) 0.31.0 (Nico Bailon) | MIT | Web search, page extraction, and source checking. Bundled into the Pitako package tarball. |
| [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory) 0.9.9 (Chandra Teja) | MIT | Persistent memory and conversation search. Bundled unchanged, independent of the Board. |
| [pi-lsp-client](https://github.com/code-yeongyu/pi-lsp-client) | MIT | LSP tools |
| [pi-codex-tools](https://github.com/jvm/pi-mono/tree/main/packages/pi-codex-tools) 0.3.0 | Apache-2.0; OpenAI Codex attribution | Official extension registers `apply_patch` and invokes upstream install telemetry. Bundled unchanged. |
| [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) 0.1.83 (ranxianglei) | MIT | ACP context compression through the public factory. Bundled unchanged, with delegation and updates off by default. |
| [acp-kernel](https://github.com/ranxianglei/acp-kernel) 0.0.98 (ranxianglei) | MIT with an additional visible-attribution term | Compression engine bundled inline in billion-context-pi's `dist/index.js`. Pitako uses acp-kernel through that package. |
| [@vndv/pi-codegraph](https://github.com/vndv/pi-codegraph) | MIT | CodeGraph tools |
| [@colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) | MIT | CodeGraph CLI |
| [Pi](https://github.com/earendil-works/pi) | MIT | Host |

License text for pi-hermes-memory: `docs/licenses/pi-hermes-memory-LICENSE`. License texts for pi-web-access: `docs/licenses/pi-web-access-LICENSE`. For Ponytail, see `docs/licenses/ponytail-LICENSE` and the package's own `LICENSE` after install. For pi-codex-tools, see `docs/licenses/pi-codex-tools-LICENSE` and `docs/licenses/pi-codex-tools-NOTICE`.

License texts for ACP: `docs/licenses/billion-context-pi-LICENSE` and `docs/licenses/acp-kernel-LICENSE`. The latter includes the upstream "Attribution on Product Surfaces" term. Pitako's README and this document provide the required visible attribution and link. Neither upstream npm package ships a separate NOTICE.

The official Codex entry invokes installation reporting to `https://mocito.dev/api/report-install` under upstream policy and stores its state under Pi's agent directory. Disable it with `PI_OFFLINE=1` or `"enableInstallTelemetry": false` in Pi's agent `settings.json`. There is no Pitako telemetry toggle. ACP configuration overrides are described in the [README](README.md#context-compression).

## Vendored

| Project | Revision | License | Local tree |
| --- | --- | --- | --- |
| [Caveman](https://github.com/JuliusBrussee/caveman) skills | `ae26f3a4775574bd49dc8bdb61c0287bbc3cd268` | MIT | `skills/caveman`, `skills/investigate-first` |
| [pstack](https://github.com/cursor/plugins/tree/main/pstack) (Lauren Tan) | plugin `6ed0f7a9504f577d7529064103cecce9be7dfc5e` | MIT | `skills/practical/*`, `skills/principles/*`, `skills/language/typescript-best-practices` |

`skills/practical/verify-behavior` adapts the useful responsibilities of three retired pstack skills into one Pitako contract. It retains the pstack attribution above. The source mapping and local modifications are in `docs/provenance.json`.

License texts: `docs/licenses/caveman-LICENSE`, `docs/licenses/pstack-LICENSE`.

Caveman engine, proxy, browse, MCP, compression, and memory backends are not included.

## Update

See `docs/provenance.json` and `scripts/vendor-engineering-layer.py`.
