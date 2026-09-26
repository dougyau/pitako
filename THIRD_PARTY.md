# Third-party notices

Pitako composes and vendors MIT material. It does not ship BSL Caveman runtime.

## Dependencies (not copied)

| Project | License | Use |
| --- | --- | --- |
| [@dietrichgebert/ponytail](https://github.com/DietrichGebert/ponytail) 4.10.0 (`e3ba2aa`) | MIT | Skill `ponytail` only. The Pi extension is installed but not loaded. |
| [@juicesharp/rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) 2.11.0 | MIT | Session-local `todo` tool, `/todos`, overlay, and branch replay. `@juicesharp/rpiv-i18n` stays optional. |
| [pi-lsp-client](https://github.com/code-yeongyu/pi-lsp-client) | MIT | LSP tools |
| [pi-codex-tools](https://github.com/jvm/pi-mono/tree/main/packages/pi-codex-tools) 0.3.0 | Apache-2.0; OpenAI Codex attribution | Public parser and grammar exports only; extension and install telemetry are not loaded. |
| [@vndv/pi-codegraph](https://github.com/vndv/pi-codegraph) | MIT | CodeGraph tools |
| [pi-web-access](https://github.com/nicobailon/pi-web-access) 0.31.0 | MIT | Web search and content retrieval (also supports PDF, video, and cloning) |
| [@colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) | MIT | CodeGraph CLI |
| [Pi](https://github.com/earendil-works/pi) | MIT | Host |

License texts for Ponytail: `docs/licenses/ponytail-LICENSE` and the package's own `LICENSE` after install. For pi-codex-tools, see `docs/licenses/pi-codex-tools-LICENSE` and `docs/licenses/pi-codex-tools-NOTICE`.

## Vendored

| Project | Revision | License | Local tree |
| --- | --- | --- | --- |
| [Caveman](https://github.com/JuliusBrussee/caveman) skills | `ae26f3a4775574bd49dc8bdb61c0287bbc3cd268` | MIT | `skills/caveman`, `skills/investigate-first` |
| [pstack](https://github.com/cursor/plugins/tree/main/pstack) (Lauren Tan) | plugin `6ed0f7a9504f577d7529064103cecce9be7dfc5e` | MIT | `skills/practical/*`, `skills/principles/*`, `skills/language/typescript-best-practices` |

License texts: `docs/licenses/caveman-LICENSE`, `docs/licenses/pstack-LICENSE`.

Caveman engine, proxy, browse, MCP, compression, and memory backends are not included.

## Update

See `docs/provenance.json` and `scripts/vendor-engineering-layer.py`.
