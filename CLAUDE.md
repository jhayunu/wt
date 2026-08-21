# GitWorktrees / wt — notes for Claude Code

## What this repo is
`wt`: a CLI + Claude Code plugin that gives every git worktree its own DDEV environment (URL, DB, media) for WordPress, Drupal, Laravel and React, sized by an "isolation level" (0–4), with DB change tracking, ownership leases and a warm pool. Built for AI agents working in parallel.

Start with `PLAN.md` (what to do next) and `ARCHITECTURE.md` (why). `BRAINSTORM.md` is ideas only.

## Layout
- `cli/` — the TypeScript package (`@jhayar/wt`) and the plugin root (`cli/.claude-plugin/plugin.json`, `cli/skills/wt/SKILL.md`, `cli/commands/wt.md`, `cli/hooks/hooks.json`, `cli/scripts/*.sh`, `cli/bin/wt`).
- `.claude-plugin/marketplace.json` — marketplace pointing at `./cli`.
- `cli/src/core/planner.ts` — the heart: step builders + `planNew/planPromote/planPoolClaim/planDestroy`.
- `cli/src/core/engine.ts` — runs steps, rolls back on failure (`Step.optional` = warn and continue).
- `cli/src/adapters/*` — per-framework behaviour. `cli/src/providers/*` — DB change tracking (`DbChangeProvider`).

## Commands
```bash
cd cli && npm install && npm run typecheck && npm test && npm run build
```
Smoke test without Docker: see PLAN.md §1 (shim `ddev`). Real DDEV test: PLAN.md §2.

## Hard rules
- Never prompt interactively; every error has an exit code + `hint`; `--json` output is an API for agents — don't change shapes silently.
- All tooling runs inside DDEV (`ddev npm`, `ddev artisan`, …). Never assume host PHP/Node.
- Never call `ddev poweroff` or touch DDEV projects `wt` didn't create.
- `.ddev/config.yaml` in target repos must have no `name:` (DDEV derives it from the directory — that's how worktrees get unique projects). `wt` only writes `.ddev/config.wt.local.yaml`.
- Level 0/1 worktrees must not run `ddev` from inside their directory (it would create a stray project); route via `wt <tool> <name>`.
- Generated files are recorded in `.wt/manifest.json` (`createdFiles`) so `destroy` removes exactly what was created.
- Keep DDEV facts verified against docs (Context7 `/ddev/ddev`) before relying on them.

## Style
TypeScript ESM, Node ≥ 20, `commander` + `execa` + `zod` + `yaml`. Small files, one concern each. Tests with `node --test` (`cli/test/*.test.ts`). Prefer extending the step builders over writing bespoke command logic.
