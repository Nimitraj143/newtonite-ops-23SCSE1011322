# Engineering Decisions

This document explains the main decisions behind the Operations Under Pressure app, the options I considered, and what each choice costs.

## Assumptions
- A user can belong to several teams, with a different role in each: `viewer < member < lead < admin`. Roles are per team, not global.
- A work item belongs to exactly one team. Users never see items of teams they are not in.
- The workflow is `open → in_progress → awaiting_approval → resolved → closed`, plus three backward moves: `in_progress → open`, `awaiting_approval → in_progress` (reject), `resolved → in_progress` (reopen). Any other jump is invalid.
- Only a lead or admin can move an item out of `awaiting_approval` (that is the approval step).
- A member can edit, claim and move only items that are unassigned or assigned to them. A viewer can only read. Resolved and closed items cannot be claimed.
- Moving an item to `in_progress` assigns it to the person doing it if nobody owns it yet.
- "Many users, fast changes" means several people may act on the same item at the same moment, so correctness matters more than raw speed.

## Decision 1: Current state plus an append-only history, written in one transaction

**Context.** The app needs to show an item's current state quickly, and also answer "who changed what and when" for every item.

**Options.**
1. Event sourcing: store only events and rebuild the state from them.
2. Snapshot or trigger-based audit tables.
3. A `work_items` table for current state plus an append-only `activity_events` table, written by the application.

**Choice.** Option 3. Every change (create, edit, claim, assign, status change, comment) updates `work_items` and inserts an `activity_events` row **inside the same database transaction**. Either both happen or neither does.

**Trade-off.** Reads stay simple and fast (no replaying events), and history cannot drift away from the real state. The cost is that every write path must remember to write an event; this is handled by keeping all writes in one module and covering them with tests. Compared to full event sourcing I give up the ability to rebuild any past state exactly, and I accept that, because the history is for people to read, not for recomputing state.

## Decision 2: Concurrency control (claim race, edit conflicts, double submits)

**Context.** Two people can claim the same item at the same moment, two people can edit the same item from stale screens, and a user can double-click or retry a request after a timeout.

**Options.**
1. Last write wins (no protection).
2. Pessimistic locking (`SELECT ... FOR UPDATE`) for every operation.
3. Atomic conditional updates and optimistic locking with a `version` column, plus idempotency keys for creates and comments.

**Choice.** Option 3, using the right tool for each problem:
- **Claim:** one statement, `UPDATE ... WHERE id = $1 AND assignee_id IS NULL AND status NOT IN ('resolved','closed')`. If it updates 0 rows, the caller gets a 409. The database decides the winner, so no two people can both succeed.
- **Edits, assignments, status changes:** the client sends the `version` it saw. The update only applies `WHERE version = $n` and increments it. A stale version gives a 409 containing the latest item, and the UI shows "someone else changed this item" and reloads.
- **Retries and double clicks:** an `Idempotency-Key` header. The key is stored in the same transaction as the item it created, so a retry returns the original result (with an `Idempotent-Replayed` header). The same key with a different body is rejected with 422.

**Trade-off.** Users sometimes see a conflict message and must redo a change, which is correct behaviour but slightly less convenient than silently overwriting. Optimistic locking needs no long-held locks, so it scales better than pessimistic locking. Idempotency keys add one table and some code; I accepted that because double submits are a very common real-world failure. Concurrency is covered by automated tests (two claimers with one winner, version conflicts, replayed keys).

## Decision 3: Authorization in one place, checked on the server for every resource

**Context.** Different roles must be able to do different things on different items, and a hidden button in the UI is not security.

**Options.**
1. Put the role inside the JWT and check it in route middleware.
2. Check permissions ad hoc inside each route handler.
3. One `authorize(user, action, resource)` function that every route calls, with roles loaded from the database on each request.

**Choice.** Option 3. The function looks at the user's role in the item's team and at the item itself (for example "members can only change their own or unassigned items"). Roles are read from the database on every request, not trusted from the token, so removing someone from a team or changing their role takes effect immediately. A user who is not in the team gets a **404** (the item's existence is not revealed), and a user with too low a role gets **403**. The item endpoint also returns a `can` object and `allowed_transitions`, so the UI shows only valid actions, but the server still enforces every rule.

**Trade-off.** One extra database lookup per request, which is cheap with an index, in exchange for correct, immediate permissions. A single function is easy to test and review, but every new endpoint must remember to call it. Postgres row-level security would be a stronger guarantee, but it is harder to explain, test and debug in a short timeframe, so I left it as a next step.

## Decision 4: Slow side effects run asynchronously through a transactional outbox

**Context.** When an item is assigned or needs approval, someone should be notified. Doing this inside the request makes requests slower and means a failure in notifications could break the main action, or worse, the action could succeed while the notification is lost.

**Options.**
1. Do it synchronously inside the request.
2. Fire and forget in memory after the response (lost if the process crashes).
3. A message broker (Redis/BullMQ or similar).
4. A transactional outbox: write a job row in the same transaction as the change, and let a separate worker process it.

**Choice.** Option 4. The change and its `outbox_jobs` row commit together, so a job exists if and only if the change happened. A separate worker polls with `FOR UPDATE SKIP LOCKED` (so several workers never take the same job), retries with exponential backoff, and marks a job `failed` after 5 attempts. Handlers are idempotent through a `dedupe_key`, so processing a job twice creates only one notification. These behaviours are tested.

**Trade-off.** Notifications are delayed by the polling interval (about a second), and polling uses a little database load. I avoided a new piece of infrastructure (a broker) that would need to be run, monitored and kept consistent with the database. The cost of the broker's extra guarantees was not justified at this size. At much higher volume I would move to a dedicated queue.

## Decision 5: Keyset pagination and Postgres full-text search

**Context.** The list must stay fast with thousands of items (the seed creates about 5000), supports filters and search, and items keep changing while people scroll.

**Options.**
1. `OFFSET/LIMIT` pagination and `ILIKE '%term%'` search.
2. An external search engine.
3. Keyset (cursor) pagination plus Postgres full-text search with a GIN index.

**Choice.** Option 3. The list is ordered by `id DESC` and the cursor is the last `id` seen (`WHERE id < cursor`), so deep pages cost the same as the first page, and new inserts do not shift or duplicate rows between pages. Search uses a generated `tsvector` column with a GIN index and `websearch_to_tsquery`. Partial indexes support the dashboard views (unassigned urgent, awaiting approval, assigned to me). Filters live in the URL so views can be bookmarked and shared.

**Trade-off.** Ordering by `id` means the list is "newest created first", not "most recently updated first"; I chose stability over that convenience. Full-text search matches words, not arbitrary substrings or typos, which an external search engine would handle better. In exchange I have no extra service to run and the search sits in the same transaction-safe database as the data.

## Other choices
- **Plain SQL with `pg`, no ORM.** The important behaviours (conditional updates, `SKIP LOCKED`, `ON CONFLICT`) are SQL features, and writing them directly keeps them visible and reviewable.
- **TypeScript backend, plain JavaScript frontend.** The backend is where correctness matters, so it gets type checking. I kept the frontend in JavaScript to move faster. (`tsx` runs the TypeScript directly and does not type check; I use `tsc --noEmit` for that.)
- **Polling instead of websockets.** The UI refreshes every 15–20 seconds. It is simple and robust; real-time push is a later improvement.
- **Docker Compose with four services** (db, api, worker, frontend) so the whole system starts with one command, including migrations and demo data on an empty database.

## What I did not build
- Automated tests for the list, search, pagination, and for the UI. The backend rules that carry the most risk (concurrency, workflow, authorization, worker) are tested; the rest was checked manually.
- A user picker for assigning (only "assign to me" and "unassign" in the UI; the API supports any team member).
- A notifications page in the UI (the API endpoint exists).
- Optimistic UI updates, websockets, rate limiting, refresh tokens, and a compiled production build of the backend.

## Known limitations
- Search matches whole words only (no fuzzy matching or substrings).
- The list is ordered by creation order, not by last activity.
- The login token lives in `localStorage`.
- Notifications are created in the database but not delivered anywhere external (no email or push).
- Default secrets and passwords are for local use only.

## What I would do next week
1. Add tests for listing, search and pagination, and basic UI tests for the conflict and double-submit flows.
2. Add a user picker for assignment and a notifications page.
3. Add real-time updates (server-sent events or websockets) to replace polling.
4. Consider Postgres row-level security as a second line of defence for team isolation.
5. Add structured logging, request IDs and metrics for the worker queue (depth and failure count).
6. Compile the backend for production and add rate limiting and proper token refresh.

## If traffic grew 10×
The first things I would look at: the connection pool size and slow queries (`EXPLAIN` on the list and search queries), moving the outbox to a dedicated queue if polling load becomes visible, read replicas for the dashboard, and caching the summary counts for a few seconds. The optimistic locking and atomic updates mean correctness does not depend on running a single API instance, so adding more API instances is straightforward.