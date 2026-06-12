# PMS v2 — Greenfield Design

**Status:** Build in progress on `pms-test` (Railway: langmuir-pms-test) for thorough staging validation.
**Owner:** Brendan · **Author:** Claude · **Date:** 2026-06-11
**Constraint locked:** the Google Sheet + `pms-locations` Apps Script remain the data layer
(that's what the floor manager inherits in August). Everything above it is rebuilt.

---

## 1. The problem, framed from zero

The PMS exists to answer one question continuously and truthfully:
**"Is every line able to build the next unit — and if not, what's blocking it?"**

Everything the system does is one of four jobs:

| Job | Today's tool | What the data says about it |
|---|---|---|
| **J1. Move material to lines before they starve** | requests + picker queue | median pick 18m, but p90 64m and 33% > 30m; "high" priority is barely faster than "low" (14m vs 19m median) |
| **J2. Keep the recorded inventory equal to physical reality** | stow/pick/transfer logging + cycle counts | tracked totals overstate reality by a median 39% on counted parts; 10% of stows are duplicates; 882 location strings where ~870 places exist |
| **J3. Keep production rhythm visible** (takt, cycles, holds) | Apollo/Titan boards | Titan logs 92 cycles; Apollo only 31 in 2 months — the board asks too much of the operator |
| **J4. Close the loop with Epicor** | cycle-count EOD worklist | 22 of 22 finalized counts say "Entered in Epicor: no" |

### Root causes found in the transaction data (Apr 13 – Jun 11, 3,589 rows)

1. **Slow writes + eager re-taps = phantom inventory.** The Apps Script write takes
   10–20s. Every UI gave up at 8–10s and re-enabled the button. Result: 119 duplicate
   plain stows, duplicate bundle stows, and even duplicate cycle-count confirms.
   This is a *system property*, not an operator failure — any slow write path without
   idempotency will be double-submitted on a factory floor.
2. **Free text is an error factory.** "WEST  BULK" (double space), "09‐D2-B"
   (non-ASCII hyphen), "01 - B3 - C", "06/07 END CAP" vs "ENDCAP", four bins
   concatenated into one entry, and line names typed as bins. Every variant is
   invisible inventory that a cycle count later "discovers."
3. **Priority buckets don't encode what matters: time.** A line-down request and a
   top-up request both sit in an unsorted list distinguished only by a badge color.
   The 8–9 am volume peak (2× other hours) is exactly when the queue is least readable.
4. **Restart amnesia.** Requests live in server memory; every deploy mid-day deletes
   the floor's open picks. This blocks deployments and erodes trust in the queue.
5. **No reason codes.** 9% of requests get cancelled and nobody knows why — the single
   richest source of "the system didn't match the floor" signal is discarded.

### Design principles (each traces to a root cause)

- **P1 — Every write is idempotent.** Client attaches an `opId`; the server processes
  each op exactly once and replays the stored result on retry. Content-based duplicate
  guards (the stow guard, generalized) back this up against human re-entry. (→ RC1)
- **P2 — No free text where a registry can exist.** Places are first-class: validated
  bins, curated named areas, and lines. Unknown places need explicit confirmation and
  are logged for review. (→ RC2)
- **P3 — The queue is a promise, not a list.** Every request carries an SLA
  (standard 20m / urgent 10m, configurable). The queue sorts by time-to-breach and
  ages visibly. Urgent means "line is blocked," one tap. (→ RC3)
- **P4 — The server can die at any moment and nothing is lost.** Open requests
  journal to the Sheet (write-behind) and are restored on boot. Deploys stop being
  scary. (→ RC4)
- **P5 — Capture the why.** Cancels take a one-tap reason. Failed writes are surfaced,
  never silently dropped. (→ RC5)
- **P6 — Truth converges.** Surfaces show sheet-vs-Epicor drift where the user is
  already looking (request cards, stow confirmations), so discrepancies get noticed
  in the flow of work, not six months later in a sweep. (→ J2/J4)
- **P7 — Hand-over ready.** Plain Node + Express + WS + static pages, no build step,
  no framework, heavily commented, config in one block. (→ August)

---

## 2. What is deliberately kept

- **The Apps Script contract** — actions `subtract`, `stow`, `bumpLine`,
  `assignOrphan`, `logRequest`, `logStationCycle`, `logLineCycle`, `logTitanCycle`,
  `updateReplenishment`, and the `doGet` payload. v2 adds only optional, additive
  actions (`journalRequests`) and degrades gracefully when they're absent.
- **The board state machines.** Apollo's station model and Titan's single-unit cycle
  were iterated with real operators; their semantics port unchanged. What changes is
  the chrome around them.
- **Bundles, line inventory, auto-reorder ingestion, cycle-count integration** — all
  current behavior carries forward.
- **Old URLs.** `/line.html`, `/picker.html`, `/titan.html`, `/worker.html` become
  redirect stubs into the app so kiosk bookmarks keep working.

## 3. Architecture

```
public/
  index.html      app shell + role picker (Board / Station / Warehouse / Line)
  app.css         one design system (dark, high-contrast, glove-sized targets)
  js/core.js      ws client (reconnect WITHOUT reload, op-id sender, pending-op UI),
                  store, shared components (toast, confirm, place picker, part search)
  js/board.js     production boards (Apollo stations · Titan · generic line)
  js/station.js   station operator screen (timer + request flow)
  js/warehouse.js warehouse screen (SLA queue · pick · stow · transfer · activity)
  js/line.js      line request screen (+ on-line stock, assign-to-line)
  *.html          legacy redirect stubs
server.js         restructured: config → state machines → caches → write pipeline →
                  place registry → SLA queue → REST → WS ops
```

**The write pipeline** (new, heart of v2): one `submitOp(opId, kind, payload, handler)`
path for every mutation. Duplicate `opId` → replay stored result. Content guards per
kind (stow/pick/transfer/request) with `force` override after explicit confirm.
Apps Script calls retry with backoff; an op that exhausts retries lands in a visible
**write-health panel** on the warehouse screen (count + retry button), never silently lost.

**Request journal:** every request mutation marks the store dirty; a 20s write-behind
posts open requests as JSON to the (additive) `journalRequests` action → `Live Requests`
tab. On boot the server restores from the journal if present. If the Apps Script
doesn't have the action yet, v2 logs once and runs in-memory like v1.

**SLA queue:** request = `{sla:'standard'|'urgent', targetMs, submittedAt}` →
`timeLeft = targetMs − age`. Sort ascending; <0 = breached (red, pulsing). The sheet
still receives priority strings (urgent→high) so existing logs/reports don't change.

## 4. The five screens

1. **Role picker** — four giant buttons; remembers the device's role; `?role=` deep links.
2. **Board** — per line: takt ring, cycle count vs target-by-now, station cards
   (Apollo), hold/andon with reasons, and an alerts rail fed by the SLA queue
   (breached requests float up automatically). One-tap cycle logging (→ J3: make
   logging cheaper than not logging).
3. **Station** — big timer, my station's open requests with live SLA countdown,
   request flow: part search (line catalog + full catalog fallback) → qty →
   standard/urgent → done. Three taps for the common case.
4. **Warehouse** — the queue as a column of cards sorted by time-to-breach with age
   rings; pick flow with per-location quantities and walk-order sort; stow/transfer
   with the **place picker** (bin keypad with format mask + named-area buttons +
   line buttons — no free text, P2); recent activity; write-health panel.
5. **Line request** — line.html's job: request for a line, see on-line stock
   (live Line Inventory), assign any catalog part to the line.

## 5. What v2 does NOT do (explicit non-goals)

- No Epicor write-back yet (J4 is improved by surfacing drift, not closed; write-back
  is the planned follow-up once cycle counts are manned).
- No auto-computed reorder points (separate project, data still accumulating).
- No changes to cycle-count portal or KPI board (separate services).
- No framework/build step — hand-over constraint wins over developer ergonomics.

## 6. Test plan on pms-test

1. Deploy with `LOCATIONS_URL` pointed at the production Apps Script (reads are safe;
   writes go to the same sheet — use TEST locations/parts for write testing).
2. Side-by-side week: floor uses v1, supervisor mirrors a sample of actions in v2.
3. Kill-test: restart the Railway service mid-queue → requests must survive.
4. Double-tap test: hammer every confirm button — zero duplicate Transaction Log rows.
5. Bad-place test: try to stow to "WEST  BULK", "3-C3-B", "MR1" as free text — must be
   impossible or explicitly confirmed + flagged.
6. Cut-over: repoint the kiosk bookmarks; keep v1 deployable for a week as rollback.
