// src/components/DNSCourseView.tsx
// 12-Week DNS Foundations course. Structurally separate from DECISION_TREE —
// does not touch activePrescriptions, history, or any assessment-flow state.
import { useEffect, useState, type ReactElement } from 'react';
import type { Auth } from 'firebase/auth';
import { ArrowLeft, CheckCircle, ChevronLeft, ChevronRight, HelpCircle, Lock, User, X } from 'lucide-react';
import { DNS_COURSE } from '../data/dnsCourse';
import type { DNSCourseDay } from '../data/dnsCourse';
import type { DnsCourseProgress } from '../state/types';
import type { PriceKey } from '../services/stripe';
import { fetchDnsCourseDayMedia, type DnsCourseDayMedia } from '../services/dnsCourseMedia';
import VideoPlayer from './VideoPlayer';
import Paywall from './Paywall';
import DNSProgramIntroduction from './DNSProgramIntroduction';

// The History tab can only ever know about completions from this date forward —
// dnsCourse.completionDates isn't backfilled for anything completed earlier.
const HISTORY_TRACKING_STARTED = '2026-08-13';
const HISTORY_TRACKING_STARTED_LABEL = new Date(`${HISTORY_TRACKING_STARTED}T00:00:00`).toLocaleDateString('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

type Props = {
  dnsCourse: DnsCourseProgress;
  onUpdateDnsCourse: (updates: Partial<DnsCourseProgress>) => void;
  today: string; // local calendar date, e.g. from todayLocalISO()
  // Server-verified DNS Foundations entitlement — 'loading' until the first snapshot for
  // the current uid resolves. Only 'entitled' unlocks anything; both 'loading' and
  // 'not-entitled' render as locked, so a legitimate purchaser sees a brief loading state
  // rather than a paywall flash, without ever trusting an unresolved/stale value.
  dnsEntitlementState: 'loading' | 'entitled' | 'not-entitled';
  onBack: () => void;
  onOpenSettings: () => void;
  auth: Auth | null;
  checkoutLoading: PriceKey | null;
  setCheckoutLoading: (key: PriceKey | null) => void;
  onGoogleSignIn: () => void;
  onSendSignInLink: (email: string) => Promise<void>;
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

// Shown on the Today tab once today's lesson has already been marked complete. This is
// deliberately NOT the normal locked-preview treatment (Lock icon, muted/opacity-60,
// "Unlocks after you complete Day X") used for a day the user simply hasn't reached yet
// — that's an earned-progression lock. This is a same-day pacing wait after a genuine
// completion, so it reads as success + "come back tomorrow," not as something withheld.
function TodayCompletionWaitState({ completedDayIndex, nextDayIndex }: { completedDayIndex: number; nextDayIndex: number | null }) {
  return (
    <div className="bg-[#0f1829] p-8 rounded-2xl border border-[#00e096]/20 text-center">
      <CheckCircle className="text-[#00e096] mx-auto mb-3" size={40} />
      <h2 className="text-xl font-bold text-[#f0f4f8] mb-1">Day {completedDayIndex} complete</h2>
      <p className="text-[#6b849e] text-sm">
        {nextDayIndex !== null ? `Day ${nextDayIndex} unlocks tomorrow.` : 'Nice work today.'}
      </p>
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
  today,
  dnsEntitlementState,
  onBack,
  onOpenSettings,
  auth,
  checkoutLoading,
  setCheckoutLoading,
  onGoogleSignIn,
  onSendSignInLink,
  signInLoading,
  signInError,
  isInAppBrowser,
}: Props) {
  // Hooks must run unconditionally, before the early returns below.
  const [activeTab, setActiveTab] = useState<'today' | 'past' | 'history' | 'qa'>('today');
  const [viewingDay, setViewingDay] = useState<number | null>(null);
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

  // isOwnerUid alone is never a security boundary — it only ever gates UI reachability.
  // Real access is still enforced by dnsEntitlementState (isQaOwner below, and the
  // unmodified entitlement/paywall check further down) and, independently, by
  // getDnsCourseDayMedia server-side.
  const isOwnerUid = QA_OWNER_UIDS.includes(auth?.currentUser?.uid ?? '');
  const isQaOwner = dnsEntitlementState === 'entitled' && isOwnerUid;

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

  const isSameDayAlreadyCompleted = dnsCourse.lastCompletedDate === today;
  // Which day was actually completed today — read from completionDates (keyed by the day
  // that was current AT THE MOMENT it was completed, before currentDay advanced) rather
  // than derived as `currentDay - 1`, so this stays correct even at the Day 84 ceiling
  // where currentDay no longer advances past the day that was just completed.
  const completedTodayDayIndex = isSameDayAlreadyCompleted
    ? Number(
        Object.entries(dnsCourse.completionDates ?? {}).find(([, date]) => date === today)?.[0] ??
          dnsCourse.currentDay - 1
      )
    : null;
  const nextDayData = DNS_COURSE[dnsCourse.currentDay]; // currentDay is 1-based, so this is the next entry
  const pastDays = DNS_COURSE.slice(0, dnsCourse.currentDay - 1); // days 1..currentDay-1

  const handleMarkComplete = () => {
    const isNewDay = dnsCourse.lastCompletedDate !== today;
    // Capped at DNS_COURSE.length + 1 (85), one past the last real day, rather than at
    // DNS_COURSE.length (84) — completing Day 84 must actually advance past it so
    // currentDayData above becomes undefined and the course-complete state is reached;
    // capping at 84 forever was the pre-existing defect that made Course Complete
    // unreachable. The +1 cap still stops currentDay from growing without bound if this
    // were ever invoked again after completion (it isn't, from the UI, once
    // currentDayData is undefined).
    const nextDay = isNewDay ? Math.min(dnsCourse.currentDay + 1, DNS_COURSE.length + 1) : dnsCourse.currentDay;
    // Record which real calendar date this day was completed on, for the History tab.
    // Only touched on an actual new completion — spread the existing map first so
    // earlier entries are never dropped (same reasoning as dnsCourse itself elsewhere).
    const completionDates = isNewDay
      ? { ...dnsCourse.completionDates, [dnsCourse.currentDay]: today }
      : dnsCourse.completionDates;
    onUpdateDnsCourse({ lastCompletedDate: today, currentDay: nextDay, completionDates });
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
          ) : !currentDayData ? (
            <CourseCompleteState onReviewPastDays={() => setActiveTab('past')} />
          ) : isSameDayAlreadyCompleted ? (
            // currentDay has already advanced to the next lesson, but at most one new
            // lesson unlocks per local calendar day — don't mount DayContent (and so
            // don't mount DayVideo / call getDnsCourseDayMedia) for it until then.
            <TodayCompletionWaitState
              completedDayIndex={completedTodayDayIndex as number}
              nextDayIndex={
                (completedTodayDayIndex as number) + 1 <= DNS_COURSE.length
                  ? (completedTodayDayIndex as number) + 1
                  : null
              }
            />
          ) : (
            <>
              <DayContent day={currentDayData} dayIndex={dnsCourse.currentDay} />

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
                    <p className="text-xs text-[#6b849e] mt-0.5">Unlocks after you complete Day {dnsCourse.currentDay}</p>
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
