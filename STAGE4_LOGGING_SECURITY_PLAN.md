# Calendar Integration Phase 1, Stage 4 — Pre-Deployment Logging Security Plan

Status: **REQUIRED READING BEFORE DEPLOYING `calendarFeed`. Deployment of this function remains BLOCKED until this plan is independently reviewed and its "Deployment/configuration protections required later" section is actually carried out.**

This document exists because the Stage 4 endpoint's entire authorization model is a bearer
token embedded in the request path (`/calendar/<43-char-token>.ics`). Source-code redaction
(never logging the token from application code — implemented, see below) cannot control what
Google/Firebase's own infrastructure logs about the raw incoming request before this
function's code ever runs. This plan treats that as a known, structural property of any
bearer-token-in-URL design, not something to argue away.

## 1. What infrastructure receives the request

1. **Firebase Hosting's edge/CDN** terminates the client's TLS connection and evaluates
   `firebase.json`'s `hosting.rewrites` list. The `/calendar/**` rule (added by this Stage)
   proxies the request to the underlying 2nd-generation Cloud Function.
2. **Cloud Run** is the actual execution substrate for a `firebase-functions/v2/https`
   `onRequest` function — Firebase Functions v2 deploys as a Cloud Run service. The proxied
   request lands on Cloud Run's own request-serving layer before reaching a function
   instance.
3. Depending on project configuration, an underlying **Google Cloud external HTTP(S) load
   balancer** may also sit in this path (Cloud Run's own auto-generated ingress, and/or one
   Firebase Hosting manages on the project's behalf).

## 2. Where the raw request URL/path may be logged automatically

- **Cloud Run's automatic request logging is the primary, well-documented, always-on
  concern.** Cloud Run emits one structured `httpRequest`-shaped log entry to Cloud Logging
  for *every* request it serves, platform-level, independent of anything this function's own
  code does. That entry's `httpRequest.requestUrl` field contains the full request path —
  i.e., the raw bearer token — by default. **This cannot be disabled from inside
  `calendarFeedEndpoint.ts`**; it is emitted by the Cloud Run infrastructure wrapping the
  container, before/after the handler runs, regardless of what the handler logs.
- Any load balancer in front of Cloud Run may separately emit its own request logs (also
  containing the full URL) if load-balancer logging is enabled on that resource — a second,
  independent log sink from the same request.
- Firebase Hosting's own edge-serving logs are not customer-exposed via Cloud Logging in the
  same first-class way Cloud Run's are, but per this Stage's own conservative brief, this
  plan does not assume they are absent — only that they are not something this plan can
  verify or control from source, and the Cloud Run request log above is treated as the
  worst-case, concrete exposure to design against.
- Application-level logging (`console.*` calls inside `calendarFeedEndpoint.ts`) is a
  **separate, much narrower** concern, already closed at the source level — see §7.
- **Request logs and application/container logs are two distinct Cloud Logging streams that
  happen to share the same `resource.type="cloud_run_revision"`.** Cloud Run's automatic
  per-request entry (log id `run.googleapis.com/requests`) is emitted by the platform itself;
  this function's own `console.*` output lands in a *separate* log id
  (`run.googleapis.com/stdout` / `run.googleapis.com/stderr`) under the same resource type.
  Any exclusion control that scopes only to `resource.type`/`resource.labels.service_name`
  without also naming the request-log id specifically would match — and could suppress —
  **both** streams, including this function's own sparse `console.error` output. See §5 for
  why the exclusion filter must be request-log-specific, not resource-type-scoped alone.

## 3. Current applicable log retention

- Google Cloud Logging's `_Default` log bucket has a **30-day default retention** unless a
  project has configured something else. **This project's actual currently-configured
  retention for its `_Default` bucket has not been verified as part of this source-only
  implementation** — no GCP/IAM inspection was performed or authorized for this task. That
  verification is listed as a required pre-deployment step in §6.
- Cloud Run's auto-generated request logs land under the standard `run.googleapis.com`
  request log name and are subject to whatever bucket/sink they route to — by default, the
  same `_Default` bucket and its retention, unless a dedicated sink/exclusion has been
  configured (see §5).

## 4. Which principals/IAM roles can read those logs

Any principal (user or service account) holding `roles/logging.viewer`,
`roles/logging.privateLogViewer`, `roles/owner`, `roles/editor`, or any custom role granting
`logging.logEntries.list` on the GCP project can read these entries, including the raw
request path. **This plan does not have visibility into which principals currently hold
these roles on this project** — no IAM read or mutation was performed or authorized for this
source-only task. Enumerating and reviewing that list (`gcloud projects get-iam-policy`, or
the equivalent Console view) is a required pre-deployment step (§6) — it determines the
actual blast radius of whatever residual log retention this plan cannot eliminate outright.

## 5. What log exclusion/redaction/retention controls are actually possible

- **Log Router exclusion filter, scoped to the REQUEST LOG SPECIFICALLY (recommended primary
  control).** An exclusion filter that names only `resource.type="cloud_run_revision" AND
  resource.labels.service_name="<deployed service name>"` is **too broad** — per §2, that
  resource type is shared by both the automatic request log and this function's own
  application/container output, so a resource-type-only filter would suppress both. The
  filter must additionally scope to the request log's own log identity, e.g.:

  ```
  resource.type="cloud_run_revision"
  resource.labels.service_name="<deployed service name>"
  log_id("run.googleapis.com/requests")
  ```

  (or the exact equivalent `logName="projects/<project>/logs/run.googleapis.com%2Frequests"`
  filter form). This is a genuine, supported GCP capability (`gcloud logging exclusions
  create`, or the Console's Logs Router UI) — not a source-code change — but it must be
  written and verified against the request-log id specifically, never bare resource-type
  matching, or it risks silently deleting this function's only existing application-level
  error signal (see §7).
- **Sinks are evaluated independently — routing to a short-retention sink does NOT, by
  itself, stop the `_Default` sink (or any other applicable sink) from ALSO retaining a full
  copy.** Cloud Logging does not have "first match wins" semantics between sinks: every sink
  whose own inclusion filter matches a given log entry receives a copy, independently of
  every other sink. Creating a dedicated short-retention bucket and routing this request log
  to it is therefore **not, on its own, a fix** — it only adds a short-lived additional copy
  alongside whatever the `_Default` sink (and any other matching sink) already retains at
  its own, longer retention, unless that other retention is *separately* addressed. The
  actually-required control set is:

  **A.** A request-log-specific exclusion (the filter above) applied to the `_Default` sink
  (or to whichever sink is actually responsible for the project's standard retention),
  removing the token-bearing entries from that long-retention destination.
  **B.** *Optionally*, if some operational signal from this route is still wanted despite
  §7's finding, route the (now `_Default`-excluded) request log to a dedicated
  short-retention bucket instead — a genuine complement to (A), not a substitute for it.
  **C.** For EVERY destination capable of receiving matching `calendarFeed` request-log
  entries — not merely a check for whether a duplicate destination *exists* — the
  deployment review must record and verify, per destination:
    - destination identity (bucket/sink name)
    - which sink/router routes matching entries to it
    - whether matching request-log entries are actually included there (inclusion filter
      covers them, and no destination-level exclusion already removes them)
    - that destination's own actual configured retention period (not assumed from a
      platform default)
    - which principals/roles can read that destination
    - whether bearer-token-bearing request paths could therefore persist there, and for
      how long

    This applies to at minimum: the `_Default` sink/bucket; any custom project-level sink;
    any custom log bucket; any folder-level aggregated sink; any organization-level
    aggregated sink; and any other ancestor destination visible/authorized to the
    reviewer. Finding that a duplicate destination merely *exists* is not sufficient —
    each one's retention and readers must be individually confirmed.
  **D.** Verification, against the actual deployed service, that the exclusion is genuinely
  effective (a real request produces no entry under `run.googleapis.com/requests`
  containing the token) — not merely that the filter text was accepted.

- **No partial-field redaction exists** for Cloud Run's auto-generated `httpRequest.requestUrl`
  — the realistic lever is exclude-or-don't for matching entries, not selectively stripping
  the path segment from an otherwise-kept entry. (Redacting *application-level* structured
  logs at the source, by contrast, is fully achievable and already done for the one signal
  this function currently emits — §7.)

## 6. Can these controls exclude/minimize retention without destroying other operationally important logs — and the staged rollout that makes them operationally possible

Yes, **provided the request-log-specific scoping in §5 is used** (not a bare resource-type
filter). A request-log-scoped exclusion (§5.A) does not touch logging for any other function
in this project (`dnsCheckout` webhooks, `notificationReminderDeliveryWorker`, etc. keep
their full, unmodified logging), and — because it is scoped to the request log id
specifically, not the resource type broadly — it also does not touch this function's own
`console.*` output, which lands under a different log id on the same resource. See §7 for an
honest accounting of just how much (or little) that surviving application-log signal
currently is: it is materially less than "every genuine failure path," and that gap is a real
factor to weigh before deciding to exclude the request log at all.

**Sequencing correction (an earlier version of this plan contained an internal
contradiction here, since resolved):** the previous list required knowing the *actual
deployed* Cloud Run/Functions service identity before the exclusion filter could be written,
while simultaneously requiring that exclusion to exist *before this function's first
deployment* — those two requirements cannot both be satisfied by a single "deploy, then
configure" step, since the service identity does not exist until something is deployed, and
the plan is unwilling to let real bearer-token traffic reach a deployed-but-unprotected
route in the gap between the two. The resolution is a **staged rollout** that separates
"deploy enough of the backend to learn its real infrastructure identity" from "expose the
public, bearer-token-bearing calendar subscription route" — these are not the same
event, and conflating them was the source of the contradiction.

**The security boundary this staged rollout enforces: NO REAL BEARER TOKEN TRAFFIC BEFORE
LOGGING CONTROLS ARE VERIFIED.** Deploying the backend service far enough to discover its
own Cloud Run identity is explicitly **not equivalent to** exposing the calendar
subscription feature publicly — the two are separated by design below, and none of this
staged rollout is performed as part of this documentation-only repair; it is recorded here
as the required future procedure.

### PHASE A — deploy backend only; no public bearer route yet

1. Deploy the `calendarFeed` function/backend only as far as needed to establish its actual
   generated Cloud Run service identity. Do **not** deploy or enable the Firebase Hosting
   `/calendar/**` rewrite in this phase (§1) — without that rewrite, the function has no
   product-facing public entry point yet.
2. Do **not** create or distribute any real calendar-subscription bearer URL in this phase.
3. Do **not** send any real bearer token to the function in this phase — any verification
   traffic in Phase A must be structurally incapable of carrying a real subscription's
   secret (there are no real subscriptions whose tokens could be exposed yet, since
   creation and distribution are withheld until Phase D).
4. From the resulting deployment, determine:
   - the exact deployed Cloud Run service name Firebase generated for this function
     (not assumed or guessed from source);
   - the exact request-log `logName`/`log_id` for that specific service;
   - the applicable project- and ancestor-level logging topology (§5.C) that could receive
     copies of that log.

### PHASE B — configure logging security, using the now-known real identity

5. Configure the request-log-specific `_Default` exclusion (§5.A) using the actual service
   identity determined in Phase A step 4 — not a placeholder.
6. If warranted per the §7 observability-gap tradeoff, configure an intentionally retained
   short-retention companion destination (§5.B).
7. Audit all project and ancestor sinks/destinations per the full §5.C checklist — destination
   identity, routing sink, inclusion status, actual configured retention, log-reader
   principals, and bearer-token persistence risk — for every destination capable of
   receiving a copy, not merely confirming duplicates exist.
8. Verify retention (§3) and log-reader IAM (§4) for every matching destination identified in
   step 7, individually.
9. Confirm this function's own application/container logs (the one `console.error` call path
   — §7) remain visible and are unaffected by whatever exclusion was configured in step 5.
10. Verify the exclusion/companion-sink behavior described above using **non-secret,
    synthetic/test requests only** — Phase A step 3's constraint still holds: no real bearer
    token exists yet to accidentally use for this verification.

### PHASE C — verify remaining pre-traffic gates

11. Complete the required Firebase emulator/security/routing test pass this plan's sibling
    completion report already tracks as open (the "Real-emulator gate").
12. Validate the actual `firebase.json` Hosting-rewrite-to-2nd-gen-function schema
    (`functionId` + `region`, as currently written in this Stage's change) against the
    actual pinned `firebase-tools` CLI version — this environment does not have
    `firebase-tools` installed, so the rewrite syntax was written from Firebase's documented
    2nd-gen rewrite contract, not verified end-to-end against a live `firebase deploy --only
    hosting` dry run.
13. Confirm, from the evidence gathered in Phases A–C, that no real bearer credential has yet
    traversed the public route — because that route does not yet exist until Phase D.
14. Tune `maxInstances: 20` (a conservative starting placeholder set in source — see
    `calendarFeedEndpoint.ts`; and see §7/§9 for why this is an instance-scaling bound, not a
    concurrency or rate limit) against actual expected subscriber volume, and decide whether
    an additional deployment-layer control (Cloud Armor, API Gateway quota) is warranted for
    this route beyond it — a deployment-time decision, not required to implement now.

### PHASE D — enable the public calendar subscription route

15. Only after every gate in Phases A–C passes, deploy/enable the Firebase Hosting
    `/calendar/**` rewrite (§1), making the route publicly reachable for the first time.
16. Only then may real bearer-token calendar-subscription URLs be created, distributed, or
    used — Stage 1's `createCalendarSubscription` producing a real, usable feed URL for the
    first time is downstream of this phase, not concurrent with Phases A–C.

## 7. Source-code / deployment-configuration / unavoidable-residual split

**Corrected application-log-visibility accounting (this section previously overstated this —
the claim that "application code already emits its own structured console.error entries for
every genuine failure path" was FALSE and has been removed). Verified directly against
`calendarFeedEndpoint.ts` as currently committed, catch block by catch block, not assumed:**

The file contains exactly one `console.*` call, in the outermost `calendarFeed` wrapper's own
`try`/`catch` around its call to `handleCalendarFeedRequestCore`. Every failure class that can
produce a `{ status: 'unavailable' }` / `{ kind: 'unavailable' }` result — a thrown Firestore
read failure inside `resolveSubscription`, a thrown Firestore read failure reading calendar
preferences, an `accountExists` check throwing something other than "user not found", the
adapter throwing something other than its own `CalendarFeedAdapterError`, or the generator
throwing something other than its own `IcsGenerationError` — is caught **internally**, inside
`resolveCalendarFeedInputCore`/`handleCalendarFeedRequestCore`, and converted into an ordinary
**returned value**, never a re-thrown exception. Because of that, none of those five failure
classes ever reaches the outer wrapper's `catch` block, so **none of them currently produces
an application-level log entry at all.**

The outer wrapper's `console.error` is therefore only reachable by a genuinely unexpected
failure in code outside those already-handled paths (for example, a defect in `extractToken`/
`isFreshFor`/`flooredDate`, or `request.method`/`request.path`/`request.header` itself
throwing) — not by the Firestore/Auth-outage scenarios an operator would most want visibility
into.

**Consequence for §5/§6: if the Cloud Run request log is excluded for this route (per §5's
recommended control) without a compensating change, a real Firestore or Firebase Auth outage
affecting this endpoint would currently produce ZERO Cloud Logging signal from this project**
— no application log (per the accounting above) and no request log (excluded). This is not a
reason to abandon the exclusion (the bearer-token exposure it addresses is real and
higher-severity), but it is a real, currently-true operational gap the pre-deployment
reviewer must weigh explicitly (§6 Phase B, step 6) — e.g. by keeping a short-retention companion
sink (§5.B) specifically because application-level failure visibility is currently this thin,
not merely as a generic caution. **This repair does not add logging to close that gap — per
this repair's own scope, we are repairing the plan's accuracy, not redesigning
observability.**

**Source-code protections implemented now (this Stage 4 candidate):**
- No `console.*` call anywhere in `calendarFeedEndpoint.ts` is ever passed the raw token,
  the resolved request path, or the resolved request URL — verified both by direct reading
  and by a dedicated static test in `calendarFeedEndpoint.test.ts` that greps the stripped
  source for every `console.*` call site and asserts none of them reference `rawToken`,
  `request.path`, `request.url`, or `input.path`, and that the file contains exactly one
  `console.*` call, logging only a fixed literal plus a caught error's own `.message`. (This
  is a source-level regression guard, not a formal runtime redaction guarantee — see §9.)
- Every response — success or failure — sets `Cache-Control: private, ...` (never
  `public`), so no shared/CDN cache is permitted to retain a response tied to a token.
- Conditional-GET (`If-Modified-Since`) support reduces per-request **generator** work and
  **response payload size** for a well-behaved, periodically-repolling client whose copy is
  already current. Corrected claim (an earlier version of this plan overstated this): it
  does **not** reduce request *volume* — a client polls on its own schedule regardless of
  whether the server can answer with a 304 — and it does **not** reduce how often the token
  itself transits the network or appears in a Cloud Run request-log entry, since the token
  is part of the URL on every request, 200 or 304 alike. Corrected claim (an earlier version
  of this plan undercounted this as "both Firestore reads"): a successful request — 200 or
  304 alike — costs this endpoint the full authorization/read pipeline, which is **four
  Firestore document reads** (hash-index lookup, owner subscription document, deletion
  tombstone/account-state document, calendar preferences document) **plus one Firebase Auth
  account lookup** (`getAuth().getUser`). A 304 avoids only `generateCalendarIcs` (ICS
  generation) and the response payload — it does **not** avoid any of those five
  authorization/read operations, which happen identically whether the request ultimately
  returns 200 or 304. See §9 for the corrected cost-amplification accounting.
- `maxInstances: 20` bounds the number of running service *instances* this function can
  scale out to. Corrected claim (an earlier version of this plan called this "a concurrency
  cap," which is inaccurate for 2nd-generation Firebase Functions): **`maxInstances` is an
  instance-scaling bound, not a request-rate or total-concurrency limit.** Per-instance
  concurrency — how many requests a single running instance may serve simultaneously — is a
  separate, independently configured setting/behavior, not something `maxInstances` controls
  directly. Depending on the effective per-instance concurrency, `maxInstances: 20` can
  therefore permit substantially more than 20 requests in flight at once. It bounds
  worst-case *instance count* (and therefore a rough upper bound on total infrastructure
  footprint), not worst-case simultaneous request volume or total log volume over time — see
  §9 for the corrected cost-amplification accounting this implies.

**Deployment/configuration protections required later (before the public route is enabled):**
- Everything in §6's staged rollout (Phases A–D) above.

**Unavoidable residual exposure (present even after every control above is applied):**
- Google's own internal edge/load-balancer infrastructure in front of Cloud Run/Hosting may
  retain short-lived internal operational logs (DDoS protection, abuse detection, global
  routing) that are not customer-configurable via Cloud Logging exclusion filters at all —
  outside any customer IAM/Log Router control entirely. This is the same category of
  exposure any bearer-token-in-URL design has on any cloud provider, which is exactly why
  this Stage's brief already asked this plan to treat it as a conservative baseline
  assumption rather than something to engineer away.
- The client-side calendar application (Apple Calendar, Google Calendar, Outlook, etc.)
  stores the subscribed URL — including the token — in its own local configuration,
  entirely outside this project's control. This is the same accepted tradeoff every
  subscribed-calendar-feed product lives with; it is not unique to this implementation.
- DNS resolver and network-path logging between the client and Google's edge is likewise
  outside this project's control.

## 8. Firestore/Auth TOCTOU (sequential-read race window) — documentation only, no source change

Independent adversarial review (Codex) assessed this separately from logging and gave:
**"FIRESTORE / TOCTOU: QUALIFIED PASS FOR SOURCE; OPEN PRE-DEPLOYMENT GATE."**
`resolveSubscription`'s six steps are ordinary sequential Firestore/Auth reads, not a single
atomic snapshot — a revocation, an account deletion, or a preference edit can commit in the
real window between two of those reads for an already-in-flight request. Codex found no
cross-user resolution and no post-race mutation vulnerability from this (the request is
read-only throughout — see the READ-ONLY GUARANTEE note in `calendarFeedEndpoint.ts`'s own
file header — so the worst case is an already-in-flight request completing against a snapshot that was
valid at the instant each individual read occurred, never a corrupted write or a
cross-account leak), and therefore no source-preservation blocker. This plan does **not**
propose adding a cross-service (Firestore + Firebase Auth) transaction to close this window —
no such primitive exists, and Stage 4 is not being redesigned to invent one.

This is recorded here as a **required real-emulator/pre-deployment test-semantics item**,
not yet exercised by the current fake-Firestore-only test suite. Before deployment, the
real-emulator verification pass (already tracked as open — see the Stage 4 completion
report's own "Real-emulator gate status") must additionally define and exercise:

- A revocation racing an already-in-flight feed request for the same token.
- An account deletion (tombstone write) racing an already-in-flight feed request for the
  same account.
- A calendar-preferences update racing an already-in-flight feed request for the same
  account.
- An explicit, agreed definition of what response an already-in-flight request is allowed to
  produce when it loses such a race (e.g., "may still return the pre-race representation for
  that one in-flight request; the NEXT request must reflect the new state" is the kind of
  boundary this test semantics needs to pin down precisely, not assume).

## 9. Low findings — documented accurately, not treated as blockers

Per Codex's review, the following are real but low-severity, and none of them justifies
building new rate-limiting infrastructure in this repair or any other redesign:

- **One Firestore read for a well-shaped-but-unknown token.** A token that matches
  `RAW_TOKEN_PATTERN` (correct length/alphabet) but does not correspond to any real
  subscription still costs exactly one hash-index `.get()` before `resolveSubscription`
  fails closed at step 1 — cheap, bounded, and already the minimum possible work for that
  case, but worth stating precisely rather than implying zero cost for an unknown token.
- **Valid-token cost amplification.** Once a token is genuinely valid, its holder can request
  it repeatedly at will; the only source-level bounds on the resulting cost are §7's
  `maxInstances` instance-scaling bound (not a concurrency or rate limit — see below) and the
  conditional-GET short-circuit (skips ICS generation only, not the four-Firestore-read-plus-
  one-Auth-lookup resolution pipeline — §7). There is no per-token request-rate limit in
  source, and no total-concurrency limit either.
- **`maxInstances` is neither request-rate limiting nor a total-concurrency limit** — it is an
  instance-scaling bound; per-instance concurrency is a separate setting, so `maxInstances: 20`
  can permit substantially more than 20 requests in flight at once depending on that setting
  — see the corrected §7 bullet above.
- **Conditional requests still perform the full authorization/read work** — a 200 and a 304
  cost identically: four Firestore document reads (hash index, owner subscription, deletion
  tombstone/account state, calendar preferences) plus one Firebase Auth account lookup. Only
  `generateCalendarIcs` and the response payload are skipped on a 304 — see the corrected §7
  bullet above.
- **The static logging-purity test is a source-level regression guard, not a formal runtime
  redaction guarantee.** `calendarFeedEndpoint.test.ts`'s check that no `console.*` call
  references `rawToken`/`request.path`/`request.url`/`input.path` proves the *current*
  source doesn't do this and will catch a *future* source edit that reintroduces it (if the
  test is re-run), but it is a static grep over stripped source text, not a runtime
  enforcement mechanism, and it says nothing about what Cloud Run's own platform-level
  request logging does independently of this file's code (§2, §5).

## Bottom line

The Firebase Hosting `/calendar/**` rewrite (and therefore any real, bearer-token-bearing
calendar subscription URL) must remain unenabled until an operator with actual GCP Console/
`gcloud` access has completed §6's full staged rollout, Phases A through D — including
discovering the real deployed service identity before configuring anything (Phase A), the
request-log-specific exclusion scoping and full per-destination retention audit (Phase B,
incorporating §5's controls and the explicit per-destination checklist in §5.C), the
remaining emulator/routing verification gates and an explicit decision on the current
application-log observability gap (Phase C, incorporating §7's finding) — and only then
Phase D, enabling the public route. The real-emulator TOCTOU test semantics in §8 must also
be defined and exercised before that point. None of this was within the access or
authorization of this source-only implementation task to perform; this plan documents the
required future procedure only.
