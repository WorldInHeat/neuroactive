# Calendar Integration Phase 1, Stage 4 — Pre-Deployment Logging Security Plan

Status: **REQUIRED READING BEFORE PUBLICLY EXPOSING `calendarFeed`. The backend function `calendarFeed` IS deployed (`createTime 2026-09-03T14:44:44Z`, revision `calendarfeed-00001-sox`), per the staged rollout's Phase A (§6). Its PUBLIC route remains BLOCKED: Firebase Hosting's `/calendar/**` rewrite is not live in production (the live Hosting release predates the rewrite's addition to `firebase.json` by roughly 9 days), so no real bearer-token calendar-subscription URL has ever been distributed, and a 30-day request-log query against the deployed service returned zero entries — confirming zero real traffic has occurred. Public exposure (enabling the Hosting rewrite, and only then creating/distributing real subscription URLs) remains BLOCKED until this plan's remaining Phases B, C, and D below are independently reviewed and actually carried out.**

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

**CONFIRMED via real, read-only Phase A production discovery (`gcloud logging buckets list
--project=neuroactive --location=global`), 2026-09-03 — no longer an assumption:**

- `_Default` bucket: **30-day retention**, exactly the GCP standard default — this project
  has not customized it.
- `_Required` bucket (mandatory audit-log categories only — `cloudaudit.googleapis.com/
  activity`, `system_event`, `access_transparency`, and their `externalaudit` equivalents):
  **400-day retention, locked** (cannot be reduced). Not relevant to Cloud Run request
  logs — see §6's confirmed sink topology for why request logs land in `_Default`, not
  `_Required`.
- Cloud Run's auto-generated request logs (`run.googleapis.com/requests`) are subject to
  the `_Default` bucket's 30-day retention above, since (confirmed in §6) no dedicated
  sink/exclusion currently exists for them in this project.

*Re-verify if materially more time has passed before deployment, or if this project's sink/
bucket configuration is known to have changed since this discovery.*

## 4. Which principals/IAM roles can read those logs

**CONFIRMED via real, read-only Phase A production discovery (`gcloud projects
get-iam-policy neuroactive`), 2026-09-03 — the complete roster, not an assumption:**

No dedicated `roles/logging.viewer` or `roles/logging.privateLogViewer` grant exists
anywhere in this project's IAM policy. All logging read access flows through exactly two
broader roles, and the full list of principals holding either is:

- **`roles/owner` → `user:AdamBruene@gmail.com`** — the *only* human principal in the
  entire project IAM policy; full access, including all logs.
- **`roles/editor` → `serviceAccount:1010503840940-compute@developer.gserviceaccount.com`**
  — the default Compute Engine service account. This is the exact same service account
  `calendarFeed` itself will run as once deployed (§1) — a standard, expected GCP pattern
  (the default compute SA is broadly privileged by default), not something specific to this
  project's configuration, but worth naming explicitly since it means the function's own
  runtime identity already has read access to its own request logs regardless of anything
  this plan configures.
- **`roles/editor` → `serviceAccount:1010503840940@cloudservices.gserviceaccount.com`** —
  the Cloud Services default service account (internal GCP infrastructure identity, not
  directly user-controlled).

No `allUsers`, `allAuthenticatedUsers`, or any other unexpected/custom role grant exists
anywhere in the policy. **This represents a small, well-understood blast radius**: one human
owner and two GCP-default service accounts — not a large or surprising set of readers.

*Re-verify if materially more time has passed before deployment, or if this project's IAM
policy is known to have changed since this discovery (`etag: BwZZ_IJkvEQ=` at time of
discovery — a changed etag on re-query is itself a signal the policy has moved).*

## 5. What log exclusion/redaction/retention controls are actually possible

- **Log Router exclusion filter, scoped to the REQUEST LOG SPECIFICALLY (recommended primary
  control).** An exclusion filter that names only `resource.type="cloud_run_revision" AND
  resource.labels.service_name="calendarfeed"` is **too broad** — per §2, that
  resource type is shared by both the automatic request log and this function's own
  application/container output, so a resource-type-only filter would suppress both. The
  filter must additionally scope to the request log's own log identity. **Originally
  predicted via real Phase A production discovery, 2026-09-03, before `calendarFeed` was
  deployed:** this exact service name was derived by direct analogy: every existing 2nd-gen
  `onRequest` function in this project deploys as a Cloud Run service named after the
  function with the name simply lowercased (verified directly, e.g. `handleDnsNoCostCheckout`
  → Cloud Run service `handlednsnocostcheckout`) — so `calendarFeed` was expected to deploy
  as **`calendarfeed`**, in region **`us-central1`** (matching every other function in this
  project and the region already hardcoded in `firebase.json`'s Hosting rewrite). **This
  prediction has since been confirmed against the actual deployed service name** (see below)
  — the analogy was strong (100% consistent across every function checked) and now matches a
  direct observation of `calendarFeed` itself exactly:

  ```
  resource.type="cloud_run_revision"
  resource.labels.service_name="calendarfeed"
  log_id("run.googleapis.com/requests")
  ```

  **`calendarfeed` is now the DIRECTLY OBSERVED live Cloud Run service name** (confirmed via
  `gcloud functions describe calendarFeed --gen2 --region=us-central1`, 2026-09-03, after Phase
  A's backend deployment — see §6), matching the prior analogy-based prediction exactly:
  region `us-central1`, service `calendarfeed`, revision `calendarfeed-00001-sox`. This is no
  longer an inference from a naming convention; it is a direct read of the deployed resource.

  The equivalent `logName` filter form is likewise now concrete rather than a template —
  **CONFIRMED real and readable** via a direct read against an existing function's request
  logs in this exact project (Phase A discovery, 2026-09-03; `httpRequest.requestUrl` was
  observed populated with the full incoming request URL on real entries, confirming this is
  not merely a generic GCP platform assumption but an active, in-project log stream):

  ```
  logName="projects/neuroactive/logs/run.googleapis.com%2Frequests"
  ```

  This is a genuine, supported GCP capability (`gcloud logging exclusions
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

    **THIS AUDIT IS ALREADY COMPLETE, and — as it turns out — trivial. CONFIRMED via real,
    read-only Phase A production discovery (`gcloud logging sinks list --project=neuroactive`
    plus `gcloud projects describe neuroactive --format="value(parent)"`), 2026-09-03:** only
    two sinks exist in this entire project, both GCP-managed defaults — `_Required` (audit-log
    categories only; does not receive Cloud Run request logs) and `_Default` (receives
    everything not claimed by `_Required`, including Cloud Run request logs, per §6's
    confirmed topology). **No custom sink of any kind exists.** The project additionally has
    **no organization or folder parent at all** (confirmed by an empty `parent` field on the
    project resource), so there is no ancestor-sink layer capable of independently capturing a
    copy — the "folder-level aggregated sink" / "organization-level aggregated sink" bullets
    above resolve to *not applicable*, not merely *unaudited*. (A visible organization,
    `adambruene-org` / `organizations/565660327705`, exists for this identity's other
    purposes, but `neuroactive` is not attached to it; separately, and only as an additional
    data point, this identity also lacks `logging.sinks.list` permission on that organization
    — moot given the project has no parent, but recorded for completeness.) Retention and
    readers for the one destination that matters (`_Default`) are confirmed in §3/§4 above.

    *This checklist item is fully satisfied as of the discovery date above. Re-verify at
    actual deployment time only if materially more time has passed, or if this project's
    sink/organization configuration is otherwise known to have changed — do not assume this
    topology is permanent, but do not re-audit from scratch by default either.*
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

**STATUS: COMPLETE as of 2026-09-03, in two sub-steps.** First, a read-only discovery pass
(no deployment, no IAM/Logging mutation, no bearer token traffic anywhere — see §5.C's
confirmation above and §3/§4) inspected the *existing*, already-deployed, comparable
`onRequest` function `handleDnsNoCostCheckout` and predicted the Cloud Run naming
convention, region, service account, and request-log identity/topology this phase exists to
establish — by strong analogy, not yet direct observation. Second, the `calendarFeed`
backend was actually deployed (`createTime 2026-09-03T14:44:44Z`, revision
`calendarfeed-00001-sox`), **without** enabling the Firebase Hosting `/calendar/**` rewrite
(§1) — so the function has no product-facing public entry point yet — and **without**
creating or sending any real bearer token (steps 2–3 below hold by deployment-order
discipline: the rewrite was never enabled, so no real subscription URL could reach the
function even if one existed, and none was created). A fresh, independent adversarial
re-review on 2026-09-03 directly re-observed the deployed function/service metadata and
confirmed it matches the analogy-based prediction exactly, and confirmed a 30-day
request-log query against the live service returns zero entries.

1. Deploy the `calendarFeed` function/backend only as far as needed to establish its actual
   generated Cloud Run service identity. Do **not** deploy or enable the Firebase Hosting
   `/calendar/**` rewrite in this phase (§1) — without that rewrite, the function has no
   product-facing public entry point yet. **DONE, 2026-09-03** — `calendarFeed` is deployed
   (revision `calendarfeed-00001-sox`); the Hosting rewrite was not touched and remains
   not-live in production (confirmed: the live Hosting release predates the rewrite's
   addition to `firebase.json` by roughly 9 days).
2. Do **not** create or distribute any real calendar-subscription bearer URL in this phase.
   **HOLDS** — no subscription-creation code path was exercised; no URL was distributed.
3. Do **not** send any real bearer token to the function in this phase — any verification
   traffic in Phase A must be structurally incapable of carrying a real subscription's
   secret (there are no real subscriptions whose tokens could be exposed yet, since
   creation and distribution are withheld until Phase D). **HOLDS** — a 30-day request-log
   query against the deployed service returned zero entries; no traffic of any kind, bearer
   or otherwise, has reached the function.
4. From the resulting deployment, determine:
   - the exact deployed Cloud Run service name Firebase generated for this function —
     **CONFIRMED by DIRECT OBSERVATION, 2026-09-03: `calendarfeed`, region `us-central1`**,
     matching the earlier analogy-based prediction exactly (`gcloud functions describe
     calendarFeed --gen2 --region=us-central1`);
   - the exact request-log `logName`/`log_id` for that specific service — **CONFIRMED
     real and readable in this project, 2026-09-03:
     `logName="projects/neuroactive/logs/run.googleapis.com%2Frequests"`** (§5);
   - the applicable project- and ancestor-level logging topology (§5.C) that could receive
     copies of that log — **CONFIRMED COMPLETE, 2026-09-03: only `_Default`/`_Required`
     exist, no custom sink, no organization/folder parent** (§5.C, §3, §4).

**Phases B, C, and D remain NOT complete** — see their own sections below for current
status. Nothing in this Phase A update authorizes enabling the public route.

**2026-09-03 addendum — live-exposure window:** between this Phase A backend deployment and
Phase B's logging exclusion being applied, a live-exposure window exists: the direct Cloud
Run (`*.run.app`) and Cloud Functions (`*.cloudfunctions.net`) URLs are platform-
unauthenticated by design (`allUsers: roles/run.invoker`), independently of whether Hosting's
`/calendar/**` rewrite is enabled. The bearer token embedded in the request path is the sole
access control layer for this endpoint — this is expected and accepted per this plan's own
staged-rollout design (§1), not a defect, but it means the window is not zero-risk merely
because Hosting is disabled: anyone who discovers either direct URL could reach the function
today (though, per Phase A step 3 above, no real bearer token exists yet for them to use).
This motivates completing Phase B promptly rather than leaving it open-ended.

### PHASE B — configure logging security, using the now-known real identity

5. Configure the request-log-specific `_Default` exclusion (§5.A) using the actual service
   identity determined in Phase A step 4 — not a placeholder.
6. If warranted per the §7 observability-gap tradeoff, configure an intentionally retained
   short-retention companion destination (§5.B).
7. Audit all project and ancestor sinks/destinations per the full §5.C checklist — destination
   identity, routing sink, inclusion status, actual configured retention, log-reader
   principals, and bearer-token persistence risk — for every destination capable of
   receiving a copy, not merely confirming duplicates exist. **ALREADY DONE, 2026-09-03 —
   see §5.C's confirmation block**: only `_Default`/`_Required` exist, no custom sink, no
   organization/folder ancestor layer. Re-verify only if materially more time has passed or
   the project's sink/organization configuration is otherwise known to have changed.
8. Verify retention (§3) and log-reader IAM (§4) for every matching destination identified in
   step 7, individually. **ALREADY DONE, 2026-09-03 — see §3 (30 days / `_Default`, 400 days
   locked / `_Required`) and §4 (one human owner, two default service accounts, no dedicated
   logging-role grants, no unexpected principals).**
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
14. Tune `maxInstances` (see `calendarFeedEndpoint.ts`; and see §7/§9 for why this is an
    instance-scaling bound, not a concurrency or rate limit) against actual expected
    subscriber volume, and decide whether an additional deployment-layer control (Cloud
    Armor, API Gateway quota) is warranted for this route beyond it — a deployment-time
    decision.

    **RESOLVED, 2026-09-03 — source now tightened from the platform default:** Phase A
    discovery observed `maxInstanceRequestConcurrency: 80` on the comparable existing
    function `handleDnsNoCostCheckout` (the Firebase Functions v2 platform default —
    `calendarFeed`'s source sets no explicit per-instance concurrency either, so it inherits
    the same default once deployed). At the platform default of `maxInstances: 20`, this
    produced a worst-case ceiling of `20 × 80 = 1,600` concurrent requests for a public,
    bearer-token-gated, Firestore-reading endpoint — judged more headroom than early-stage
    subscriber traffic needs. **`calendarFeedEndpoint.ts` has been updated to
    `maxInstances: 5`**, deliberately below the platform default, yielding a worst-case
    ceiling of `5 × 80 = 400` concurrent requests — comfortably above any realistic
    legitimate load for a low-volume individual-subscriber feed, while meaningfully reducing
    worst-case cost/abuse exposure. This was previously an open decision item for a human;
    it is now resolved in source. Remaining options (not applied, available for future
    reconsideration if real traffic patterns warrant): tune `maxInstances` further,
    explicitly configure a lower per-instance concurrency, or add a deployment-layer control
    (Cloud Armor, API Gateway quota — already named above).

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
- `maxInstances: 5` bounds the number of running service *instances* this function can
  scale out to. Corrected claim (an earlier version of this plan called this "a concurrency
  cap," which is inaccurate for 2nd-generation Firebase Functions): **`maxInstances` is an
  instance-scaling bound, not a request-rate or total-concurrency limit.** Per-instance
  concurrency — how many requests a single running instance may serve simultaneously — is a
  separate, independently configured setting/behavior, not something `maxInstances` controls
  directly. **CONFIRMED via real, read-only Phase A production discovery, 2026-09-03:** the
  effective default for this environment is `maxInstanceRequestConcurrency: 80` (2nd-gen
  Cloud Functions default; confirmed by direct observation of the now-deployed `calendarFeed`
  service itself, which does not override it). At the platform default of `maxInstances: 20`,
  this would have yielded a worst-case
  ceiling of `20 × 80 = 1,600` concurrent in-flight requests — not an abstract "substantially
  more than 20," but this specific number — for a public, bearer-token-gated endpoint. Source
  has since been tightened to `maxInstances: 5` (see §6 Phase C step 14), yielding a
  worst-case ceiling of `5 × 80 = 400` concurrent in-flight requests instead. It bounds
  worst-case *instance count* (and therefore a rough upper bound on total infrastructure
  footprint), not worst-case simultaneous request volume or total log volume over time — see
  §9 for the corrected cost-amplification accounting this implies, and see §6 Phase C step 14
  for the now-resolved decision on this figure.

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
  instance-scaling bound; per-instance concurrency is a separate setting. **CONFIRMED via real,
  read-only Phase A production discovery, 2026-09-03:** the effective default
  `maxInstanceRequestConcurrency: 80` means source's current `maxInstances: 5` yields a
  concrete worst-case ceiling of `5 × 80 = 400` requests in flight at once (the platform
  default of `maxInstances: 20` would have yielded `1,600`) — see the corrected §7 bullet
  above and §6 Phase C step 14 for the now-resolved decision on this figure.
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
`gcloud` access has completed §6's full staged rollout, Phases A through D. **Phase A is now
marked COMPLETE (2026-09-03)**, in two parts: (1) real, read-only production discovery
(analogy-based service identity/log-name confirmation, sink topology, retention, and IAM
audit), and (2) the actual backend deployment of `calendarFeed` itself (revision
`calendarfeed-00001-sox`), performed **without** enabling the Hosting `/calendar/**` rewrite
and **without** sending any bearer token through production. The service identity is now
confirmed by direct observation of the deployed function/service, not merely by analogy to
`calendarFeed`'s sibling functions (a fresh, independent adversarial re-review on 2026-09-03
re-confirmed this and found zero request-log entries in a 30-day window). The actual safety
property this plan relies on is **not** "nothing was deployed" — it is: the public Hosting
route is disabled, no real bearer token has ever been created or distributed, and zero real
traffic has reached the function. What remains is: the request-log-specific exclusion
scoping and full per-destination retention audit (Phase B, incorporating §5's controls and
the explicit per-destination checklist in §5.C — largely already confirmed per §5.C and §§3-4,
but not yet *configured*), and the remaining emulator/routing verification gates (Phase C,
incorporating §7's finding; the maxInstances concurrency-ceiling decision that was open in
Phase C is now RESOLVED — source tightened to `maxInstances: 5` / 400-concurrent worst case,
see §6 Phase C step 14) — and only then Phase D, enabling the public route. The
real-emulator TOCTOU test semantics in §8 must also be defined and exercised before that
point. Phases B, C, and D remain NOT complete and are not authorized by this update; this
plan documents the required future procedure only. See §6's 2026-09-03 addendum for the
live-exposure window this backend-deployed/route-disabled state implies while Phase B is
still pending.
