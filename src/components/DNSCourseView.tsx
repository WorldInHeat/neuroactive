// src/components/DNSCourseView.tsx
// 12-Week DNS Foundations course. Structurally separate from DECISION_TREE —
// does not touch activePrescriptions, history, or any assessment-flow state.
import { useEffect, useState, type ReactElement } from 'react';
import type { Auth } from 'firebase/auth';
import { ArrowLeft, CheckCircle, ChevronLeft, ChevronRight, HelpCircle, Lock, User, X } from 'lucide-react';
import { DNS_COURSE, DNS_COURSE_LENGTH } from '../data/dnsCourse';
import type { DNSCourseDay } from '../data/dnsCourse';
import { computeDnsDayAvailability } from '../services/dnsCourseProgression';
import type { DnsCourseProgress } from '../state/types';
import type { PriceKey } from '../services/stripe';
import { fetchDnsCourseDayMedia, type DnsCourseDayMedia } from '../services/dnsCourseMedia';
import VideoPlayer from './VideoPlayer';
import Paywall from './Paywall';
import DNSProgramIntroduction from './DNSProgramIntroduction';
import InstallPromptCard from './InstallPromptCard';

// The History tab can only ever know about completions from this date forward —
// dnsCourse.completionDates isn't backfilled for anything completed earlier.
const HISTORY_TRACKING_STARTED = '2026-08-13';
const HISTORY_TRACKING_STARTED_LABEL = new Date(`${HISTORY_TRACKING_STARTED}T00:00:00`).toLocaleDateString('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

// Session-only "which tab/day was I on" restoration — mirrors App.tsx's
// CURRENT_VIEW_STORAGE_KEY pattern; never a security boundary (every candidate is
// re-validated against live dnsCourse.currentDay/isQaOwner below before ever being
// applied), and never touches the URL or window.history. Key name duplicated in App.tsx
// (not imported — this patch is scoped to not add new shared modules) purely so
// sign-out/uid-change resets there can clear it too; keep both in sync if this name ever
// changes.
const DNS_COURSE_SUBVIEW_STORAGE_KEY = 'na_dns_course_subview';

// A throwing or unavailable Storage implementation must never break mounting this view.
function safeSessionStorageGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSessionStorageSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // best-effort only
  }
}

type StoredSubView = { activeTab: 'today' | 'past' | 'history' | 'qa'; viewingDay: number | null };

// --- Two-phase restoration ---
// Phase 1 (structural, below): can run the instant the component mounts, with no
// dependency on dnsCourse/isQaOwner having hydrated from Firestore yet. Only checks
// shape — is this parseable JSON, is activeTab one of the four known literals, is
// viewingDay either absent/null or an integer within the course's ABSOLUTE bounds
// (1..DNS_COURSE.length, not "unlocked as of right now"). Anything else (wrong type,
// out-of-absolute-bounds, an unknown tab literal) is treated as corrupted/untrustworthy
// and the WHOLE candidate is rejected — unlike phase 2 below, this phase never
// degrades a single field and keeps the rest; a structurally wrong shape gets no benefit
// of the doubt at all.
//
// Phase 2 (context-dependent, validateSubViewCandidate below): must NOT run until
// dnsHydrationReady is true (both the first userData and first entitlement snapshot have
// resolved for the current uid — see App.tsx) — before that, dnsCourse.currentDay is
// still the DEFAULT_DNS_COURSE placeholder (1) and isQaOwner is still necessarily false
// (dnsEntitlementState hasn't left 'loading' yet), so validating against them would
// reject perfectly legitimate restorable state (e.g. a real Past Day 5 rejected because
// the placeholder currentDay is 1) — this was the exact hydration race this repair
// fixes. Once hydration is ready, this runs the same "is this day/tab actually
// authorized right now" checks the previous single-phase version did.
function parseRawSubViewCandidate(raw: string | null): StoredSubView | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const tab = obj.activeTab;
  if (tab !== 'today' && tab !== 'past' && tab !== 'history' && tab !== 'qa') return null;

  const rawDay = obj.viewingDay;
  if (rawDay === null || typeof rawDay === 'undefined') {
    return { activeTab: tab, viewingDay: null };
  }
  // Any other type/shape, or an integer outside the course's absolute bounds, is
  // "dangerous"/corrupted — reject the WHOLE candidate rather than silently coercing it.
  if (typeof rawDay !== 'number' || !Number.isInteger(rawDay) || rawDay < 1 || rawDay > DNS_COURSE.length) {
    return null;
  }
  return { activeTab: tab, viewingDay: rawDay };
}

// Phase 2 — see the block comment above. Validates an already structurally-valid
// candidate against LIVE dnsCourse/isQaOwner. A day that isn't legitimately unlocked (or
// a QA tab for a non-owner) is silently dropped, falling back to the safe default
// instead of being applied. This can never unlock a future day, bypass pacing, or bypass
// entitlement: getDnsCourseDayMedia still independently re-checks entitlement
// server-side for whatever day ends up rendered, exactly as for a normal manual visit.
function validateSubViewCandidate(
  candidate: StoredSubView,
  dnsCourse: DnsCourseProgress,
  isQaOwner: boolean
): StoredSubView | null {
  const { activeTab: tab, viewingDay: rawDay } = candidate;
  if (tab === 'qa' && !isQaOwner) return null;

  // Today/History always restore to their own default content (Today has no separate
  // "day" concept here; History restores to the calendar grid, not a specific opened
  // day) — keeps Today/Past Days restoration unambiguous rather than risking a leftover
  // viewingDay from a different tab being shown under the wrong one.
  if (tab === 'today' || tab === 'history') return { activeTab: tab, viewingDay: null };
  if (rawDay === null) return { activeTab: tab, viewingDay: null };

  if (tab === 'qa') {
    // The QA browser intentionally exposes every real day regardless of currentDay —
    // isQaOwner is already re-verified live above, never trusted from the stored value.
    return { activeTab: tab, viewingDay: rawDay };
  }

  // tab === 'past': only ever a day that's actually already in pastDays (1..currentDay-1).
  if (rawDay < dnsCourse.currentDay) {
    return { activeTab: tab, viewingDay: rawDay };
  }
  return { activeTab: tab, viewingDay: null };
}

type Props = {
  dnsCourse: DnsCourseProgress;
  onUpdateDnsCourse: (updates: Partial<DnsCourseProgress>) => void;
  // Transactional Mark Complete action (see App.tsx's completeDnsCourseDay) — the ONLY
  // path that ever advances currentDay/completionDates, so a double-click or a race
  // between two tabs can never regress progress or double-advance past the calendar
  // ceiling. onUpdateDnsCourse above remains the path for the separate, idempotent
  // startedAt-only write ("Start Week 1, Day 1"), which carries no such race risk.
  // expectedCompletedDay is the day THIS render actually displayed (availability.openDay)
  // — never re-derived from dnsCourse.currentDay inside the transaction, so a stale tab
  // can never have its click silently reinterpreted as completing a different, later day.
  onCompleteDay: (today: string, expectedCompletedDay: number) => Promise<void>;
  today: string; // local calendar date, e.g. from todayLocalISO()
  // Server-verified DNS Foundations entitlement — 'loading' until the first snapshot for
  // the current uid resolves. Only 'entitled' unlocks anything; both 'loading' and
  // 'not-entitled' render as locked, so a legitimate purchaser sees a brief loading state
  // rather than a paywall flash, without ever trusting an unresolved/stale value.
  dnsEntitlementState: 'loading' | 'entitled' | 'not-entitled';
  // True only once BOTH the first userData/main snapshot and the first entitlement
  // snapshot have resolved (success, deterministic absence, or error) for the exact uid
  // currently mounted here (this component is itself keyed on uid in App.tsx, so a real
  // uid change always remounts a fresh instance rather than this prop ever flipping
  // false-to-true-to-false again mid-mount for a different owner). Stored sub-view
  // restoration must not be validated against dnsCourse/isQaOwner until this is true —
  // see the render-time restoration adjustment below (restorationFinalized), which reads
  // this value directly rather than watching for a transition into true.
  dnsHydrationReady: boolean;
  onBack: () => void;
  onOpenSettings: () => void;
  auth: Auth | null;
  checkoutLoading: PriceKey | null;
  setCheckoutLoading: (key: PriceKey | null) => void;
  onGoogleSignIn: () => void;
  onSendSignInLink: (email: string) => Promise<void>;
  onCreatePasswordAccount: (email: string, password: string) => Promise<'ok' | 'account-exists'>;
  onSignInWithPassword: (email: string, password: string) => Promise<void>;
  signInLoading: boolean;
  signInError: string | null;
  isInAppBrowser: boolean;
};

// Standard 7-column month grid: null for the leading/trailing blanks that pad the first
// and last weeks out to full rows, otherwise the day-of-month number and its ISO date.
type CalendarCell = { date: number; iso: string } | null;
function buildCalendarCells(year: number, month: number): CalendarCell[] {
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: CalendarCell[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: d, iso: `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}` });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

// Week badge + heading + video (or placeholder) + description — the content shared by
// both the current day and whichever past day is being reviewed. Reuses VideoPlayer
// rather than duplicating video-playing logic.
// Vimeo credentials aren't in the client bundle (security fix — see
// functions/src/index.ts: getDnsCourseDayMedia) — fetched on demand per day, only
// succeeds for an authenticated, DNS-entitled caller. The parent renders this with
// `key={dayIndex}` so switching days remounts a fresh instance (empty media/failed
// state) rather than needing an explicit reset inside the effect. A stale in-flight
// request is ignored via the `cancelled` flag rather than shown once it resolves after
// the component has already unmounted for a different day.
function DayVideo({ dayIndex, title }: { dayIndex: number; title: string }) {
  const [media, setMedia] = useState<DnsCourseDayMedia | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchDnsCourseDayMedia(dayIndex)
      .then((result) => { if (!cancelled) setMedia(result); })
      .catch((err) => {
        console.error('[DNS course] video fetch failed:', err);
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [dayIndex]);

  if (failed) {
    return (
      <div className="bg-[#0f1829] border border-[#1a2a42] rounded-xl aspect-video flex items-center justify-center mb-6">
        <p className="text-[#6b849e] text-sm font-semibold">Couldn't load this video — try again shortly.</p>
      </div>
    );
  }

  if (!media) {
    return (
      <div className="bg-black rounded-xl aspect-video flex items-center justify-center mb-6 animate-pulse">
        <p className="text-[#6b849e] text-sm font-semibold">Loading video…</p>
      </div>
    );
  }

  return (
    <VideoPlayer
      nodeId={`dns_course_day_${dayIndex}`}
      title={title}
      videoId={media.videoId}
      hash={media.hash}
      autoplayToken={null}
      onConsumeAutoplay={() => {}}
    />
  );
}

function DayContent({ day, dayIndex }: { day: DNSCourseDay; dayIndex: number }) {
  return (
    <>
      <div className="text-center mb-6">
        <div
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold mb-3"
          style={{ backgroundColor: 'rgba(0,212,200,0.1)', color: '#00d4c8', border: '1px solid rgba(0,212,200,0.3)' }}
        >
          {day.weekPhase} · Week {day.week} of 12
        </div>
        <h1 className="text-2xl font-bold text-[#f0f4f8]">
          Week {day.week}, Day {day.day}
        </h1>
        <p className="text-[#6b849e] text-sm mt-1">{day.weekTitle}</p>
      </div>

      {day.hasVideo ? (
        <DayVideo key={dayIndex} dayIndex={dayIndex} title={day.dayTitle} />
      ) : (
        <div className="bg-[#0f1829] border border-[#1a2a42] rounded-xl aspect-video flex items-center justify-center mb-6">
          <p className="text-[#6b849e] text-sm font-semibold">Video coming soon</p>
        </div>
      )}

      <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42] mb-6">
        <h2 className="text-lg font-bold text-[#f0f4f8] mb-2">{day.dayTitle}</h2>
        <p className="text-[#6b849e] text-sm leading-relaxed">{day.description}</p>
      </div>
    </>
  );
}

// Shared between the one-time pre-Day-1 gate below and the revisitable "Before You
// Start" guidance entry, so the copy lives in exactly one place.
function BeforeYouStartContent() {
  return (
    <>
      <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42] mb-6">
        <h2 className="text-lg font-bold text-[#f0f4f8] mb-2">What is DNS?</h2>
        <p className="text-[#6b849e] text-sm leading-relaxed">
          Dynamic Neuromuscular Stabilization is based on how a healthy infant learns to move — rolling, crawling, standing — before ever being taught. Those early patterns wire in a stabilization strategy your nervous system is supposed to use for life. Most adults have drifted from it, usually without knowing. This program rebuilds it, one developmental position at a time, in the same sequence a body learns it naturally.
        </p>
      </div>

      <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42] mb-6 space-y-5">
        <div>
          <h3 className="font-bold text-[#f0f4f8] mb-1">It's okay to repeat a day.</h3>
          <p className="text-[#6b849e] text-sm leading-relaxed">
            If Day 4 didn't feel right, do it again tomorrow. The calendar isn't the point — the movement is. Some weeks will click fast. Others will take longer. Both are normal.
          </p>
        </div>
        <div>
          <h3 className="font-bold text-[#f0f4f8] mb-1">Quality beats quantity, every time.</h3>
          <p className="text-[#6b849e] text-sm leading-relaxed">
            A position done with real control for 30 seconds is worth more than five minutes of gritting through it. If it feels like survival, it's not working yet — go back and find the version that feels effortless.
          </p>
        </div>
        <div>
          <h3 className="font-bold text-[#f0f4f8] mb-1">You can't cheat this.</h3>
          <p className="text-[#6b849e] text-sm leading-relaxed">
            Rushing to the next day before you're ready doesn't get you there faster. It just means you build the next position on a foundation that isn't set. Be honest with yourself about where you actually are.
          </p>
        </div>
        <div>
          <h3 className="font-bold text-[#f0f4f8] mb-1">Missing a day won't set you back.</h3>
          <p className="text-[#6b849e] text-sm leading-relaxed">
            Life happens. Come back whenever you're ready — your progress is exactly where you left it.
          </p>
        </div>
        <p className="text-[#f0f4f8] text-sm font-semibold text-center pt-2">This isn't a race. It's practice.</p>
      </div>
    </>
  );
}

function HowMuchToPracticeContent() {
  const paragraphs = [
    "The daily video itself is short, but we recommend doing your DNS exercises for 10–15 minutes once per day when you're starting out (this can grow to 10–20 minutes as you progress).",
    "Why so little? Because these movements and positions are already wired into your brain from early development — you're not learning something new, you're reminding your brain of what it already knows. That's why a relatively short amount of focused practice is enough to create real, lasting change: it works at a subconscious (subcortical) level, below the reach of conscious effort or willpower.",
    "Do the new exercise of the day first, then spend the remaining time returning to something from past days or weeks — unless you need the full time just to feel comfortable with the new movement, in which case, that's completely fine too.",
    "Quality over quantity — only perfect practice makes perfect. If you're the type to want to do more, it's better to split your practice into two separate 10–15 minute sessions than one 40-minute session. Longer single sessions increase the chance that fatigue creeps in and you start compensating — at which point you're no longer training the movement, you're training the compensation.",
    "If a new exercise feels difficult or unfamiliar, it's completely okay to stay on it for a few extra days before moving forward — there's no rush. And if something feels hard or uncomfortable later on, even weeks after you've moved past it, it's okay to come back to it. The videos will always be there waiting for you when you're ready.",
    'Throughout every session, keep coming back to the fundamentals: abdominal breathing, nasal breathing, fixed points, and joint centration (once you understand these concepts).',
    "Once your 12 weeks are complete, you're free to pick and choose whichever positions and movements serve you best going forward — but keep checking back in on the others, especially the foundational ones, often.",
  ];
  return (
    <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42] space-y-4">
      {paragraphs.map((p, i) => (
        <p key={i} className="text-[#6b849e] text-sm leading-relaxed">
          {p}
        </p>
      ))}
    </div>
  );
}

// Small, deliberately generic list+modal pattern — more reference entries will likely be
// added later, so each entry is just a label + title + content renderer.
type GuidanceEntry = { id: string; label: string; title: string; Content: () => ReactElement };

const GUIDANCE_ENTRIES: GuidanceEntry[] = [
  { id: 'before-you-start', label: 'Before You Start', title: 'Before You Start', Content: BeforeYouStartContent },
  { id: 'how-much-to-practice', label: 'How Much to Practice', title: 'How Much to Practice', Content: HowMuchToPracticeContent },
];

// null = closed, 'list' = the entry list, otherwise a GuidanceEntry id.
function GuidanceModal({ view, onNavigate, onClose }: { view: string; onNavigate: (view: string) => void; onClose: () => void }) {
  const activeEntry = view !== 'list' ? GUIDANCE_ENTRIES.find((e) => e.id === view) : undefined;

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm animate-fade-in">
      <div className="bg-[#0f1829] max-w-lg w-full rounded-xl shadow-2xl max-h-[85vh] flex flex-col border border-[#1a2a42]">
        <div className="p-4 border-b border-[#1a2a42] flex items-center justify-between flex-shrink-0">
          {activeEntry ? (
            <button
              onClick={() => onNavigate('list')}
              className="text-[#6b849e] hover:text-[#f0f4f8] flex items-center gap-1 text-sm transition-colors"
            >
              <ArrowLeft size={16} /> Back
            </button>
          ) : (
            <div className="w-12" />
          )}
          <div className="font-semibold text-[#f0f4f8] text-center flex-1 truncate px-2">
            {activeEntry ? activeEntry.title : 'Guidance'}
          </div>
          <button onClick={onClose} className="text-[#6b849e] hover:text-[#f0f4f8] transition-colors" aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className="p-6 overflow-y-auto flex-1">
          {activeEntry ? (
            <activeEntry.Content />
          ) : (
            <div className="space-y-3">
              {GUIDANCE_ENTRIES.map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => onNavigate(entry.id)}
                  className="w-full bg-[#080d1a] p-4 rounded-lg border border-[#1a2a42] flex items-center justify-between hover:border-[#00d4c8]/40 transition-all text-left"
                >
                  <span className="text-sm font-semibold text-[#f0f4f8]">{entry.label}</span>
                  <ChevronRight size={16} className="text-[#6b849e] flex-shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Shown on the Today tab, alongside (not instead of) today's lesson, once it's already
// been marked complete — a visual acknowledgment in place of the Mark Complete button,
// not a replacement for the lesson content itself. Today's video/description stay
// mounted and replayable; this never triggers a write on its own (see the render branch
// below), so revisiting/refreshing/replaying is always idempotent.
function CompletedTodayBanner({ completedDayIndex, nextDayIndex }: { completedDayIndex: number; nextDayIndex: number | null }) {
  return (
    <div className="bg-[#0f1829] p-4 rounded-2xl border border-[#00e096]/20 flex items-center gap-3">
      <CheckCircle className="text-[#00e096] flex-shrink-0" size={22} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-[#f0f4f8]">Day {completedDayIndex} complete</p>
        <p className="text-xs text-[#6b849e]">
          {nextDayIndex !== null ? `Day ${nextDayIndex} unlocks tomorrow — this one's still here to replay anytime.` : 'Nice work today.'}
        </p>
      </div>
    </div>
  );
}

// Shown on the Today tab once currentDay has advanced past the last real day — i.e. Day
// 84 has been completed. Reuses the same success/terminal visual language as
// TodayCompletionWaitState (this is also a completion state, just a permanent one, not a
// same-day pacing wait) rather than the old standalone full-screen version, so the tab
// bar stays visible and Past Days/History remain reachable for rewatching Day 84.
function CourseCompleteState({ onReviewPastDays }: { onReviewPastDays: () => void }) {
  return (
    <div className="bg-[#0f1829] p-8 rounded-2xl border border-[#00e096]/20 text-center">
      <CheckCircle className="text-[#00e096] mx-auto mb-3" size={40} />
      <h2 className="text-xl font-bold text-[#f0f4f8] mb-1">Course Complete</h2>
      <p className="text-[#6b849e] text-sm mb-6">You've completed all 84 days of the DNS Foundations program.</p>
      <button
        onClick={onReviewPastDays}
        className="px-6 py-3 rounded-xl font-bold text-sm text-[#080d1a] hover:opacity-90 active:scale-95 transition-all"
        style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
      >
        Review Past Days
      </button>
    </div>
  );
}

// Internal QA affordance — lets the owner open any of the 84 real lesson days for
// verification, regardless of dnsCourse.currentDay. Hardcoded Firebase UID (not email),
// same pattern as functions/scripts/grantBetaEntitlement.js: no lookup/resolution logic,
// just an explicit allowlist. This is a UI-visibility check only, never a security
// boundary — isQaOwner below also requires dnsEntitlementState === 'entitled', and every
// QA-opened lesson still goes through the same fetchDnsCourseDayMedia -> the
// getDnsCourseDayMedia entitlement check server-side, unchanged.
const QA_OWNER_UIDS = ['y8ZkA5HM93gcwGrhXHUMf3fBue32'];

export default function DNSCourseView({
  dnsCourse,
  onUpdateDnsCourse,
  onCompleteDay,
  today,
  dnsEntitlementState,
  dnsHydrationReady,
  onBack,
  onOpenSettings,
  auth,
  checkoutLoading,
  setCheckoutLoading,
  onGoogleSignIn,
  onSendSignInLink,
  onCreatePasswordAccount,
  onSignInWithPassword,
  signInLoading,
  signInError,
  isInAppBrowser,
}: Props) {
  // Hooks must run unconditionally, before the early returns below.

  // isOwnerUid alone is never a security boundary — it only ever gates UI reachability.
  // Real access is still enforced by dnsEntitlementState (isQaOwner below, and the
  // unmodified entitlement/paywall check further down) and, independently, by
  // getDnsCourseDayMedia server-side.
  const isOwnerUid = QA_OWNER_UIDS.includes(auth?.currentUser?.uid ?? '');
  const isQaOwner = dnsEntitlementState === 'entitled' && isOwnerUid;

  // Phase 1 (structural) — read and shape-validate the stored candidate exactly once, at
  // mount, via useState's lazy initializer. Deliberately does NOT depend on
  // dnsCourse/isQaOwner (see parseRawSubViewCandidate's block comment above) — this is
  // always safe to compute immediately, before Firestore hydration.
  const [pendingCandidate] = useState<StoredSubView | null>(() =>
    parseRawSubViewCandidate(safeSessionStorageGet(DNS_COURSE_SUBVIEW_STORAGE_KEY))
  );

  // activeTab/viewingDay start at their coherent safe defaults, NEVER at pendingCandidate
  // directly — applying the candidate before dnsCourse/isQaOwner have hydrated from
  // Firestore is exactly the race this repair closes (a real Past Day 5 rejected against
  // the DEFAULT_DNS_COURSE placeholder currentDay of 1, etc.). The restoration effect
  // below is the only place these are ever set to anything else, and only once.
  const [activeTab, setActiveTab] = useState<'today' | 'past' | 'history' | 'qa'>('today');
  const [viewingDay, setViewingDay] = useState<number | null>(null);

  // Gates the persistence effect further below: sessionStorage must never be overwritten
  // with the temporary 'today'/null defaults above while the restoration decision is
  // still pending — that overwrite (firing on every mount, before hydration had a chance
  // to complete) was the actual mechanism of the bug this repair fixes, not just a
  // display glitch: it permanently destroyed the real candidate in storage too. Also
  // guards Phase 2 (right below) against ever reapplying pendingCandidate after the user
  // has since navigated on their own, once it's flipped true.
  const [restorationFinalized, setRestorationFinalized] = useState(false);

  // Phase 2 (context validation + apply) — fires on any render where dnsHydrationReady
  // is true AND restoration hasn't been finalized yet (readiness-based, not a
  // false-to-true transition: a transition comparison against a prevHydrationReady seeded
  // from dnsHydrationReady's OWN initial value is false on the very first render whenever
  // this component happens to mount with dnsHydrationReady already true — e.g. hydration
  // settling before this component's first render — so no transition is ever observed and
  // restoration, and therefore persistence, would stay disabled forever. Reading
  // readiness directly instead removes that failure mode entirely). This is React's
  // documented "adjust state during render" pattern — the SAME shape as
  // isQaOwner/prevIsQaOwner just below — deliberately NOT a useEffect: an effect version
  // needs a ref (mutated inside the effect) to guard against re-firing on every later
  // dnsCourse/isQaOwner change, and mutating a ref is a side effect in its own right,
  // which is exactly what react-hooks/set-state-in-effect flags — moving the whole
  // decision into the render phase avoids that guard needing a ref at all.
  // restorationFinalized is the one-shot guard: once true, this block can never run its
  // body again, so a later completed day, entitlement change, or Strict Mode's dev-only
  // double-invocation of the render function can never reapply — or re-reject — the
  // candidate. Strict Mode safety follows from React's render-phase-update guarantee: a
  // setState called during render is applied before any subsequent invocation of that
  // same render observes the old value, so restorationFinalized already reads true by the
  // second (Strict Mode) invocation, and the `!restorationFinalized` guard below is
  // false on it.
  if (dnsHydrationReady && !restorationFinalized) {
    if (pendingCandidate) {
      const validated = validateSubViewCandidate(pendingCandidate, dnsCourse, isQaOwner);
      if (validated) {
        setActiveTab(validated.activeTab);
        setViewingDay(validated.viewingDay);
      }
      // else: rejected — activeTab/viewingDay simply stay at the coherent safe
      // defaults already in place since mount ('today'/null).
    }
    // No candidate at all (first-time visitor, or App.tsx's owner-binding check
    // already cleared it for a mismatched/missing owner) — nothing to apply; same
    // safe defaults.
    setRestorationFinalized(true);
  }

  const [historyMonth, setHistoryMonth] = useState(() => {
    const [y, m] = today.split('-').map(Number);
    return { year: y, month: m - 1 }; // 0-indexed month, to match Date's convention
  });
  // null = closed, 'list', or a GuidanceEntry id — purely local overlay state, so closing
  // it never touches activeTab, viewingDay, dnsCourse, or the parent's currentView.
  const [guidanceView, setGuidanceView] = useState<string | null>(null);
  // Navigation-only state: advancing from the public program introduction to the
  // paywall never writes user/course data and never participates in authorization.
  const [showPaywall, setShowPaywall] = useState(false);

  // Session-only refresh convenience (see DNS_COURSE_SUBVIEW_STORAGE_KEY) — never a
  // routing mechanism, never touches the URL/window.history. Gated on
  // restorationFinalized (see above) so this can never fire — and so never overwrite a
  // still-valid stored candidate with the provisional pre-hydration defaults — before
  // Phase 2 has had a chance to run. Every ordinary user-driven tab/day change after that
  // point persists exactly as before.
  useEffect(() => {
    if (!restorationFinalized) return;
    safeSessionStorageSet(DNS_COURSE_SUBVIEW_STORAGE_KEY, JSON.stringify({ activeTab, viewingDay }));
  }, [activeTab, viewingDay, restorationFinalized]);

  // QA is a local convenience for one hardcoded uid and must never survive a uid change or
  // entitlement loss into a different session on the same mounted instance — closes the
  // moment isQaOwner drops, same defensive shape as entitlementUidRef/dnsCourseUidRef in
  // App.tsx. Adjusting state during render (React's documented pattern for "reset state
  // when a prop changes") rather than in a useEffect, so the reset lands in the same
  // render pass instead of triggering an extra one. No-op for every non-owner uid, which
  // never sets isQaOwner true in the first place.
  const [prevIsQaOwner, setPrevIsQaOwner] = useState(isQaOwner);
  if (isQaOwner !== prevIsQaOwner) {
    setPrevIsQaOwner(isQaOwner);
    if (!isQaOwner) {
      setActiveTab((tab) => (tab === 'qa' ? 'today' : tab));
      setViewingDay(null);
    }
  }

  // undefined once currentDay has advanced past the last real day (see handleMarkComplete
  // below) — i.e. the course is complete. Previously this was handled as a full-screen
  // early return here, which made it unreachable in practice (currentDay was capped at
  // DNS_COURSE.length forever) AND, even if reached, would have hidden Past Days/History
  // entirely. Now it's handled inside the Today tab instead (see CourseCompleteState),
  // so the tab bar — and Day 84's rewatch access via Past Days/History — stays intact.
  const currentDayData = DNS_COURSE[dnsCourse.currentDay - 1];

  // currentDayData is undefined only in the course-complete state (see above) — every
  // real day in DNS_COURSE is premium, so `?? true` preserves the exact same gating
  // behavior for that state (Past Days/History content is premium too) without reading
  // .isPremium off of undefined.
  if ((currentDayData?.isPremium ?? true) && dnsEntitlementState !== 'entitled') {
    // 'loading': the current uid's entitlement snapshot hasn't resolved yet — a real
    // purchaser lands here first, so show a lightweight wait state instead of flashing
    // the paywall at them. 'not-entitled' (resolved, confirmed no access, or a uid
    // change/listener error per the auth effect) shows the real paywall.
    if (dnsEntitlementState === 'loading') {
      return (
        <div className="min-h-screen bg-[#080d1a] flex items-center justify-center">
          <p className="text-[#6b849e] text-sm font-semibold">Checking your access…</p>
        </div>
      );
    }
    if (!showPaywall) {
      return (
        <DNSProgramIntroduction
          onBack={onBack}
          onContinue={() => setShowPaywall(true)}
          onOpenSettings={onOpenSettings}
        />
      );
    }
    return (
      <Paywall
        auth={auth}
        checkoutLoading={checkoutLoading}
        setCheckoutLoading={setCheckoutLoading}
        onBack={onBack}
        onOpenSettings={onOpenSettings}
        onGoogleSignIn={onGoogleSignIn}
        onSendSignInLink={onSendSignInLink}
        onCreatePasswordAccount={onCreatePasswordAccount}
        onSignInWithPassword={onSignInWithPassword}
        signInLoading={signInLoading}
        signInError={signInError}
        isInAppBrowser={isInAppBrowser}
      />
    );
  }

  // Shown once, now that entitlement is confirmed — this is the first screen of the
  // entitled program experience, not pre-purchase content (moved below the entitlement
  // check above; previously shown to unentitled visitors too).
  //
  // Narrow owner-only exception (unchanged): the QA owner reaches this component's tab
  // bar/QA tab even with an empty startedAt, without being blocked by this full-page
  // return — their "not started yet" state is handled inside the Today tab instead (see
  // the `activeTab === 'today'` branch below), the same way `!currentDayData` (course
  // complete) already is.
  if (!dnsCourse.startedAt && !isOwnerUid) {
    return (
      <div className="min-h-screen bg-[#080d1a] pb-20">
        <div className="max-w-2xl mx-auto p-6 pt-10">
          <h1 className="text-2xl font-bold text-[#f0f4f8] mb-6 text-center">Before You Start</h1>

          <BeforeYouStartContent />

          <button
            onClick={() => onUpdateDnsCourse({ startedAt: today })}
            className="w-full py-4 rounded-xl font-bold text-base text-[#080d1a] hover:opacity-90 active:scale-95 transition-all"
            style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
          >
            Start Week 1, Day 1
          </button>
        </div>
      </div>
    );
  }

  // See services/dnsCourseProgression.ts for the full model — availability.openDay is the
  // ONLY lesson viewable/completable right now (calendar ceiling AND sequence both
  // satisfied); availability.waitingForNextDay is the "come back tomorrow" state, gated on
  // elapsed calendar days since startedAt rather than on whether Mark Complete happened to
  // be clicked today (the fix for the reported defect — see that module's header comment).
  const availability = computeDnsDayAvailability(dnsCourse, today, DNS_COURSE_LENGTH);
  const showCompletionBanner = availability.waitingForNextDay || (availability.courseComplete && availability.completedSomethingToday);
  const bannerDayIndex = availability.mostRecentlyCompletedDay;
  const nextDayData = DNS_COURSE[dnsCourse.currentDay]; // currentDay is 1-based, so this is the next entry
  const pastDays = DNS_COURSE.slice(0, dnsCourse.currentDay - 1); // days 1..currentDay-1

  const handleMarkComplete = () => {
    // Guaranteed non-null: this handler is only ever wired to the button rendered in the
    // availability.openDay !== null branch below. The defensive check exists purely so
    // this can never silently pass `null` through as some other numeric day if that
    // invariant is ever violated by a future edit — it does NOT re-derive "which day" from
    // dnsCourse.currentDay, which is exactly what must never happen here (see the prop's
    // own doc comment above).
    if (availability.openDay === null) return;
    void onCompleteDay(today, availability.openDay);
  };

  const tabButtonStyle = (tab: 'today' | 'past' | 'history') =>
    activeTab === tab
      ? { background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)', color: '#080d1a' }
      : { backgroundColor: '#1a2a42', color: '#6b849e' };

  return (
    <>
      {guidanceView !== null && (
        <GuidanceModal view={guidanceView} onNavigate={setGuidanceView} onClose={() => setGuidanceView(null)} />
      )}
    <div className="min-h-screen bg-[#080d1a] pb-20">
      <div className="bg-[#0f1829] border-b border-[#1a2a42] sticky top-0 z-30">
        <div className="p-4 flex items-center justify-between max-w-2xl mx-auto">
          <button onClick={onBack} className="text-[#6b849e] hover:text-[#f0f4f8] flex items-center gap-1 transition-colors">
            <ArrowLeft size={20} /> Back
          </button>
          <div className="font-semibold text-[#f0f4f8]">12-Week DNS Foundations</div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setGuidanceView('list')}
              className="text-[#6b849e] hover:text-[#f0f4f8] p-2 rounded-full hover:bg-[#1a2a42] transition-colors"
              aria-label="Guidance"
            >
              <HelpCircle size={20} />
            </button>
            <button onClick={onOpenSettings} className="bg-[#1a2a42] p-2 rounded-full hover:opacity-80 transition-opacity" aria-label="Profile & Settings">
              <User size={20} className="text-[#6b849e]" />
            </button>
          </div>
        </div>

        <div className="max-w-2xl mx-auto px-4 pb-3 flex gap-2">
          <button
            onClick={() => { setActiveTab('today'); setViewingDay(null); }}
            className="flex-1 py-2 rounded-lg text-sm font-bold transition-all"
            style={tabButtonStyle('today')}
          >
            Today
          </button>
          <button
            onClick={() => setActiveTab('past')}
            className="flex-1 py-2 rounded-lg text-sm font-bold transition-all"
            style={tabButtonStyle('past')}
          >
            Past Days
          </button>
          <button
            onClick={() => { setActiveTab('history'); setViewingDay(null); }}
            className="flex-1 py-2 rounded-lg text-sm font-bold transition-all"
            style={tabButtonStyle('history')}
          >
            History
          </button>
          {/* Owner-only, deliberately off the app's teal/purple palette (dashed amber) so
              it never reads as a normal tab. */}
          {isQaOwner && (
            <button
              onClick={() => { setActiveTab('qa'); setViewingDay(null); }}
              className="flex-1 py-2 rounded-lg text-sm font-bold transition-all border border-dashed"
              style={
                activeTab === 'qa'
                  ? { backgroundColor: '#ffcc00', color: '#080d1a', borderColor: '#ffcc00' }
                  : { backgroundColor: '#1a2a42', color: '#ffcc00', borderColor: 'rgba(255,204,0,0.4)' }
              }
            >
              QA Lessons
            </button>
          )}
        </div>
      </div>

      <div className="max-w-2xl mx-auto p-6 mt-6">
        {/* Optional install prompt — only ever reached once entitlement/paywall/QA-owner
            checks above have already passed, i.e. the user is actually in the program.
            eligible uses currentDay > 1 (already advances only once Day 1 is actually
            completed, via handleMarkComplete) rather than showing on first arrival, so
            the user experiences the program before being asked to install. No new
            persisted field — this reads the same currentDay already driving Today/Past
            Days/History. */}
        <InstallPromptCard eligible={dnsCourse.currentDay > 1} />
        {viewingDay !== null ? (() => {
          // Shared by Past Days, History, and QA Lessons — same DayContent, same
          // read-only rewatch behavior, no progress-tracking side effects either way.
          // Only the "Back to" destination differs, based on wherever the tap
          // originated — activeTab isn't touched when viewingDay is set, so it still
          // reflects the originating tab here, and Back (which only clears viewingDay)
          // lands back on that same tab, QA included.
          const day = DNS_COURSE[viewingDay - 1];
          if (!day) return null;
          const backLabel = activeTab === 'qa' ? 'QA Lessons' : activeTab === 'history' ? 'History' : 'Past Days';
          return (
            <>
              <button
                onClick={() => setViewingDay(null)}
                className="text-[#6b849e] hover:text-[#f0f4f8] flex items-center gap-1 transition-colors text-sm mb-4"
              >
                <ArrowLeft size={16} /> Back to {backLabel}
              </button>
              {activeTab === 'qa' && (
                <div className="inline-block bg-[#ffcc00]/10 border border-dashed border-[#ffcc00]/40 rounded-full px-3 py-1 text-[10px] font-bold text-[#ffcc00] uppercase tracking-wider mb-4">
                  Internal QA View · Day {viewingDay}
                </div>
              )}
              {/* View-only: no Mark Complete button, no up-next teaser — rewatching a
                  past day never touches dnsCourse.currentDay or lastCompletedDate. */}
              <DayContent day={day} dayIndex={viewingDay} />
            </>
          );
        })() : activeTab === 'today' ? (
          !dnsCourse.startedAt ? (
            // Only reachable here for the entitled QA owner uid with an empty
            // startedAt — every other uid already returned the full-page BeforeYouStart
            // screen above before ever reaching this render. Same content, same single
            // write (onUpdateDnsCourse({ startedAt: today })) as that screen — moved
            // in-tab rather than duplicated, so QA/Past Days/History stay reachable
            // alongside it and the normal start behavior (D) is identical once clicked.
            <>
              <h1 className="text-2xl font-bold text-[#f0f4f8] mb-6 text-center">Before You Start</h1>
              <BeforeYouStartContent />
              <button
                onClick={() => onUpdateDnsCourse({ startedAt: today })}
                className="w-full py-4 rounded-xl font-bold text-base text-[#080d1a] hover:opacity-90 active:scale-95 transition-all"
                style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
              >
                Start Week 1, Day 1
              </button>
            </>
          ) : showCompletionBanner ? (() => {
            // Checked BEFORE the courseComplete branch below — completing Day 84 advances
            // currentDay to 85, so the ordinary permanent course-complete screen would
            // otherwise win first and make Day 84 unreachable from Today on its own
            // completion date. bannerDayIndex (dnsCourse.currentDay - 1) is always the
            // real, valid day that was just completed — see computeDnsDayAvailability's
            // invariant that this is always >= 1 whenever showCompletionBanner is true.
            // Read-only: no onCompleteDay call anywhere in this branch, so mounting it
            // (including on a refresh that restores straight back into this exact state,
            // or a Retry inside VideoPlayer) never writes completion data again —
            // completeDnsCourseDay's own ceiling check means even a stray extra call here
            // would still be a no-op, but there isn't one to begin with.
            const completedDay = DNS_COURSE[bannerDayIndex - 1] as DNSCourseDay;
            const nextDayIndex = availability.waitingForNextDay ? dnsCourse.currentDay : null;
            return (
              <>
                <DayContent day={completedDay} dayIndex={bannerDayIndex} />
                <CompletedTodayBanner completedDayIndex={bannerDayIndex} nextDayIndex={nextDayIndex} />
                {/* Day 84 specifically: acknowledge the whole program is done, without
                    replacing the replayable content above the way CourseCompleteState
                    (the *later-date* landing screen — see the branch below) does. */}
                {nextDayIndex === null && (
                  <p className="mt-3 text-center text-xs text-[#6b849e]">
                    That's all 12 weeks — you've completed the DNS Foundations program.
                  </p>
                )}
              </>
            );
          })() : availability.openDay === null ? (
            <CourseCompleteState onReviewPastDays={() => setActiveTab('past')} />
          ) : (
            <>
              <DayContent day={DNS_COURSE[availability.openDay - 1] as DNSCourseDay} dayIndex={availability.openDay} />

              <button
                onClick={handleMarkComplete}
                className="w-full py-4 rounded-xl font-bold text-base text-[#080d1a] hover:opacity-90 active:scale-95 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
                style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
              >
                <CheckCircle size={18} />
                Mark Complete & Continue
              </button>

              {nextDayData && (
                <div
                  className="mt-4 rounded-xl p-4 flex items-center gap-3 opacity-60"
                  style={{ background: '#0f1829', border: '1px solid #1a2a42' }}
                >
                  <Lock size={18} className="text-[#6b849e] flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-[#6b849e] uppercase tracking-wider">
                      Week {nextDayData.week}, Day {nextDayData.day}
                    </p>
                    <p className="text-sm font-semibold text-[#f0f4f8] truncate">{nextDayData.dayTitle}</p>
                    <p className="text-xs text-[#6b849e] mt-0.5">
                      {availability.nextLessonAvailableImmediately
                        ? `Unlocks after you complete Day ${dnsCourse.currentDay}`
                        : 'Unlocks tomorrow'}
                    </p>
                  </div>
                </div>
              )}
            </>
          )
        ) : activeTab === 'past' ? (
          <div className="space-y-3">
            {pastDays.length === 0 ? (
              <p className="text-[#6b849e] text-sm text-center py-8">
                Complete Day 1 to start building your history here.
              </p>
            ) : (
              pastDays.map((day, i) => {
                const dayIndex = i + 1;
                return (
                  <button
                    key={dayIndex}
                    onClick={() => setViewingDay(dayIndex)}
                    className="w-full bg-[#0f1829] p-4 rounded-xl border border-[#1a2a42] flex items-center justify-between hover:border-[#00d4c8]/40 transition-all text-left"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-[#00d4c8] uppercase tracking-wider">
                        Week {day.week}, Day {day.day}
                      </p>
                      <p className="text-sm font-semibold text-[#f0f4f8] truncate">{day.dayTitle}</p>
                    </div>
                    <ChevronRight size={18} className="text-[#6b849e] flex-shrink-0" />
                  </button>
                );
              })
            )}
          </div>
        ) : activeTab === 'qa' ? (
          // Internal QA browser: every real DNS_COURSE day (index + 1 = overall course
          // day, NOT the per-week day.day field, which repeats 1-7 each week), regardless
          // of dnsCourse.currentDay. Selecting one only sets viewingDay — same read-only
          // path as Past Days/History above, DayVideo included; no onUpdateDnsCourse, no
          // handleMarkComplete, nothing here ever writes dnsCourse or userData/main.
          <div className="space-y-3">
            <div className="bg-[#ffcc00]/10 border border-dashed border-[#ffcc00]/40 rounded-xl px-4 py-3 text-xs text-[#ffcc00] font-semibold">
              Internal QA — opens real production lesson content for verification. Never affects course progress, pacing, or entitlement.
            </div>
            {DNS_COURSE.map((day, i) => {
              const dayIndex = i + 1;
              return (
                <button
                  key={dayIndex}
                  onClick={() => setViewingDay(dayIndex)}
                  className="w-full bg-[#0f1829] p-4 rounded-xl border border-dashed border-[#ffcc00]/30 flex items-center justify-between hover:border-[#ffcc00]/70 transition-all text-left"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-[#ffcc00] uppercase tracking-wider">
                      Day {dayIndex} · Week {day.week}, Day {day.day}
                    </p>
                    <p className="text-sm font-semibold text-[#f0f4f8] truncate">{day.dayTitle}</p>
                  </div>
                  <ChevronRight size={18} className="text-[#6b849e] flex-shrink-0" />
                </button>
              );
            })}
          </div>
        ) : (() => {
          // History: a real calendar-grid month view of completed days, driven entirely
          // by dnsCourse.completionDates (see handleMarkComplete). Skipped/empty dates
          // are deliberately left looking like ordinary empty days — no gap emphasis.
          const completionDates = dnsCourse.completionDates ?? {};
          const dateToDayIndex = new Map<string, number>();
          Object.entries(completionDates).forEach(([dayIndexStr, iso]) => {
            dateToDayIndex.set(iso, Number(dayIndexStr));
          });
          const trackedCount = Object.keys(completionDates).length;
          const hasUntrackedHistory = dnsCourse.currentDay - 1 > trackedCount;

          const { year, month } = historyMonth;
          const cells = buildCalendarCells(year, month);
          const monthLabel = new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

          return (
            <div>
              {hasUntrackedHistory && (
                <p className="text-xs text-[#6b849e] bg-[#0f1829] border border-[#1a2a42] rounded-lg px-3 py-2 mb-4 leading-relaxed">
                  Your history starts tracking from {HISTORY_TRACKING_STARTED_LABEL} — earlier completed days aren't reflected on the calendar below, but your overall progress is unaffected.
                </p>
              )}

              <div className="flex items-center justify-between mb-4">
                <button
                  onClick={() => setHistoryMonth(({ year, month }) => (month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 }))}
                  className="p-2 rounded-lg text-[#6b849e] hover:text-[#f0f4f8] hover:bg-[#1a2a42] transition-colors"
                  aria-label="Previous month"
                >
                  <ChevronLeft size={20} />
                </button>
                <div className="font-bold text-[#f0f4f8]">{monthLabel}</div>
                <button
                  onClick={() => setHistoryMonth(({ year, month }) => (month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 }))}
                  className="p-2 rounded-lg text-[#6b849e] hover:text-[#f0f4f8] hover:bg-[#1a2a42] transition-colors"
                  aria-label="Next month"
                >
                  <ChevronRight size={20} />
                </button>
              </div>

              <div className="grid grid-cols-7 gap-1 mb-1">
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((label, i) => (
                  <div key={i} className="text-center text-[10px] font-bold text-[#6b849e] uppercase py-1">
                    {label}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-7 gap-1">
                {cells.map((cell, i) => {
                  if (!cell) return <div key={i} className="aspect-square" />;
                  const dayIndex = dateToDayIndex.get(cell.iso);
                  if (dayIndex === undefined) {
                    return (
                      <div
                        key={i}
                        className="aspect-square rounded-lg border border-[#1a2a42] flex items-center justify-center text-[#3a4a5e] text-xs"
                      >
                        {cell.date}
                      </div>
                    );
                  }
                  return (
                    <button
                      key={i}
                      onClick={() => setViewingDay(dayIndex)}
                      className="aspect-square rounded-lg border border-[#00d4c8]/40 bg-[#00d4c8]/10 hover:bg-[#00d4c8]/20 transition-all flex flex-col items-center justify-center gap-0.5"
                    >
                      <span className="text-xs font-bold text-[#f0f4f8]">{cell.date}</span>
                      <span className="text-[9px] font-bold text-[#00d4c8] leading-none">Day {dayIndex}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
    </>
  );
}
