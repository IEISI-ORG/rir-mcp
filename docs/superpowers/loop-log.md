# Unattended work loop — log

Started 2026-10-03, from `/loop 120m` (session-only cron job `a4220b1f`, fires at :07 every 2 hours).

Rules from the user:
- Work through all plans; put questions in `QUESTIONS.md` with space to answer.
- Work on `main` (Plan 1 merged); nothing is deployed.
- Every 5th iteration is a code review, not feature work.
- Run a security audit of the code once a day.

| # | Date | Kind | Work | Commits |
|---|---|---|---|---|
| 1 | 2026-10-03 | work | Fast-forwarded `main` to Plan 1 (`81f92a3`). Security follow-ups: sanitiser ranges, redirect port/userinfo, ASCII handles, reader lock. Wrote Plan 2 (Node HTTP + auth). Opened QUESTIONS.md (Q1–Q8). | `ec4bfd8`, `0ed7203` |
| 1 (cont.) | 2026-10-03 | work | Plan 2 Tasks 1–3 inline: key stores, client gate, `RirService.forClient`. 345 tests pass. Ledger: `.superpowers/sdd/2026-10-03-rir-mcp-plan-2-node-http/progress.md` (git-ignored). | `8a22d28`, `bbec943`, `4d38215` |
| 1 (fix) | 2026-10-03 | security | Background security review flagged cross-client state mixing: one client's quota/suspension denial was shared via in-flight coalescing. Reproduced, fixed with a per-client denial sentinel; coalescing clients are not charged. | `a62a194` |
| 2 | 2026-10-03 | work + audit | Q4 answered (Cloudflare key design; Node keys file now reloads on change, spec §7 amended). Plan 2 Task 4 (call-log hook) and Task 5 (HTTP config, FileKeyStore). Daily security audit dispatched on snapshot `998bb8a` (fresh-context reviewer). 369 tests pass. | `449b6fc`, `520a3b7`, `54db90f` |
| 2 (audit) | 2026-10-03 | security | Daily audit (fresh reviewer, snapshot `998bb8a`): 0 Critical/High, 2 Medium, 4 Low. Fixed both Mediums (raw `ldhName` in history keys; deleted personal entity's history served/cached) and Lows #3 (redirect query/fragment/path in `meta.url`), #6 (NaN quota fails open). #4 (byte-bounded memory) and #5 (sliding windows) deferred to follow-ups. Also fixed review finding: keys-file fail-open (`f808a36`). 385 tests pass. | `f808a36`, `1965919` |
| 3 | 2026-10-03 | work (cut short) | Answers: Q1 approved, Q4 follow-up approved, Q7 → default port 4608 (IANA-unassigned), Q8 → create public repo. Repo creation/push was denied by Claude Code's auto-mode permission check, which then also blocked local reads; stopped the iteration. Nothing pushed. | `8b84a94` |
| 4 | 2026-10-03 | work | Q8 left for the user (no answer, no remote). Plan 2 Task 6 (authenticated Streamable HTTP: path → Host → Origin → Bearer → MCP; smoke-tested) and Task 7 (`--stdio/--http` CLI, `scripts/keys.ts`). 404 tests pass. | `76e0fb7`, `48853ba` |
| 5 | 2026-10-04 | code review | Fresh reviewer (Opus) on `81f92a3..cb38d86`: 0 Critical, 2 Important, 7 Minor; all 5 Plan 2 Review Focus items verified. Fixed: rDNS charged per zone (Q5), limiter refusal spent quota (refund), NaN quota fail-open (re-graded). Allow-list validation → Task 8; 6 Minors to follow-ups. 410 tests pass. | `2d68a06` |
| 6 | 2026-10-04 | audit + work | Daily audit (fresh reviewer, snapshot `af76a4c`): 1 Medium (SSE `subscriptions/listen` held open indefinitely, bypassing quota/scan/timeouts), 2 Low (backslash request target set URL host; prototype keys as RIR hosts) — all fixed test-first. Plan 2 Task 8: allow-list validation + HTTP deployment docs (commands smoke-tested). **Plan 2 closed.** 428 tests pass. | `82c1a0f`, `4ee9b0c`, `7e34186` |
| 7 | 2026-10-04 | plan | Researched current Cloudflare tooling (Vitest plugin 1.3.6 needs Vitest 4; no outbound fetch mocking). Wrote Plan 3 (Worker; "StateDO as the server" to avoid ~5 cross-region DO round trips per lookup). Opened Q9–Q12 with defaults. | `f39956f`, `53905e1` |
| 7 (cont.) | 2026-10-04 | work | Plan 3 Task 1: limiter and gate run over an injectable `StateMap` (Map in Node, SQLite in the DO); digest before read for DO atomicity. 432 tests pass. | `c15bd68` |

**Next iteration:** 8 — Plan 3 Task 2 (move HTTP gate/handler to core) and Task 3 (worker scaffold).
**Next code review:** iteration 10.
**Security audit:** 2026-10-04 done (iteration 6, snapshot `af76a4c`); next due 2026-10-05.
