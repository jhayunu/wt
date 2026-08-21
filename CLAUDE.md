# wt — notes for Claude Code

## What this repo is
`wt`: a CLI + Claude Code plugin that gives every git worktree its own DDEV environment (URL, DB, media) for WordPress, Drupal, Laravel and React, sized by an "isolation level" (0–4), with DB change tracking, ownership leases and a warm pool. Built for AI agents working in parallel.

Read `ARCHITECTURE.md` for why it works this way, and `README.md` for the user-facing surface
(including the maturity note: levels 0–1 are verified on real DDEV, levels 2–4 only against the shim).

## Layout
- `cli/` — the TypeScript package (`@jhayunu/wt`) and the plugin root (`cli/.claude-plugin/plugin.json`, `cli/skills/wt/SKILL.md`, `cli/commands/wt.md`, `cli/hooks/hooks.json`, `cli/scripts/*.sh`, `cli/bin/wt`).
- `.claude-plugin/marketplace.json` — marketplace pointing at `./cli`.
- `cli/src/core/planner.ts` — the heart: step builders + `planNew/planPromote/planPoolClaim/planDestroy`.
- `cli/src/core/engine.ts` — runs steps, rolls back on failure (`Step.optional` = warn and continue).
- `cli/src/adapters/*` — per-framework behaviour. `cli/src/providers/*` — DB change tracking (`DbChangeProvider`).

## Commands
```bash
cd cli && npm install && npm run typecheck && npm test && npm run build
```
`npm run test:smoke` drives the whole lifecycle against a fake `ddev` on `PATH` — no Docker needed;
`npm run test:all` runs both. `KEEP=1 npm run test:smoke` keeps the scratch repo for inspection.

## Hard rules
- Never prompt interactively; every error has an exit code + `hint`; `--json` output is an API for agents — don't change shapes silently.
- All tooling runs inside DDEV (`ddev npm`, `ddev artisan`, …). Never assume host PHP/Node.
- Never call `ddev poweroff` or touch DDEV projects `wt` didn't create.
- `wt` only ever writes `.ddev/config.wt.local.yaml`, never the committed `.ddev/config.yaml`. That override sets `name: <worktree>` explicitly, so target repos may keep their own `name:` — DDEV merges `config.*.yaml` on top (verified on DDEV v1.25.1 with `ddev utility configyaml`). What must stay in step is `.wt.yml: main` and the repo's project name; `wt doctor` checks it.
- Level 0/1 worktrees must not run `ddev` from inside their directory (it would create a stray project); route via `wt <tool> <name>`.
- Generated files are recorded in `.wt/manifest.json` (`createdFiles`) so `destroy` removes exactly what was created.
- Keep DDEV facts verified against docs (Context7 `/ddev/ddev`) before relying on them.

## Where the "take a worktree" rule lives

`core/claudemd.ts` owns the text, and it is written to two places on purpose: `wt init` puts the repo variant in the project's `CLAUDE.md` (travels with the repository — new machine, new teammate), and `wt skill install` puts the `.wt.yml`-scoped variant in `~/.claude/CLAUDE.md` (covers every repo on this machine). Both share the `<!-- wt:worktrees -->` marker, so re-running either is a no-op. Skills fire once a task is under way; CLAUDE.md is read before that, which is why the trigger has to be there and not only in `skills/wt/SKILL.md`.

## Style
TypeScript ESM, Node ≥ 20, `commander` + `execa` + `zod` + `yaml`. Small files, one concern each. Tests with `node --test` (`cli/test/*.test.ts`). Prefer extending the step builders over writing bespoke command logic.
