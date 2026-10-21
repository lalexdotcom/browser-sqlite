# Follow-up — the CI workflows: Linux through `tests.yaml`, `tests-ubuntu.yaml`, a `browsers` input (user, 2026-10-21)

Part of `mem:follow-ups`. **Next piece of work after `fix/tx-quiesce-abort`** (user: "on enchaînera là-dessus une fois qu'on a fini ce qui est en cours"), on its own branch. Decided by the user:

- **`ci.yaml` calls `tests.yaml`** (`runs-on: ubuntu-latest`) instead of repeating build/test/conformance in `verify`, beside a `checks` job (actionlint + shellcheck, `biome ci`, the VFS table, `tsc`) that needs no browsers. One definition of the test steps for every OS, the `test-logs-Linux` artifact on failure, the checks in parallel. Nothing depends on the job name `verify`: the `main` ruleset requires no status check, and `release-and-publish.yaml` finds CI's run by workflow file.
- **A `tests-ubuntu.yaml` too**, `workflow_dispatch` only like `tests-windows`/`tests-macos-26`/`tests-macos-27`, calling `tests.yaml` directly — to run Linux by hand, and for symmetry. Not called by `ci.yaml` (one nesting level, no shared concurrency group); the cost is `ubuntu-latest` written twice.
- **`tests.yaml` gets a `browsers` input**, default `chrome,firefox`, passed to the setup action and to the planner. **Only the macOS workflows give their list**; the others take the default. In this piece the macOS list is still `chrome,firefox`.
- Safari's install, and the error for a browser a platform lacks, belong to the Safari piece (`mem:follow-ups/safari-suite`), not to this one.
