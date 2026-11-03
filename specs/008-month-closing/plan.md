# Implementation Plan: Month closing

**Branch**: `008-month-closing` | **Date**: 2026-11-03 | **Spec**: [spec.md](spec.md)

## Summary

Implement the accepted single-boundary close using existing SQLite settings and audit history. Guard the shared ledger write queries inside transactions so every application entry point obeys the boundary. Extend the existing permission catalog, provide a compact review/close/reopen page, and broadcast status through SSE.

## Technical Context

**Language/Version**: TypeScript strict, Svelte 5, Bun.  
**Primary Dependencies**: Existing SvelteKit, Drizzle, SQLite, Zod; none added.  
**Storage**: Existing settings/audit tables; no duplicated per-record closed flags.  
**Testing**: Isolated SQLite service/application tests, permission tests, required check/lint/test gates.  
**Target Platform**: Browser/PWA/Tauri/mobile from one source tree.  
**Project Type**: Self-hosted web application.  
**Performance Goals**: Indexed closed-date lookups on writes; no network dependency or polling.  
**Constraints**: Never start the app against real data; no .env or live UI access.  
**Scale/Scope**: One book-wide boundary, all existing financial writers, three user stories.

## Constitution Check

| Gate                 | Principle        | Check                                                                                                   |
| -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
| Single codebase      | I                | PASS: one responsive Svelte page and shared server logic.                                               |
| Lightweight          | II               | PASS: existing SQLite/settings/audit; no dependency or network service.                                 |
| YAGNI                | III              | PASS: one boundary; no workflow engine, snapshots or module states.                                     |
| SOLID boundaries     | IV               | PASS: policy/query enforcement, service business logic, authorized application operations, thin routes. |
| Mutation obligations | IV               | PASS: permission, Zod, atomic audit and after-commit SSE planned for every action.                      |
| TDD scope            | V                | PASS: financial policy, state transitions and permission behavior test-first; no redundant UI tests.    |
| Established patterns | VI               | PASS: existing shared controls, real /closing URL, SSE only.                                            |
| Fixed stack          | Tech constraints | PASS: existing Svelte/Drizzle stack; state needs no schema migration.                                   |

Pre-research gate passed 2026-11-03. Post-design review PASS: shared transactional guards cover specialized writers; explicit master-data guards cover partner membership and merges; typed error conversion happens after rollback. No new unresolved design questions.

## Project Structure

Documentation in `specs/008-month-closing/`: spec, plan, research, data-model, contracts, quickstart, tasks and quality checklist.

Source changes: `server/closing/policy.ts`, shared ledger queries, account/contact writers, `server/application/closing.ts`, closing routes/components, permission catalog, audit labels, SSE status, app-shell boundary and report link.

## Complexity Tracking

Explicit source-level query guards are preferred to custom SQL triggers because the ORM schema cannot describe triggers and existing application errors are typed refusals.

### Validation baseline exception

The repository-wide lint gate is already failing on main: Prettier reports 242 existing files. The feature branch reports 237 existing files after formatting its changed files. Running ESLint separately found 62 errors in unchanged files (the four initially introduced Svelte findings were corrected). This PR does not bulk-format or rewrite unrelated code to make the existing gate green. Changed files pass their focused formatter and ESLint checks; type-check and the full server/client test suites pass. This is a documented validation-baseline exception, not an unreported passing lint gate.
