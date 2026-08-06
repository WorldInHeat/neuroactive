// src/components/DNSCourseView.tsx
// 12-Week DNS Foundations course. Structurally separate from DECISION_TREE —
// does not touch activePrescriptions, history, or any assessment-flow state.
import { useState } from 'react';
import type { Auth } from 'firebase/auth';
import { ArrowLeft, CheckCircle, ChevronRight, Lock } from 'lucide-react';
import { DNS_COURSE } from '../data/dnsCourse';
import type { DNSCourseDay } from '../data/dnsCourse';
import type { DnsCourseProgress } from '../state/types';
import type { PriceKey } from '../services/stripe';
import VideoPlayer from './VideoPlayer';
import Paywall from './Paywall';

type Props = {
  dnsCourse: DnsCourseProgress;
  onUpdateDnsCourse: (updates: Partial<DnsCourseProgress>) => void;
  today: string; // local calendar date, e.g. from todayLocalISO()
  isPremium: boolean;
  onBack: () => void;
  auth: Auth | null;
  checkoutLoading: PriceKey | null;
  setCheckoutLoading: (key: PriceKey | null) => void;
};

// Week badge + heading + video (or placeholder) + description — the content shared by
// both the current day and whichever past day is being reviewed. Reuses VideoPlayer
// rather than duplicating video-playing logic.
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

      {day.videoId ? (
        <VideoPlayer
          nodeId={`dns_course_day_${dayIndex}`}
          title={day.dayTitle}
          videoId={day.videoId}
          autoplayToken={null}
          onConsumeAutoplay={() => {}}
        />
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

export default function DNSCourseView({
  dnsCourse,
  onUpdateDnsCourse,
  today,
  isPremium,
  onBack,
  auth,
  checkoutLoading,
  setCheckoutLoading,
}: Props) {
  // Hooks must run unconditionally, before the early returns below.
  const [activeTab, setActiveTab] = useState<'today' | 'past'>('today');
  const [viewingDay, setViewingDay] = useState<number | null>(null);

  const currentDayData = DNS_COURSE[dnsCourse.currentDay - 1];

  if (!currentDayData) {
    return (
      <div className="min-h-screen bg-[#080d1a] p-6">
        <div className="max-w-2xl mx-auto bg-[#0f1829] p-6 rounded-xl border border-[#1a2a42]">
          <h2 className="text-xl font-bold text-[#f0f4f8]">Course Complete</h2>
          <p className="text-[#6b849e] mt-2">You've completed all 84 days of the DNS Foundations program.</p>
          <button
            onClick={onBack}
            className="mt-4 px-4 py-2 rounded-lg font-semibold text-[#080d1a]"
            style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  // Shown once, before the user has ever started the course. Deliberately shown before
  // the paywall check below — this is philosophy/context-setting, not program content,
  // so non-premium users see it too (same reasoning as keeping pain-triage free).
  if (!dnsCourse.startedAt) {
    return (
      <div className="min-h-screen bg-[#080d1a] pb-20">
        <div className="max-w-2xl mx-auto p-6 pt-10">
          <h1 className="text-2xl font-bold text-[#f0f4f8] mb-6 text-center">Before You Start</h1>

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

  if (currentDayData.isPremium && !isPremium) {
    return <Paywall auth={auth} checkoutLoading={checkoutLoading} setCheckoutLoading={setCheckoutLoading} onBack={onBack} />;
  }

  const isSameDayAlreadyCompleted = dnsCourse.lastCompletedDate === today;
  const nextDayData = DNS_COURSE[dnsCourse.currentDay]; // currentDay is 1-based, so this is the next entry
  const pastDays = DNS_COURSE.slice(0, dnsCourse.currentDay - 1); // days 1..currentDay-1

  const handleMarkComplete = () => {
    const isNewDay = dnsCourse.lastCompletedDate !== today;
    const nextDay = isNewDay ? Math.min(dnsCourse.currentDay + 1, DNS_COURSE.length) : dnsCourse.currentDay;
    onUpdateDnsCourse({ lastCompletedDate: today, currentDay: nextDay });
  };

  const tabButtonStyle = (tab: 'today' | 'past') =>
    activeTab === tab
      ? { background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)', color: '#080d1a' }
      : { backgroundColor: '#1a2a42', color: '#6b849e' };

  return (
    <div className="min-h-screen bg-[#080d1a] pb-20">
      <div className="bg-[#0f1829] border-b border-[#1a2a42] sticky top-0 z-30">
        <div className="p-4 flex items-center justify-between max-w-2xl mx-auto">
          <button onClick={onBack} className="text-[#6b849e] hover:text-[#f0f4f8] flex items-center gap-1 transition-colors">
            <ArrowLeft size={20} /> Back
          </button>
          <div className="font-semibold text-[#f0f4f8]">12-Week DNS Foundations</div>
          <div className="w-16" />
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
        </div>
      </div>

      <div className="max-w-2xl mx-auto p-6 mt-6">
        {activeTab === 'today' && (
          <>
            <DayContent day={currentDayData} dayIndex={dnsCourse.currentDay} />

            <button
              onClick={handleMarkComplete}
              disabled={isSameDayAlreadyCompleted}
              className="w-full py-4 rounded-xl font-bold text-base text-[#080d1a] hover:opacity-90 active:scale-95 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
              style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
            >
              <CheckCircle size={18} />
              {isSameDayAlreadyCompleted ? 'Completed for Today' : 'Mark Complete & Continue'}
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
        )}

        {activeTab === 'past' && viewingDay === null && (
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
        )}

        {activeTab === 'past' && viewingDay !== null && (() => {
          const day = DNS_COURSE[viewingDay - 1];
          if (!day) return null;
          return (
            <>
              <button
                onClick={() => setViewingDay(null)}
                className="text-[#6b849e] hover:text-[#f0f4f8] flex items-center gap-1 transition-colors text-sm mb-4"
              >
                <ArrowLeft size={16} /> Back to Past Days
              </button>
              {/* View-only: no Mark Complete button, no up-next teaser — rewatching a
                  past day never touches dnsCourse.currentDay or lastCompletedDate. */}
              <DayContent day={day} dayIndex={viewingDay} />
            </>
          );
        })()}
      </div>
    </div>
  );
}
